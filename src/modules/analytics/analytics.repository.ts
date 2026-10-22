import { db } from "@/lib/db";
import { computeListingAnalytics } from "@/modules/analytics/listing-analytics";
import {
  ANALYTICS_WINDOW_DAYS,
  type CurrencyAnalytics,
  type ListingAnalytics,
  type ProductCurrencyIntelligence,
  type ProductIntelligence,
  type ProductListingIntelligence,
} from "@/modules/analytics/types";

const MS_PER_DAY = 86_400_000;

const observationSelect = {
  priceMinor: true,
  originalPriceMinor: true,
  discountPct: true,
  currency: true,
  availability: true,
  observedAt: true,
} as const;

/**
 * Load a listing's history and compute per-currency price intelligence.
 *
 * Only one observation before the longest window is fetched as a carry-in:
 * it establishes the price active at the window boundary without loading
 * the entire lifetime of the listing.
 */
export async function getListingAnalytics(
  retailerListingId: string,
  options: { now?: Date; windows?: readonly number[] } = {},
): Promise<ListingAnalytics | null> {
  const now = options.now ?? new Date();
  const windows = options.windows ?? ANALYTICS_WINDOW_DAYS;
  const longestWindowDays = Math.max(...windows);
  const cutoff = new Date(now.getTime() - longestWindowDays * MS_PER_DAY);

  const [listing, carryIn, observations] = await Promise.all([
    db.retailerListing.findUnique({
      where: { id: retailerListingId },
      select: { id: true, currency: true },
    }),
    db.listingObservation.findFirst({
      where: {
        retailerListingId,
        observedAt: { lt: cutoff },
        priceMinor: { not: null },
      },
      orderBy: { observedAt: "desc" },
      select: observationSelect,
    }),
    db.listingObservation.findMany({
      where: {
        retailerListingId,
        observedAt: { gte: cutoff, lte: now },
      },
      orderBy: { observedAt: "asc" },
      select: observationSelect,
    }),
  ]);

  if (!listing) {
    return null;
  }

  return computeListingAnalytics({
    retailerListingId,
    observations: carryIn ? [carryIn, ...observations] : observations,
    windows,
    now,
    currentCurrency: listing.currency,
  });
}

function currentCurrencyAnalytics(
  listing: ProductListingIntelligence,
): CurrencyAnalytics | null {
  return (
    listing.analytics.byCurrency.find((entry) => entry.isCurrent) ??
    listing.analytics.byCurrency[0] ??
    null
  );
}

function buildCurrencyIntelligence(
  listings: ProductListingIntelligence[],
  windows: readonly number[],
): ProductCurrencyIntelligence[] {
  const byCurrency = new Map<string, ProductListingIntelligence[]>();
  for (const listing of listings) {
    const group = byCurrency.get(listing.currency) ?? [];
    group.push(listing);
    byCurrency.set(listing.currency, group);
  }

  return [...byCurrency.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, currencyListings]) => {
      const inStockListings = currencyListings.filter(
        (listing) => listing.currentAvailability === "IN_STOCK",
      );

      let bestCurrent: ProductCurrencyIntelligence["bestCurrent"] = null;
      for (const listing of inStockListings) {
        const priceMinor = listing.currentPriceMinor;
        if (priceMinor === null) {
          continue;
        }
        if (
          !bestCurrent ||
          priceMinor < bestCurrent.priceMinor ||
          (priceMinor === bestCurrent.priceMinor &&
            listing.id < bestCurrent.listingId)
        ) {
          bestCurrent = {
            listingId: listing.id,
            retailerId: listing.retailerId,
            priceMinor,
            originalPriceMinor: listing.currentOriginalPriceMinor,
            discountPct: listing.currentDiscountPct,
          };
        }
      }

      const lowestByWindow = windows.map((windowDays) => {
        let lowestPriceMinor: number | null = null;
        let lowestListing: ProductListingIntelligence | null = null;

        for (const listing of currencyListings) {
          const window = currentCurrencyAnalytics(listing)?.windows.find(
            (entry) => entry.windowDays === windowDays,
          );
          if (
            !window?.hasData ||
            window.minPriceMinor === null
          ) {
            continue;
          }
          if (
            lowestPriceMinor === null ||
            window.minPriceMinor < lowestPriceMinor
          ) {
            lowestPriceMinor = window.minPriceMinor;
            lowestListing = listing;
          }
        }

        return {
          windowDays,
          priceMinor: lowestPriceMinor,
          listingId: lowestListing?.id ?? null,
          retailerId: lowestListing?.retailerId ?? null,
        };
      });

      return {
        currency,
        listingCount: currencyListings.length,
        inStockCount: inStockListings.length,
        bestCurrent,
        lowestByWindow,
      };
    });
}

/**
 * Product-level intelligence across every retailer listing of one canonical
 * product. Metrics remain per listing and per currency; the summary exposes
 * best current prices and lowest historical prices, never synthetic
 * cross-retailer averages.
 *
 * Passing `userId` enforces that the caller has a subscription or inventory
 * item for this canonical product. No inventory or alert configuration is
 * returned.
 */
export async function getProductIntelligence(
  canonicalProductId: string,
  options: {
    userId?: string;
    now?: Date;
    windows?: readonly number[];
  } = {},
): Promise<ProductIntelligence | null> {
  const now = options.now ?? new Date();
  const windows = options.windows ?? ANALYTICS_WINDOW_DAYS;

  if (options.userId) {
    const [subscription, inventoryItem] = await Promise.all([
      db.monitoringSubscription.findFirst({
        where: {
          userId: options.userId,
          retailerListing: { canonicalProductId },
        },
        select: { id: true },
      }),
      db.inventoryItem.findUnique({
        where: {
          userId_canonicalProductId: {
            userId: options.userId,
            canonicalProductId,
          },
        },
        select: { id: true },
      }),
    ]);
    if (!subscription && !inventoryItem) {
      return null;
    }
  }

  const product = await db.canonicalProduct.findUnique({
    where: { id: canonicalProductId },
    select: {
      id: true,
      name: true,
      brand: true,
      model: true,
      gtin: true,
      mpn: true,
      listings: {
        select: {
          id: true,
          retailerId: true,
          name: true,
          url: true,
          imageUrl: true,
          currency: true,
          currentPriceMinor: true,
          currentOriginalPriceMinor: true,
          currentDiscountPct: true,
          currentAvailability: true,
          lastCheckedAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!product) {
    return null;
  }

  const analyticsResults = await Promise.all(
    product.listings.map((listing) =>
      getListingAnalytics(listing.id, { now, windows }),
    ),
  );

  const listings: ProductListingIntelligence[] = product.listings.map(
    (listing, index) => ({
      ...listing,
      analytics:
        analyticsResults[index] ?? {
          retailerListingId: listing.id,
          generatedAt: now,
          byCurrency: [],
        },
    }),
  );

  return {
    product: {
      id: product.id,
      name: product.name,
      brand: product.brand,
      model: product.model,
      gtin: product.gtin,
      mpn: product.mpn,
    },
    listings,
    byCurrency: buildCurrencyIntelligence(listings, windows),
    generatedAt: now,
  };
}
