import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { monitorQueue } from "@/lib/queue";
import { mockRetailer, mockRetailerStore } from "@/modules/retailers/testing/mock";
import { mockProductUrl } from "@/modules/retailers/testing/mock/types";
import { addMonitoringSubscription } from "@/modules/monitoring/service";
import {
  claimDueSubscription,
  createSubscription,
} from "@/modules/monitoring/repository";
import { sweepDueSubscriptions } from "@/modules/monitoring/scheduler";
import { createMonitoringWorker } from "@/modules/monitoring/worker";
import { createTestUser, createTestListing, resetTestState } from "@test/helpers/integration";
import type { Worker } from "bullmq";

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("waitFor timed out");
}

describe("monitoring scheduler (integration)", () => {
  let dueCounter = 0;

  beforeEach(async () => {
    await resetTestState();
    mockRetailerStore.reset();
  });

  afterAll(async () => {
    await resetTestState();
    await monitorQueue.obliterate({ force: true });
  });

  async function dueSubscription(
    overrides: { status?: "ACTIVE" | "PAUSED"; sku?: string } = {},
  ) {
    const userId = await createTestUser(`due-${dueCounter++}@example.com`);
    const subscription = await addMonitoringSubscription({
      userId,
      url: mockProductUrl(overrides.sku ?? "in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });
    if (overrides.status) {
      await db.monitoringSubscription.update({
        where: { id: subscription.id },
        data: { status: overrides.status },
      });
    }
    return subscription;
  }

  it("claims a due subscription and advances nextCheckAt by its interval", async () => {
    const subscription = await dueSubscription();

    const claimed = await claimDueSubscription(subscription.id);
    expect(claimed?.intervalMinutes).toBe(15);

    const row = await db.monitoringSubscription.findUnique({
      where: { id: subscription.id },
    });
    const expected = Date.now() + 15 * 60_000;
    expect(row?.nextCheckAt?.getTime()).toBeGreaterThan(expected - 5000);
    expect(row?.nextCheckAt?.getTime()).toBeLessThanOrEqual(expected + 5000);

    // Not due anymore: claiming again returns null.
    expect(await claimDueSubscription(subscription.id)).toBeNull();
  });

  it("does not claim paused subscriptions", async () => {
    const subscription = await dueSubscription({ status: "PAUSED" });
    expect(await claimDueSubscription(subscription.id)).toBeNull();
  });

  it("groups subscriptions for the same shared listing into one queued check", async () => {
    await dueSubscription();
    await dueSubscription();

    const first = await sweepDueSubscriptions();
    expect(first.swept).toBe(2);
    expect(first.enqueued).toBe(1);

    const counts = await monitorQueue.getJobCounts("wait", "active", "delayed");
    expect(counts.wait + counts.active + counts.delayed).toBe(1);

    // Nothing due anymore: second sweep enqueues nothing.
    const second = await sweepDueSubscriptions();
    expect(second.enqueued).toBe(0);
    const countsAfter = await monitorQueue.getJobCounts("wait", "active", "delayed");
    expect(countsAfter.wait + countsAfter.active + countsAfter.delayed).toBe(1);
  });

  it("enqueues one check per distinct listing", async () => {
    await dueSubscription({ sku: "in-stock" });
    await dueSubscription({ sku: "price-drops" });

    const result = await sweepDueSubscriptions();
    expect(result.swept).toBe(2);
    expect(result.enqueued).toBe(2);
  });

  it("runs an enqueued check through a real worker end to end", async () => {
    const subscription = await dueSubscription();
    const worker: Worker = createMonitoringWorker();

    try {
      await sweepDueSubscriptions();

      await waitFor(async () => {
        const checks = await db.monitoringCheck.count({
          where: { subscriptionId: subscription.id, status: "SUCCESS" },
        });
        return checks === 1;
      });

      const listing = await db.retailerListing.findUnique({
        where: { id: subscription.retailerListingId },
      });
      expect(listing?.lastCheckedAt).not.toBeNull();
    } finally {
      await worker.close();
    }
  });

  it("checks a shared listing once and records a check for every active subscriber", async () => {
    const first = await dueSubscription();
    const second = await dueSubscription();
    expect(first.retailerListingId).toBe(second.retailerListingId);

    const worker: Worker = createMonitoringWorker();
    const spy = vi.spyOn(mockRetailer, "getProduct");
    try {
      await sweepDueSubscriptions();

      await waitFor(async () => {
        const checks = await db.monitoringCheck.count({
          where: {
            retailerListingId: first.retailerListingId,
            status: "SUCCESS",
          },
        });
        return checks === 2;
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(
        await db.listingObservation.count({
          where: { retailerListingId: first.retailerListingId },
        }),
      ).toBe(1);
    } finally {
      spy.mockRestore();
      await worker.close();
    }
  });

  it("enqueues a new check while the previous completed job is retained", async () => {
    const subscription = await dueSubscription();
    const worker: Worker = createMonitoringWorker();

    try {
      await sweepDueSubscriptions();
      await waitFor(async () => {
        const checks = await db.monitoringCheck.count({
          where: { subscriptionId: subscription.id, status: "SUCCESS" },
        });
        return checks === 1;
      });

      // The completed job is still in Redis because removeOnComplete keeps
      // it for an hour. A second due check must still be enqueued.
      const counts = await monitorQueue.getJobCounts("completed");
      expect(counts.completed).toBeGreaterThanOrEqual(1);

      await db.monitoringSubscription.update({
        where: { id: subscription.id },
        data: { nextCheckAt: new Date(Date.now() - 1_000) },
      });

      const second = await sweepDueSubscriptions();
      expect(second.enqueued).toBe(1);

      await waitFor(async () => {
        const checks = await db.monitoringCheck.count({
          where: { subscriptionId: subscription.id, status: "SUCCESS" },
        });
        return checks === 2;
      });
    } finally {
      await worker.close();
    }
  });

  it("a paused subscription never reaches the queue", async () => {
    await dueSubscription({ status: "PAUSED" });
    const result = await sweepDueSubscriptions();
    expect(result.enqueued).toBe(0);
  });

  it("re-scheduling applies when the interval is updated", async () => {
    const userId = await createTestUser();
    const { listing } = await createTestListing({
      retailerProductId: "interval-test",
      name: "Interval product",
      url: "https://mock-retailer.test/products/interval-test",
    });
    const subscription = await createSubscription({
      userId,
      retailerListingId: listing.id,
      condition: "BACK_IN_STOCK",
      intervalMinutes: 60,
    });

    // Claim once (advances to +60m), then change interval to 15m.
    await claimDueSubscription(subscription.id);
    await db.monitoringSubscription.update({
      where: { id: subscription.id },
      data: { intervalMinutes: 15, nextCheckAt: new Date() },
    });

    const claimed = await claimDueSubscription(subscription.id);
    expect(claimed?.intervalMinutes).toBe(15);
  });
});
