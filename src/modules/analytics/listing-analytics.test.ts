import { describe, expect, it } from "vitest";

import { computeListingAnalytics } from "@/modules/analytics/listing-analytics";
import type { AnalyticsObservation } from "@/modules/analytics/types";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-06-01T00:00:00.000Z");

function observation(
  daysAgo: number,
  priceMinor: number | null,
  overrides: Partial<AnalyticsObservation> = {},
): AnalyticsObservation {
  return {
    priceMinor,
    originalPriceMinor: null,
    discountPct: null,
    currency: "GBP",
    availability: "IN_STOCK",
    observedAt: new Date(NOW.getTime() - daysAgo * DAY_MS),
    ...overrides,
  };
}

function compute(
  observations: AnalyticsObservation[],
  currentCurrency: string | null = "GBP",
) {
  return computeListingAnalytics({
    retailerListingId: "listing-1",
    observations,
    now: NOW,
    currentCurrency,
  });
}

function windowFor(
  result: ReturnType<typeof compute>,
  currency: string,
  windowDays: number,
) {
  const currencyAnalytics = result.byCurrency.find(
    (entry) => entry.currency === currency,
  );
  expect(currencyAnalytics, `currency ${currency}`).toBeDefined();
  const window = currencyAnalytics?.windows.find(
    (entry) => entry.windowDays === windowDays,
  );
  expect(window, `window ${windowDays}`).toBeDefined();
  return window!;
}

describe("computeListingAnalytics", () => {
  it("derives time-weighted metrics without counting snapshots as changes", () => {
    const result = compute([
      observation(40, 1000),
      observation(20, 800),
      observation(19, 800),
      observation(15, 800),
      observation(5, 1200),
      observation(1, 1200),
      observation(0, 1200),
    ]);

    expect(result.byCurrency).toHaveLength(1);
    expect(result.byCurrency[0].isCurrent).toBe(true);

    const monthly = windowFor(result, "GBP", 30);
    expect(monthly.hasData).toBe(true);
    expect(monthly.minPriceMinor).toBe(800);
    expect(monthly.maxPriceMinor).toBe(1200);
    expect(monthly.latestPriceMinor).toBe(1200);
    expect(monthly.priceChangeCount).toBe(2);
    expect(monthly.avgDaysBetweenChanges).toBeCloseTo(15, 5);
    expect(monthly.averagePriceMinor).toBeCloseTo(933.333, 2);
    expect(monthly.trackedDurationMs).toBe(30 * DAY_MS);
    expect(monthly.belowCurrentPct).toBeCloseTo((25 / 30) * 100, 5);
    expect(monthly.aboveCurrentPct).toBe(0);
    expect(monthly.atCurrentPct).toBeCloseTo((5 / 30) * 100, 5);
    expect(monthly.percentile).toBeCloseTo(((25 + 2.5) / 30) * 100, 5);
    expect(monthly.volatilityPct).not.toBeNull();
    expect(monthly.volatilityPct!).toBeGreaterThan(0);

    const quarterly = windowFor(result, "GBP", 90);
    expect(quarterly.trackedDurationMs).toBe(40 * DAY_MS);
    expect(quarterly.priceChangeCount).toBe(2);
    expect(quarterly.minPriceMinor).toBe(800);
    expect(quarterly.maxPriceMinor).toBe(1200);
  });

  it("handles a price held for the entire window with a carry-in observation", () => {
    const result = compute([observation(40, 1000)]);
    const monthly = windowFor(result, "GBP", 30);

    expect(monthly.hasData).toBe(true);
    expect(monthly.minPriceMinor).toBe(1000);
    expect(monthly.maxPriceMinor).toBe(1000);
    expect(monthly.priceChangeCount).toBe(0);
    expect(monthly.avgDaysBetweenChanges).toBeNull();
    expect(monthly.percentile).toBe(50);
    expect(monthly.aboveCurrentPct).toBe(0);
    expect(monthly.belowCurrentPct).toBe(0);
    expect(monthly.atCurrentPct).toBe(100);
    expect(monthly.volatilityPct).toBe(0);
    expect(monthly.trackedDurationMs).toBe(30 * DAY_MS);
  });

  it("counts a change exactly at the window boundary", () => {
    const result = compute([observation(40, 1000), observation(30, 800)]);
    const monthly = windowFor(result, "GBP", 30);

    expect(monthly.minPriceMinor).toBe(800);
    expect(monthly.maxPriceMinor).toBe(800);
    expect(monthly.priceChangeCount).toBe(1);
    expect(monthly.avgDaysBetweenChanges).toBeNull();
    expect(monthly.trackedDurationMs).toBe(30 * DAY_MS);
  });

  it("never mixes currencies and marks the current series", () => {
    const result = compute(
      [
        observation(10, 1000, { currency: "GBP" }),
        observation(5, 800, { currency: "GBP" }),
        observation(3, 500, { currency: "USD" }),
        observation(1, 600, { currency: "USD" }),
      ],
      "USD",
    );

    expect(result.byCurrency).toHaveLength(2);
    expect(result.byCurrency[0].currency).toBe("USD");
    expect(result.byCurrency[0].isCurrent).toBe(true);
    expect(result.byCurrency[1].currency).toBe("GBP");
    expect(result.byCurrency[1].isCurrent).toBe(false);

    const gbp = windowFor(result, "GBP", 30);
    expect(gbp.minPriceMinor).toBe(800);
    expect(gbp.maxPriceMinor).toBe(1000);
    expect(gbp.priceChangeCount).toBe(1);
    // GBP ends when the listing switches to USD at day -3.
    expect(gbp.trackedDurationMs).toBe(7 * DAY_MS);

    const usd = windowFor(result, "USD", 30);
    expect(usd.minPriceMinor).toBe(500);
    expect(usd.maxPriceMinor).toBe(600);
    expect(usd.priceChangeCount).toBe(1);
    expect(usd.trackedDurationMs).toBe(3 * DAY_MS);
  });

  it("computes sale frequency only from time where sale data is known", () => {
    const result = compute([
      observation(20, 1000, { originalPriceMinor: 1200 }),
      observation(10, 1000, { originalPriceMinor: 1000 }),
    ]);
    const monthly = windowFor(result, "GBP", 30);

    expect(monthly.saleDataDurationMs).toBe(20 * DAY_MS);
    expect(monthly.saleFrequencyPct).toBe(50);
  });

  it("excludes intervals with missing sale data instead of guessing", () => {
    const result = compute([
      observation(20, 1000, { originalPriceMinor: 1200 }),
      observation(10, 1000),
      observation(0, 1000, { originalPriceMinor: 1000 }),
    ]);
    const monthly = windowFor(result, "GBP", 30);

    expect(monthly.saleDataDurationMs).toBe(10 * DAY_MS);
    expect(monthly.saleFrequencyPct).toBe(100);
  });

  it("returns null sale frequency when no sale data is known", () => {
    const result = compute([observation(10, 1000), observation(0, 900)]);
    const monthly = windowFor(result, "GBP", 30);
    expect(monthly.saleFrequencyPct).toBeNull();
    expect(monthly.saleDataDurationMs).toBe(0);
  });

  it("returns no currency analytics when there are no price observations", () => {
    const result = compute([
      observation(5, null, { currency: null, availability: "OUT_OF_STOCK" }),
    ]);
    expect(result.byCurrency).toHaveLength(0);
  });

  it("ignores observations after the analytics timestamp", () => {
    const result = compute([
      observation(10, 1000),
      observation(-1, 500),
    ]);
    const monthly = windowFor(result, "GBP", 30);
    expect(monthly.maxPriceMinor).toBe(1000);
    expect(monthly.minPriceMinor).toBe(1000);
  });

  it("supports custom windows", () => {
    const result = computeListingAnalytics({
      retailerListingId: "listing-1",
      observations: [observation(10, 1000), observation(2, 900)],
      now: NOW,
      currentCurrency: "GBP",
      windows: [7],
    });
    const weekly = windowFor(result, "GBP", 7);
    expect(weekly.minPriceMinor).toBe(900);
    expect(weekly.maxPriceMinor).toBe(1000);
    expect(weekly.priceChangeCount).toBe(1);
    expect(weekly.trackedDurationMs).toBe(7 * DAY_MS);
  });
});
