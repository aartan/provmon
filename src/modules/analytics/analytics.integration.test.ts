import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  getListingAnalytics,
  getProductIntelligence,
} from "@/modules/analytics/analytics.repository";
import { updateListingFromCheck } from "@/modules/catalogue/catalogue.repository";
import { ensureInventoryItem } from "@/modules/catalogue/inventory.repository";
import type { AvailabilityStatus } from "@/modules/retailers/core/types";
import {
  createTestListing,
  createTestUser,
  resetTestState,
} from "@test/helpers/integration";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-06-01T00:00:00.000Z");

async function seedObservation(
  retailerListingId: string,
  daysAgo: number,
  priceMinor: number | null,
  overrides: {
    originalPriceMinor?: number | null;
    currency?: string | null;
    availability?: AvailabilityStatus | null;
  } = {},
): Promise<void> {
  await db.listingObservation.create({
    data: {
      retailerListingId,
      priceMinor,
      originalPriceMinor: overrides.originalPriceMinor ?? null,
      discountPct: null,
      currency:
        overrides.currency === undefined ? "GBP" : overrides.currency,
      availability:
        overrides.availability === undefined
          ? "IN_STOCK"
          : overrides.availability,
      kind: "SNAPSHOT",
      observedAt: new Date(NOW.getTime() - daysAgo * DAY_MS),
    },
  });
}

describe("analytics repository (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("computes listing metrics from stored observation history", async () => {
    const { listing } = await createTestListing({
      retailerProductId: "analytics-a",
      currentPriceMinor: 1200,
      currency: "GBP",
    });

    await seedObservation(listing.id, 40, 1000, {
      originalPriceMinor: 1200,
    });
    await seedObservation(listing.id, 20, 800, {
      originalPriceMinor: 800,
    });
    await seedObservation(listing.id, 19, 800, {
      originalPriceMinor: 800,
    });
    await seedObservation(listing.id, 5, 1200, {
      originalPriceMinor: 1200,
    });
    await seedObservation(listing.id, 1, 1200, {
      originalPriceMinor: 1200,
    });

    const analytics = await getListingAnalytics(listing.id, { now: NOW });
    expect(analytics).not.toBeNull();
    expect(analytics?.byCurrency).toHaveLength(1);
    expect(analytics?.byCurrency[0].currency).toBe("GBP");
    expect(analytics?.byCurrency[0].isCurrent).toBe(true);

    const monthly = analytics?.byCurrency[0].windows.find(
      (window) => window.windowDays === 30,
    );
    expect(monthly).toBeDefined();
    expect(monthly?.hasData).toBe(true);
    expect(monthly?.minPriceMinor).toBe(800);
    expect(monthly?.maxPriceMinor).toBe(1200);
    expect(monthly?.latestPriceMinor).toBe(1200);
    expect(monthly?.priceChangeCount).toBe(2);
    expect(monthly?.avgDaysBetweenChanges).toBeCloseTo(15, 5);
    expect(monthly?.trackedDurationMs).toBe(30 * DAY_MS);
    expect(monthly?.saleDataDurationMs).toBe(30 * DAY_MS);
    expect(monthly?.saleFrequencyPct).toBeCloseTo((10 / 30) * 100, 5);
  });

  it("returns null for a missing listing", async () => {
    expect(await getListingAnalytics("missing-listing")).toBeNull();
  });

  it("records sale state on new observations", async () => {
    const { listing } = await createTestListing({
      retailerProductId: "sale-fields",
      currentPriceMinor: 1000,
      currency: "GBP",
    });

    await updateListingFromCheck(listing.id, {
      retailerId: "mock",
      retailerProductId: "sale-fields",
      name: "Sale product",
      url: "https://mock-retailer.test/products/sale-fields",
      currency: "GBP",
      priceMinor: 750,
      originalPriceMinor: 1000,
      availability: "IN_STOCK",
      lastUpdated: new Date(),
    });

    const change = await db.listingObservation.findFirst({
      where: { retailerListingId: listing.id, kind: "CHANGE" },
    });
    expect(change?.originalPriceMinor).toBe(1000);
    expect(change?.discountPct).toBe(25);
  });

  it("consolidates product listings per currency without average prices", async () => {
    const first = await createTestListing({
      retailerId: "retailer-a",
      retailerProductId: "gbp-a",
      name: "GBP listing A",
      currency: "GBP",
      currentPriceMinor: 900,
      currentAvailability: "IN_STOCK",
    });
    const canonicalProductId = first.canonicalProduct.id;

    const second = await createTestListing({
      canonicalProductId,
      retailerId: "retailer-b",
      retailerProductId: "gbp-b",
      name: "GBP listing B",
      currency: "GBP",
      currentPriceMinor: 800,
      currentAvailability: "IN_STOCK",
    });
    const third = await createTestListing({
      canonicalProductId,
      retailerId: "retailer-us",
      retailerProductId: "usd",
      name: "USD listing",
      currency: "USD",
      currentPriceMinor: 450,
      currentAvailability: "IN_STOCK",
    });

    await seedObservation(first.listing.id, 10, 1000);
    await seedObservation(first.listing.id, 2, 900);
    await seedObservation(second.listing.id, 10, 900);
    await seedObservation(second.listing.id, 2, 800);
    await seedObservation(third.listing.id, 10, 500, { currency: "USD" });
    await seedObservation(third.listing.id, 2, 450, { currency: "USD" });

    const intelligence = await getProductIntelligence(canonicalProductId, {
      now: NOW,
    });
    expect(intelligence).not.toBeNull();
    expect(intelligence?.listings).toHaveLength(3);

    const gbp = intelligence?.byCurrency.find(
      (currency) => currency.currency === "GBP",
    );
    const usd = intelligence?.byCurrency.find(
      (currency) => currency.currency === "USD",
    );
    expect(gbp).toBeDefined();
    expect(usd).toBeDefined();

    expect(gbp?.listingCount).toBe(2);
    expect(gbp?.inStockCount).toBe(2);
    expect(gbp?.bestCurrent?.listingId).toBe(second.listing.id);
    expect(gbp?.bestCurrent?.priceMinor).toBe(800);
    const gbpWindow30 = gbp?.lowestByWindow.find(
      (window) => window.windowDays === 30,
    );
    expect(gbpWindow30?.windowDays).toBe(30);
    expect(gbpWindow30?.priceMinor).toBe(800);
    expect(gbpWindow30?.listingId).toBe(second.listing.id);

    expect(usd?.listingCount).toBe(1);
    expect(usd?.bestCurrent?.listingId).toBe(third.listing.id);
    expect(usd?.bestCurrent?.priceMinor).toBe(450);
    expect(
      usd?.lowestByWindow.find((window) => window.windowDays === 30)
        ?.priceMinor,
    ).toBe(450);

    // Currencies never combine into a synthetic cross-currency best price.
    expect(gbp?.bestCurrent?.priceMinor).not.toBe(
      usd?.bestCurrent?.priceMinor,
    );
  });

  it("requires the user to have a subscription or inventory item for product intelligence", async () => {
    const { canonicalProduct } = await createTestListing({
      retailerProductId: "owned-intelligence",
      currentPriceMinor: 1000,
    });
    const owner = await createTestUser("analytics-owner@example.com");
    const stranger = await createTestUser("analytics-stranger@example.com");

    expect(
      await getProductIntelligence(canonicalProduct.id, {
        userId: owner,
        now: NOW,
      }),
    ).toBeNull();

    await ensureInventoryItem(owner, canonicalProduct.id);

    expect(
      await getProductIntelligence(canonicalProduct.id, {
        userId: owner,
        now: NOW,
      }),
    ).not.toBeNull();
    expect(
      await getProductIntelligence(canonicalProduct.id, {
        userId: stranger,
        now: NOW,
      }),
    ).toBeNull();
  });
});
