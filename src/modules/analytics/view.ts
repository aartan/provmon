import type { AvailabilityStatus } from "@/modules/retailers/core/types";
import type {
  CurrencyAnalytics,
  ListingAnalytics,
  ProductIntelligence,
  WindowAnalytics,
} from "@/modules/analytics/types";

/**
 * Serialisable analytics shapes for client components. Dates are omitted;
 * the UI only needs the computed values and window sizes.
 */

export interface WindowMetricsView {
  windowDays: number;
  hasData: boolean;
  minPriceMinor: number | null;
  maxPriceMinor: number | null;
  percentile: number | null;
  aboveCurrentPct: number | null;
  belowCurrentPct: number | null;
  atCurrentPct: number | null;
  volatilityPct: number | null;
  priceChangeCount: number;
  avgDaysBetweenChanges: number | null;
  saleFrequencyPct: number | null;
}

export interface ListingAnalyticsView {
  currency: string;
  windows: WindowMetricsView[];
}

export interface ProductCurrencyView {
  currency: string;
  listingCount: number;
  inStockCount: number;
  bestCurrent: {
    listingId: string;
    retailerId: string;
    priceMinor: number;
    originalPriceMinor: number | null;
    discountPct: number | null;
  } | null;
  lowestByWindow: Array<{
    windowDays: number;
    priceMinor: number | null;
    listingId: string | null;
    retailerId: string | null;
  }>;
}

export interface ProductListingView {
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
  lastCheckedAt: string | null;
  bestForCurrency: boolean;
  windows: WindowMetricsView[];
}

export interface ProductIntelligenceView {
  product: {
    id: string;
    name: string;
    brand: string | null;
    model: string | null;
    gtin: string | null;
    mpn: string | null;
  };
  listings: ProductListingView[];
  byCurrency: ProductCurrencyView[];
}

export function toWindowMetricsView(
  window: WindowAnalytics,
): WindowMetricsView {
  return {
    windowDays: window.windowDays,
    hasData: window.hasData,
    minPriceMinor: window.minPriceMinor,
    maxPriceMinor: window.maxPriceMinor,
    percentile: window.percentile,
    aboveCurrentPct: window.aboveCurrentPct,
    belowCurrentPct: window.belowCurrentPct,
    atCurrentPct: window.atCurrentPct,
    volatilityPct: window.volatilityPct,
    priceChangeCount: window.priceChangeCount,
    avgDaysBetweenChanges: window.avgDaysBetweenChanges,
    saleFrequencyPct: window.saleFrequencyPct,
  };
}

function currentCurrencyAnalytics(
  analytics: ListingAnalytics,
): CurrencyAnalytics | null {
  return (
    analytics.byCurrency.find((entry) => entry.isCurrent) ??
    analytics.byCurrency[0] ??
    null
  );
}

export function toListingAnalyticsView(
  analytics: ListingAnalytics | null,
): ListingAnalyticsView | null {
  if (!analytics) {
    return null;
  }
  const current = currentCurrencyAnalytics(analytics);
  if (!current) {
    return null;
  }
  return {
    currency: current.currency,
    windows: current.windows.map(toWindowMetricsView),
  };
}

export function toProductIntelligenceView(
  intelligence: ProductIntelligence | null,
): ProductIntelligenceView | null {
  if (!intelligence) {
    return null;
  }

  return {
    product: intelligence.product,
    byCurrency: intelligence.byCurrency.map((currency) => ({
      currency: currency.currency,
      listingCount: currency.listingCount,
      inStockCount: currency.inStockCount,
      bestCurrent: currency.bestCurrent,
      lowestByWindow: currency.lowestByWindow,
    })),
    listings: intelligence.listings.map((listing) => {
      const current = currentCurrencyAnalytics(listing.analytics);
      const summary = intelligence.byCurrency.find(
        (currency) => currency.currency === listing.currency,
      );
      return {
        id: listing.id,
        retailerId: listing.retailerId,
        name: listing.name,
        url: listing.url,
        imageUrl: listing.imageUrl,
        currency: listing.currency,
        currentPriceMinor: listing.currentPriceMinor,
        currentOriginalPriceMinor: listing.currentOriginalPriceMinor,
        currentDiscountPct: listing.currentDiscountPct,
        currentAvailability: listing.currentAvailability,
        lastCheckedAt: listing.lastCheckedAt?.toISOString() ?? null,
        bestForCurrency:
          summary?.bestCurrent?.listingId === listing.id,
        windows:
          current?.windows.map(toWindowMetricsView) ?? [],
      };
    }),
  };
}
