import Redis from "ioredis";

import { db } from "@/lib/db";
import { TEST_REDIS_URL } from "@test/setup/global-setup";

/**
 * Integration test helpers. Reset the test database and the dedicated test
 * Redis instance (database 1) between tests so each test starts clean.
 */

export const testRedis = new Redis(TEST_REDIS_URL, {
  maxRetriesPerRequest: null,
});

export async function flushRedis(): Promise<void> {
  await testRedis.flushdb();
}

/** Delete every row in FK-safe order. */
export async function resetDb(): Promise<void> {
  await db.$transaction([
    db.catalogueDiscoveryRun.deleteMany(),
    db.retailerCatalogue.deleteMany(),
    db.notification.deleteMany(),
    db.monitoringCheck.deleteMany(),
    db.listingObservation.deleteMany(),
    db.priceAlertRule.deleteMany(),
    db.monitoringSubscription.deleteMany(),
    db.inventoryItem.deleteMany(),
    db.retailerListing.deleteMany(),
    db.canonicalProduct.deleteMany(),
    db.notificationPreference.deleteMany(),
    db.user.deleteMany(),
  ]);
}

export async function resetTestState(): Promise<void> {
  await resetDb();
  await flushRedis();
}

export async function createTestUser(email = "test@example.com"): Promise<string> {
  const user = await db.user.create({
    data: { email, passwordHash: "not-a-real-hash", name: "Test User" },
  });
  await db.notificationPreference.create({ data: { userId: user.id } });
  return user.id;
}

/**
 * Create a catalogue listing with a canonical product for repository-level
 * tests that do not go through the add-product flow.
 */
export async function createTestListing(input: {
  retailerId?: string;
  retailerProductId?: string | null;
  name?: string;
  url?: string;
  currency?: string;
  currentPriceMinor?: number | null;
  currentAvailability?: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN";
  canonicalProductId?: string;
  brand?: string | null;
  model?: string | null;
  category?: string | null;
  imageUrl?: string | null;
} = {}) {
  const canonicalProduct =
    input.canonicalProductId !== undefined
      ? { id: input.canonicalProductId }
      : await db.canonicalProduct.create({
          data: {
            name: input.name ?? "Test product",
            brand: input.brand ?? null,
            model: input.model ?? null,
          },
          select: { id: true },
        });

  const listing = await db.retailerListing.create({
    data: {
      canonicalProductId: canonicalProduct.id,
      retailerId: input.retailerId ?? "mock",
      retailerProductId: input.retailerProductId ?? "direct",
      name: input.name ?? "Test product",
      url:
        input.url ??
        `https://mock-retailer.test/products/${input.retailerProductId ?? "direct"}`,
      currency: input.currency ?? "GBP",
      currentPriceMinor: input.currentPriceMinor ?? null,
      currentAvailability: input.currentAvailability ?? "IN_STOCK",
      brand: input.brand ?? null,
      model: input.model ?? null,
      category: input.category ?? null,
      imageUrl: input.imageUrl ?? null,
    },
  });

  return { canonicalProduct, listing };
}
