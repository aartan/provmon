import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  addCatalogueListingsToInventory,
  addCatalogueListingsToMonitoring,
  CatalogueServiceError,
} from "@/modules/catalogue/catalogue.service";
import { registerTestMockRetailer } from "@/modules/retailers/testing";
import {
  createTestListing,
  createTestUser,
  resetTestState,
} from "@test/helpers/integration";

describe("catalogue bulk actions (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
    registerTestMockRetailer();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("saves one inventory item per canonical product and is idempotent", async () => {
    const userId = await createTestUser("bulk-inventory@example.com");
    const first = await createTestListing({
      retailerId: "mock",
      retailerProductId: "inventory-a",
    });
    const second = await createTestListing({
      retailerId: "mock",
      retailerProductId: "inventory-b",
      canonicalProductId: first.canonicalProduct.id,
    });
    const third = await createTestListing({
      retailerId: "mock",
      retailerProductId: "inventory-c",
    });

    const result = await addCatalogueListingsToInventory(userId, [
      first.listing.id,
      second.listing.id,
      third.listing.id,
    ]);
    expect(result).toEqual({
      requestedListings: 3,
      trackedProducts: 2,
      addedProducts: 2,
      alreadyTrackedProducts: 0,
    });
    expect(await db.inventoryItem.count({ where: { userId } })).toBe(2);

    const again = await addCatalogueListingsToInventory(userId, [
      first.listing.id,
      third.listing.id,
    ]);
    expect(again.addedProducts).toBe(0);
    expect(again.alreadyTrackedProducts).toBe(2);
    expect(await db.inventoryItem.count({ where: { userId } })).toBe(2);
  });

  it("starts independent monitoring for multiple users and skips active rules", async () => {
    const userA = await createTestUser("bulk-monitor-a@example.com");
    const userB = await createTestUser("bulk-monitor-b@example.com");
    const first = await createTestListing({
      retailerId: "mock",
      retailerProductId: "monitor-a",
      currentPriceMinor: 1000,
    });
    const second = await createTestListing({
      retailerId: "mock",
      retailerProductId: "monitor-b",
      currentPriceMinor: 2000,
    });
    const listingIds = [first.listing.id, second.listing.id];

    const initial = await addCatalogueListingsToMonitoring(userA, listingIds);
    expect(initial.added).toBe(2);
    expect(initial.failed).toHaveLength(0);
    expect(
      await db.monitoringSubscription.count({ where: { userId: userA } }),
    ).toBe(2);
    const created = await db.monitoringSubscription.findMany({
      where: { userId: userA },
    });
    expect(created.every((row) => row.intervalMinutes === 15)).toBe(true);
    expect(created.every((row) => row.condition === "BACK_IN_STOCK")).toBe(true);

    const repeat = await addCatalogueListingsToMonitoring(userA, listingIds);
    expect(repeat.added).toBe(0);
    expect(repeat.skipped).toBe(2);

    const paused = created[0];
    await db.monitoringSubscription.update({
      where: { id: paused.id },
      data: {
        status: "PAUSED",
        condition: "PRICE_DROP",
        targetPriceMinor: 900,
      },
    });
    const resumed = await addCatalogueListingsToMonitoring(userA, listingIds);
    expect(resumed.resumed).toBe(1);
    expect(resumed.skipped).toBe(1);
    const resumedRow = await db.monitoringSubscription.findUniqueOrThrow({
      where: { id: paused.id },
    });
    expect(resumedRow.status).toBe("ACTIVE");
    // Bulk resume keeps the condition and target the user configured.
    expect(resumedRow.condition).toBe("PRICE_DROP");
    expect(resumedRow.targetPriceMinor).toBe(900);

    const otherUser = await addCatalogueListingsToMonitoring(
      userB,
      listingIds,
      { targetPriceMinor: 900 },
    );
    expect(otherUser.added).toBe(2);
    expect(
      await db.monitoringSubscription.count({ where: { userId: userB } }),
    ).toBe(2);
    expect(
      await db.monitoringSubscription.count({ where: { userId: userA } }),
    ).toBe(2);
  });

  it("validates conditions, intervals, and selected listings", async () => {
    const userId = await createTestUser("bulk-validation@example.com");
    const { listing } = await createTestListing({
      retailerId: "mock",
      retailerProductId: "validation",
    });

    await expect(
      addCatalogueListingsToMonitoring(userId, [listing.id], {
        condition: "PRICE_DROP",
      }),
    ).rejects.toBeInstanceOf(CatalogueServiceError);

    await expect(
      addCatalogueListingsToMonitoring(userId, [listing.id], {
        intervalMinutes: 7,
      }),
    ).rejects.toBeInstanceOf(CatalogueServiceError);

    await expect(
      addCatalogueListingsToMonitoring(userId, ["missing-listing"]),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      addCatalogueListingsToInventory(userId, []),
    ).rejects.toBeInstanceOf(CatalogueServiceError);
  });
});
