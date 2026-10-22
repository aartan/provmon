import type { AvailabilityStatus } from "@/modules/retailers/core/types";

/**
 * Historical price-intelligence types.
 *
 * Metrics are derived from the append-only ListingObservation history. A
 * repeated unchanged snapshot extends the duration of a price level but is
 * never counted as an independent price change.
 */

export const ANALYTICS_WINDOW_DAYS = [7, 30, 90, 180, 365] as const;
export type AnalyticsWindowDays = (typeof ANALYTICS_WINDOW_DAYS)[number];

export interface AnalyticsObservation {
  priceMinor: number | null;
  originalPriceMinor: number | null;
  discountPct: number | null;
  currency: string | null;
  availability: AvailabilityStatus | null;
  observedAt: Date;
}

export interface WindowAnalytics {
  windowDays: number;
  windowStart: Date;
  windowEnd: Date;
  hasData: boolean;
  latestPriceMinor: number | null;
  minPriceMinor: number | null;
  maxPriceMinor: number | null;
  minPriceAt: Date | null;
  maxPriceAt: Date | null;
  /** Time-weighted mean price across the tracked window. */
  averagePriceMinor: number | null;
  /**
   * Time-weighted percentile rank of the latest price within this window,
   * 0 = cheapest observed and 100 = most expensive. Equal-price time sits
   * at the midpoint of its band.
   */
  percentile: number | null;
  /** Percentage of tracked time the price was strictly above the latest price. */
  aboveCurrentPct: number | null;
  /** Percentage of tracked time the price was strictly below the latest price. */
  belowCurrentPct: number | null;
  /** Percentage of tracked time the price equalled the latest price. */
  atCurrentPct: number | null;
  /** Time-weighted coefficient of variation (standard deviation / mean). */
  volatilityPct: number | null;
  priceChangeCount: number;
  /** Average days between consecutive price changes; null with fewer than two. */
  avgDaysBetweenChanges: number | null;
  /**
   * Percentage of sale-known time the listing was discounted against its
   * original price. Null when no observation in the window carried an
   * original price.
   */
  saleFrequencyPct: number | null;
  /** Duration covered by observations that included an original price. */
  saleDataDurationMs: number;
  /** Total duration of price levels tracked inside the window. */
  trackedDurationMs: number;
}

export interface CurrencyAnalytics {
  currency: string;
  /** True for the listing's current currency. */
  isCurrent: boolean;
  currentPriceMinor: number | null;
  windows: WindowAnalytics[];
}

export interface ListingAnalytics {
  retailerListingId: string;
  generatedAt: Date;
  byCurrency: CurrencyAnalytics[];
}

export interface ProductListingIntelligence {
  id: string;
  retailerId: string;
  name: string;
  url: string;
  imageUrl: string | null;
  currency: string;
  currentPriceMinor: number | null;
  currentOriginalPriceMinor: number | null;
  currentDiscountPct: number | null;
  currentAvailability: AvailabilityStatus;
  lastCheckedAt: Date | null;
  analytics: ListingAnalytics;
}

export interface ProductCurrencyIntelligence {
  currency: string;
  listingCount: number;
  inStockCount: number;
  /**
   * Best current in-stock price for this currency. Deliberately not an
   * average across retailers.
   */
  bestCurrent: {
    listingId: string;
    retailerId: string;
    priceMinor: number;
    originalPriceMinor: number | null;
    discountPct: number | null;
  } | null;
  /** Lowest observed price per window across this currency's listings. */
  lowestByWindow: Array<{
    windowDays: number;
    priceMinor: number | null;
    listingId: string | null;
    retailerId: string | null;
  }>;
}

export interface ProductIntelligence {
  product: {
    id: string;
    name: string;
    brand: string | null;
    model: string | null;
    gtin: string | null;
    mpn: string | null;
  };
  listings: ProductListingIntelligence[];
  byCurrency: ProductCurrencyIntelligence[];
  generatedAt: Date;
}
