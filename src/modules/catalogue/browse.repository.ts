import type { Prisma } from "@/generated/prisma/client";
import type { AvailabilityStatus } from "@/modules/retailers/core/types";
import { db } from "@/lib/db";
import { registerBuiltInAdapters } from "@/modules/retailers/adapters";
import { retailerRegistry } from "@/modules/retailers/core/retailer-registry";
import {
  catalogueHistoryCutoff,
  type CatalogueHistoryRange,
} from "@/modules/catalogue/history";

/**
 * Shared catalogue browsing queries.
 *
 * Catalogue rows are retailer listings, not user-owned data. Reads take an
 * optional user id only to annotate rows with that user's monitoring and
 * inventory membership; no other user's state is ever returned.
 */

export const CATALOGUE_SORTS = [
  "relevance",
  "price_asc",
  "price_desc",
  "discount_desc",
  "name_asc",
  "recent",
] as const;
export type CatalogueSort = (typeof CATALOGUE_SORTS)[number];

export const CATALOGUE_STOCK_FILTERS = ["all", "in", "out"] as const;
export type CatalogueStockFilter = (typeof CATALOGUE_STOCK_FILTERS)[number];

export interface CatalogueRetailerSummary {
  id: string;
  name: string;
  currency: string;
  supportsCatalogue: boolean;
  productCount: number;
  inStockCount: number;
  discoveryEnabled: boolean;
  lastSuccessfulRunAt: string | null;
}

export interface CatalogueBrowseFilters {
  retailerId: string;
  q?: string;
  category?: string;
  brand?: string;
  minPriceMinor?: number | null;
  maxPriceMinor?: number | null;
  stock?: CatalogueStockFilter;
  sort?: CatalogueSort;
  page?: number;
  pageSize?: number;
}

export interface CatalogueListingRow {
  id: string;
  canonicalProductId: string;
  retailerId: string;
  retailerProductId: string | null;
  sku: string | null;
  gtin: string | null;
  name: string;
  brand: string | null;
  model: string | null;
  category: string | null;
  url: string;
  imageUrl: string | null;
  currency: string;
  currentPriceMinor: number | null;
  currentOriginalPriceMinor: number | null;
  currentDiscountPct: number | null;
  currentAvailability: AvailabilityStatus;
  lastCheckedAt: string | null;
  lastCatalogueSeenAt: string | null;
  delistedAt: string | null;
  monitored: boolean;
  subscriptionId: string | null;
  subscriptionStatus: "ACTIVE" | "PAUSED" | "ARCHIVED" | null;
  inInventory: boolean;
  inventoryItemId: string | null;
}

export interface CatalogueBrowseResult {
  items: CatalogueListingRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CatalogueFilterOptions {
  categories: string[];
  brands: string[];
}

const listingSelect = {
  id: true,
  canonicalProductId: true,
  retailerId: true,
  retailerProductId: true,
  sku: true,
  gtin: true,
  name: true,
  brand: true,
  model: true,
  category: true,
  url: true,
  imageUrl: true,
  currency: true,
  currentPriceMinor: true,
  currentOriginalPriceMinor: true,
  currentDiscountPct: true,
  currentAvailability: true,
  lastCheckedAt: true,
  lastCatalogueSeenAt: true,
  delistedAt: true,
} as const;

function normalizePage(value: number | undefined): number {
  return Number.isInteger(value) && value && value > 0 ? value : 1;
}

function normalizePageSize(value: number | undefined): number {
  if (!Number.isInteger(value) || !value) {
    return 24;
  }
  return Math.min(100, Math.max(12, value));
}

function browseOrderBy(sort: CatalogueSort): Prisma.RetailerListingOrderByWithRelationInput[] {
  switch (sort) {
    case "price_asc":
      return [
        { currentPriceMinor: { sort: "asc", nulls: "last" } },
        { name: "asc" },
      ];
    case "price_desc":
      return [
        { currentPriceMinor: { sort: "desc", nulls: "last" } },
        { name: "asc" },
      ];
    case "discount_desc":
      return [
        { currentDiscountPct: { sort: "desc", nulls: "last" } },
        { currentPriceMinor: { sort: "asc", nulls: "last" } },
        { name: "asc" },
      ];
    case "name_asc":
      return [{ name: "asc" }];
    case "recent":
      return [
        { catalogueDiscoveredAt: { sort: "desc", nulls: "last" } },
        { name: "asc" },
      ];
    case "relevance":
    default:
      // Postgres cannot order by relevance without a search engine. Keep a
      // stable cheap ordering; the trigram index still narrows the search.
      return [{ name: "asc" }];
  }
}

function buildBrowseWhere(
  filters: CatalogueBrowseFilters,
): Prisma.RetailerListingWhereInput {
  const where: Prisma.RetailerListingWhereInput = {
    retailerId: filters.retailerId,
    delistedAt: null,
  };

  const q = filters.q?.trim();
  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { sku: { contains: q, mode: "insensitive" } },
      { brand: { contains: q, mode: "insensitive" } },
      { gtin: { contains: q } },
    ];
  }
  if (filters.category) {
    where.category = filters.category;
  }
  if (filters.brand) {
    where.brand = filters.brand;
  }
  if (filters.stock === "in") {
    where.currentAvailability = "IN_STOCK";
  } else if (filters.stock === "out") {
    where.currentAvailability = { not: "IN_STOCK" };
  }

  if (
    filters.minPriceMinor !== null &&
    filters.minPriceMinor !== undefined &&
    filters.maxPriceMinor !== null &&
    filters.maxPriceMinor !== undefined
  ) {
    where.currentPriceMinor = {
      gte: filters.minPriceMinor,
      lte: filters.maxPriceMinor,
    };
  } else if (
    filters.minPriceMinor !== null &&
    filters.minPriceMinor !== undefined
  ) {
    where.currentPriceMinor = { gte: filters.minPriceMinor };
  } else if (
    filters.maxPriceMinor !== null &&
    filters.maxPriceMinor !== undefined
  ) {
    where.currentPriceMinor = { lte: filters.maxPriceMinor };
  }

  return where;
}

async function annotateUserState(
  userId: string | undefined,
  rows: Array<Omit<CatalogueListingRow, "monitored" | "subscriptionId" | "subscriptionStatus" | "inInventory" | "inventoryItemId">>,
): Promise<CatalogueListingRow[]> {
  if (!userId || rows.length === 0) {
    return rows.map((row) => ({
      ...row,
      monitored: false,
      subscriptionId: null,
      subscriptionStatus: null,
      inInventory: false,
      inventoryItemId: null,
    }));
  }

  const listingIds = rows.map((row) => row.id);
  const canonicalIds = [...new Set(rows.map((row) => row.canonicalProductId))];

  const [subscriptions, inventoryItems] = await Promise.all([
    db.monitoringSubscription.findMany({
      where: { userId, retailerListingId: { in: listingIds } },
      select: { id: true, retailerListingId: true, status: true },
    }),
    db.inventoryItem.findMany({
      where: { userId, canonicalProductId: { in: canonicalIds } },
      select: { id: true, canonicalProductId: true },
    }),
  ]);

  const subscriptionByListing = new Map(
    subscriptions.map((subscription) => [subscription.retailerListingId, subscription]),
  );
  const inventoryByCanonical = new Map(
    inventoryItems.map((item) => [item.canonicalProductId, item.id]),
  );

  return rows.map((row) => {
    const subscription = subscriptionByListing.get(row.id);
    const inventoryItemId = inventoryByCanonical.get(row.canonicalProductId) ?? null;
    return {
      ...row,
      monitored:
        subscription?.status === "ACTIVE" || subscription?.status === "PAUSED",
      subscriptionId: subscription?.id ?? null,
      subscriptionStatus: subscription?.status ?? null,
      inInventory: inventoryItemId !== null,
      inventoryItemId,
    };
  });
}

export async function browseCatalogue(
  filters: CatalogueBrowseFilters,
  userId?: string,
): Promise<CatalogueBrowseResult> {
  const page = normalizePage(filters.page);
  const pageSize = normalizePageSize(filters.pageSize);
  const where = buildBrowseWhere(filters);

  const [total, rows] = await Promise.all([
    db.retailerListing.count({ where }),
    db.retailerListing.findMany({
      where,
      select: listingSelect,
      orderBy: browseOrderBy(filters.sort ?? "relevance"),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const items = await annotateUserState(
    userId,
    rows.map((row) => ({
      ...row,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastCatalogueSeenAt: row.lastCatalogueSeenAt?.toISOString() ?? null,
      delistedAt: row.delistedAt?.toISOString() ?? null,
    })),
  );

  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * Retailers with a browsable catalogue. Discovery-capable adapters are
 * always listed, even before their first import, so the UI can link to
 * retailer management instead of hiding the retailer entirely.
 */
export async function listCatalogueRetailers(): Promise<CatalogueRetailerSummary[]> {
  registerBuiltInAdapters();

  const [counts, catalogues] = await Promise.all([
    db.retailerListing.groupBy({
      by: ["retailerId", "currentAvailability"],
      where: { delistedAt: null },
      _count: { _all: true },
    }),
    db.retailerCatalogue.findMany({
      select: {
        retailerId: true,
        discoveryEnabled: true,
        lastSuccessfulRunAt: true,
      },
    }),
  ]);

  const countByRetailer = new Map<string, { total: number; inStock: number }>();
  for (const row of counts) {
    const entry = countByRetailer.get(row.retailerId) ?? {
      total: 0,
      inStock: 0,
    };
    entry.total += row._count._all;
    if (row.currentAvailability === "IN_STOCK") {
      entry.inStock += row._count._all;
    }
    countByRetailer.set(row.retailerId, entry);
  }

  const catalogueByRetailer = new Map(
    catalogues.map((catalogue) => [catalogue.retailerId, catalogue]),
  );

  const summaries: CatalogueRetailerSummary[] = [];
  for (const adapter of retailerRegistry.list()) {
    const count = countByRetailer.get(adapter.id);
    if (!adapter.catalogue && !count) {
      continue;
    }
    const catalogue = catalogueByRetailer.get(adapter.id);
    summaries.push({
      id: adapter.id,
      name: adapter.name,
      currency: adapter.currency,
      supportsCatalogue: Boolean(adapter.catalogue),
      productCount: count?.total ?? 0,
      inStockCount: count?.inStock ?? 0,
      discoveryEnabled: catalogue?.discoveryEnabled ?? false,
      lastSuccessfulRunAt: catalogue?.lastSuccessfulRunAt?.toISOString() ?? null,
    });
  }

  // Retailers with imported listings but no registered adapter (for example
  // after an adapter is removed) remain browsable.
  for (const [retailerId, count] of countByRetailer) {
    if (summaries.some((summary) => summary.id === retailerId)) {
      continue;
    }
    summaries.push({
      id: retailerId,
      name: retailerId,
      currency: "GBP",
      supportsCatalogue: false,
      productCount: count.total,
      inStockCount: count.inStock,
      discoveryEnabled: false,
      lastSuccessfulRunAt: null,
    });
  }

  return summaries.sort((left, right) => {
    if (left.productCount === right.productCount) {
      return left.name.localeCompare(right.name);
    }
    return right.productCount - left.productCount;
  });
}

export async function getCatalogueFilterOptions(
  retailerId: string,
  limit = 500,
): Promise<CatalogueFilterOptions> {
  const [categories, brands] = await Promise.all([
    db.$queryRaw<Array<{ value: string }>>`
      SELECT DISTINCT "category" AS value
      FROM "retailer_listings"
      WHERE "retailer_id" = ${retailerId}
        AND "category" IS NOT NULL
        AND "delisted_at" IS NULL
      ORDER BY "category" ASC
      LIMIT ${limit}
    `,
    db.$queryRaw<Array<{ value: string }>>`
      SELECT DISTINCT "brand" AS value
      FROM "retailer_listings"
      WHERE "retailer_id" = ${retailerId}
        AND "brand" IS NOT NULL
        AND "delisted_at" IS NULL
      ORDER BY "brand" ASC
      LIMIT ${limit}
    `,
  ]);

  return {
    categories: categories.map((row) => row.value),
    brands: brands.map((row) => row.value),
  };
}

export interface CatalogueListingDetail {
  id: string;
  canonicalProductId: string;
  canonicalProduct: {
    id: string;
    name: string;
    brand: string | null;
    model: string | null;
    gtin: string | null;
    mpn: string | null;
  };
  retailerId: string;
  retailerProductId: string | null;
  sku: string | null;
  gtin: string | null;
  mpn: string | null;
  name: string;
  brand: string | null;
  model: string | null;
  category: string | null;
  url: string;
  imageUrl: string | null;
  currency: string;
  currentPriceMinor: number | null;
  currentOriginalPriceMinor: number | null;
  currentDiscountPct: number | null;
  currentAvailability: AvailabilityStatus;
  lastCheckedAt: Date | null;
  lastCatalogueSeenAt: Date | null;
  delistedAt: Date | null;
  inventoryItemId: string | null;
  subscription: {
    id: string;
    status: "ACTIVE" | "PAUSED" | "ARCHIVED";
    condition: "BACK_IN_STOCK" | "PRICE_DROP" | "BOTH";
    targetPriceMinor: number | null;
    intervalMinutes: number;
  } | null;
}

export async function findCatalogueListing(
  id: string,
  userId?: string,
): Promise<CatalogueListingDetail | null> {
  const listing = await db.retailerListing.findUnique({
    where: { id },
    select: {
      ...listingSelect,
      mpn: true,
      canonicalProduct: {
        select: {
          id: true,
          name: true,
          brand: true,
          model: true,
          gtin: true,
          mpn: true,
        },
      },
    },
  });
  if (!listing) {
    return null;
  }

  let inventoryItemId: string | null = null;
  let subscription: CatalogueListingDetail["subscription"] = null;

  if (userId) {
    const [inventoryItem, subscriptionRow] = await Promise.all([
      db.inventoryItem.findUnique({
        where: {
          userId_canonicalProductId: {
            userId,
            canonicalProductId: listing.canonicalProductId,
          },
        },
        select: { id: true },
      }),
      db.monitoringSubscription.findUnique({
        where: {
          userId_retailerListingId: {
            userId,
            retailerListingId: listing.id,
          },
        },
        select: {
          id: true,
          status: true,
          condition: true,
          targetPriceMinor: true,
          intervalMinutes: true,
        },
      }),
    ]);
    inventoryItemId = inventoryItem?.id ?? null;
    subscription = subscriptionRow ?? null;
  }

  return {
    ...listing,
    inventoryItemId,
    subscription,
  };
}

export interface CatalogueBulkListing {
  id: string;
  canonicalProductId: string;
  retailerId: string;
  name: string;
  currentAvailability: AvailabilityStatus;
  delistedAt: Date | null;
}

/** Minimal listing rows for bulk catalogue actions. */
export async function findCatalogueListingsForBulk(
  listingIds: string[],
): Promise<CatalogueBulkListing[]> {
  return db.retailerListing.findMany({
    where: { id: { in: listingIds } },
    select: {
      id: true,
      canonicalProductId: true,
      retailerId: true,
      name: true,
      currentAvailability: true,
      delistedAt: true,
    },
  });
}

export interface CatalogueHistoryPoint {
  t: string;
  priceMinor: number;
}

export interface CatalogueHistoryStats {
  hasData: boolean;
  from: string;
  to: string;
  currency: string;
  currentPriceMinor: number | null;
  lowestPriceMinor: number | null;
  highestPriceMinor: number | null;
  averagePriceMinor: number | null;
  pointCount: number;
}

export interface CatalogueHistoryResult {
  range: CatalogueHistoryRange;
  currency: string;
  points: CatalogueHistoryPoint[];
  stats: CatalogueHistoryStats;
}

interface HistoryObservation {
  observedAt: Date;
  priceMinor: number;
  availability: AvailabilityStatus | null;
}

function downsamplePoints(
  points: CatalogueHistoryPoint[],
  maxPoints: number,
): CatalogueHistoryPoint[] {
  if (points.length <= maxPoints) {
    return points;
  }
  const stride = Math.ceil(points.length / maxPoints);
  const sampled = points.filter(
    (_point, index) => index === 0 || index === points.length - 1 || index % stride === 0,
  );
  // Always keep the extremes even when the stride skips them.
  let minIndex = 0;
  let maxIndex = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].priceMinor < points[minIndex].priceMinor) {
      minIndex = index;
    }
    if (points[index].priceMinor > points[maxIndex].priceMinor) {
      maxIndex = index;
    }
  }
  const byTime = new Map<string, CatalogueHistoryPoint>();
  for (const point of [
    ...sampled,
    points[minIndex],
    points[maxIndex],
  ]) {
    byTime.set(point.t, point);
  }
  return [...byTime.values()].sort((left, right) => left.t.localeCompare(right.t));
}

/**
 * Price history for one catalogue listing and range. The query keeps a
 * single pre-range observation as a carry-in so the chart and statistics
 * start at the range boundary with the price that was actually active.
 */
export async function getCatalogueListingHistory(
  retailerListingId: string,
  range: CatalogueHistoryRange,
  userId?: string,
): Promise<CatalogueHistoryResult | null> {
  void userId; // History is shared catalogue data; the user id is accepted for API symmetry.

  const listing = await db.retailerListing.findUnique({
    where: { id: retailerListingId },
    select: {
      id: true,
      currency: true,
      currentPriceMinor: true,
    },
  });
  if (!listing) {
    return null;
  }

  const now = new Date();
  const cutoff = catalogueHistoryCutoff(range, now);

  const [carryIn, observations] = await Promise.all([
    cutoff
      ? db.listingObservation.findFirst({
          where: {
            retailerListingId,
            currency: listing.currency,
            priceMinor: { not: null },
            observedAt: { lt: cutoff },
          },
          orderBy: { observedAt: "desc" },
          select: { observedAt: true, priceMinor: true, availability: true },
        })
      : Promise.resolve(null),
    db.listingObservation.findMany({
      where: {
        retailerListingId,
        currency: listing.currency,
        priceMinor: { not: null },
        observedAt: cutoff ? { gte: cutoff, lte: now } : { lte: now },
      },
      orderBy: { observedAt: "asc" },
      select: { observedAt: true, priceMinor: true, availability: true },
    }),
  ]);

  const typedObservations: HistoryObservation[] = observations.flatMap(
    (observation) =>
      observation.priceMinor === null
        ? []
        : [
            {
              observedAt: observation.observedAt,
              priceMinor: observation.priceMinor,
              availability: observation.availability,
            },
          ],
  );

  const firstObservedAt =
    cutoff ??
    (carryIn?.observedAt ?? typedObservations[0]?.observedAt ?? now);
  const from = firstObservedAt;

  const changePoints: Array<{ observedAt: Date; priceMinor: number }> = [];
  if (carryIn) {
    changePoints.push({
      observedAt: from,
      priceMinor: carryIn.priceMinor as number,
    });
  }
  for (const observation of typedObservations) {
    const last = changePoints.at(-1);
    if (last?.priceMinor === observation.priceMinor) {
      continue;
    }
    changePoints.push({
      observedAt: observation.observedAt,
      priceMinor: observation.priceMinor,
    });
  }

  if (changePoints.length === 0 && listing.currentPriceMinor !== null) {
    changePoints.push({ observedAt: from, priceMinor: listing.currentPriceMinor });
  }

  let weightedSum = 0;
  let trackedDurationMs = 0;
  let lowestPriceMinor: number | null = null;
  let highestPriceMinor: number | null = null;

  for (let index = 0; index < changePoints.length; index += 1) {
    const point = changePoints[index];
    const next = changePoints[index + 1];
    const startMs = Math.max(point.observedAt.getTime(), from.getTime());
    const endMs = Math.min(next?.observedAt.getTime() ?? now.getTime(), now.getTime());
    if (endMs > startMs) {
      const duration = endMs - startMs;
      trackedDurationMs += duration;
      weightedSum += point.priceMinor * duration;
    }
    lowestPriceMinor =
      lowestPriceMinor === null || point.priceMinor < lowestPriceMinor
        ? point.priceMinor
        : lowestPriceMinor;
    highestPriceMinor =
      highestPriceMinor === null || point.priceMinor > highestPriceMinor
        ? point.priceMinor
        : highestPriceMinor;
  }

  // Extend the line to "now" so the latest observed price is not stranded in
  // the past. A change at exactly now is already present.
  const lastPoint = changePoints.at(-1);
  const currentPriceMinor = lastPoint?.priceMinor ?? listing.currentPriceMinor;
  const points: CatalogueHistoryPoint[] = changePoints.map((point) => ({
    t: point.observedAt.toISOString(),
    priceMinor: point.priceMinor,
  }));
  if (
    currentPriceMinor !== null &&
    (points.length === 0 || points[points.length - 1].t !== now.toISOString())
  ) {
    points.push({ t: now.toISOString(), priceMinor: currentPriceMinor });
  }

  return {
    range,
    currency: listing.currency,
    points: downsamplePoints(points, 2_000),
    stats: {
      hasData: changePoints.length > 0,
      from: from.toISOString(),
      to: now.toISOString(),
      currency: listing.currency,
      currentPriceMinor,
      lowestPriceMinor,
      highestPriceMinor,
      averagePriceMinor:
        trackedDurationMs > 0
          ? Math.round(weightedSum / trackedDurationMs)
          : lowestPriceMinor,
      pointCount: changePoints.length,
    },
  };
}
