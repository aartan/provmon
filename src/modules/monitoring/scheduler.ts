
import { logger } from "@/lib/logger";
import { monitorQueue } from "@/lib/queue";
import {
  claimDueSubscription,
  findDueSubscriptions,
} from "@/modules/monitoring/repository";
import { CHECK_JOB_NAME, SWEEP_JOB_NAME } from "@/modules/monitoring/types";

export const SWEEP_BATCH_SIZE = 100;
export const SWEEP_INTERVAL_MS = 60_000;

/**
 * Find subscriptions whose nextCheckAt is due and enqueue a check job for
 * each. Every subscription is claimed atomically before enqueueing, so
 * concurrent sweepers can never schedule the same check twice — and the
 * BullMQ jobId (the subscription id) deduplicates even a raced enqueue.
 */
export async function sweepDueSubscriptions(
  limit: number = SWEEP_BATCH_SIZE,
): Promise<{ swept: number; enqueued: number }> {
  const due = await findDueSubscriptions(limit);
  let enqueued = 0;

  for (const subscription of due) {
    const claimed = await claimDueSubscription(subscription.id);
    if (!claimed) {
      continue; // Paused, rescheduled, or claimed concurrently.
    }
    await monitorQueue.add(
      CHECK_JOB_NAME,
      { subscriptionId: subscription.id },
      { jobId: subscription.id },
    );
    enqueued += 1;
  }

  logger.info(
    { component: "monitoring", due: due.length, enqueued },
    "sweep complete",
  );
  return { swept: due.length, enqueued };
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
