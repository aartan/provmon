import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  resumeCatalogueDiscovery,
  processCatalogueDiscoveryStep,
  startCatalogueDiscovery,
  sweepDueCatalogues,
} from "@/modules/catalogue/discovery.service";
import {
  delistUnseenCatalogueListings,
  importCataloguePage,
} from "@/modules/catalogue/discovery.importer";
import { findActiveDiscoveryRun } from "@/modules/catalogue/discovery.repository";
import {
  browseCatalogue,
  findCatalogueListing,
  getCatalogueListingHistory,
} from "@/modules/catalogue/browse.repository";
import {
  addCatalogueListingsToInventory,
  addCatalogueListingsToMonitoring,
} from "@/modules/catalogue/catalogue.service";
import {
  listRetailerAdminViews,
  updateRetailerDiscoverySettings,
} from "@/modules/catalogue/retailer-admin.service";
import { registerTestMockRetailer } from "@/modules/retailers/testing";
import { mockRetailerStore } from "@/modules/retailers/testing/mock";
import type { ProductDetails } from "@/modules/retailers/core/types";
import {
  createTestUser,
  resetTestState,
} from "@test/helpers/integration";

function details(
  sku: string,
  overrides: Partial<ProductDetails> = {},
): ProductDetails {
  return {
    retailerId: "mock",
    retailerProductId: sku,
    sku,
    name: `Catalogue ${sku}`,
    url: `https://mock-retailer.test/products/${sku}`,
    currency: "GBP",
    priceMinor: 1000,
    availability: "IN_STOCK",
    lastUpdated: new Date(),
    ...overrides,
  };
}

describe("catalogue discovery importer (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("creates listings, canonical products, and one baseline observation", async () => {
    const result = await importCataloguePage({
      retailerId: "mock",
      items: [
        details("one", { gtin: "4006381333931" }),
        details("two", { brand: "Acme", mpn: "ACME-2", category: "Laptops" }),
      ],
      seenAt: new Date(),
    });

    expect(result.itemsSeen).toBe(2);
    expect(result.itemsCreated).toBe(2);
    expect(await db.retailerListing.count({ where: { retailerId: "mock" } })).toBe(2);
    expect(await db.canonicalProduct.count()).toBe(2);
    expect(
      await db.listingObservation.count({ where: { kind: "INITIAL" } }),
    ).toBe(2);

    const listing = await db.retailerListing.findFirst({
      where: { retailerId: "mock", retailerProductId: "two" },
    });
    expect(listing?.category).toBe("Laptops");
    expect(listing?.brand).toBe("Acme");
    expect(listing?.catalogueDiscoveredAt).not.toBeNull();
  });

  it("records a change observation only when the price changes", async () => {
    const firstSeen = new Date(Date.now() - 60_000);
    await importCataloguePage({
      retailerId: "mock",
      items: [details("stable", { priceMinor: 1000 })],
      seenAt: firstSeen,
    });
    const initial = await db.retailerListing.findFirstOrThrow({
      where: { retailerId: "mock", retailerProductId: "stable" },
    });

    const secondSeen = new Date();
    const unchanged = await importCataloguePage({
      retailerId: "mock",
      items: [details("stable", { priceMinor: 1000 })],
      seenAt: secondSeen,
    });
    expect(unchanged.itemsUnchanged).toBe(1);
    expect(
      await db.listingObservation.count({
        where: { retailerListingId: initial.id },
      }),
    ).toBe(1);

    // An unchanged repeat still records the catalogue sighting, otherwise a
    // later full refresh would delist the whole stable catalogue.
    const sighted = await db.retailerListing.findUniqueOrThrow({
      where: { id: initial.id },
    });
    expect(sighted.lastCatalogueSeenAt?.getTime()).toBe(secondSeen.getTime());

    const changed = await importCataloguePage({
      retailerId: "mock",
      items: [details("stable", { priceMinor: 800 })],
      seenAt: new Date(),
    });
    expect(changed.itemsUpdated).toBe(1);
    expect(changed.priceChanges).toBe(1);

    const observations = await db.listingObservation.findMany({
      where: { retailerListingId: initial.id },
      orderBy: { observedAt: "asc" },
    });
    expect(observations.map((row) => row.priceMinor)).toEqual([1000, 800]);
    expect(observations[1]?.kind).toBe("CHANGE");
  });

  it("leaves monitored listings to their own checks while recording the sighting", async () => {
    await importCataloguePage({
      retailerId: "mock",
      items: [details("protected", { priceMinor: 1000 })],
      seenAt: new Date(Date.now() - 60_000),
    });
    const listing = await db.retailerListing.findFirstOrThrow({
      where: { retailerId: "mock", retailerProductId: "protected" },
    });
    const userId = await createTestUser("discovery-protected@example.com");
    await db.monitoringSubscription.create({
      data: {
        userId,
        retailerListingId: listing.id,
        condition: "BACK_IN_STOCK",
        intervalMinutes: 15,
      },
    });

    const seenAt = new Date();
    const result = await importCataloguePage({
      retailerId: "mock",
      items: [details("protected", { priceMinor: 700 })],
      seenAt,
    });

    expect(result.itemsUnchanged).toBe(1);
    expect(result.priceChanges).toBe(0);
    const stored = await db.retailerListing.findUniqueOrThrow({
      where: { id: listing.id },
    });
    expect(stored.currentPriceMinor).toBe(1000);
    expect(stored.lastCatalogueSeenAt?.getTime()).toBe(seenAt.getTime());
    expect(
      await db.listingObservation.count({
        where: { retailerListingId: listing.id },
      }),
    ).toBe(1);
  });

  it("ignores out-of-range prices instead of failing the page", async () => {
    const result = await importCataloguePage({
      retailerId: "mock",
      items: [
        details("overflow", {
          priceMinor: 99_999_999_990_000,
          originalPriceMinor: 99_999_999_990_000,
        }),
      ],
      seenAt: new Date(),
    });

    expect(result.itemsCreated).toBe(1);
    const listing = await db.retailerListing.findFirstOrThrow({
      where: { retailerId: "mock", retailerProductId: "overflow" },
    });
    expect(listing.currentPriceMinor).toBeNull();
    expect(listing.currentOriginalPriceMinor).toBeNull();
    const observations = await db.listingObservation.findMany({
      where: { retailerListingId: listing.id },
    });
    expect(observations).toHaveLength(1);
    expect(observations[0]?.priceMinor).toBeNull();
  });

  it("keeps the existing price when a refresh sends an invalid value", async () => {
    await importCataloguePage({
      retailerId: "mock",
      items: [details("invalid-refresh", { priceMinor: 1200 })],
      seenAt: new Date(Date.now() - 60_000),
    });
    const listing = await db.retailerListing.findFirstOrThrow({
      where: { retailerId: "mock", retailerProductId: "invalid-refresh" },
    });

    const result = await importCataloguePage({
      retailerId: "mock",
      items: [details("invalid-refresh", { priceMinor: 99_999_999_990_000 })],
      seenAt: new Date(),
    });
    expect(result.itemsUnchanged).toBe(1);
    const stored = await db.retailerListing.findUniqueOrThrow({
      where: { id: listing.id },
    });
    expect(stored.currentPriceMinor).toBe(1200);
    expect(
      await db.listingObservation.count({
        where: { retailerListingId: listing.id },
      }),
    ).toBe(1);
  });

  it("repairs a listing whose baseline observation was lost", async () => {
    await importCataloguePage({
      retailerId: "mock",
      items: [details("repair-me", { priceMinor: 1200 })],
      seenAt: new Date(Date.now() - 60_000),
    });
    const listing = await db.retailerListing.findFirstOrThrow({
      where: { retailerId: "mock", retailerProductId: "repair-me" },
    });
    await db.listingObservation.deleteMany({
      where: { retailerListingId: listing.id },
    });

    await importCataloguePage({
      retailerId: "mock",
      items: [details("repair-me", { priceMinor: 1200 })],
      seenAt: new Date(),
    });

    const repaired = await db.listingObservation.findMany({
      where: { retailerListingId: listing.id },
    });
    expect(repaired).toHaveLength(1);
    expect(repaired[0]?.kind).toBe("INITIAL");
    expect(repaired[0]?.priceMinor).toBe(1200);
  });

  it("skips mass delisting when a completed refresh saw no products", async () => {
    await importCataloguePage({
      retailerId: "mock",
      items: [details("guard-a"), details("guard-b")],
      seenAt: new Date(Date.now() - 60_000),
    });

    const delisted = await delistUnseenCatalogueListings({
      retailerId: "mock",
      runStartedAt: new Date(),
      itemsSeen: 0,
    });
    expect(delisted).toBe(0);
    expect(
      await db.retailerListing.count({
        where: { retailerId: "mock", delistedAt: null },
      }),
    ).toBe(2);
  });

  it("delists unseen listings without deleting history and skips monitored listings", async () => {
    const firstSeen = new Date(Date.now() - 60_000);
    await importCataloguePage({
      retailerId: "mock",
      items: [
        details("gone", { priceMinor: 1200 }),
        details("protected-gone", { priceMinor: 1500 }),
      ],
      seenAt: firstSeen,
    });
    const gone = await db.retailerListing.findFirstOrThrow({
      where: { retailerId: "mock", retailerProductId: "gone" },
    });
    const protectedGone = await db.retailerListing.findFirstOrThrow({
      where: { retailerId: "mock", retailerProductId: "protected-gone" },
    });
    const userId = await createTestUser("discovery-delist@example.com");
    await db.monitoringSubscription.create({
      data: {
        userId,
        retailerListingId: protectedGone.id,
        condition: "BACK_IN_STOCK",
        intervalMinutes: 15,
      },
    });

    const runStartedAt = new Date();
    const delisted = await delistUnseenCatalogueListings({
      retailerId: "mock",
      runStartedAt,
      itemsSeen: 1,
    });
    expect(delisted).toBe(1);

    const storedGone = await db.retailerListing.findUniqueOrThrow({
      where: { id: gone.id },
    });
    expect(storedGone.delistedAt).not.toBeNull();
    expect(storedGone.currentAvailability).toBe("OUT_OF_STOCK");

    const storedProtected = await db.retailerListing.findUniqueOrThrow({
      where: { id: protectedGone.id },
    });
    expect(storedProtected.delistedAt).toBeNull();
    expect(storedProtected.currentAvailability).toBe("IN_STOCK");

    const history = await db.listingObservation.findMany({
      where: { retailerListingId: gone.id },
      orderBy: { observedAt: "asc" },
    });
    expect(history).toHaveLength(2);
    expect(history[1]?.availability).toBe("OUT_OF_STOCK");
    expect(history[1]?.kind).toBe("CHANGE");
  });
});

describe("catalogue discovery run (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
    mockRetailerStore.clear();
    registerTestMockRetailer();
  });

  afterAll(async () => {
    mockRetailerStore.clear();
    await resetTestState();
  });

  it("completes an initial run and a refresh that delists removed products", async () => {
    mockRetailerStore.set("run-a", {
      name: "Run product A",
      currency: "GBP",
      priceMinor: 1000,
      availability: "IN_STOCK",
      brand: "Acme",
      sku: "run-a",
    });
    mockRetailerStore.set("run-b", {
      name: "Run product B",
      currency: "GBP",
      priceMinor: 2000,
      availability: "IN_STOCK",
      sku: "run-b",
    });

    const run = await startCatalogueDiscovery({
      retailerId: "mock",
      trigger: "MANUAL",
    });
    expect(run.mode).toBe("INITIAL");
    const result = await processCatalogueDiscoveryStep(run.id);
    expect(result.status).toBe("COMPLETED");

    const completed = await db.catalogueDiscoveryRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.itemsSeen).toBe(2);
    expect(completed.itemsCreated).toBe(2);
    expect(completed.pagesProcessed).toBe(1);
    expect(await db.retailerListing.count({ where: { retailerId: "mock" } })).toBe(2);

    const catalogue = await db.retailerCatalogue.findUniqueOrThrow({
      where: { retailerId: "mock" },
    });
    expect(catalogue.lastSuccessfulRunAt).not.toBeNull();

    // A stable daily refresh must not delist unchanged products.
    const stableRefresh = await startCatalogueDiscovery({
      retailerId: "mock",
      trigger: "SCHEDULED",
    });
    expect(stableRefresh.mode).toBe("REFRESH");
    await processCatalogueDiscoveryStep(stableRefresh.id);
    expect(
      await db.retailerListing.count({
        where: { retailerId: "mock", delistedAt: null },
      }),
    ).toBe(2);

    mockRetailerStore.setPrice("run-a", 800);
    mockRetailerStore.delete("run-b");
    const refresh = await startCatalogueDiscovery({
      retailerId: "mock",
      trigger: "MANUAL",
      forceRefresh: true,
    });
    expect(refresh.mode).toBe("REFRESH");
    const refreshResult = await processCatalogueDiscoveryStep(refresh.id);
    expect(refreshResult.status).toBe("COMPLETED");

    const listingA = await db.retailerListing.findFirstOrThrow({
      where: { retailerId: "mock", retailerProductId: "run-a" },
    });
    expect(listingA.currentPriceMinor).toBe(800);
    expect(listingA.delistedAt).toBeNull();

    const listingB = await db.retailerListing.findFirstOrThrow({
      where: { retailerId: "mock", retailerProductId: "run-b" },
    });
    expect(listingB.delistedAt).not.toBeNull();
    expect(
      await db.listingObservation.count({
        where: { retailerListingId: listingB.id },
      }),
    ).toBeGreaterThanOrEqual(2);
  });

  it("resumes a multi-page run from the persisted cursor and keeps totals", async () => {
    for (let index = 0; index < 55; index += 1) {
      mockRetailerStore.set(`multi-${index}`, {
        name: `Multi product ${String(index).padStart(2, "0")}`,
        currency: "GBP",
        priceMinor: 1000 + index,
        availability: "IN_STOCK",
        sku: `multi-${index}`,
      });
    }

    const run = await startCatalogueDiscovery({
      retailerId: "mock",
      trigger: "MANUAL",
    });

    const first = await processCatalogueDiscoveryStep(run.id);
    expect(first.status).toBe("RUNNING");
    expect(first.nextCursor).not.toBeNull();

    const midway = await db.catalogueDiscoveryRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(midway.status).toBe("RUNNING");
    expect(midway.pagesProcessed).toBe(1);
    expect(midway.itemsSeen).toBe(50);

    // A fresh worker reads the cursor and revision from the database rather
    // than relying on in-memory state.
    const second = await processCatalogueDiscoveryStep(run.id);
    expect(second.status).toBe("COMPLETED");

    const completed = await db.catalogueDiscoveryRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(completed.pagesProcessed).toBe(2);
    expect(completed.itemsSeen).toBe(55);
    expect(completed.itemsCreated).toBe(55);
    expect(completed.totalEstimate).toBe(55);
    expect(
      await db.retailerListing.count({ where: { retailerId: "mock" } }),
    ).toBe(55);
  });

  it("resumes a failed run from its saved cursor and counters", async () => {
    for (let index = 0; index < 55; index += 1) {
      mockRetailerStore.set(`resume-${index}`, {
        name: `Resume product ${String(index).padStart(2, "0")}`,
        currency: "GBP",
        priceMinor: 1000 + index,
        availability: "IN_STOCK",
        sku: `resume-${index}`,
      });
    }

    const run = await startCatalogueDiscovery({
      retailerId: "mock",
      trigger: "MANUAL",
    });
    const first = await processCatalogueDiscoveryStep(run.id);
    expect(first.status).toBe("RUNNING");
    expect((await findActiveDiscoveryRun("mock"))?.itemsSeen).toBe(50);

    await db.catalogueDiscoveryRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        error: "simulated failure",
        finishedAt: new Date(),
      },
    });

    const adminView = (await listRetailerAdminViews()).find(
      (view) => view.id === "mock",
    );
    expect(adminView?.latestRun?.resumable).toBe(true);

    const resumed = await resumeCatalogueDiscovery("mock");
    expect(resumed.id).toBe(run.id);
    expect(resumed.status).toBe("QUEUED");
    expect(resumed.revision).toBe(run.revision + 1);
    expect(resumed.itemsSeen).toBe(50);

    const second = await processCatalogueDiscoveryStep(run.id);
    expect(second.status).toBe("COMPLETED");

    const completed = await db.catalogueDiscoveryRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(completed.itemsSeen).toBe(55);
    expect(completed.itemsCreated).toBe(55);
    expect(
      await db.retailerListing.count({ where: { retailerId: "mock" } }),
    ).toBe(55);
  });

  it("rejects resume when no failed run exists", async () => {
    await expect(resumeCatalogueDiscovery("mock")).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("runs the full enable → discover → browse → history → monitor flow", async () => {
    const userId = await createTestUser("catalogue-flow@example.com");
    mockRetailerStore.set("flow-a", {
      name: "Flow product A",
      currency: "GBP",
      priceMinor: 2500,
      originalPriceMinor: 3000,
      availability: "IN_STOCK",
      brand: "Acme",
      sku: "flow-a",
    });
    mockRetailerStore.set("flow-b", {
      name: "Flow product B",
      currency: "GBP",
      priceMinor: 900,
      availability: "OUT_OF_STOCK",
      brand: "Borealis",
      sku: "flow-b",
    });

    // Enabling discovery makes the retailer due for the next sweep.
    await updateRetailerDiscoverySettings("mock", {
      discoveryEnabled: true,
      refreshIntervalHours: 24,
    });
    const sweep = await sweepDueCatalogues();
    expect(sweep.started).toBe(1);

    const run = await findActiveDiscoveryRun("mock");
    expect(run?.trigger).toBe("SCHEDULED");
    expect(run?.mode).toBe("INITIAL");
    const result = await processCatalogueDiscoveryStep(run!.id);
    expect(result.status).toBe("COMPLETED");

    const catalogue = await db.retailerCatalogue.findUniqueOrThrow({
      where: { retailerId: "mock" },
    });
    expect(catalogue.lastSuccessfulRunAt).not.toBeNull();
    expect(catalogue.nextRefreshAt).not.toBeNull();

    const browse = await browseCatalogue(
      { retailerId: "mock", sort: "price_asc" },
      userId,
    );
    expect(browse.total).toBe(2);
    expect(browse.items.map((item) => item.name)).toEqual([
      "Flow product B",
      "Flow product A",
    ]);
    expect(browse.items[0]?.currentDiscountPct).toBeNull();

    const productA = browse.items.find((item) => item.name === "Flow product A");
    expect(productA?.currentDiscountPct).toBe(17);

    const history = await getCatalogueListingHistory(productA!.id, "90d");
    expect(history?.stats.hasData).toBe(true);
    expect(history?.stats.currentPriceMinor).toBe(2500);

    const inventory = await addCatalogueListingsToInventory(userId, [
      productA!.id,
    ]);
    expect(inventory.addedProducts).toBe(1);
    const monitoring = await addCatalogueListingsToMonitoring(userId, [
      productA!.id,
    ]);
    expect(monitoring.added).toBe(1);

    const detail = await findCatalogueListing(productA!.id, userId);
    expect(detail?.subscription?.status).toBe("ACTIVE");
    expect(detail?.subscription?.intervalMinutes).toBe(15);
    expect(detail?.inventoryItemId).not.toBeNull();
  });
});
