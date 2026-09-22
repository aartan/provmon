import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { monitorQueue } from "@/lib/queue";
import { mockRetailerStore } from "@/modules/retailers/adapters/mock";
import { mockProductUrl } from "@/modules/retailers/adapters/mock/types";
import { addMonitoringSubscription } from "@/modules/monitoring/service";
import {
  claimDueSubscription,
  createSubscription,
} from "@/modules/monitoring/repository";
import { sweepDueSubscriptions } from "@/modules/monitoring/scheduler";
import { createMonitoringWorker } from "@/modules/monitoring/worker";
import { createTestUser, resetTestState } from "@test/helpers/integration";
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

  async function dueSubscription(overrides: { status?: "ACTIVE" | "PAUSED" } = {}) {
    const userId = await createTestUser(`due-${dueCounter++}@example.com`);
    const subscription = await addMonitoringSubscription({
      userId,
      url: mockProductUrl("in-stock"),
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

  it("sweeps due subscriptions into the queue without duplicates", async () => {
    await dueSubscription();
    await dueSubscription();

    const first = await sweepDueSubscriptions();
    expect(first.enqueued).toBe(2);

    const counts = await monitorQueue.getJobCounts("wait", "active", "delayed");
    expect(counts.wait + counts.active + counts.delayed).toBe(2);

    // Nothing due anymore: second sweep enqueues nothing.
    const second = await sweepDueSubscriptions();
    expect(second.enqueued).toBe(0);
    const countsAfter = await monitorQueue.getJobCounts("wait", "active", "delayed");
    expect(countsAfter.wait + countsAfter.active + countsAfter.delayed).toBe(2);
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

      const product = await db.product.findUnique({
        where: { id: subscription.productId },
      });
      expect(product?.lastCheckedAt).not.toBeNull();
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
    const product = await db.product.create({
      data: {
        retailerId: "mock",
        retailerProductId: "interval-test",
        name: "Interval product",
        url: "https://mock-retailer.test/products/interval-test",
        currency: "GBP",
        currentAvailability: "IN_STOCK",
      },
    });
    const subscription = await createSubscription({
      userId,
      productId: product.id,
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
