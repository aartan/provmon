
import type { ProductDetails } from "@/modules/retailers/core/types";
import { db } from "@/lib/db";

/**
 * Product persistence. Products are shared across users and keyed by
 * (retailerId, retailerProductId); subscription-specific state lives in
 * the monitoring module.
 *
 * Every function takes and returns the normalised shapes only — retailer
 * data never reaches the database in any other form.
 */
export interface StoredProduct {
  id: string;
  retailerId: string;
  retailerProductId: string | null;
  name: string;
  url: string;
  imageUrl: string | null;
  currency: string;
  currentPriceMinor: number | null;
  currentAvailability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN";
  lastCheckedAt: Date | null;
  lastSuccessfulAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function findProductByRetailerIdentity(
  retailerId: string,
  retailerProductId: string | undefined,
): Promise<StoredProduct | null> {
  // findFirst rather than the compound unique input: Prisma 7's generated
  // unique input does not accept null for nullable columns.
  return db.product.findFirst({
    where: {
      retailerId,
      retailerProductId: retailerProductId ?? null,
    },
  });
}

/**
 * Find an existing product by retailer identity or create it from freshly
 * fetched details. Callers use this in the add-product flow: fetch first
 * (via the adapter), then upsert.
 */
export async function findOrCreateProduct(
  details: ProductDetails,
): Promise<StoredProduct> {
  const existing = await findProductByRetailerIdentity(
    details.retailerId,
    details.retailerProductId,
  );
  if (existing) {
    return existing;
  }

  return db.product.create({
    data: {
      retailerId: details.retailerId,
      retailerProductId: details.retailerProductId ?? null,
      name: details.name,
      url: details.url,
      imageUrl: details.imageUrl ?? null,
      currency: details.currency,
      currentPriceMinor: details.priceMinor ?? null,
      currentAvailability: details.availability,
      lastCheckedAt: new Date(),
      lastSuccessfulAt: new Date(),
    },
  });
}

/**
 * Update the product's current state from a successful check and append
 * observations only when the value actually changed, keeping the history
 * tables clean and the charts fast.
 */
export async function updateProductFromCheck(
  productId: string,
  details: ProductDetails,
): Promise<void> {
  const product = await db.product.findUnique({ where: { id: productId } });
  if (!product) {
    throw new Error(`Product ${productId} not found`);
  }

  const priceChanged = product.currentPriceMinor !== (details.priceMinor ?? null);
  const availabilityChanged =
    product.currentAvailability !== details.availability;

  await db.$transaction(async (tx) => {
    await tx.product.update({
      where: { id: productId },
      data: {
        name: details.name,
        imageUrl: details.imageUrl ?? product.imageUrl,
        currency: details.currency,
        currentPriceMinor: details.priceMinor ?? product.currentPriceMinor,
        currentAvailability: details.availability,
        lastCheckedAt: new Date(),
        lastSuccessfulAt: new Date(),
      },
    });

    if (priceChanged && details.priceMinor !== undefined) {
      await tx.priceObservation.create({
        data: {
          productId,
          priceMinor: details.priceMinor,
          currency: details.currency,
          observedAt: new Date(),
        },
      });
    }

    if (availabilityChanged) {
      await tx.availabilityObservation.create({
        data: {
          productId,
          availability: details.availability,
          observedAt: new Date(),
        },
      });
    }
  });
}

/** Mark a product as checked even when the retailer call failed. */
export async function markProductChecked(productId: string): Promise<void> {
  await db.product.update({
    where: { id: productId },
    data: { lastCheckedAt: new Date() },
  });
}

export async function getProductHistory(productId: string) {
  const [priceObservations, availabilityObservations] = await Promise.all([
    db.priceObservation.findMany({
      where: { productId },
      orderBy: { observedAt: "asc" },
    }),
    db.availabilityObservation.findMany({
      where: { productId },
      orderBy: { observedAt: "asc" },
    }),
  ]);

  return { priceObservations, availabilityObservations };
}
