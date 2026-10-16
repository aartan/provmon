import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import type {
  AvailabilityStatus,
  ProductDetails,
} from "@/modules/retailers/core/types";
import {
  normalizeBrandKey,
  normalizeGtin,
  normalizeMpnKey,
} from "@/modules/catalogue/identifiers";

/**
 * Shared catalogue persistence: canonical products and their retailer
 * listings. Listings are keyed by retailer identity and are shared across
 * users; user-specific state lives in inventory and monitoring modules.
 *
 * Every function accepts and returns normalised shapes only — retailer data
 * never reaches the database in any other form.
 */
export interface StoredRetailerListing {
  id: string;
  canonicalProductId: string;
  retailerId: string;
  retailerProductId: string | null;
  sku: string | null;
  gtin: string | null;
  mpn: string | null;
  brand: string | null;
  model: string | null;
  name: string;
  url: string;
  imageUrl: string | null;
  currency: string;
  currentPriceMinor: number | null;
  currentOriginalPriceMinor: number | null;
  currentDiscountPct: number | null;
  currentAvailability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN";
  lastCheckedAt: Date | null;
  lastSuccessfulAt: Date | null;
  lastSeenAt: Date | null;
  delistedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/** Compute the displayed discount percentage from a current and original price. */
export function computeDiscountPct(
  priceMinor: number | null,
  originalPriceMinor: number | null,
  provided?: number,
): number | null {
  if (provided !== undefined) {
    return Math.max(0, Math.min(100, Math.round(provided)));
  }
  if (
    priceMinor === null ||
    originalPriceMinor === null ||
    originalPriceMinor <= 0
  ) {
    return null;
  }
  if (priceMinor >= originalPriceMinor) {
    return 0;
  }
  return Math.round(
    ((originalPriceMinor - priceMinor) / originalPriceMinor) * 100,
  );
}

export async function findListingByRetailerIdentity(
  retailerId: string,
  retailerProductId: string | undefined,
  url?: string,
): Promise<StoredRetailerListing | null> {
  // When the retailer exposes no product id, the canonical URL is the only
  // stable identity available. Never collapse unrelated URL-less listings.
  return db.retailerListing.findFirst({
    where:
      retailerProductId !== undefined
        ? { retailerId, retailerProductId }
        : { retailerId, retailerProductId: null, ...(url ? { url } : {}) },
  });
}

interface CanonicalProductInput {
  name: string;
  brand?: string;
  model?: string;
  gtin: string | null;
  mpn?: string;
  brandKey: string | null;
  mpnKey: string | null;
}

/**
 * Resolve the canonical product for a listing using identifier-first
 * matching. A GTIN is authoritative; otherwise a normalised brand + MPN
 * pair may match. Everything else creates a new canonical product.
 */
async function findOrCreateCanonicalProduct(
  input: CanonicalProductInput,
): Promise<{ id: string }> {
  if (input.gtin) {
    const byGtin = await db.canonicalProduct.findUnique({
      where: { gtin: input.gtin },
      select: { id: true, gtin: true, brand: true, model: true },
    });
    if (byGtin) {
      const updates: Prisma.CanonicalProductUpdateInput = {};
      if (!byGtin.brand && input.brand) {
        updates.brand = input.brand;
      }
      if (!byGtin.model && input.model) {
        updates.model = input.model;
      }
      if (Object.keys(updates).length > 0) {
        await db.canonicalProduct.update({
          where: { id: byGtin.id },
          data: updates,
        });
      }
      return byGtin;
    }
  }

  if (input.brandKey && input.mpnKey) {
    const byMpn = await db.canonicalProduct.findUnique({
      where: {
        brandKey_mpnKey: {
          brandKey: input.brandKey,
          mpnKey: input.mpnKey,
        },
      },
      select: { id: true, gtin: true, brand: true, model: true },
    });
    if (byMpn) {
      const updates: Prisma.CanonicalProductUpdateInput = {};
      if (!byMpn.gtin && input.gtin) {
        updates.gtin = input.gtin;
      }
      if (!byMpn.brand && input.brand) {
        updates.brand = input.brand;
      }
      if (!byMpn.model && input.model) {
        updates.model = input.model;
      }
      if (Object.keys(updates).length > 0) {
        await db.canonicalProduct.update({
          where: { id: byMpn.id },
          data: updates,
        });
      }
      return byMpn;
    }
  }

  try {
    return await db.canonicalProduct.create({
      data: {
        name: input.name,
        brand: input.brand ?? null,
        model: input.model ?? null,
        gtin: input.gtin,
        mpn: input.mpn ?? null,
        brandKey: input.brandKey,
        mpnKey: input.mpnKey,
      },
      select: { id: true },
    });
  } catch (error) {
    // A concurrent add may have created the same identifier first.
    if (isUniqueConstraintError(error)) {
      if (input.gtin) {
        const byGtin = await db.canonicalProduct.findUnique({
          where: { gtin: input.gtin },
          select: { id: true },
        });
        if (byGtin) {
          return byGtin;
        }
      }
      if (input.brandKey && input.mpnKey) {
        const byMpn = await db.canonicalProduct.findUnique({
          where: {
            brandKey_mpnKey: {
              brandKey: input.brandKey,
              mpnKey: input.mpnKey,
            },
          },
          select: { id: true },
        });
        if (byMpn) {
          return byMpn;
        }
      }
    }
    throw error;
  }
}

/**
 * Find an existing retailer listing by retailer identity or create it from
 * freshly fetched details, associating it with a canonical product.
 *
 * If the listing already exists it is returned untouched: shared catalogue
 * data is never silently moved between canonical products.
 */
export async function findOrCreateListing(
  details: ProductDetails,
): Promise<StoredRetailerListing> {
  const existing = await findListingByRetailerIdentity(
    details.retailerId,
    details.retailerProductId,
    details.url,
  );
  if (existing) {
    return existing;
  }

  const gtin = normalizeGtin(details.gtin);
  const brandKey = normalizeBrandKey(details.brand);
  const mpnKey = normalizeMpnKey(details.mpn);

  const canonical = await findOrCreateCanonicalProduct({
    name: details.name,
    brand: details.brand,
    model: details.model,
    gtin,
    mpn: details.mpn,
    brandKey,
    mpnKey,
  });

  const now = new Date();
  const discountPct = computeDiscountPct(
    details.priceMinor ?? null,
    details.originalPriceMinor ?? null,
    details.discountPct,
  );
  try {
    return await db.$transaction(async (tx) => {
      const listing = await tx.retailerListing.create({
        data: {
          canonicalProductId: canonical.id,
          retailerId: details.retailerId,
          retailerProductId: details.retailerProductId ?? null,
          sku: details.sku ?? details.retailerProductId ?? null,
          gtin,
          mpn: details.mpn ?? null,
          brand: details.brand ?? null,
          model: details.model ?? null,
          name: details.name,
          url: details.url,
          imageUrl: details.imageUrl || null,
          currency: details.currency,
          currentPriceMinor: details.priceMinor ?? null,
          currentOriginalPriceMinor: details.originalPriceMinor ?? null,
          currentDiscountPct: discountPct,
          currentAvailability: details.availability,
          lastCheckedAt: now,
          lastSuccessfulAt: now,
          lastSeenAt: now,
        },
      });

      // The add flow just fetched this state from the retailer, so it is a
      // truthful baseline rather than a fabricated historical observation.
      await tx.listingObservation.create({
        data: {
          retailerListingId: listing.id,
          priceMinor: details.priceMinor ?? null,
          originalPriceMinor: details.originalPriceMinor ?? null,
          discountPct,
          currency: details.currency,
          availability: details.availability,
          kind: "INITIAL",
          observedAt: now,
        },
      });

      return listing;
    });
  } catch (error) {
    // Lost a race with another user adding the same listing.
    if (isUniqueConstraintError(error)) {
      const raced = await findListingByRetailerIdentity(
        details.retailerId,
        details.retailerProductId,
        details.url,
      );
      if (raced) {
        return raced;
      }
    }
    throw error;
  }
}

export type ListingObservationKind =
  | "INITIAL"
  | "CHANGE"
  | "SNAPSHOT"
  | "BACKFILL";

export interface ListingCheckState {
  availability: AvailabilityStatus;
  priceMinor: number | null;
}

export interface ListingObservationSummary {
  id: string;
  kind: ListingObservationKind;
  observedAt: Date;
}

export interface ListingCheckResult {
  previous: ListingCheckState;
  current: ListingCheckState;
  observation: ListingObservationSummary | null;
}

export interface UpdateListingFromCheckOptions {
  /**
   * Fallback snapshot cadence in minutes when no active subscription
   * defines one. 0 disables unchanged snapshots.
   */
  snapshotIntervalMinutes?: number;
  /** True when the adapter reported the listing as no longer available. */
  delisted?: boolean;
}

interface LockedListingRow {
  current_price_minor: number | null;
  current_original_price_minor: number | null;
  current_availability: AvailabilityStatus;
  currency: string;
  image_url: string | null;
  gtin: string | null;
  mpn: string | null;
  brand: string | null;
  model: string | null;
}

/**
 * Resolve the snapshot cadence for a listing. The finest positive cadence
 * among active subscriptions wins: shared history must be at least as
 * granular as the most demanding user requested. When nobody is actively
 * monitoring, the caller's fallback applies (manual checks).
 */
async function resolveSnapshotIntervalMinutes(
  tx: Prisma.TransactionClient,
  retailerListingId: string,
  fallback: number,
): Promise<number> {
  const active = await tx.monitoringSubscription.findMany({
    where: { retailerListingId, status: "ACTIVE" },
    select: { snapshotIntervalMinutes: true },
  });

  if (active.length === 0) {
    return Math.max(0, fallback);
  }

  const positive = active
    .map((subscription) => subscription.snapshotIntervalMinutes)
    .filter((minutes) => minutes > 0);
  return positive.length > 0 ? Math.min(...positive) : 0;
}

/**
 * Update a listing's current state from a successful check and append the
 * observation history.
 *
 * The listing row is locked with SELECT ... FOR UPDATE before the previous
 * state is read, so concurrent checks for the same shared listing serialize:
 * exactly one check observes a transition, and the others see the new state
 * instead of duplicating price-change or availability-change rows.
 */
export async function updateListingFromCheck(
  retailerListingId: string,
  details: ProductDetails,
  options: UpdateListingFromCheckOptions = {},
): Promise<ListingCheckResult> {
  const now = new Date();

  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedListingRow[]>`
      SELECT
        "current_price_minor",
        "current_original_price_minor",
        "current_availability",
        "currency",
        "image_url",
        "gtin",
        "mpn",
        "brand",
        "model"
      FROM "retailer_listings"
      WHERE "id" = ${retailerListingId}
      FOR UPDATE
    `;
    const listing = rows[0];
    if (!listing) {
      throw new Error(`Retailer listing ${retailerListingId} not found`);
    }

    const previous: ListingCheckState = {
      availability: listing.current_availability,
      priceMinor: listing.current_price_minor,
    };

    const nextPrice =
      details.priceMinor === undefined
        ? listing.current_price_minor
        : details.priceMinor;
    const nextOriginal =
      details.originalPriceMinor === undefined
        ? listing.current_original_price_minor
        : details.originalPriceMinor;
    const nextDiscount = computeDiscountPct(
      nextPrice,
      nextOriginal,
      details.discountPct,
    );

    const priceChanged =
      nextPrice !== listing.current_price_minor ||
      details.currency !== listing.currency;
    const availabilityChanged =
      listing.current_availability !== details.availability;

    await tx.retailerListing.update({
      where: { id: retailerListingId },
      data: {
        name: details.name,
        imageUrl: details.imageUrl || listing.image_url,
        gtin: normalizeGtin(details.gtin) ?? listing.gtin,
        mpn: details.mpn ?? listing.mpn,
        brand: details.brand ?? listing.brand,
        model: details.model ?? listing.model,
        currency: details.currency,
        currentPriceMinor: nextPrice,
        currentOriginalPriceMinor: nextOriginal,
        currentDiscountPct: nextDiscount,
        currentAvailability: details.availability,
        lastCheckedAt: now,
        lastSuccessfulAt: now,
        ...(options.delisted
          ? { delistedAt: now }
          : { delistedAt: null, lastSeenAt: now }),
      },
    });

    const latest = await tx.listingObservation.findFirst({
      where: { retailerListingId },
      orderBy: { observedAt: "desc" },
      select: { observedAt: true },
    });

    let kind: "CHANGE" | "SNAPSHOT" | null = null;
    if (priceChanged || availabilityChanged) {
      kind = "CHANGE";
    } else if (!latest) {
      // Baseline for a listing that predates the history table.
      kind = "SNAPSHOT";
    } else {
      const intervalMinutes = await resolveSnapshotIntervalMinutes(
        tx,
        retailerListingId,
        options.snapshotIntervalMinutes ?? 0,
      );
      if (
        intervalMinutes > 0 &&
        now.getTime() - latest.observedAt.getTime() >=
          intervalMinutes * 60_000
      ) {
        kind = "SNAPSHOT";
      }
    }

    let observation: ListingObservationSummary | null = null;
    if (kind !== null) {
      observation = await tx.listingObservation.create({
        data: {
          retailerListingId,
          priceMinor: nextPrice,
          originalPriceMinor: nextOriginal,
          discountPct: nextDiscount,
          currency: details.currency,
          availability: details.availability,
          kind,
          observedAt: now,
        },
        select: { id: true, kind: true, observedAt: true },
      });
    }

    return {
      previous,
      current: {
        availability: details.availability,
        priceMinor: nextPrice,
      },
      observation,
    };
  });
}

/** Mark a listing as checked even when the retailer call failed. */
export async function markListingChecked(
  retailerListingId: string,
): Promise<void> {
  await db.retailerListing.update({
    where: { id: retailerListingId },
    data: { lastCheckedAt: new Date() },
  });
}

export interface ListingPricePoint {
  id: string;
  retailerListingId: string;
  priceMinor: number;
  currency: string | null;
  observedAt: Date;
}

export interface ListingAvailabilityPoint {
  id: string;
  retailerListingId: string;
  availability: AvailabilityStatus;
  observedAt: Date;
}

/**
 * Full append-only observation history for a listing, oldest first. This is
 * the source of truth for analytics and for the change-only projections
 * consumed by the existing product page.
 */
export async function listListingObservations(retailerListingId: string) {
  return db.listingObservation.findMany({
    where: { retailerListingId },
    orderBy: { observedAt: "asc" },
    select: {
      id: true,
      retailerListingId: true,
      priceMinor: true,
      currency: true,
      availability: true,
      kind: true,
      observedAt: true,
    },
  });
}

/**
 * Change-only projection of the history used by the existing product page
 * and API. Periodic unchanged snapshots extend durations but never appear
 * as independent price or availability changes.
 */
export async function getListingHistory(
  retailerListingId: string,
): Promise<{
  priceObservations: ListingPricePoint[];
  availabilityObservations: ListingAvailabilityPoint[];
}> {
  const observations = await listListingObservations(retailerListingId);

  const priceObservations: ListingPricePoint[] = [];
  const availabilityObservations: ListingAvailabilityPoint[] = [];
  let lastPrice: number | null = null;
  let lastCurrency: string | null = null;
  let lastAvailability: AvailabilityStatus | null = null;

  for (const observation of observations) {
    if (
      observation.priceMinor !== null &&
      (observation.priceMinor !== lastPrice ||
        observation.currency !== lastCurrency)
    ) {
      priceObservations.push({
        id: observation.id,
        retailerListingId,
        priceMinor: observation.priceMinor,
        currency: observation.currency,
        observedAt: observation.observedAt,
      });
      lastPrice = observation.priceMinor;
      lastCurrency = observation.currency;
    }

    if (
      observation.availability !== null &&
      observation.availability !== lastAvailability
    ) {
      availabilityObservations.push({
        id: observation.id,
        retailerListingId,
        availability: observation.availability,
        observedAt: observation.observedAt,
      });
      lastAvailability = observation.availability;
    }
  }

  return { priceObservations, availabilityObservations };
}
