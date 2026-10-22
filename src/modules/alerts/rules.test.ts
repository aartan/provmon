import { describe, expect, it } from "vitest";

import {
  evaluateHistoricalAlertRule,
  mergeAlertRuleState,
  parseAlertRuleState,
} from "@/modules/alerts/rules";
import type { AlertListingContext } from "@/modules/alerts/types";

function listing(
  overrides: Partial<AlertListingContext> & {
    id: string;
    currentPriceMinor: number;
  },
): AlertListingContext {
  return {
    retailerId: "mock",
    name: `Listing ${overrides.id}`,
    url: `https://example.test/${overrides.id}`,
    currency: "GBP",
    currentAvailability: "IN_STOCK",
    allTimeLowMinor: null,
    twelveMonthLowMinor: null,
    ninetyDayAverageMinor: null,
    recentPriceLevels: [],
    ...overrides,
  };
}

describe("evaluateHistoricalAlertRule", () => {
  it("triggers only on a genuinely new all-time low", () => {
    const state = {};
    const trigger = evaluateHistoricalAlertRule({
      type: "HISTORICAL_LOW",
      thresholdPct: null,
      state,
      listings: [
        listing({
          id: "a",
          currentPriceMinor: 900,
          allTimeLowMinor: 1000,
        }),
      ],
    });
    expect(trigger).toHaveLength(1);
    expect(trigger[0]).toMatchObject({
      listingId: "a",
      type: "HISTORICAL_LOW",
      priceMinor: 900,
      comparatorPriceMinor: 1000,
    });
    expect(trigger[0].statePatch.lastNotifiedPriceByListing).toEqual({
      a: 900,
    });
  });

  it("does not trigger at or above the prior all-time low", () => {
    expect(
      evaluateHistoricalAlertRule({
        type: "HISTORICAL_LOW",
        thresholdPct: null,
        state: {},
        listings: [
          listing({
            id: "a",
            currentPriceMinor: 1000,
            allTimeLowMinor: 1000,
          }),
        ],
      }),
    ).toHaveLength(0);
    expect(
      evaluateHistoricalAlertRule({
        type: "HISTORICAL_LOW",
        thresholdPct: null,
        state: {},
        listings: [
          listing({
            id: "a",
            currentPriceMinor: 1100,
            allTimeLowMinor: 1000,
          }),
        ],
      }),
    ).toHaveLength(0);
  });

  it("does not repeat a low already acknowledged in state", () => {
    expect(
      evaluateHistoricalAlertRule({
        type: "HISTORICAL_LOW",
        thresholdPct: null,
        state: { lastNotifiedPriceByListing: { a: 900 } },
        listings: [
          listing({
            id: "a",
            currentPriceMinor: 900,
            allTimeLowMinor: 1000,
          }),
        ],
      }),
    ).toHaveLength(0);
  });

  it("ignores out-of-stock listings", () => {
    expect(
      evaluateHistoricalAlertRule({
        type: "HISTORICAL_LOW",
        thresholdPct: null,
        state: {},
        listings: [
          listing({
            id: "a",
            currentPriceMinor: 900,
            currentAvailability: "OUT_OF_STOCK",
            allTimeLowMinor: 1000,
          }),
        ],
      }),
    ).toHaveLength(0);
  });

  it("triggers a 12-month low independently of the all-time low", () => {
    const triggers = evaluateHistoricalAlertRule({
      type: "TWELVE_MONTH_LOW",
      thresholdPct: null,
      state: {},
      listings: [
        listing({
          id: "a",
          currentPriceMinor: 800,
          allTimeLowMinor: 700,
          twelveMonthLowMinor: 900,
        }),
      ],
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0].comparatorPriceMinor).toBe(900);
  });

  it("applies the below-average percentage threshold", () => {
    const base = {
      type: "BELOW_90_DAY_AVERAGE" as const,
      thresholdPct: 20,
      state: {},
      listings: [
        listing({
          id: "a",
          currentPriceMinor: 800,
          ninetyDayAverageMinor: 1000,
        }),
      ],
    };
    expect(evaluateHistoricalAlertRule(base)).toHaveLength(1);
    expect(
      evaluateHistoricalAlertRule({
        ...base,
        listings: [
          listing({
            id: "a",
            currentPriceMinor: 850,
            ninetyDayAverageMinor: 1000,
          }),
        ],
      }),
    ).toHaveLength(0);
  });

  it("does not repeat a below-average alert at the same price", () => {
    expect(
      evaluateHistoricalAlertRule({
        type: "BELOW_90_DAY_AVERAGE",
        thresholdPct: 20,
        state: { lastNotifiedPriceByListing: { a: 800 } },
        listings: [
          listing({
            id: "a",
            currentPriceMinor: 800,
            ninetyDayAverageMinor: 1000,
          }),
        ],
      }),
    ).toHaveLength(0);
  });

  it("triggers when a listing becomes the cheapest retailer", () => {
    const triggers = evaluateHistoricalAlertRule({
      type: "RETAILER_LOWEST",
      thresholdPct: null,
      state: {},
      listings: [
        listing({ id: "a", currentPriceMinor: 1000 }),
        listing({ id: "b", currentPriceMinor: 900 }),
      ],
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0].listingId).toBe("b");
    expect(triggers[0].statePatch.cheapest).toEqual({
      listingId: "b",
      priceMinor: 900,
    });
  });

  it("does not repeat the same cheapest price but triggers on a new cheapest", () => {
    expect(
      evaluateHistoricalAlertRule({
        type: "RETAILER_LOWEST",
        thresholdPct: null,
        state: { cheapest: { listingId: "b", priceMinor: 900 } },
        listings: [
          listing({ id: "a", currentPriceMinor: 1000 }),
          listing({ id: "b", currentPriceMinor: 900 }),
        ],
      }),
    ).toHaveLength(0);

    const triggers = evaluateHistoricalAlertRule({
      type: "RETAILER_LOWEST",
      thresholdPct: null,
      state: { cheapest: { listingId: "b", priceMinor: 900 } },
      listings: [
        listing({ id: "a", currentPriceMinor: 800 }),
        listing({ id: "b", currentPriceMinor: 900 }),
      ],
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0].listingId).toBe("a");
    expect(triggers[0].comparatorPriceMinor).toBe(900);
  });

  it("detects a trend reversal in either direction", () => {
    const downThenUp = evaluateHistoricalAlertRule({
      type: "TREND_REVERSAL",
      thresholdPct: null,
      state: {},
      listings: [
        listing({
          id: "a",
          currentPriceMinor: 950,
          recentPriceLevels: [1000, 900, 950],
        }),
      ],
    });
    expect(downThenUp).toHaveLength(1);

    const upThenDown = evaluateHistoricalAlertRule({
      type: "TREND_REVERSAL",
      thresholdPct: null,
      state: {},
      listings: [
        listing({
          id: "a",
          currentPriceMinor: 1050,
          recentPriceLevels: [1000, 1100, 1050],
        }),
      ],
    });
    expect(upThenDown).toHaveLength(1);

    const continuingDown = evaluateHistoricalAlertRule({
      type: "TREND_REVERSAL",
      thresholdPct: null,
      state: {},
      listings: [
        listing({
          id: "a",
          currentPriceMinor: 850,
          recentPriceLevels: [1000, 900, 850],
        }),
      ],
    });
    expect(continuingDown).toHaveLength(0);
  });

  it("does not repeat the same reversal price", () => {
    expect(
      evaluateHistoricalAlertRule({
        type: "TREND_REVERSAL",
        thresholdPct: null,
        state: { lastTrendReversalPriceByListing: { a: 950 } },
        listings: [
          listing({
            id: "a",
            currentPriceMinor: 950,
            recentPriceLevels: [1000, 900, 950],
          }),
        ],
      }),
    ).toHaveLength(0);
  });
});

describe("alert rule state", () => {
  it("parses valid state and resets invalid state safely", () => {
    expect(
      parseAlertRuleState({
        lastNotifiedPriceByListing: { a: 900 },
        cheapest: { listingId: "a", priceMinor: 900 },
      }),
    ).toEqual({
      lastNotifiedPriceByListing: { a: 900 },
      cheapest: { listingId: "a", priceMinor: 900 },
    });
    expect(parseAlertRuleState("not-json")).toEqual({});
    expect(parseAlertRuleState({ lastNotifiedPriceByListing: { a: -1 } })).toEqual(
      {},
    );
  });

  it("merges per-listing state patches without dropping other listings", () => {
    expect(
      mergeAlertRuleState(
        {
          lastNotifiedPriceByListing: { a: 1000 },
          cheapest: { listingId: "a", priceMinor: 1000 },
        },
        { lastNotifiedPriceByListing: { b: 800 } },
      ),
    ).toEqual({
      lastNotifiedPriceByListing: { a: 1000, b: 800 },
      cheapest: { listingId: "a", priceMinor: 1000 },
    });
  });
});
