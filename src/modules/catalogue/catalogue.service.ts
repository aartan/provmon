import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  findCatalogueListingsForBulk,
  type CatalogueBulkListing,
} from "@/modules/catalogue/browse.repository";
import {
  ensureInventoryItem,
  findInventoryItemByCanonicalProduct,
} from "@/modules/catalogue/inventory.repository";
import {
  createSubscription,
  updateSubscription,
} from "@/modules/monitoring/repository";
import { intervalOptionsForRetailer } from "@/modules/monitoring/service";
import {
  createSubscriptionSchema,
  requiresTargetPrice,
} from "@/modules/monitoring/schemas";
import type { MonitoringCondition } from "@/modules/monitoring/types";

/**
 * Catalogue actions that are not simple reads: bulk inventory membership
 * and bulk monitoring. Shared catalogue rows are never user-owned; only the
 * membership rows created here are scoped to the signed-in user.
 */

export const MAX_BULK_CATALOGUE_LISTINGS = 100;
export const DEFAULT_CATALOGUE_MONITOR_INTERVAL_MINUTES = 15;

export class CatalogueServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "CatalogueServiceError";
  }
}

function normalizeListingIds(listingIds: string[]): string[] {
  const ids = [...new Set(listingIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    throw new CatalogueServiceError("Select at least one product", 400);
  }
  if (ids.length > MAX_BULK_CATALOGUE_LISTINGS) {
    throw new CatalogueServiceError(
      `Select at most ${MAX_BULK_CATALOGUE_LISTINGS} products at a time`,
      400,
    );
  }
  return ids;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

function lookupListings(
  listings: CatalogueBulkListing[],
  listingIds: string[],
): Map<string, CatalogueBulkListing> {
  const found = new Map(listings.map((listing) => [listing.id, listing]));
  const missing = listingIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new CatalogueServiceError(
      `Some selected products no longer exist (${missing.length})`,
      404,
    );
  }
  return found;
}

export interface BulkInventoryResult {
  requestedListings: number;
  trackedProducts: number;
  addedProducts: number;
  alreadyTrackedProducts: number;
}

/**
 * Save catalogue listings to the user's inventory. Multiple listings of the
 * same canonical product collapse into one inventory item, matching the
 * catalogue's product-level inventory model.
 */
export async function addCatalogueListingsToInventory(
  userId: string,
  listingIds: string[],
): Promise<BulkInventoryResult> {
  const ids = normalizeListingIds(listingIds);
  const listings = await findCatalogueListingsForBulk(ids);
  lookupListings(listings, ids);

  const canonicalIds = [
    ...new Set(listings.map((listing) => listing.canonicalProductId)),
  ];
  const existing = await db.inventoryItem.findMany({
    where: { userId, canonicalProductId: { in: canonicalIds } },
    select: { canonicalProductId: true },
  });
  const existingIds = new Set(existing.map((item) => item.canonicalProductId));
  const missing = canonicalIds.filter((id) => !existingIds.has(id));

  if (missing.length > 0) {
    await db.inventoryItem.createMany({
      data: missing.map((canonicalProductId) => ({
        userId,
        canonicalProductId,
      })),
      skipDuplicates: true,
    });
  }

  return {
    requestedListings: ids.length,
    trackedProducts: canonicalIds.length,
    addedProducts: missing.length,
    alreadyTrackedProducts: canonicalIds.length - missing.length,
  };
}

export interface BulkMonitoringOptions {
  condition?: MonitoringCondition;
  targetPriceMinor?: number;
  intervalMinutes?: number;
  snapshotIntervalMinutes?: number;
}

export interface BulkMonitoringResult {
  requestedListings: number;
  added: number;
  resumed: number;
  skipped: number;
  failed: Array<{ listingId: string; message: string }>;
}

/**
 * Start monitoring for many catalogue listings. Existing active
 * subscriptions are left untouched; paused or archived subscriptions are
 * resumed. Each subscription still evaluates its own condition and target,
 * so adding the same shared listing for another user never shares state.
 */
export async function addCatalogueListingsToMonitoring(
  userId: string,
  listingIds: string[],
  options: BulkMonitoringOptions = {},
): Promise<BulkMonitoringResult> {
  const ids = normalizeListingIds(listingIds);
  const condition = options.condition ?? "BACK_IN_STOCK";
  const intervalMinutes =
    options.intervalMinutes ?? DEFAULT_CATALOGUE_MONITOR_INTERVAL_MINUTES;

  const validated = createSubscriptionSchema.safeParse({
    retailerListingId: "bulk",
    targetPriceMinor: options.targetPriceMinor,
    condition,
    intervalMinutes,
    snapshotIntervalMinutes: options.snapshotIntervalMinutes,
  });
  if (!validated.success) {
    throw new CatalogueServiceError(
      validated.error.issues.map((issue) => issue.message).join("; "),
      400,
    );
  }
  if (requiresTargetPrice(condition) && options.targetPriceMinor === undefined) {
    throw new CatalogueServiceError(
      "A target price is required for price monitoring",
      400,
    );
  }

  const listings = await findCatalogueListingsForBulk(ids);
  const byId = lookupListings(listings, ids);

  const existingSubscriptions = await db.monitoringSubscription.findMany({
    where: { userId, retailerListingId: { in: ids } },
    select: { id: true, retailerListingId: true, status: true },
  });
  const existingByListing = new Map(
    existingSubscriptions.map((subscription) => [
      subscription.retailerListingId,
      subscription,
    ]),
  );

  const result: BulkMonitoringResult = {
    requestedListings: ids.length,
    added: 0,
    resumed: 0,
    skipped: 0,
    failed: [],
  };

  for (const listingId of ids) {
    const listing = byId.get(listingId);
    if (!listing) {
      continue;
    }

    const existing = existingByListing.get(listingId);
    if (!existing || options.intervalMinutes !== undefined) {
      const requestedInterval = options.intervalMinutes ?? intervalMinutes;
      const allowedIntervals = await intervalOptionsForRetailer(listing.retailerId);
      if (!allowedIntervals.includes(requestedInterval)) {
        result.failed.push({
          listingId,
          message: `Interval must be one of: ${allowedIntervals.join(", ")} minutes`,
        });
        continue;
      }
    }

    try {
      if (existing) {
        if (existing.status === "ACTIVE") {
          result.skipped += 1;
          continue;
        }
        // Resume without discarding a configuration the user chose earlier.
        // Only fields explicitly supplied by this bulk action are applied.
        const resumed = await updateSubscription(existing.id, userId, {
          status: "ACTIVE",
          ...(options.condition !== undefined
            ? { condition: options.condition }
            : {}),
          ...(options.targetPriceMinor !== undefined
            ? { targetPriceMinor: options.targetPriceMinor }
            : {}),
          ...(options.intervalMinutes !== undefined
            ? { intervalMinutes: options.intervalMinutes }
            : {}),
          ...(options.snapshotIntervalMinutes !== undefined
            ? { snapshotIntervalMinutes: options.snapshotIntervalMinutes }
            : {}),
        });
        if (!resumed) {
          result.failed.push({ listingId, message: "Could not resume monitoring" });
        } else {
          result.resumed += 1;
        }
        continue;
      }

      await createSubscription({
        userId,
        retailerListingId: listingId,
        targetPriceMinor: options.targetPriceMinor,
        condition,
        intervalMinutes,
        snapshotIntervalMinutes: options.snapshotIntervalMinutes,
        initialAvailability: listing.currentAvailability,
      });
      result.added += 1;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        result.skipped += 1;
        continue;
      }
      logger.error(
        { component: "catalogue", userId, listingId, err: error },
        "bulk monitoring add failed",
      );
      result.failed.push({
        listingId,
        message:
          error instanceof Error ? error.message : "Could not start monitoring",
      });
    }
  }

  return result;
}

/**
 * Add one listing to inventory. Used by the catalogue detail page, where a
 * single click should not need the bulk endpoint's selection contract.
 */
export async function addCatalogueListingToInventory(
  userId: string,
  listingId: string,
): Promise<{ inventoryItemId: string; created: boolean }> {
  const [listing] = await findCatalogueListingsForBulk([listingId]);
  if (!listing) {
    throw new CatalogueServiceError("Product not found", 404);
  }
  const existing = await findInventoryItemByCanonicalProduct(
    userId,
    listing.canonicalProductId,
  );
  if (existing) {
    return { inventoryItemId: existing.id, created: false };
  }
  const item = await ensureInventoryItem(userId, listing.canonicalProductId);
  return { inventoryItemId: item.id, created: true };
}
