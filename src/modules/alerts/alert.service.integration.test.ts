import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Worker } from "bullmq";

import { db } from "@/lib/db";
import { monitorQueue } from "@/lib/queue";
import {
  AlertServiceError,
  setInventoryAlertRule,
} from "@/modules/alerts/alert.service";
import { addInventoryItem } from "@/modules/catalogue/inventory.service";
import { findInventoryItemForUser } from "@/modules/catalogue/inventory.repository";
import { performListingCheck } from "@/modules/monitoring/service";
import { sweepDueAlertListings } from "@/modules/monitoring/scheduler";
import { createMonitoringWorker } from "@/modules/monitoring/worker";
import { mockRetailerStore } from "@/modules/retailers/adapters/mock";
import { mockProductUrl } from "@/modules/retailers/adapters/mock/types";
import { createTestUser, resetTestState } from "@test/helpers/integration";

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

async function setupItem(userId: string) {
  const added = await addInventoryItem({
    userId,
    url: mockProductUrl("in-stock"),
  });
  const item = await findInventoryItemForUser(
    added.inventoryItem.id,
    userId,
  );
  if (!item) {
    throw new Error("inventory item missing");
  }
  return { item, listing: item.canonicalProduct.listings[0] };
}

function stateFor(
  rule: { state: unknown } | null,
): { lastNotifiedPriceByListing?: Record<string, number> } {
  if (!rule || typeof rule.state !== "object" || rule.state === null) {
    return {};
  }
  return rule.state as { lastNotifiedPriceByListing?: Record<string, number> };
}

describe("historical alerts (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
    mockRetailerStore.reset();
  });

  afterAll(async () => {
    await resetTestState();
    await monitorQueue.obliterate({ force: true });
  });

  it("enforces ownership and currency validity when configuring rules", async () => {
    const owner = await createTestUser("alerts-owner@example.com");
    const stranger = await createTestUser("alerts-stranger@example.com");
    const { item, listing } = await setupItem(owner);

    const enabled = await setInventoryAlertRule({
      userId: owner,
      inventoryItemId: item.id,
      type: "HISTORICAL_LOW",
      currency: "GBP",
      enabled: true,
    });
    expect(enabled.enabled).toBe(true);
    expect(enabled.currency).toBe("GBP");

    const storedListing = await db.retailerListing.findUnique({
      where: { id: listing.id },
      select: { nextAlertCheckAt: true },
    });
    expect(storedListing?.nextAlertCheckAt).not.toBeNull();

    const disabled = await setInventoryAlertRule({
      userId: owner,
      inventoryItemId: item.id,
      type: "HISTORICAL_LOW",
      currency: "GBP",
      enabled: false,
    });
    expect(disabled.id).toBe(enabled.id);
    expect(disabled.enabled).toBe(false);
    expect(
      await db.priceAlertRule.count({
        where: { inventoryItemId: item.id },
      }),
    ).toBe(1);

    await expect(
      setInventoryAlertRule({
        userId: stranger,
        inventoryItemId: item.id,
        type: "HISTORICAL_LOW",
        currency: "GBP",
        enabled: true,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      setInventoryAlertRule({
        userId: owner,
        inventoryItemId: item.id,
        type: "HISTORICAL_LOW",
        currency: "USD",
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(AlertServiceError);

    await expect(
      setInventoryAlertRule({
        userId: owner,
        inventoryItemId: item.id,
        type: "BELOW_90_DAY_AVERAGE",
        currency: "GBP",
        enabled: true,
        thresholdPct: 0,
      }),
    ).rejects.toBeInstanceOf(AlertServiceError);
  });

  it("evaluates a new historical low and advances state without emailing when preferences are off", async () => {
    const userId = await createTestUser("alerts-eval@example.com");
    const { item, listing } = await setupItem(userId);

    await db.notificationPreference.update({
      where: { userId },
      data: { emailEnabled: false },
    });
    await setInventoryAlertRule({
      userId,
      inventoryItemId: item.id,
      type: "HISTORICAL_LOW",
      currency: "GBP",
      enabled: true,
    });

    mockRetailerStore.setPrice("in-stock", 25000);
    const result = await performListingCheck(listing.id, { force: true });
    expect(result.success).toBe(true);

    const rule = await db.priceAlertRule.findFirst({
      where: {
        inventoryItemId: item.id,
        type: "HISTORICAL_LOW",
        currency: "GBP",
      },
    });
    expect(stateFor(rule).lastNotifiedPriceByListing?.[listing.id]).toBe(25000);
    expect(rule?.lastTriggeredAt).not.toBeNull();
    expect(
      await db.notification.count({
        where: { userId, type: "HISTORICAL_ALERT" },
      }),
    ).toBe(0);

    // A second unchanged check does not repeat the acknowledged low.
    await performListingCheck(listing.id, { force: true });
    const unchanged = await db.priceAlertRule.findFirst({
      where: {
        inventoryItemId: item.id,
        type: "HISTORICAL_LOW",
        currency: "GBP",
      },
    });
    expect(stateFor(unchanged).lastNotifiedPriceByListing?.[listing.id]).toBe(
      25000,
    );
  });

  it("checks an alert-only inventory listing without a monitoring subscription", async () => {
    const userId = await createTestUser("alerts-only@example.com");
    const { item, listing } = await setupItem(userId);

    await db.notificationPreference.update({
      where: { userId },
      data: { emailEnabled: false },
    });
    await setInventoryAlertRule({
      userId,
      inventoryItemId: item.id,
      type: "HISTORICAL_LOW",
      currency: "GBP",
      enabled: true,
    });
    expect(
      await db.monitoringSubscription.count({ where: { userId } }),
    ).toBe(0);

    mockRetailerStore.setPrice("in-stock", 25000);
    const worker: Worker = createMonitoringWorker();
    try {
      const sweep = await sweepDueAlertListings();
      expect(sweep.enqueued).toBe(1);

      await waitFor(async () => {
        const rule = await db.priceAlertRule.findFirst({
          where: {
            inventoryItemId: item.id,
            type: "HISTORICAL_LOW",
            currency: "GBP",
          },
        });
        return (
          stateFor(rule).lastNotifiedPriceByListing?.[listing.id] === 25000
        );
      });

      const stored = await db.retailerListing.findUnique({
        where: { id: listing.id },
        select: { currentPriceMinor: true, lastCheckedAt: true },
      });
      expect(stored?.currentPriceMinor).toBe(25000);
      expect(stored?.lastCheckedAt).not.toBeNull();
      expect(
        await db.monitoringCheck.count({
          where: { retailerListingId: listing.id },
        }),
      ).toBe(0);
    } finally {
      await worker.close();
    }
  });
});

const describeWithSmtp = process.env.RESEND_API_KEY ? describe.skip : describe;

describeWithSmtp("historical alert delivery (SMTP/Mailpit)", () => {
  beforeEach(async () => {
    await resetTestState();
    mockRetailerStore.reset();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("records a user-specific historical alert notification", async () => {
    const userId = await createTestUser("testmail@example.com");
    const { item, listing } = await setupItem(userId);

    await setInventoryAlertRule({
      userId,
      inventoryItemId: item.id,
      type: "HISTORICAL_LOW",
      currency: "GBP",
      enabled: true,
    });

    mockRetailerStore.setPrice("in-stock", 25000);
    await performListingCheck(listing.id, { force: true });

    const notification = await db.notification.findFirst({
      where: { userId, type: "HISTORICAL_ALERT" },
    });
    expect(notification).not.toBeNull();
    expect(notification?.status).toBe("SENT");
    expect(notification?.subscriptionId).toBeNull();
    expect(notification?.inventoryItemId).toBe(item.id);
    expect(notification?.priceMinor).toBe(25000);
    expect(notification?.subject).toMatch(/all-time low/i);
  });
});
