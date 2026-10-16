import { db } from "@/lib/db";

/**
 * User-owned inventory persistence.
 *
 * Every function that reads or mutates an inventory item requires the
 * owning user id, so a shared canonical product or retailer listing can
 * never expose another user's inventory membership or alert configuration.
 */
export async function ensureInventoryItem(
  userId: string,
  canonicalProductId: string,
): Promise<{ id: string; userId: string; canonicalProductId: string }> {
  return db.inventoryItem.upsert({
    where: {
      userId_canonicalProductId: { userId, canonicalProductId },
    },
    create: { userId, canonicalProductId },
    update: {},
    select: { id: true, userId: true, canonicalProductId: true },
  });
}

export async function findInventoryItemByCanonicalProduct(
  userId: string,
  canonicalProductId: string,
): Promise<{ id: string; userId: string; canonicalProductId: string } | null> {
  return db.inventoryItem.findUnique({
    where: {
      userId_canonicalProductId: { userId, canonicalProductId },
    },
    select: { id: true, userId: true, canonicalProductId: true },
  });
}

const listingSummarySelect = {
  id: true,
  retailerId: true,
  sku: true,
  gtin: true,
  mpn: true,
  name: true,
  url: true,
  imageUrl: true,
  currency: true,
  currentPriceMinor: true,
  currentOriginalPriceMinor: true,
  currentDiscountPct: true,
  currentAvailability: true,
  lastCheckedAt: true,
  lastSeenAt: true,
} as const;

const subscriptionSummarySelect = {
  id: true,
  status: true,
  condition: true,
  targetPriceMinor: true,
  intervalMinutes: true,
  snapshotIntervalMinutes: true,
  nextCheckAt: true,
  archivedAt: true,
  createdAt: true,
} as const;

/**
 * Full owned inventory detail for one item: shared catalogue listings plus
 * only this user's subscriptions attached to them.
 */
export async function findInventoryItemForUser(
  inventoryItemId: string,
  userId: string,
) {
  return db.inventoryItem.findFirst({
    where: { id: inventoryItemId, userId },
    include: {
      canonicalProduct: {
        select: {
          id: true,
          name: true,
          brand: true,
          model: true,
          gtin: true,
          mpn: true,
          listings: {
            select: {
              ...listingSummarySelect,
              subscriptions: {
                where: { userId },
                select: subscriptionSummarySelect,
                orderBy: { createdAt: "desc" },
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      },
      alertRules: true,
    },
  });
}

/**
 * Inventory list. Alert rules are intentionally omitted; the detail view
 * loads them only for the owning user.
 */
export async function listInventoryItemsForUser(userId: string) {
  return db.inventoryItem.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      canonicalProduct: {
        select: {
          id: true,
          name: true,
          brand: true,
          model: true,
          gtin: true,
          mpn: true,
          listings: {
            select: {
              ...listingSummarySelect,
              subscriptions: {
                where: { userId },
                select: { id: true, status: true },
                orderBy: { createdAt: "desc" },
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      },
    },
  });
}

/**
 * Remove an inventory item from the user's collection. Monitoring
 * subscriptions for the product are archived, never deleted, so price
 * history and past notifications survive. Shared catalogue rows and their
 * observations are untouched.
 */
export async function removeInventoryItemForUser(
  inventoryItemId: string,
  userId: string,
): Promise<boolean> {
  const item = await db.inventoryItem.findFirst({
    where: { id: inventoryItemId, userId },
    select: { id: true, canonicalProductId: true },
  });
  if (!item) {
    return false;
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    const listings = await tx.retailerListing.findMany({
      where: { canonicalProductId: item.canonicalProductId },
      select: { id: true },
    });
    const listingIds = listings.map((listing) => listing.id);

    if (listingIds.length > 0) {
      await tx.monitoringSubscription.updateMany({
        where: {
          userId,
          retailerListingId: { in: listingIds },
          status: { not: "ARCHIVED" },
        },
        data: {
          status: "ARCHIVED",
          archivedAt: now,
          nextCheckAt: null,
        },
      });
    }

    // PriceAlertRule rows cascade with this user-owned inventory row.
    await tx.inventoryItem.delete({ where: { id: item.id } });
  });

  return true;
}
