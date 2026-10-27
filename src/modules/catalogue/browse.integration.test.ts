import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  browseCatalogue,
  findCatalogueListing,
  getCatalogueFilterOptions,
  getCatalogueListingHistory,
  listCatalogueRetailers,
} from "@/modules/catalogue/browse.repository";
import { ensureInventoryItem } from "@/modules/catalogue/inventory.repository";
import { registerBuiltInAdapters } from "@/modules/retailers/adapters";
import {
  createTestListing,
  createTestUser,
  resetTestState,
} from "@test/helpers/integration";

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000);

async function seedCatalogue() {
  const laptopA = await createTestListing({
    retailerId: "mock",
    retailerProductId: "browse-laptop-a",
    name: "Atlas Laptop 14",
    brand: "Atlas",
    category: "Laptops",
    currentPriceMinor: 100_000,
    currentAvailability: "IN_STOCK",
  });
  const laptopB = await createTestListing({
    retailerId: "mock",
    retailerProductId: "browse-laptop-b",
    name: "Borealis Laptop 16",
    brand: "Borealis",
    category: "Laptops",
    currentPriceMinor: 80_000,
    currentAvailability: "OUT_OF_STOCK",
  });
  const phone = await createTestListing({
    retailerId: "mock",
    retailerProductId: "browse-phone",
    name: "Atlas Phone",
    brand: "Atlas",
    category: "Phones",
    currentPriceMinor: 50_000,
    currentAvailability: "IN_STOCK",
  });

  await db.retailerListing.updateMany({
    where: { id: laptopA.listing.id },
    data: { currentDiscountPct: 10 },
  });
  await db.retailerListing.updateMany({
    where: { id: laptopB.listing.id },
    data: { currentDiscountPct: 35 },
  });
  await db.retailerListing.updateMany({
    where: { id: phone.listing.id },
    data: { currentDiscountPct: 0 },
  });

  return { laptopA, laptopB, phone };
}

describe("catalogue browsing (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
    registerBuiltInAdapters();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("filters by search, category, brand, price, and stock", async () => {
    await seedCatalogue();

    const search = await browseCatalogue({
      retailerId: "mock",
      q: "laptop",
    });
    expect(search.total).toBe(2);

    const category = await browseCatalogue({
      retailerId: "mock",
      category: "Phones",
    });
    expect(category.items.map((item) => item.name)).toEqual(["Atlas Phone"]);

    const brand = await browseCatalogue({
      retailerId: "mock",
      brand: "Atlas",
    });
    expect(brand.total).toBe(2);

    const price = await browseCatalogue({
      retailerId: "mock",
      minPriceMinor: 60_000,
      maxPriceMinor: 90_000,
    });
    expect(price.items.map((item) => item.name)).toEqual([
      "Borealis Laptop 16",
    ]);

    const inStock = await browseCatalogue({
      retailerId: "mock",
      stock: "in",
    });
    expect(inStock.total).toBe(2);
    const outOfStock = await browseCatalogue({
      retailerId: "mock",
      stock: "out",
    });
    expect(outOfStock.items.map((item) => item.name)).toEqual([
      "Borealis Laptop 16",
    ]);
  });

  it("sorts by price and discount and hides delisted listings", async () => {
    const { laptopB } = await seedCatalogue();

    const byPrice = await browseCatalogue({
      retailerId: "mock",
      sort: "price_asc",
    });
    expect(byPrice.items.map((item) => item.currentPriceMinor)).toEqual([
      50_000, 80_000, 100_000,
    ]);

    const byDiscount = await browseCatalogue({
      retailerId: "mock",
      sort: "discount_desc",
    });
    expect(byDiscount.items[0]?.name).toBe("Borealis Laptop 16");

    await db.retailerListing.update({
      where: { id: laptopB.listing.id },
      data: { delistedAt: new Date() },
    });
    const visible = await browseCatalogue({ retailerId: "mock" });
    expect(visible.total).toBe(2);
    expect(visible.items.map((item) => item.name)).not.toContain(
      "Borealis Laptop 16",
    );
  });

  it("paginates with a stable total", async () => {
    for (let index = 0; index < 15; index += 1) {
      await createTestListing({
        retailerId: "mock",
        retailerProductId: `page-${index}`,
        name: `Page product ${String(index).padStart(2, "0")}`,
        currentPriceMinor: 1000 + index,
      });
    }

    const first = await browseCatalogue({
      retailerId: "mock",
      page: 1,
      pageSize: 12,
      sort: "name_asc",
    });
    expect(first.total).toBe(15);
    expect(first.totalPages).toBe(2);
    expect(first.items).toHaveLength(12);

    const second = await browseCatalogue({
      retailerId: "mock",
      page: 2,
      pageSize: 12,
      sort: "name_asc",
    });
    expect(second.items).toHaveLength(3);
    expect(second.items[0]?.name).toBe("Page product 12");
  });

  it("annotates only the requesting user's monitoring and inventory state", async () => {
    const { laptopA, phone } = await seedCatalogue();
    const userA = await createTestUser("browse-a@example.com");
    const userB = await createTestUser("browse-b@example.com");

    await db.monitoringSubscription.create({
      data: {
        userId: userA,
        retailerListingId: laptopA.listing.id,
        condition: "BACK_IN_STOCK",
        intervalMinutes: 15,
      },
    });
    await ensureInventoryItem(userA, phone.canonicalProduct.id);

    const forA = await browseCatalogue({ retailerId: "mock" }, userA);
    const laptopRow = forA.items.find(
      (item) => item.id === laptopA.listing.id,
    );
    expect(laptopRow?.monitored).toBe(true);
    expect(laptopRow?.inInventory).toBe(false);
    expect(laptopRow?.subscriptionStatus).toBe("ACTIVE");
    const phoneRow = forA.items.find((item) => item.id === phone.listing.id);
    expect(phoneRow?.inInventory).toBe(true);
    expect(phoneRow?.monitored).toBe(false);

    const forB = await browseCatalogue({ retailerId: "mock" }, userB);
    const otherRow = forB.items.find(
      (item) => item.id === laptopA.listing.id,
    );
    expect(otherRow?.monitored).toBe(false);
    expect(otherRow?.inInventory).toBe(false);
    expect(otherRow?.subscriptionId).toBeNull();
  });

  it("lists catalogue retailers with imports and filter options", async () => {
    await seedCatalogue();
    await db.retailerCatalogue.create({
      data: {
        retailerId: "mock",
        discoveryEnabled: true,
        refreshIntervalHours: 24,
      },
    });

    const retailers = await listCatalogueRetailers();
    const mock = retailers.find((retailer) => retailer.id === "mock");
    expect(mock?.productCount).toBe(3);
    expect(mock?.inStockCount).toBe(2);
    expect(mock?.supportsCatalogue).toBe(true);
    expect(mock?.discoveryEnabled).toBe(true);

    const options = await getCatalogueFilterOptions("mock");
    expect(options.categories).toEqual(["Laptops", "Phones"]);
    expect(options.brands).toEqual(["Atlas", "Borealis"]);
  });

  it("returns listing detail without exposing another user's subscription", async () => {
    const { laptopA } = await seedCatalogue();
    const owner = await createTestUser("detail-owner@example.com");
    const stranger = await createTestUser("detail-stranger@example.com");
    await ensureInventoryItem(owner, laptopA.canonicalProduct.id);
    await db.monitoringSubscription.create({
      data: {
        userId: owner,
        retailerListingId: laptopA.listing.id,
        condition: "PRICE_DROP",
        targetPriceMinor: 90_000,
        intervalMinutes: 15,
      },
    });

    const own = await findCatalogueListing(laptopA.listing.id, owner);
    expect(own?.subscription?.condition).toBe("PRICE_DROP");
    expect(own?.subscription?.targetPriceMinor).toBe(90_000);
    expect(own?.inventoryItemId).not.toBeNull();

    const other = await findCatalogueListing(laptopA.listing.id, stranger);
    expect(other?.subscription).toBeNull();
    expect(other?.inventoryItemId).toBeNull();
  });
});

describe("catalogue price history (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("uses a carry-in observation and computes range statistics", async () => {
    const { listing } = await createTestListing({
      retailerId: "mock",
      retailerProductId: "history",
      currentPriceMinor: 800,
    });

    await db.listingObservation.createMany({
      data: [
        {
          retailerListingId: listing.id,
          priceMinor: 1000,
          currency: "GBP",
          availability: "IN_STOCK",
          kind: "INITIAL",
          observedAt: daysAgo(100),
        },
        {
          retailerListingId: listing.id,
          priceMinor: 900,
          currency: "GBP",
          availability: "IN_STOCK",
          kind: "CHANGE",
          observedAt: daysAgo(40),
        },
        {
          retailerListingId: listing.id,
          priceMinor: 800,
          currency: "GBP",
          availability: "IN_STOCK",
          kind: "CHANGE",
          observedAt: daysAgo(2),
        },
      ],
    });

    const ninety = await getCatalogueListingHistory(listing.id, "90d");
    expect(ninety?.stats.hasData).toBe(true);
    expect(ninety?.stats.currentPriceMinor).toBe(800);
    expect(ninety?.stats.highestPriceMinor).toBe(1000);
    expect(ninety?.stats.lowestPriceMinor).toBe(800);
    expect(ninety?.stats.pointCount).toBe(3);
    // Carry-in plus two in-range changes, extended to the present.
    expect(ninety?.points.length).toBe(4);

    const seven = await getCatalogueListingHistory(listing.id, "7d");
    expect(seven?.stats.highestPriceMinor).toBe(900);
    expect(seven?.stats.lowestPriceMinor).toBe(800);
    expect(seven?.stats.pointCount).toBe(2);

    const all = await getCatalogueListingHistory(listing.id, "all");
    expect(all?.stats.pointCount).toBe(3);
    expect(all?.stats.highestPriceMinor).toBe(1000);
    expect(all?.stats.lowestPriceMinor).toBe(800);
  });

  it("returns null for an unknown listing", async () => {
    expect(
      await getCatalogueListingHistory("does-not-exist", "90d"),
    ).toBeNull();
  });
});
