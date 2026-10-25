
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { monitorQueue } from "@/lib/queue";
import { alertCheckIntervalMinutes } from "@/modules/alerts/config";
import {
  claimDueSubscription,
  findDueSubscriptions,
} from "@/modules/monitoring/repository";
import { CHECK_JOB_NAME, SWEEP_JOB_NAME } from "@/modules/monitoring/types";

export const SWEEP_BATCH_SIZE = 100;
export const SWEEP_INTERVAL_MS = 60_000;

/**
 * Find subscriptions whose nextCheckAt is due and enqueue at most one check
 * job per shared retailer listing. Every subscription is claimed atomically
 * before enqueueing, so concurrent sweepers can never schedule the same
 * check twice.
 *
 * The jobId includes the claim time: reusing the listing id would make
 * BullMQ drop every check whose previous job is still retained by
 * removeOnComplete/removeOnFail, delaying checks by up to an hour.
 */
export async function sweepDueSubscriptions(
  limit: number = SWEEP_BATCH_SIZE,
): Promise<{ swept: number; enqueued: number }> {
  const due = await findDueSubscriptions(limit);

  // Multiple users watching the same listing must share one retailer
  // request; group their due subscriptions into a single listing job.
  const byListing = new Map<string, string[]>();
  for (const subscription of due) {
    const ids = byListing.get(subscription.retailerListingId) ?? [];
    ids.push(subscription.id);
    byListing.set(subscription.retailerListingId, ids);
  }

  let enqueued = 0;
  for (const [retailerListingId, subscriptionIds] of byListing) {
    const enqueuedAt = Date.now();
    let claimed = false;
    for (const subscriptionId of subscriptionIds) {
      if (await claimDueSubscription(subscriptionId)) {
        claimed = true;
      }
    }
    if (!claimed) {
      continue; // Paused, rescheduled, or claimed concurrently.
    }
    await monitorQueue.add(
      CHECK_JOB_NAME,
      { retailerListingId, enqueuedAt },
      { jobId: `${retailerListingId}-${enqueuedAt}` },
    );
    enqueued += 1;
  }

  logger.info(
    { component: "monitoring", due: due.length, listings: byListing.size, enqueued },
    "sweep complete",
  );
  return { swept: due.length, enqueued };
}

/**
 * Enqueue checks for listings that have inventory alert rules but may have
 * no monitoring subscription at all. Alert-only checks are deliberately
 * coarse (daily by default) because historical price alerts are not
 * real-time signals. The shared listing lease still prevents duplicate
 * retailer fetches when a subscription check runs around the same time.
 */
export async function sweepDueAlertListings(
  limit: number = SWEEP_BATCH_SIZE,
): Promise<{ due: number; enqueued: number }> {
  const now = new Date();
  const intervalMs = alertCheckIntervalMinutes() * 60_000;

  const due = await db.retailerListing.findMany({
    where: {
      OR: [
        { nextAlertCheckAt: { lte: now } },
        // Listings added after a rule was enabled have no schedule yet.
        { nextAlertCheckAt: null },
      ],
      canonicalProduct: {
        inventoryItems: {
          some: {
            alertRules: { some: { enabled: true } },
          },
        },
      },
    },
    select: { id: true },
    orderBy: { nextAlertCheckAt: "asc" },
    take: limit,
  });

  let enqueued = 0;
  for (const listing of due) {
    // The shared listing lease and enqueuedAt freshness check handle overlap
    // with subscription-driven checks. Do not suppress the first alert check
    // merely because the add flow or a subscription check ran recently:
    // enabling a new rule must be able to evaluate immediately.
    const claimed = await db.retailerListing.updateMany({
      where: {
        id: listing.id,
        OR: [
          { nextAlertCheckAt: { lte: now } },
          { nextAlertCheckAt: null },
        ],
      },
      data: {
        nextAlertCheckAt: new Date(now.getTime() + intervalMs),
      },
    });
    if (claimed.count !== 1) {
      continue;
    }

    await monitorQueue.add(
      CHECK_JOB_NAME,
      {
        retailerListingId: listing.id,
        enqueuedAt: now.getTime(),
      },
      { jobId: `alert-${listing.id}-${now.getTime()}` },
    );
    enqueued += 1;
  }

  logger.info(
    { component: "monitoring", due: due.length, enqueued },
    "alert sweep complete",
  );
  return { due: due.length, enqueued };
}

/**
 * One sweep for both subscription-driven and alert-only shared checks.
 * Grouping by listing is handled by each sweep, and the listing lease
 * deduplicates any overlap between the two.
 */
export async function sweepDueChecks(
  limit: number = SWEEP_BATCH_SIZE,
): Promise<{ swept: number; enqueued: number }> {
  const subscriptions = await sweepDueSubscriptions(limit);
  const alerts = await sweepDueAlertListings(limit);
  return {
    swept: subscriptions.swept + alerts.due,
    enqueued: subscriptions.enqueued + alerts.enqueued,
  };
}

/**
 * Register the recurring sweep job. Uses an upserted job scheduler so the
 * repeat definition is idempotent across restarts.
 */
export async function ensureSweepRepeatJob(): Promise<void> {
  await monitorQueue.upsertJobScheduler(
    "monitor-sweep",
    { every: SWEEP_INTERVAL_MS },
    { name: SWEEP_JOB_NAME, data: {} },
  );
}

/** Kick an immediate sweep (used at startup so new subscriptions check fast). */
export async function triggerSweepNow(): Promise<void> {
  await monitorQueue.add(SWEEP_JOB_NAME, {});
}
