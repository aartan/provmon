import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import { mockRetailer, mockRetailerStore } from "@/modules/retailers/testing/mock";
import { mockProductUrl } from "@/modules/retailers/testing/mock/types";
import { RetailerNetworkError } from "@/modules/retailers/core/errors";
import {
  addMonitoringSubscription,
  MonitoringServiceError,
  performListingCheck,
  processCheckJob,
} from "@/modules/monitoring/service";
import { archiveSubscription, createSubscription } from "@/modules/monitoring/repository";
import { createTestUser, createTestListing, resetTestState } from "@test/helpers/integration";

describe("addMonitoringSubscription (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
    mockRetailerStore.reset();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("creates a retailer listing, canonical product, inventory item and subscription", async () => {
    const userId = await createTestUser();
    const subscription = await addMonitoringSubscription({
      userId,
      url: mockProductUrl("in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });

    expect(subscription.retailerListing.retailerId).toBe("mock");
    expect(subscription.retailerListing.name).toContain("In Stock");
    expect(subscription.status).toBe("ACTIVE");

    const storedListing = await db.retailerListing.findFirst({
      where: { retailerId: "mock" },
    });
    expect(storedListing?.currentAvailability).toBe("IN_STOCK");
    expect(storedListing?.currentPriceMinor).toBe(29999);

    expect(await db.canonicalProduct.count()).toBe(1);
    expect(await db.canonicalProduct.count({
      where: { id: storedListing?.canonicalProductId },
    })).toBe(1);
    expect(await db.inventoryItem.count({ where: { userId } })).toBe(1);
  });

  it("shares one listing across users monitoring the same URL but keeps inventory user-scoped", async () => {
    const userA = await createTestUser("a@example.com");
    const userB = await createTestUser("b@example.com");

    await addMonitoringSubscription({
      userId: userA,
      url: mockProductUrl("in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });
    await addMonitoringSubscription({
      userId: userB,
      url: mockProductUrl("in-stock"),
      condition: "PRICE_DROP",
      targetPriceMinor: 25000,
      intervalMinutes: 30,
    });

    const listingCount = await db.retailerListing.count();
    const canonicalCount = await db.canonicalProduct.count();
    const subscriptionCount = await db.monitoringSubscription.count();
    const inventoryA = await db.inventoryItem.findMany({
      where: { userId: userA },
    });
    const inventoryB = await db.inventoryItem.findMany({
      where: { userId: userB },
    });
    expect(listingCount).toBe(1);
    expect(canonicalCount).toBe(1);
    expect(subscriptionCount).toBe(2);
    expect(inventoryA).toHaveLength(1);
    expect(inventoryB).toHaveLength(1);
    expect(inventoryA[0].canonicalProductId).toBe(
      inventoryB[0].canonicalProductId,
    );
  });

  it("rejects a duplicate subscription for the same user and product", async () => {
    const userId = await createTestUser();
    await addMonitoringSubscription({
      userId,
      url: mockProductUrl("in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });
    await expect(
      addMonitoringSubscription({
        userId,
        url: mockProductUrl("in-stock"),
        condition: "BACK_IN_STOCK",
        intervalMinutes: 15,
      }),
    ).rejects.toThrow(MonitoringServiceError);
  });

  it("rejects PRICE_DROP without a target price", async () => {
    const userId = await createTestUser();
    await expect(
      addMonitoringSubscription({
        userId,
        url: mockProductUrl("in-stock"),
        condition: "PRICE_DROP",
        intervalMinutes: 15,
      }),
    ).rejects.toThrow(/target price is required/i);
  });

  it("rejects intervals below the retailer floor", async () => {
    const userId = await createTestUser();
    await expect(
      addMonitoringSubscription({
        userId,
        url: mockProductUrl("in-stock"),
        condition: "BACK_IN_STOCK",
        intervalMinutes: 1 as never,
      }),
    ).rejects.toThrow(MonitoringServiceError);
  });

  it("rejects unsupported retailer URLs", async () => {
    const userId = await createTestUser();
    await expect(
      addMonitoringSubscription({
        userId,
        url: "https://unknown-shop.example/products/1",
        condition: "BACK_IN_STOCK",
        intervalMinutes: 15,
      }),
    ).rejects.toThrow(MonitoringServiceError);
  });

  it("rejects URLs that are not product URLs", async () => {
    const userId = await createTestUser();
    await expect(
      addMonitoringSubscription({
        userId,
        url: "https://mock-retailer.test/",
        condition: "BACK_IN_STOCK",
        intervalMinutes: 15,
      }),
    ).rejects.toThrow(MonitoringServiceError);
  });

  it("rejects products the retailer reports as errors", async () => {
    const userId = await createTestUser();
    mockRetailerStore.setError("broken", { code: "BLOCKED", message: "nope" });
    await expect(
      addMonitoringSubscription({
        userId,
        url: mockProductUrl("broken"),
        condition: "BACK_IN_STOCK",
        intervalMinutes: 15,
      }),
    ).rejects.toThrow(/could not load the product/i);
  });

  it("resumes an archived subscription when the same URL is added again", async () => {
    const userId = await createTestUser("resume@example.com");
    const subscription = await addMonitoringSubscription({
      userId,
      url: mockProductUrl("in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });

    const archived = await archiveSubscription(subscription.id, userId);
    expect(archived?.status).toBe("ARCHIVED");
    expect(archived?.nextCheckAt).toBeNull();

    const resumed = await addMonitoringSubscription({
      userId,
      url: mockProductUrl("in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 30,
    });
    expect(resumed.id).toBe(subscription.id);
    expect(resumed.status).toBe("ACTIVE");
    expect(resumed.intervalMinutes).toBe(30);
    expect(resumed.archivedAt).toBeNull();
  });
});

describe("processCheckJob (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
    mockRetailerStore.reset();
  });

  afterAll(async () => {
    await resetTestState();
  });

  async function createInStockSubscription(userId?: string) {
    const user = userId ?? (await createTestUser());
    return addMonitoringSubscription({
      userId: user,
      url: mockProductUrl("in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });
  }

  it("records a successful check and updates the product", async () => {
    const subscription = await createInStockSubscription();
    const outcome = await processCheckJob({ subscriptionId: subscription.id });

    expect(outcome.success).toBe(true);
    expect(outcome.current.availability).toBe("IN_STOCK");
    expect(outcome.current.priceMinor).toBe(29999);

    const checks = await db.monitoringCheck.findMany({
      where: { subscriptionId: subscription.id },
    });
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("SUCCESS");

    const listing = await db.retailerListing.findUnique({
      where: { id: subscription.retailerListingId },
    });
    expect(listing?.lastCheckedAt).not.toBeNull();
    expect(listing?.lastSuccessfulAt).not.toBeNull();
  });

  it("records a price change as a single observation", async () => {
    const subscription = await createInStockSubscription();
    await processCheckJob({ subscriptionId: subscription.id });

    // The add flow recorded the initial state from real retailer data.
    const initial = await db.listingObservation.findMany({
      where: { retailerListingId: subscription.retailerListingId },
    });
    expect(initial).toHaveLength(1);
    expect(initial[0].kind).toBe("INITIAL");

    mockRetailerStore.setPrice("in-stock", 25000);
    await processCheckJob({ subscriptionId: subscription.id });
    const afterDrop = await db.listingObservation.findMany({
      where: { retailerListingId: subscription.retailerListingId },
      orderBy: { observedAt: "asc" },
    });
    expect(afterDrop).toHaveLength(2);
    expect(afterDrop[1].kind).toBe("CHANGE");
    expect(afterDrop[1].priceMinor).toBe(25000);

    await processCheckJob({ subscriptionId: subscription.id });
    expect(
      await db.listingObservation.count({
        where: { retailerListingId: subscription.retailerListingId },
      }),
    ).toBe(2);
  });

  it("records an availability observation only on transitions", async () => {
    const subscription = await createInStockSubscription();
    await processCheckJob({ subscriptionId: subscription.id });
    expect(
      await db.listingObservation.count({
        where: { retailerListingId: subscription.retailerListingId },
      }),
    ).toBe(1);

    mockRetailerStore.setAvailability("in-stock", "OUT_OF_STOCK");
    await processCheckJob({ subscriptionId: subscription.id });
    expect(
      await db.listingObservation.count({
        where: {
          retailerListingId: subscription.retailerListingId,
          availability: "OUT_OF_STOCK",
        },
      }),
    ).toBe(1);

    // Out of stock again: no new observation.
    await processCheckJob({ subscriptionId: subscription.id });
    expect(
      await db.listingObservation.count({
        where: {
          retailerListingId: subscription.retailerListingId,
          availability: "OUT_OF_STOCK",
        },
      }),
    ).toBe(1);

    // Back in stock: another transition.
    mockRetailerStore.setAvailability("in-stock", "IN_STOCK");
    await processCheckJob({ subscriptionId: subscription.id });
    expect(
      await db.listingObservation.count({
        where: {
          retailerListingId: subscription.retailerListingId,
          availability: "IN_STOCK",
        },
      }),
    ).toBe(2);
  });

  it("records an unchanged snapshot only after the listing cadence elapses", async () => {
    const subscription = await createInStockSubscription();
    await db.monitoringSubscription.update({
      where: { id: subscription.id },
      data: { snapshotIntervalMinutes: 15 },
    });
    await processCheckJob({ subscriptionId: subscription.id });

    await db.listingObservation.updateMany({
      where: { retailerListingId: subscription.retailerListingId },
      data: { observedAt: new Date(Date.now() - 16 * 60_000) },
    });

    await processCheckJob({ subscriptionId: subscription.id });
    const rows = await db.listingObservation.findMany({
      where: { retailerListingId: subscription.retailerListingId },
      orderBy: { observedAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[1].kind).toBe("SNAPSHOT");
  });

  it("does not record snapshots when the cadence is disabled", async () => {
    const subscription = await createInStockSubscription();
    await db.monitoringSubscription.update({
      where: { id: subscription.id },
      data: { snapshotIntervalMinutes: 0 },
    });
    await processCheckJob({ subscriptionId: subscription.id });

    await db.listingObservation.updateMany({
      where: { retailerListingId: subscription.retailerListingId },
      data: { observedAt: new Date(Date.now() - 400 * 24 * 60 * 60_000) },
    });

    await processCheckJob({ subscriptionId: subscription.id });
    expect(
      await db.listingObservation.count({
        where: { retailerListingId: subscription.retailerListingId },
      }),
    ).toBe(1);
  });

  it("reports the previous state in the outcome", async () => {
    const subscription = await createInStockSubscription();
    mockRetailerStore.setPrice("in-stock", 25000);
    const outcome = await processCheckJob({ subscriptionId: subscription.id });

    expect(outcome.previous).toEqual({ availability: "IN_STOCK", priceMinor: 29999 });
    expect(outcome.current).toEqual({ availability: "IN_STOCK", priceMinor: 25000 });
  });

  it("records retryable errors and rethrows for BullMQ retries", async () => {
    const subscription = await createInStockSubscription();
    mockRetailerStore.setError("in-stock", { code: "NETWORK", message: "down" });

    await expect(
      processCheckJob({ subscriptionId: subscription.id }),
    ).rejects.toBeInstanceOf(RetailerNetworkError);

    const checks = await db.monitoringCheck.findMany({
      where: { subscriptionId: subscription.id },
    });
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("ERROR");
    expect(checks[0].errorCode).toBe("NETWORK");
  });

  it("records non-retryable errors without throwing", async () => {
    const subscription = await createInStockSubscription();
    mockRetailerStore.setError("in-stock", { code: "BLOCKED", message: "blocked" });

    const outcome = await processCheckJob({ subscriptionId: subscription.id });
    expect(outcome.success).toBe(false);
    expect(outcome.errorCode).toBe("BLOCKED");

    const checks = await db.monitoringCheck.findMany({
      where: { subscriptionId: subscription.id },
    });
    expect(checks[0].status).toBe("ERROR");
    expect(checks[0].errorCode).toBe("BLOCKED");
  });

  it("recovers after transient retailer errors", async () => {
    const subscription = await createInStockSubscription();
    mockRetailerStore.setError("in-stock", { code: "NETWORK", message: "down" });
    await expect(
      processCheckJob({ subscriptionId: subscription.id }),
    ).rejects.toBeInstanceOf(RetailerNetworkError);

    mockRetailerStore.setError("in-stock", undefined);
    const outcome = await processCheckJob({ subscriptionId: subscription.id });
    expect(outcome.success).toBe(true);
  });

  it("skips gracefully when the subscription no longer exists", async () => {
    const outcome = await processCheckJob({ subscriptionId: "missing" });
    expect(outcome.success).toBe(false);
    expect(outcome.errorCode).toBe("SUBSCRIPTION_NOT_FOUND");
  });

  it("does not notify or change state for UNKNOWN availability", async () => {
    const subscription = await createInStockSubscription();
    mockRetailerStore.setAvailability("in-stock", "UNKNOWN");
    const outcome = await processCheckJob({ subscriptionId: subscription.id });

    expect(outcome.success).toBe(true);
    expect(outcome.current.availability).toBe("UNKNOWN");
    const listing = await db.retailerListing.findUnique({
      where: { id: subscription.retailerListingId },
    });
    expect(listing?.currentAvailability).toBe("UNKNOWN");
  });

  it("supports a manually created subscription (target price, combined condition)", async () => {
    const userId = await createTestUser();
    const viaAdd = await addMonitoringSubscription({
      userId,
      url: mockProductUrl("price-drops"),
      condition: "BOTH",
      targetPriceMinor: 20000,
      intervalMinutes: 30,
    });
    expect(viaAdd.targetPriceMinor).toBe(20000);
    expect(viaAdd.condition).toBe("BOTH");

    const outcome = await processCheckJob({ subscriptionId: viaAdd.id });
    expect(outcome.current.priceMinor).toBe(14999);
  });
});

describe("mockRetailer", () => {
  it("is registered with the shared registry", () => {
    expect(mockRetailer.id).toBe("mock");
  });
  it("createSubscription is usable directly (repository level)", async () => {
    await resetTestState();
    const userId = await createTestUser();
    const { listing } = await createTestListing({
      retailerProductId: "direct",
      name: "Direct product",
      url: "https://mock-retailer.test/products/direct",
    });
    const subscription = await createSubscription({
      userId,
      retailerListingId: listing.id,
      condition: "BACK_IN_STOCK",
      intervalMinutes: 60,
    });
    expect(subscription.id).toBeTruthy();
    expect(await db.inventoryItem.count({ where: { userId } })).toBe(1);
  });
});

describe("marketplace not-found semantics (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
    mockRetailerStore.reset();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("records OUT_OF_STOCK when an adapter with treatNotFoundAsOutOfStock throws ProductNotFoundError", async () => {
    const { retailerRegistry } = await import("@/modules/retailers/core/retailer-registry");
    const { ProductNotFoundError } = await import("@/modules/retailers/core/errors");

    const testAdapter = {
      id: "marketplace-test",
      name: "Marketplace Test",
      supportedDomains: ["marketplace-test.example"],
      minCheckIntervalMs: 60_000,
      currency: "GBP",
      treatNotFoundAsOutOfStock: true,
      parseProductUrl(url: string) {
        return { retailerProductId: "gone", url };
      },
      async getProduct() {
        throw new ProductNotFoundError("marketplace-test", "gone");
      },
    };
    retailerRegistry.register(testAdapter);

    const userId = await createTestUser("market@example.com");
    const { listing } = await createTestListing({
      retailerId: "marketplace-test",
      retailerProductId: "gone",
      name: "One-off item",
      url: "https://marketplace-test.example/shop/gone",
      currentPriceMinor: 5000,
      currentAvailability: "IN_STOCK",
    });
    const subscription = await createSubscription({
      userId,
      retailerListingId: listing.id,
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });

    const outcome = await processCheckJob({ subscriptionId: subscription.id });

    expect(outcome.success).toBe(true);
    expect(outcome.current).toEqual({
      availability: "OUT_OF_STOCK",
      priceMinor: 5000,
    });

    const updated = await db.retailerListing.findUnique({
      where: { id: listing.id },
    });
    expect(updated?.currentAvailability).toBe("OUT_OF_STOCK");
    expect(updated?.delistedAt).not.toBeNull();
    // Name preserved from the stored listing.
    expect(updated?.name).toBe("One-off item");

    const checks = await db.monitoringCheck.findMany({
      where: { subscriptionId: subscription.id },
    });
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("SUCCESS");
    expect(checks[0].availability).toBe("OUT_OF_STOCK");

    // Availability transition was observed in the append-only history.
    const observations = await db.listingObservation.findMany({
      where: {
        retailerListingId: listing.id,
        availability: "OUT_OF_STOCK",
      },
    });
    expect(observations).toHaveLength(1);
    expect(observations[0].kind).toBe("CHANGE");
  });
});

describe("shared listing checks (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
    mockRetailerStore.reset();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("fetches a shared listing once and records a check for every active subscriber", async () => {
    const userA = await createTestUser("shared-a@example.com");
    const userB = await createTestUser("shared-b@example.com");
    const subscriptionA = await addMonitoringSubscription({
      userId: userA,
      url: mockProductUrl("in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });
    const subscriptionB = await addMonitoringSubscription({
      userId: userB,
      url: mockProductUrl("in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 60,
    });
    expect(subscriptionA.retailerListingId).toBe(
      subscriptionB.retailerListingId,
    );

    const spy = vi.spyOn(mockRetailer, "getProduct");
    mockRetailerStore.setPrice("in-stock", 25000);
    try {
      const run = await performListingCheck(
        subscriptionA.retailerListingId,
        { force: true },
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(run.outcomes.size).toBe(2);
    } finally {
      spy.mockRestore();
    }

    expect(
      await db.monitoringCheck.count({
        where: {
          retailerListingId: subscriptionA.retailerListingId,
          status: "SUCCESS",
        },
      }),
    ).toBe(2);
    expect(
      await db.listingObservation.count({
        where: {
          retailerListingId: subscriptionA.retailerListingId,
          kind: "CHANGE",
        },
      }),
    ).toBe(1);
  });

  it("reuses a newer shared check instead of fetching again", async () => {
    const userId = await createTestUser("shared-reuse@example.com");
    const subscription = await addMonitoringSubscription({
      userId,
      url: mockProductUrl("in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });

    const enqueuedAt = Date.now();
    await performListingCheck(subscription.retailerListingId, { force: true });

    const spy = vi.spyOn(mockRetailer, "getProduct");
    try {
      const reused = await performListingCheck(
        subscription.retailerListingId,
        { enqueuedAt },
      );
      expect(reused.success).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("serialises concurrent checks with the listing lease", async () => {
    const userId = await createTestUser("shared-lease@example.com");
    const subscription = await addMonitoringSubscription({
      userId,
      url: mockProductUrl("in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });

    const original = mockRetailer.getProduct.bind(mockRetailer);
    const spy = vi
      .spyOn(mockRetailer, "getProduct")
      .mockImplementation(async (url) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return original(url);
      });

    try {
      const [first, second] = await Promise.all([
        performListingCheck(subscription.retailerListingId, { force: true }),
        performListingCheck(subscription.retailerListingId, { force: true }),
      ]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
