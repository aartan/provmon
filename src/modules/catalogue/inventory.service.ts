import { db } from "@/lib/db";
import { findOrCreateListing } from "@/modules/catalogue/catalogue.repository";
import {
  ensureInventoryItem,
  findInventoryItemByCanonicalProduct,
  findInventoryItemForUser,
} from "@/modules/catalogue/inventory.repository";
import {
  fetchProductFromUrl,
  ProductFetchError,
} from "@/modules/catalogue/product-fetch";
import {
  createSubscription,
  updateSubscription,
} from "@/modules/monitoring/repository";
import {
  createSubscriptionSchema,
  requiresTargetPrice,
} from "@/modules/monitoring/schemas";
import { intervalOptionsForRetailer } from "@/modules/monitoring/service";
import type { MonitoringCondition } from "@/modules/monitoring/types";

/** User-facing inventory-service error with an HTTP status hint. */
export class InventoryServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "InventoryServiceError";
  }
}

export interface AddInventoryItemInput {
  userId: string;
  url: string;
}

/**
 * Add a product to the user's inventory without creating any monitoring
 * subscription. The canonical product and retailer listing are shared
 * catalogue rows; only the user-owned inventory membership is created.
 */
export async function addInventoryItem(input: AddInventoryItemInput) {
  let fetched;
  try {
    fetched = await fetchProductFromUrl(input.url);
  } catch (error) {
    if (error instanceof ProductFetchError) {
      throw new InventoryServiceError(error.message);
    }
    throw error;
  }

  const listing = await findOrCreateListing(fetched.details);
  const existing = await findInventoryItemByCanonicalProduct(
    input.userId,
    listing.canonicalProductId,
  );
  const inventoryItem =
    existing ??
    (await ensureInventoryItem(
      input.userId,
      listing.canonicalProductId,
    ));

  return {
    inventoryItem,
    created: existing === null,
    listing,
  };
}

export interface AttachMonitoringInput {
  userId: string;
  inventoryItemId: string;
  retailerListingId: string;
  targetPriceMinor?: number;
  condition: MonitoringCondition;
  intervalMinutes: number;
  snapshotIntervalMinutes?: number;
}

/**
 * Attach a monitoring subscription to one of the user's inventory listings.
 * The listing must belong to this inventory item's canonical product, so an
 * inventory id can never be used to monitor another user's unrelated
 * listing.
 */
export async function attachMonitoringToInventoryItem(
  input: AttachMonitoringInput,
) {
  const inventoryItem = await findInventoryItemForUser(
    input.inventoryItemId,
    input.userId,
  );
  if (!inventoryItem) {
    throw new InventoryServiceError("Inventory item not found", 404);
  }

  const listing = inventoryItem.canonicalProduct.listings.find(
    (candidate) => candidate.id === input.retailerListingId,
  );
  if (!listing) {
    throw new InventoryServiceError(
      "That retailer listing does not belong to this inventory item",
    );
  }

  const validated = createSubscriptionSchema.safeParse({
    retailerListingId: input.retailerListingId,
    targetPriceMinor: input.targetPriceMinor,
    condition: input.condition,
    intervalMinutes: input.intervalMinutes,
    snapshotIntervalMinutes: input.snapshotIntervalMinutes,
  });
  if (!validated.success) {
    throw new InventoryServiceError(
      validated.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  if (
    requiresTargetPrice(input.condition) &&
    input.targetPriceMinor === undefined
  ) {
    throw new InventoryServiceError(
      "A target price is required for price monitoring",
    );
  }

  const allowedIntervals = await intervalOptionsForRetailer(listing.retailerId);
  if (!allowedIntervals.includes(input.intervalMinutes)) {
    throw new InventoryServiceError(
      `Interval must be one of: ${allowedIntervals.join(", ")} minutes`,
    );
  }

  const existing = await db.monitoringSubscription.findUnique({
    where: {
      userId_retailerListingId: {
        userId: input.userId,
        retailerListingId: input.retailerListingId,
      },
    },
  });
  if (existing) {
    if (existing.status === "ARCHIVED") {
      const resumed = await updateSubscription(existing.id, input.userId, {
        status: "ACTIVE",
        condition: input.condition,
        targetPriceMinor: input.targetPriceMinor ?? null,
        intervalMinutes: input.intervalMinutes,
        snapshotIntervalMinutes: input.snapshotIntervalMinutes,
      });
      if (!resumed) {
        throw new InventoryServiceError("Could not resume monitoring");
      }
      return resumed;
    }
    throw new InventoryServiceError(
      "You are already monitoring this retailer listing",
    );
  }

  return createSubscription({
    userId: input.userId,
    retailerListingId: input.retailerListingId,
    targetPriceMinor: input.targetPriceMinor,
    condition: input.condition,
    intervalMinutes: input.intervalMinutes,
    snapshotIntervalMinutes: input.snapshotIntervalMinutes,
    initialAvailability: listing.currentAvailability,
  });
}
