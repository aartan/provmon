import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  computeDiscountPct,
  findOrCreateListing,
  getListingHistory,
  listListingObservations,
  updateListingFromCheck,
} from "@/modules/catalogue/catalogue.repository";
import {
  ensureInventoryItem,
  findInventoryItemForUser,
  listInventoryItemsForUser,
} from "@/modules/catalogue/inventory.repository";
import { createSubscription } from "@/modules/monitoring/repository";
import type { ProductDetails } from "@/modules/retailers/core/types";
import {
  createTestListing,
  createTestUser,
  resetTestState,
} from "@test/helpers/integration";

function listingDetails(
  overrides: Partial<ProductDetails> & { retailerProductId: string },
): ProductDetails {
  return {
    retailerId: "mock",
    name: `Product ${overrides.retailerProductId}`,
    url: `https://mock-retailer.test/products/${overrides.retailerProductId}`,
    currency: "GBP",
    availability: "IN_STOCK",
    lastUpdated: new Date(),
    ...overrides,
  };
}

describe("canonical product matching (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("groups listings by valid GTIN", async () => {
    const first = await findOrCreateListing(
      listingDetails({
        retailerProductId: "gtin-a",
        gtin: "4006381333931",
      }),
    );
    const second = await findOrCreateListing(
      listingDetails({
        retailerProductId: "gtin-b",
        gtin: "4006381 333931",
      }),
    );

    expect(second.canonicalProductId).toBe(first.canonicalProductId);
    expect(await db.canonicalProduct.count()).toBe(1);
    expect(await db.retailerListing.count()).toBe(2);
  });

  it("groups listings by normalised brand and MPN when no GTIN exists", async () => {
    const first = await findOrCreateListing(
      listingDetails({
        retailerProductId: "mpn-a",
        brand: "Apple",
        mpn: "A-2141",
      }),
    );
    const second = await findOrCreateListing(
      listingDetails({
        retailerProductId: "mpn-b",
        brand: " apple ",
        mpn: "a2141",
      }),
    );

    expect(second.canonicalProductId).toBe(first.canonicalProductId);
    expect(await db.canonicalProduct.count()).toBe(1);
  });

  it("creates separate canonical products without strong identifiers", async () => {
    const first = await findOrCreateListing(
      listingDetails({ retailerProductId: "no-ident-a" }),
    );
    const second = await findOrCreateListing(
      listingDetails({ retailerProductId: "no-ident-b" }),
    );

    expect(second.canonicalProductId).not.toBe(first.canonicalProductId);
    expect(await db.canonicalProduct.count()).toBe(2);
  });

  it("ignores invalid GTINs instead of merging unrelated listings", async () => {
    const first = await findOrCreateListing(
      listingDetails({
        retailerProductId: "invalid-gtin-a",
        gtin: "4006381333932",
      }),
    );
    const second = await findOrCreateListing(
      listingDetails({
        retailerProductId: "invalid-gtin-b",
        gtin: "4006381333932",
      }),
    );

    expect(second.canonicalProductId).not.toBe(first.canonicalProductId);
  });

  it("never silently moves an existing shared listing to another canonical product", async () => {
    const first = await findOrCreateListing(
      listingDetails({ retailerProductId: "stable", brand: "Acme", mpn: "ONE" }),
    );
    const again = await findOrCreateListing(
      listingDetails({
        retailerProductId: "stable",
        brand: "Other",
        mpn: "TWO",
        gtin: "4006381333931",
      }),
    );

    expect(again.id).toBe(first.id);
    expect(again.canonicalProductId).toBe(first.canonicalProductId);
    expect(await db.canonicalProduct.count()).toBe(1);
  });

  it("records original price and computes discounts from retailer RRP", async () => {
    const listing = await findOrCreateListing(
      listingDetails({
        retailerProductId: "sale",
        priceMinor: 7500,
        originalPriceMinor: 10000,
      }),
    );

    expect(listing.currentOriginalPriceMinor).toBe(10000);
    expect(listing.currentDiscountPct).toBe(25);

    const initialObservation = await db.listingObservation.findFirst({
      where: { retailerListingId: listing.id, kind: "INITIAL" },
    });
    expect(initialObservation?.originalPriceMinor).toBe(10000);
    expect(initialObservation?.discountPct).toBe(25);

    expect(computeDiscountPct(10000, 10000)).toBe(0);
    expect(computeDiscountPct(12000, 10000)).toBe(0);
    expect(computeDiscountPct(7500, null)).toBeNull();
  });
});

describe("inventory ownership (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("creates inventory items independently and scopes reads to the owner", async () => {
    const userA = await createTestUser("inventory-a@example.com");
    const userB = await createTestUser("inventory-b@example.com");
    const listing = await findOrCreateListing(
      listingDetails({ retailerProductId: "inventory" }),
    );

    const first = await ensureInventoryItem(
      userA,
      listing.canonicalProductId,
    );
    const second = await ensureInventoryItem(
      userA,
      listing.canonicalProductId,
    );
    expect(second.id).toBe(first.id);
    expect(await db.inventoryItem.count({ where: { userId: userA } })).toBe(1);

    const owned = await findInventoryItemForUser(first.id, userA);
    expect(owned?.canonicalProduct.id).toBe(listing.canonicalProductId);

    expect(await findInventoryItemForUser(first.id, userB)).toBeNull();
    expect(await listInventoryItemsForUser(userB)).toHaveLength(0);
  });

  it("does not delete inventory when a monitoring subscription is removed", async () => {
    const userId = await createTestUser("inventory-retain@example.com");
    const listing = await findOrCreateListing(
      listingDetails({ retailerProductId: "retain" }),
    );
    const inventory = await ensureInventoryItem(
      userId,
      listing.canonicalProductId,
    );
    const subscription = await db.monitoringSubscription.create({
      data: {
        userId,
        retailerListingId: listing.id,
        condition: "BACK_IN_STOCK",
        intervalMinutes: 60,
      },
    });

    await db.monitoringSubscription.delete({
      where: { id: subscription.id },
    });

    expect(await db.inventoryItem.count({ where: { userId } })).toBe(1);
    expect(await findInventoryItemForUser(inventory.id, userId)).not.toBeNull();
    expect(await db.retailerListing.count()).toBe(1);
    expect(await db.canonicalProduct.count()).toBe(1);
  });
});

describe("listing observation engine (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("creates one baseline observation and no unchanged duplicate rows", async () => {
    const { listing } = await createTestListing({
      retailerProductId: "obs-baseline",
      currentPriceMinor: 1000,
    });

    const first = await updateListingFromCheck(
      listing.id,
      listingDetails({ retailerProductId: "obs-baseline", priceMinor: 1000 }),
    );
    expect(first.observation?.kind).toBe("SNAPSHOT");

    const second = await updateListingFromCheck(
      listing.id,
      listingDetails({ retailerProductId: "obs-baseline", priceMinor: 1000 }),
    );
    expect(second.observation).toBeNull();
    expect(
      await db.listingObservation.count({
        where: { retailerListingId: listing.id },
      }),
    ).toBe(1);
  });

  it("serialises concurrent changes and records exactly one transition", async () => {
    const { listing } = await createTestListing({
      retailerProductId: "obs-lock",
      currentPriceMinor: 1000,
    });
    await updateListingFromCheck(
      listing.id,
      listingDetails({ retailerProductId: "obs-lock", priceMinor: 1000 }),
    );

    const details = listingDetails({
      retailerProductId: "obs-lock",
      priceMinor: 2000,
    });
    await Promise.all([
      updateListingFromCheck(listing.id, details),
      updateListingFromCheck(listing.id, details),
    ]);

    const changes = await db.listingObservation.findMany({
      where: { retailerListingId: listing.id, kind: "CHANGE" },
    });
    expect(changes).toHaveLength(1);
    expect(changes[0].priceMinor).toBe(2000);
  });

  it("uses the finest positive snapshot cadence among active subscribers", async () => {
    const firstUser = await createTestUser("snapshot-a@example.com");
    const secondUser = await createTestUser("snapshot-b@example.com");
    const { listing } = await createTestListing({
      retailerProductId: "obs-cadence",
      currentPriceMinor: 1000,
    });
    await createSubscription({
      userId: firstUser,
      retailerListingId: listing.id,
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
      snapshotIntervalMinutes: 1440,
    });
    await createSubscription({
      userId: secondUser,
      retailerListingId: listing.id,
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
      snapshotIntervalMinutes: 360,
    });

    await updateListingFromCheck(
      listing.id,
      listingDetails({ retailerProductId: "obs-cadence", priceMinor: 1000 }),
    );
    await db.listingObservation.updateMany({
      where: { retailerListingId: listing.id },
      data: { observedAt: new Date(Date.now() - 361 * 60_000) },
    });

    const result = await updateListingFromCheck(
      listing.id,
      listingDetails({ retailerProductId: "obs-cadence", priceMinor: 1000 }),
    );
    expect(result.observation?.kind).toBe("SNAPSHOT");
  });

  it("projects change-only history without redundant snapshots", async () => {
    const { listing } = await createTestListing({
      retailerProductId: "obs-history",
      currentPriceMinor: 1000,
    });

    await updateListingFromCheck(
      listing.id,
      listingDetails({ retailerProductId: "obs-history", priceMinor: 1000 }),
    );
    await db.listingObservation.updateMany({
      where: { retailerListingId: listing.id },
      data: { observedAt: new Date(Date.now() - 16 * 60_000) },
    });
    await updateListingFromCheck(
      listing.id,
      listingDetails({ retailerProductId: "obs-history", priceMinor: 1000 }),
      { snapshotIntervalMinutes: 15 },
    );
    await updateListingFromCheck(
      listing.id,
      listingDetails({ retailerProductId: "obs-history", priceMinor: 900 }),
    );

    const history = await getListingHistory(listing.id);
    expect(history.priceObservations.map((point) => point.priceMinor)).toEqual([
      1000, 900,
    ]);
    expect(history.availabilityObservations).toHaveLength(1);
    expect(await listListingObservations(listing.id)).toHaveLength(3);
  });

  it("marks a disappeared listing without deleting its history", async () => {
    const { listing } = await createTestListing({
      retailerProductId: "obs-delisted",
      currentPriceMinor: 1000,
      currentAvailability: "IN_STOCK",
    });
    await updateListingFromCheck(
      listing.id,
      listingDetails({ retailerProductId: "obs-delisted", priceMinor: 1000 }),
    );

    await updateListingFromCheck(
      listing.id,
      listingDetails({
        retailerProductId: "obs-delisted",
        priceMinor: undefined,
        availability: "OUT_OF_STOCK",
      }),
      { delisted: true },
    );

    const stored = await db.retailerListing.findUnique({
      where: { id: listing.id },
    });
    expect(stored?.delistedAt).not.toBeNull();
    expect(stored?.currentAvailability).toBe("OUT_OF_STOCK");
    expect(
      await db.listingObservation.count({
        where: { retailerListingId: listing.id },
      }),
    ).toBe(2);

    await updateListingFromCheck(
      listing.id,
      listingDetails({
        retailerProductId: "obs-delisted",
        priceMinor: 1000,
        availability: "IN_STOCK",
      }),
    );
    const renewed = await db.retailerListing.findUnique({
      where: { id: listing.id },
    });
    expect(renewed?.delistedAt).toBeNull();
    expect(renewed?.lastSeenAt).not.toBeNull();
  });
});
