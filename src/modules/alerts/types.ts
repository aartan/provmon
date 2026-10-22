import type { AvailabilityStatus } from "@/modules/retailers/core/types";

/**
 * Inventory-scoped historical alert rules.
 *
 * Evaluation is always per listing and per currency. A GBP rule can never
 * compare a USD listing, and no cross-retailer average is used.
 */

export const PRICE_ALERT_TYPES = [
  "HISTORICAL_LOW",
  "BELOW_90_DAY_AVERAGE",
  "TWELVE_MONTH_LOW",
  "TREND_REVERSAL",
  "RETAILER_LOWEST",
] as const;

export type PriceAlertType = (typeof PRICE_ALERT_TYPES)[number];

export const ALERT_RULE_LABELS: Record<PriceAlertType, string> = {
  HISTORICAL_LOW: "All-time low",
  BELOW_90_DAY_AVERAGE: "Below 90-day average",
  TWELVE_MONTH_LOW: "12-month low",
  TREND_REVERSAL: "Trend reversal",
  RETAILER_LOWEST: "Cheapest retailer",
};

export const ALERT_RULE_DESCRIPTIONS: Record<PriceAlertType, string> = {
  HISTORICAL_LOW:
    "Alert when a listing falls below its lowest recorded price.",
  BELOW_90_DAY_AVERAGE:
    "Alert when a listing falls a set percentage below its 90-day average.",
  TWELVE_MONTH_LOW:
    "Alert when a listing falls below its lowest price in the last 12 months.",
  TREND_REVERSAL:
    "Alert when a listing's price direction reverses after a rise or fall.",
  RETAILER_LOWEST:
    "Alert when a listing becomes the cheapest in-stock retailer for this product.",
};

export interface AlertRuleState {
  /** Last notified price per retailer listing. */
  lastNotifiedPriceByListing?: Record<string, number>;
  /** Last notified reversal price per retailer listing. */
  lastTrendReversalPriceByListing?: Record<string, number>;
  /** Last notified cheapest listing/price for RETAILER_LOWEST. */
  cheapest?: { listingId: string; priceMinor: number };
}

export interface AlertListingContext {
  id: string;
  retailerId: string;
  name: string;
  url: string;
  currency: string;
  currentPriceMinor: number | null;
  currentAvailability: AvailabilityStatus;
  /** Lowest price before the current check, in the same currency. */
  allTimeLowMinor: number | null;
  /** Lowest price in the 365 days before the current check. */
  twelveMonthLowMinor: number | null;
  /** Time-weighted 90-day average before the current check. */
  ninetyDayAverageMinor: number | null;
  /** Distinct consecutive prices, oldest to newest, including current. */
  recentPriceLevels: number[];
}

export interface AlertTrigger {
  listingId: string;
  retailerId: string;
  listingName: string;
  listingUrl: string;
  currency: string;
  priceMinor: number;
  availability: AvailabilityStatus;
  type: PriceAlertType;
  /** Prior low, average, previous cheapest price, or reversal pivot. */
  comparatorPriceMinor: number | null;
  thresholdPct: number | null;
  /** Only the state keys this trigger should acknowledge. */
  statePatch: AlertRuleState;
}
