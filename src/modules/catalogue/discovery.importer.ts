import { randomUUID } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import type { AvailabilityStatus, ProductDetails } from "@/modules/retailers/core/types";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import { safePriceMinor } from "@/lib/money";
import {
  computeDiscountPct,
} from "@/modules/catalogue/catalogue.repository";
import {
  normalizeBrandKey,
  normalizeGtin,
  normalizeMpnKey,
} from "@/modules/catalogue/identifiers";

/**
 * High-volume catalogue importer.
 *
 * Daily discovery pages can contain thousands of products, and the
 * largest catalogues contain hundreds of thousands of listings. Per-product Prisma calls
 * would make the initial scan impractically slow, so this module batches
 * identifier lookups, canonical creation, listing creation, current-state
 * updates, and observation inserts.
 *
 * History remains append-only: existing listings only get a new observation
 * when price, original price, discount, or availability changed, or when a
 * previously delisted product reappears.
 */

export interface ImportCataloguePageInput {
  retailerId: string;
  items: ProductDetails[];
  seenAt: Date;
}

export interface ImportCataloguePageResult {
  itemsSeen: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsUnchanged: number;
  priceChanges: number;
}

interface PreparedItem {
  key: string;
  details: ProductDetails;
  gtin: string | null;
  brandKey: string | null;
  mpnKey: string | null;
}

interface ExistingListing {
  id: string;
  canonicalProductId: string;
  retailerProductId: string | null;
  url: string;
  name: string;
  imageUrl: string | null;
  brand: string | null;
  model: string | null;
  category: string | null;
  sku: string | null;
  gtin: string | null;
  mpn: string | null;
  currency: string;
  currentPriceMinor: number | null;
  currentOriginalPriceMinor: number | null;
  currentDiscountPct: number | null;
  currentAvailability: AvailabilityStatus;
  delistedAt: Date | null;
}

interface ListingUpdate {
  id: string;
  name: string;
  url: string;
  imageUrl: string | null;
  brand: string | null;
  model: string | null;
  category: string | null;
  sku: string | null;
  gtin: string | null;
  mpn: string | null;
  currency: string;
  priceMinor: number | null;
  originalPriceMinor: number | null;
  discountPct: number | null;
  availability: AvailabilityStatus;
}

function itemKey(details: ProductDetails): string {
  return details.retailerProductId ?? details.url;
}

function dedupeItems(items: ProductDetails[]): ProductDetails[] {
  const byKey = new Map<string, ProductDetails>();
  for (const item of items) {
    // Store partitions can return the same product more than once. The last
    // sighting wins; the importer is idempotent within a page.
    byKey.set(itemKey(item), item);
  }
  return [...byKey.values()];
}

function uniqueValues<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function loadExistingListings(
  retailerId: string,
  items: ProductDetails[],
  client: Pick<typeof db, "retailerListing"> = db,
): Promise<Map<string, ExistingListing>> {
  const productIds = uniqueValues(
    items
      .map((item) => item.retailerProductId)
      .filter((value): value is string => Boolean(value)),
  );
  const urls = uniqueValues(
    items
      .filter((item) => !item.retailerProductId)
      .map((item) => item.url),
  );

  const conditions: Prisma.RetailerListingWhereInput[] = [];
  if (productIds.length > 0) {
    conditions.push({ retailerProductId: { in: productIds } });
  }
  if (urls.length > 0) {
    conditions.push({ retailerProductId: null, url: { in: urls } });
  }
  if (conditions.length === 0) {
    return new Map();
  }

  const rows = await client.retailerListing.findMany({
    where: { retailerId, OR: conditions },
    select: {
      id: true,
      canonicalProductId: true,
      retailerProductId: true,
      url: true,
      name: true,
      imageUrl: true,
      brand: true,
      model: true,
      category: true,
      sku: true,
      gtin: true,
      mpn: true,
      currency: true,
      currentPriceMinor: true,
      currentOriginalPriceMinor: true,
      currentDiscountPct: true,
      currentAvailability: true,
      delistedAt: true,
    },
  });

  return new Map(
    rows.map((row) => [
      row.retailerProductId ?? row.url,
      row as ExistingListing,
    ]),
  );
}

/**
 * Resolve a canonical product for every new listing. GTIN is authoritative;
 * brand + MPN is the fallback. Products without identifiers are kept as
 * distinct canonical products rather than fuzzy-matched by title.
 */
async function resolveCanonicalProducts(
  prepared: PreparedItem[],
): Promise<Map<string, string>> {
  const gtins = uniqueValues(
    prepared
      .map((item) => item.gtin)
      .filter((value): value is string => Boolean(value)),
  );
  const pairs = uniqueValues(
    prepared
      .filter((item) => item.brandKey !== null && item.mpnKey !== null)
      .map((item) => `${item.brandKey}\u0000${item.mpnKey}`),
  ).map((key) => {
    const [brandKey, mpnKey] = key.split("\u0000");
    return { brandKey, mpnKey };
  });

  const [byGtin, byPair] = await Promise.all([
    gtins.length > 0
      ? db.canonicalProduct.findMany({
          where: { gtin: { in: gtins } },
          select: { id: true, gtin: true },
        })
      : Promise.resolve([]),
    pairs.length > 0
      ? db.canonicalProduct.findMany({
          where: {
            OR: pairs.map((pair) => ({
              brandKey: pair.brandKey,
              mpnKey: pair.mpnKey,
            })),
          },
          select: { id: true, brandKey: true, mpnKey: true },
        })
      : Promise.resolve([]),
  ]);

  const canonicalByGtin = new Map(
    byGtin
      .filter((row): row is { id: string; gtin: string } => row.gtin !== null)
      .map((row) => [row.gtin, row.id]),
  );
  const canonicalByPair = new Map(
    byPair
      .filter(
        (row): row is { id: string; brandKey: string; mpnKey: string } =>
          row.brandKey !== null && row.mpnKey !== null,
      )
      .map((row) => [`${row.brandKey}\u0000${row.mpnKey}`, row.id]),
  );

  const resolved = new Map<string, string>();
  const toCreate: Array<{
    id: string;
    name: string;
    brand: string | null;
    model: string | null;
    gtin: string | null;
    mpn: string | null;
    brandKey: string | null;
    mpnKey: string | null;
  }> = [];
  const createdWithoutIdentifiers: Array<{
    itemKey: string;
    id: string;
  }> = [];
  const createKeys = new Set<string>();

  for (const item of prepared) {
    const pairKey =
      item.brandKey !== null && item.mpnKey !== null
        ? `${item.brandKey}\u0000${item.mpnKey}`
        : null;
    const existing =
      (item.gtin ? canonicalByGtin.get(item.gtin) : undefined) ??
      (pairKey ? canonicalByPair.get(pairKey) : undefined);
    if (existing) {
      resolved.set(item.key, existing);
      continue;
    }

    const dedupeKey = item.gtin
      ? `gtin:${item.gtin}`
      : pairKey
        ? `pair:${pairKey}`
        : `item:${item.key}`;
    if (createKeys.has(dedupeKey)) {
      continue;
    }
    createKeys.add(dedupeKey);

    const id = randomUUID();
    toCreate.push({
      id,
      name: item.details.name,
      brand: item.details.brand ?? null,
      model: item.details.model ?? null,
      gtin: item.gtin,
      mpn: item.details.mpn ?? null,
      brandKey: item.brandKey,
      mpnKey: item.mpnKey,
    });
    if (!item.gtin && (!item.brandKey || !item.mpnKey)) {
      createdWithoutIdentifiers.push({ itemKey: item.key, id });
    }
  }

  if (toCreate.length > 0) {
    await db.canonicalProduct.createMany({
      data: toCreate,
      skipDuplicates: true,
    });

    // Re-read identifier matches so a concurrent import that won a unique
    // constraint is used instead of the id we generated.
    const [createdByGtin, createdByPair] = await Promise.all([
      gtins.length > 0
        ? db.canonicalProduct.findMany({
            where: { gtin: { in: gtins } },
            select: { id: true, gtin: true },
          })
        : Promise.resolve([]),
      pairs.length > 0
        ? db.canonicalProduct.findMany({
            where: {
              OR: pairs.map((pair) => ({
                brandKey: pair.brandKey,
                mpnKey: pair.mpnKey,
              })),
            },
            select: { id: true, brandKey: true, mpnKey: true },
          })
        : Promise.resolve([]),
    ]);

    for (const row of createdByGtin) {
      if (row.gtin) {
        canonicalByGtin.set(row.gtin, row.id);
      }
    }
    for (const row of createdByPair) {
      if (row.brandKey && row.mpnKey) {
        canonicalByPair.set(`${row.brandKey}\u0000${row.mpnKey}`, row.id);
      }
    }

    // Identifier-less rows cannot conflict, so their generated ids are final.
    for (const row of createdWithoutIdentifiers) {
      resolved.set(row.itemKey, row.id);
    }
  }

  for (const item of prepared) {
    if (resolved.has(item.key)) {
      continue;
    }
    const pairKey =
      item.brandKey !== null && item.mpnKey !== null
        ? `${item.brandKey}\u0000${item.mpnKey}`
        : null;
    const existing =
      (item.gtin ? canonicalByGtin.get(item.gtin) : undefined) ??
      (pairKey ? canonicalByPair.get(pairKey) : undefined);

    if (existing) {
      resolved.set(item.key, existing);
      continue;
    }

    // Last-resort create for an identifier-less item whose generated id was
    // not linked above, or a rare race where the row is still invisible.
    const created = await db.canonicalProduct.create({
      data: {
        name: item.details.name,
        brand: item.details.brand ?? null,
        model: item.details.model ?? null,
        gtin: item.gtin,
        mpn: item.details.mpn ?? null,
        brandKey: item.brandKey,
        mpnKey: item.mpnKey,
      },
      select: { id: true },
    });
    resolved.set(item.key, created.id);
  }

  return resolved;
}

function availabilityOf(details: ProductDetails): AvailabilityStatus {
  return details.availability;
}

/**
 * Import one discovery page. Returns counters suitable for accumulating on
 * the discovery run.
 */
export async function importCataloguePage(
  input: ImportCataloguePageInput,
): Promise<ImportCataloguePageResult> {
  const items = dedupeItems(input.items);
  if (items.length === 0) {
    return {
      itemsSeen: 0,
      itemsCreated: 0,
      itemsUpdated: 0,
      itemsUnchanged: 0,
      priceChanges: 0,
    };
  }
  let invalidPriceCount = 0;

  const existing = await loadExistingListings(input.retailerId, items);
  const newItems = items.filter((item) => !existing.has(itemKey(item)));

  const preparedNew: PreparedItem[] = newItems.map((details) => ({
    key: itemKey(details),
    details,
    gtin: normalizeGtin(details.gtin),
    brandKey: normalizeBrandKey(details.brand),
    mpnKey: normalizeMpnKey(details.mpn),
  }));

  const canonicalByKey =
    preparedNew.length > 0
      ? await resolveCanonicalProducts(preparedNew)
      : new Map<string, string>();

  const now = input.seenAt;
  const listingRows: Prisma.RetailerListingCreateManyInput[] = [];
  for (const item of newItems) {
    const canonicalProductId = canonicalByKey.get(itemKey(item));
    if (!canonicalProductId) {
      continue;
    }
    const priceMinor = safePriceMinor(item.priceMinor);
    const originalPriceMinor = safePriceMinor(item.originalPriceMinor);
    if (
      (item.priceMinor !== undefined && priceMinor === null) ||
      (item.originalPriceMinor !== undefined && originalPriceMinor === null)
    ) {
      invalidPriceCount += 1;
    }
    const gtin = normalizeGtin(item.gtin);
    listingRows.push({
      id: randomUUID(),
      canonicalProductId,
      retailerId: input.retailerId,
      retailerProductId: item.retailerProductId ?? null,
      sku: item.sku ?? item.retailerProductId ?? null,
      gtin,
      mpn: item.mpn ?? null,
      brand: item.brand ?? null,
      model: item.model ?? null,
      category: item.category ?? null,
      name: item.name,
      url: item.url,
      imageUrl: item.imageUrl || null,
      currency: item.currency,
      currentPriceMinor: priceMinor,
      currentOriginalPriceMinor: originalPriceMinor,
      currentDiscountPct: computeDiscountPct(
        priceMinor,
        originalPriceMinor,
        item.discountPct,
      ),
      currentAvailability: availabilityOf(item),
      lastCheckedAt: now,
      lastSuccessfulAt: now,
      lastSeenAt: now,
      catalogueDiscoveredAt: now,
      lastCatalogueSeenAt: now,
      delistedAt: null,
    });
  }

  let createdIds: string[] = [];
  if (listingRows.length > 0) {
    const created = await db.retailerListing.createManyAndReturn({
      data: listingRows,
      skipDuplicates: true,
      select: { id: true },
    });
    createdIds = created.map((row) => row.id);
  }

  // Re-read every listing in the page: races with other imports, and values
  // such as the generated id, are authoritative in the database. State and
  // observation writes share one transaction so a retried page can never
  // commit a price update without its history row or vice versa.
  const result = await db.$transaction(async (tx) => {
    const current = await loadExistingListings(input.retailerId, items, tx);
    const createdIdSet = new Set(createdIds);

    const listingIds = [...current.values()].map((listing) => listing.id);
    const canonicalIds = uniqueValues(
      [...current.values()].map((listing) => listing.canonicalProductId),
    );

    const [activeSubscriptions, alertRules] = await Promise.all([
      listingIds.length > 0
        ? tx.monitoringSubscription.findMany({
            where: {
              retailerListingId: { in: listingIds },
              status: "ACTIVE",
            },
            select: { retailerListingId: true },
          })
        : Promise.resolve([]),
      canonicalIds.length > 0
        ? tx.priceAlertRule.findMany({
            where: {
              enabled: true,
              inventoryItem: { canonicalProductId: { in: canonicalIds } },
            },
            select: {
              inventoryItem: { select: { canonicalProductId: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    const protectedListingIds = new Set(
      activeSubscriptions.map((row) => row.retailerListingId),
    );
    const alertCanonicalIds = new Set(
      alertRules.map((rule) => rule.inventoryItem.canonicalProductId),
    );

    const updates: ListingUpdate[] = [];
    const seenOnlyIds: string[] = [];
    const observations: Prisma.ListingObservationCreateManyInput[] = [];
    let itemsCreated = 0;
    let itemsUpdated = 0;
    let itemsUnchanged = 0;
    let priceChanges = 0;

    for (const item of items) {
      const listing = current.get(itemKey(item));
      if (!listing) {
        continue;
      }

      const priceMinor = safePriceMinor(item.priceMinor);
      const originalPriceMinor = safePriceMinor(item.originalPriceMinor);
      if (
        (item.priceMinor !== undefined && priceMinor === null) ||
        (item.originalPriceMinor !== undefined && originalPriceMinor === null)
      ) {
        invalidPriceCount += 1;
      }

      if (createdIdSet.has(listing.id)) {
        itemsCreated += 1;
        observations.push({
          retailerListingId: listing.id,
          priceMinor,
          originalPriceMinor,
          discountPct: computeDiscountPct(
            priceMinor,
            originalPriceMinor,
            item.discountPct,
          ),
          currency: item.currency,
          availability: item.availability,
          kind: "INITIAL",
          observedAt: now,
        });
        continue;
      }

      const isProtected =
        protectedListingIds.has(listing.id) ||
        alertCanonicalIds.has(listing.canonicalProductId);

      if (isProtected) {
        // Monitored listings and listings watched by enabled alert rules keep
        // their own check schedule. Record only the catalogue sighting here so
        // the delist sweep does not mistake them for unseen products.
        seenOnlyIds.push(listing.id);
        itemsUnchanged += 1;
        continue;
      }

      const nextPrice =
        item.priceMinor === undefined || priceMinor === null
          ? listing.currentPriceMinor
          : priceMinor;
      const nextOriginal =
        item.originalPriceMinor === undefined || originalPriceMinor === null
          ? listing.currentOriginalPriceMinor
          : originalPriceMinor;
      const nextDiscount = computeDiscountPct(
        nextPrice,
        nextOriginal,
        item.discountPct,
      );

      const priceChanged =
        nextPrice !== listing.currentPriceMinor ||
        nextOriginal !== listing.currentOriginalPriceMinor ||
        nextDiscount !== listing.currentDiscountPct ||
        item.currency !== listing.currency;
      const availabilityChanged =
        item.availability !== listing.currentAvailability;
      const relisted = listing.delistedAt !== null;
      // The update SQL uses COALESCE for descriptive fields, so a missing
      // adapter value means "keep what we have", not "clear the field". Compare
      // the effective values to avoid no-op updates on every refresh.
      const nextImageUrl = item.imageUrl || listing.imageUrl;
      const nextBrand = item.brand ?? listing.brand;
      const nextModel = item.model ?? listing.model;
      const nextCategory = item.category ?? listing.category;
      const nextSku = item.sku ?? item.retailerProductId ?? listing.sku;
      const nextGtin = normalizeGtin(item.gtin) ?? listing.gtin;
      const nextMpn = item.mpn ?? listing.mpn;
      const descriptiveChanged =
        item.name !== listing.name ||
        item.url !== listing.url ||
        nextImageUrl !== listing.imageUrl ||
        nextBrand !== listing.brand ||
        nextModel !== listing.model ||
        nextCategory !== listing.category ||
        nextSku !== listing.sku ||
        nextGtin !== listing.gtin ||
        nextMpn !== listing.mpn;

      if (!priceChanged && !availabilityChanged && !relisted && !descriptiveChanged) {
        // Unchanged rows still need the sighting timestamp, otherwise the
        // delist sweep would treat the whole stable catalogue as vanished.
        seenOnlyIds.push(listing.id);
        itemsUnchanged += 1;
        continue;
      }

      itemsUpdated += 1;
      if (priceChanged) {
        priceChanges += 1;
      }

      updates.push({
        id: listing.id,
        name: item.name,
        url: item.url,
        imageUrl: nextImageUrl,
        brand: nextBrand,
        model: nextModel,
        category: nextCategory,
        sku: nextSku,
        gtin: nextGtin,
        mpn: nextMpn,
        currency: item.currency,
        priceMinor: nextPrice,
        originalPriceMinor: nextOriginal,
        discountPct: nextDiscount,
        availability: item.availability,
      });

      if (priceChanged || availabilityChanged || relisted) {
        observations.push({
          retailerListingId: listing.id,
          priceMinor: nextPrice,
          originalPriceMinor: nextOriginal,
          discountPct: nextDiscount,
          currency: item.currency,
          availability: item.availability,
          kind: "CHANGE",
          observedAt: now,
        });
      }
    }

    if (updates.length > 0) {
      const values = updates.map(
        (update) => Prisma.sql`(
          ${update.id}::text,
          ${update.name}::text,
          ${update.url}::text,
          ${update.imageUrl}::text,
          ${update.brand}::text,
          ${update.model}::text,
          ${update.category}::text,
          ${update.sku}::text,
          ${update.gtin}::text,
          ${update.mpn}::text,
          ${update.currency}::text,
          ${update.priceMinor}::int,
          ${update.originalPriceMinor}::int,
          ${update.discountPct}::int,
          ${update.availability}::text,
          ${now}::timestamp(3)
        )`,
      );

      await tx.$executeRaw(Prisma.sql`
        UPDATE "retailer_listings" AS l
        SET
          "name" = v.name,
          "url" = v.url,
          "image_url" = COALESCE(v.image_url, l."image_url"),
          "brand" = COALESCE(v.brand, l."brand"),
          "model" = COALESCE(v.model, l."model"),
          "category" = COALESCE(v.category, l."category"),
          "sku" = COALESCE(v.sku, l."sku"),
          "gtin" = COALESCE(v.gtin, l."gtin"),
          "mpn" = COALESCE(v.mpn, l."mpn"),
          "currency" = v.currency,
          "current_price_minor" = v.price_minor,
          "current_original_price_minor" = v.original_price_minor,
          "current_discount_pct" = v.discount_pct,
          "current_availability" = v.availability::text::"AvailabilityStatus",
          "last_checked_at" = v.seen_at,
          "last_successful_at" = v.seen_at,
          "last_seen_at" = v.seen_at,
          "last_catalogue_seen_at" = v.seen_at,
          "catalogue_discovered_at" = COALESCE(l."catalogue_discovered_at", v.seen_at),
          "delisted_at" = NULL,
          "updated_at" = v.seen_at
        FROM (VALUES ${Prisma.join(values)}) AS v(
          id, name, url, image_url, brand, model, category, sku, gtin, mpn,
          currency, price_minor, original_price_minor, discount_pct,
          availability, seen_at
        )
        WHERE l."id" = v.id
      `);
    }

    if (seenOnlyIds.length > 0) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "retailer_listings"
        SET
          "last_catalogue_seen_at" = ${now},
          "last_seen_at" = ${now},
          "catalogue_discovered_at" = COALESCE("catalogue_discovered_at", ${now}),
          "updated_at" = ${now}
        WHERE "id" IN (${Prisma.join(seenOnlyIds)})
      `);
    }

    if (observations.length > 0) {
      await tx.listingObservation.createMany({ data: observations });
    }

    // Repair listings whose creation committed but whose baseline observation
    // did not (for example a worker crash between the two writes). Only rows
    // that still have no history are touched, so this is a no-op on retries.
    if (listingIds.length > 0) {
      const missing = await tx.$queryRaw<
        Array<{
          id: string;
          current_price_minor: number | null;
          current_original_price_minor: number | null;
          current_discount_pct: number | null;
          currency: string;
          current_availability: AvailabilityStatus;
        }>
      >(Prisma.sql`
        SELECT
          l."id",
          l."current_price_minor",
          l."current_original_price_minor",
          l."current_discount_pct",
          l."currency",
          l."current_availability"
        FROM "retailer_listings" l
        WHERE l."id" IN (${Prisma.join(listingIds)})
          AND NOT EXISTS (
            SELECT 1
            FROM "listing_observations" o
            WHERE o."retailer_listing_id" = l."id"
          )
      `);

      if (missing.length > 0) {
        await tx.listingObservation.createMany({
          data: missing.map((row) => ({
            retailerListingId: row.id,
            priceMinor: row.current_price_minor,
            originalPriceMinor: row.current_original_price_minor,
            discountPct: row.current_discount_pct,
            currency: row.currency,
            availability: row.current_availability,
            kind: "INITIAL" as const,
            observedAt: now,
          })),
        });
      }
    }

    return {
      itemsSeen: items.length,
      itemsCreated,
      itemsUpdated,
      itemsUnchanged,
      priceChanges,
    };
  }, {
    // A 1,000-item page can touch many rows. Stay well above Prisma's 5s
    // default but comfortably below the worker's 120s lock duration.
    maxWait: 10_000,
    timeout: 60_000,
  });

  if (invalidPriceCount > 0) {
    logger.warn(
      {
        component: "catalogue-discovery",
        retailerId: input.retailerId,
        invalidPriceCount,
        pageItems: items.length,
      },
      "ignored out-of-range catalogue prices",
    );
  }

  return result;
}

/**
 * Mark discovery-sourced listings that were not seen during a fully
 * successful refresh as delisted. Monitored listings and listings with
 * enabled historical alert rules are left to their own checks so their
 * notification semantics are not disturbed.
 *
 * History is preserved: the listing row, observations, subscriptions, and
 * notifications are never deleted. A CHANGE observation records the
 * transition to out of stock.
 */
export async function delistUnseenCatalogueListings(input: {
  retailerId: string;
  runStartedAt: Date;
  /** Products seen by the completed run, used as a mass-delist safety check. */
  itemsSeen: number;
}): Promise<number> {
  const now = new Date();

  // A transient API outage can return an empty but technically valid page.
  // Never let that wipe the catalogue's availability. Require a completed
  // scan to have seen at least half of a large catalogue; small catalogues
  // only require a non-empty scan.
  const existingCount = await db.retailerListing.count({
    where: {
      retailerId: input.retailerId,
      catalogueDiscoveredAt: { not: null },
      delistedAt: null,
    },
  });
  if (
    existingCount > 0 &&
    (input.itemsSeen === 0 ||
      (existingCount >= 100 && input.itemsSeen < existingCount * 0.5))
  ) {
    logger.warn(
      {
        component: "catalogue-discovery",
        retailerId: input.retailerId,
        itemsSeen: input.itemsSeen,
        existingCount,
      },
      "skipping delist: refresh saw too few products; keeping existing catalogue state",
    );
    return 0;
  }

  try {
    return await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          current_price_minor: number | null;
          current_original_price_minor: number | null;
          current_discount_pct: number | null;
          currency: string;
        }>
      >`
        UPDATE "retailer_listings" AS l
        SET
          "delisted_at" = ${now},
          "current_availability" = 'OUT_OF_STOCK'::"AvailabilityStatus",
          "updated_at" = ${now}
        WHERE l."retailer_id" = ${input.retailerId}
          AND l."catalogue_discovered_at" IS NOT NULL
          AND l."delisted_at" IS NULL
          AND (
            l."last_catalogue_seen_at" IS NULL
            OR l."last_catalogue_seen_at" < ${input.runStartedAt}
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "monitoring_subscriptions" s
            WHERE s."retailer_listing_id" = l."id" AND s."status" = 'ACTIVE'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "inventory_items" i
            JOIN "price_alert_rules" r ON r."inventory_item_id" = i."id"
            WHERE i."canonical_product_id" = l."canonical_product_id"
              AND r."enabled" = true
          )
        RETURNING
          l."id",
          l."current_price_minor",
          l."current_original_price_minor",
          l."current_discount_pct",
          l."currency"
      `;

      if (rows.length === 0) {
        return 0;
      }

      await tx.listingObservation.createMany({
        data: rows.map((row) => ({
          retailerListingId: row.id,
          priceMinor: row.current_price_minor,
          originalPriceMinor: row.current_original_price_minor,
          discountPct: row.current_discount_pct,
          currency: row.currency,
          availability: "OUT_OF_STOCK" as const,
          kind: "CHANGE" as const,
          observedAt: now,
        })),
      });

      return rows.length;
    }, {
      // Delisting can touch a large portion of a 500k-product catalogue.
      maxWait: 10_000,
      timeout: 120_000,
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2034"
    ) {
      // A concurrent monitored-check update raced the delist transaction.
      // The next refresh will retry; do not fail the completed run.
      return 0;
    }
    throw error;
  }
}
