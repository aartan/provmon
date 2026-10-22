import { z } from "zod";

import type {
  AlertListingContext,
  AlertRuleState,
  AlertTrigger,
  PriceAlertType,
} from "@/modules/alerts/types";

const stateSchema = z.object({
  lastNotifiedPriceByListing: z
    .record(z.string(), z.number().int().nonnegative())
    .optional(),
  lastTrendReversalPriceByListing: z
    .record(z.string(), z.number().int().nonnegative())
    .optional(),
  cheapest: z
    .object({
      listingId: z.string(),
      priceMinor: z.number().int().nonnegative(),
    })
    .optional(),
});

/** Parse untrusted PriceAlertRule.state JSON. Invalid state resets safely. */
export function parseAlertRuleState(value: unknown): AlertRuleState {
  if (value === null || value === undefined) {
    return {};
  }
  const parsed = stateSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/** Merge only the fields acknowledged by a successful/skipped delivery. */
export function mergeAlertRuleState(
  current: AlertRuleState,
  patch: AlertRuleState,
): AlertRuleState {
  const next: AlertRuleState = { ...current, ...patch };
  if (
    current.lastNotifiedPriceByListing ||
    patch.lastNotifiedPriceByListing
  ) {
    next.lastNotifiedPriceByListing = {
      ...(current.lastNotifiedPriceByListing ?? {}),
      ...(patch.lastNotifiedPriceByListing ?? {}),
    };
  }
  if (
    current.lastTrendReversalPriceByListing ||
    patch.lastTrendReversalPriceByListing
  ) {
    next.lastTrendReversalPriceByListing = {
      ...(current.lastTrendReversalPriceByListing ?? {}),
      ...(patch.lastTrendReversalPriceByListing ?? {}),
    };
  }
  if (patch.cheapest) {
    next.cheapest = patch.cheapest;
  }
  return next;
}

function activeListings(
  listings: AlertListingContext[],
): Array<AlertListingContext & { currentPriceMinor: number; currentAvailability: "IN_STOCK" }> {
  return listings.filter(
    (
      listing,
    ): listing is AlertListingContext & {
      currentPriceMinor: number;
      currentAvailability: "IN_STOCK";
    } =>
      listing.currentAvailability === "IN_STOCK" &&
      listing.currentPriceMinor !== null,
  );
}

function triggerFor(
  listing: AlertListingContext & { currentPriceMinor: number },
  type: PriceAlertType,
  comparatorPriceMinor: number | null,
  thresholdPct: number | null,
  statePatch: AlertRuleState,
): AlertTrigger {
  return {
    listingId: listing.id,
    retailerId: listing.retailerId,
    listingName: listing.name,
    listingUrl: listing.url,
    currency: listing.currency,
    priceMinor: listing.currentPriceMinor,
    availability: listing.currentAvailability,
    type,
    comparatorPriceMinor,
    thresholdPct,
    statePatch,
  };
}

/**
 * Evaluate one rule against all in-stock listings of the rule's currency.
 * Triggers only fire for genuinely new lows / new cheapness / new reversals;
 * state patches are applied by the caller only after delivery or a skipped
 * notification (user preference off).
 */
export function evaluateHistoricalAlertRule(input: {
  type: PriceAlertType;
  thresholdPct: number | null;
  state: AlertRuleState;
  listings: AlertListingContext[];
}): AlertTrigger[] {
  const { type, state } = input;
  const listings = activeListings(input.listings);
  const triggers: AlertTrigger[] = [];

  switch (type) {
    case "HISTORICAL_LOW":
    case "TWELVE_MONTH_LOW": {
      for (const listing of listings) {
        const comparator =
          type === "HISTORICAL_LOW"
            ? listing.allTimeLowMinor
            : listing.twelveMonthLowMinor;
        if (comparator === null || listing.currentPriceMinor >= comparator) {
          continue;
        }
        const lastNotified =
          state.lastNotifiedPriceByListing?.[listing.id];
        if (
          lastNotified !== undefined &&
          listing.currentPriceMinor >= lastNotified
        ) {
          continue;
        }
        triggers.push(
          triggerFor(listing, type, comparator, null, {
            lastNotifiedPriceByListing: {
              [listing.id]: listing.currentPriceMinor,
            },
          }),
        );
      }
      break;
    }

    case "BELOW_90_DAY_AVERAGE": {
      const thresholdPct = input.thresholdPct ?? 10;
      for (const listing of listings) {
        const average = listing.ninetyDayAverageMinor;
        if (average === null || average <= 0) {
          continue;
        }
        const thresholdPrice = Math.floor(
          (average * (100 - thresholdPct)) / 100,
        );
        if (listing.currentPriceMinor > thresholdPrice) {
          continue;
        }
        const lastNotified =
          state.lastNotifiedPriceByListing?.[listing.id];
        if (
          lastNotified !== undefined &&
          listing.currentPriceMinor >= lastNotified
        ) {
          continue;
        }
        triggers.push(
          triggerFor(
            listing,
            type,
            average,
            thresholdPct,
            {
              lastNotifiedPriceByListing: {
                [listing.id]: listing.currentPriceMinor,
              },
            },
          ),
        );
      }
      break;
    }

    case "RETAILER_LOWEST": {
      const cheapest = listings.reduce<
        (AlertListingContext & { currentPriceMinor: number }) | null
      >((best, listing) => {
        if (!best) {
          return listing;
        }
        if (listing.currentPriceMinor < best.currentPriceMinor) {
          return listing;
        }
        if (
          listing.currentPriceMinor === best.currentPriceMinor &&
          listing.id < best.id
        ) {
          return listing;
        }
        return best;
      }, null);
      if (!cheapest) {
        break;
      }
      const previous = state.cheapest;
      if (
        previous &&
        previous.listingId === cheapest.id &&
        previous.priceMinor <= cheapest.currentPriceMinor
      ) {
        break;
      }
      triggers.push(
        triggerFor(
          cheapest,
          type,
          previous?.priceMinor ?? null,
          null,
          {
            cheapest: {
              listingId: cheapest.id,
              priceMinor: cheapest.currentPriceMinor,
            },
          },
        ),
      );
      break;
    }

    case "TREND_REVERSAL": {
      for (const listing of listings) {
        const levels = listing.recentPriceLevels;
        if (levels.length < 3) {
          continue;
        }
        const [first, pivot, latest] = levels.slice(-3);
        const previousDirection = Math.sign(pivot - first);
        const latestDirection = Math.sign(latest - pivot);
        if (
          previousDirection === 0 ||
          latestDirection === 0 ||
          previousDirection === latestDirection
        ) {
          continue;
        }
        const lastReversal =
          state.lastTrendReversalPriceByListing?.[listing.id];
        if (lastReversal !== undefined && latest <= lastReversal) {
          continue;
        }
        triggers.push(
          triggerFor(listing, type, pivot, null, {
            lastTrendReversalPriceByListing: {
              [listing.id]: latest,
            },
          }),
        );
      }
      break;
    }
  }

  return triggers;
}
