import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import type {
  CatalogueDiscoveryMode,
  CatalogueDiscoveryStatus,
  CatalogueDiscoveryTrigger,
} from "@/generated/prisma/client";

/**
 * Persistence for retailer-wide catalogue discovery.
 *
 * Configuration is keyed by the adapter id rather than a foreign key, since
 * retailers live in the adapter registry. Runs are resumable: the opaque
 * adapter cursor and optimistic revision are stored after every page.
 */

export interface RetailerCatalogueRecord {
  retailerId: string;
  discoveryEnabled: boolean;
  refreshIntervalHours: number;
  nextRefreshAt: Date | null;
  lastSuccessfulRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CatalogueDiscoveryRunRecord {
  id: string;
  retailerId: string;
  mode: CatalogueDiscoveryMode;
  trigger: CatalogueDiscoveryTrigger;
  status: CatalogueDiscoveryStatus;
  cursor: Prisma.JsonValue | null;
  revision: number;
  totalEstimate: number | null;
  pagesProcessed: number;
  itemsSeen: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsUnchanged: number;
  itemsDelisted: number;
  priceChanges: number;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  heartbeatAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const DEFAULT_REFRESH_INTERVAL_HOURS = 24;

export async function getRetailerCatalogue(
  retailerId: string,
): Promise<RetailerCatalogueRecord> {
  const row = await db.retailerCatalogue.findUnique({ where: { retailerId } });
  if (row) {
    return row;
  }
  const now = new Date();
  return {
    retailerId,
    discoveryEnabled: false,
    refreshIntervalHours: DEFAULT_REFRESH_INTERVAL_HOURS,
    nextRefreshAt: null,
    lastSuccessfulRunAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listRetailerCatalogues(): Promise<
  RetailerCatalogueRecord[]
> {
  return db.retailerCatalogue.findMany({
    orderBy: { retailerId: "asc" },
  });
}

export async function upsertRetailerCatalogue(
  retailerId: string,
  data: {
    discoveryEnabled?: boolean;
    refreshIntervalHours?: number;
    nextRefreshAt?: Date | null;
    lastSuccessfulRunAt?: Date | null;
  },
): Promise<RetailerCatalogueRecord> {
  return db.retailerCatalogue.upsert({
    where: { retailerId },
    create: {
      retailerId,
      discoveryEnabled: data.discoveryEnabled ?? false,
      refreshIntervalHours:
        data.refreshIntervalHours ?? DEFAULT_REFRESH_INTERVAL_HOURS,
      nextRefreshAt:
        data.nextRefreshAt ??
        (data.discoveryEnabled
          ? new Date()
          : null),
      lastSuccessfulRunAt: data.lastSuccessfulRunAt ?? null,
    },
    update: {
      ...(data.discoveryEnabled !== undefined
        ? {
            discoveryEnabled: data.discoveryEnabled,
            nextRefreshAt:
              data.nextRefreshAt !== undefined
                ? data.nextRefreshAt
                : data.discoveryEnabled
                  ? new Date()
                  : null,
          }
        : {}),
      ...(data.refreshIntervalHours !== undefined
        ? { refreshIntervalHours: data.refreshIntervalHours }
        : {}),
      ...(data.nextRefreshAt !== undefined
        ? { nextRefreshAt: data.nextRefreshAt }
        : {}),
      ...(data.lastSuccessfulRunAt !== undefined
        ? { lastSuccessfulRunAt: data.lastSuccessfulRunAt }
        : {}),
    },
  });
}

export async function findActiveDiscoveryRun(
  retailerId: string,
): Promise<CatalogueDiscoveryRunRecord | null> {
  return db.catalogueDiscoveryRun.findFirst({
    where: { retailerId, status: { in: ["QUEUED", "RUNNING"] } },
    orderBy: { createdAt: "desc" },
  });
}

export async function findLatestDiscoveryRun(
  retailerId: string,
): Promise<CatalogueDiscoveryRunRecord | null> {
  return db.catalogueDiscoveryRun.findFirst({
    where: { retailerId },
    orderBy: { createdAt: "desc" },
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

export async function createDiscoveryRun(input: {
  retailerId: string;
  mode: CatalogueDiscoveryMode;
  trigger: CatalogueDiscoveryTrigger;
}): Promise<CatalogueDiscoveryRunRecord> {
  try {
    // Ensure the parent configuration row exists before the FK insert.
    await db.retailerCatalogue.upsert({
      where: { retailerId: input.retailerId },
      create: {
        retailerId: input.retailerId,
        discoveryEnabled: false,
        refreshIntervalHours: DEFAULT_REFRESH_INTERVAL_HOURS,
        nextRefreshAt: null,
      },
      update: {},
    });

    return await db.catalogueDiscoveryRun.create({
      data: {
        retailerId: input.retailerId,
        mode: input.mode,
        trigger: input.trigger,
        status: "QUEUED",
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await findActiveDiscoveryRun(input.retailerId);
      if (existing) {
        return existing;
      }
    }
    throw error;
  }
}

export async function findDiscoveryRun(
  runId: string,
): Promise<CatalogueDiscoveryRunRecord | null> {
  return db.catalogueDiscoveryRun.findUnique({ where: { id: runId } });
}

/**
 * Atomically claim the next step of a run. The revision guard ensures two
 * workers cannot advance the same cursor concurrently; the loser simply
 * returns null and lets the queued successor job continue.
 */
export async function claimDiscoveryRunStep(
  runId: string,
  revision: number,
): Promise<CatalogueDiscoveryRunRecord | null> {
  const now = new Date();
  const claimed = await db.$executeRaw`
    UPDATE "catalogue_discovery_runs"
    SET
      "status" = 'RUNNING',
      "heartbeat_at" = ${now},
      "started_at" = COALESCE("started_at", ${now}),
      "updated_at" = ${now}
    WHERE "id" = ${runId}
      AND "revision" = ${revision}
      AND "status" IN ('QUEUED', 'RUNNING')
  `;
  if (claimed !== 1) {
    return null;
  }
  return findDiscoveryRun(runId);
}

export interface DiscoveryRunProgressUpdate {
  cursor: Prisma.InputJsonValue | null;
  totalEstimate?: number | null;
  pagesProcessed: number;
  itemsSeen: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsUnchanged: number;
  priceChanges: number;
}

export async function advanceDiscoveryRun(
  runId: string,
  revision: number,
  update: DiscoveryRunProgressUpdate,
): Promise<CatalogueDiscoveryRunRecord | null> {
  const updated = await db.catalogueDiscoveryRun.updateMany({
    where: { id: runId, revision, status: "RUNNING" },
    data: {
      cursor: update.cursor === null ? Prisma.DbNull : update.cursor,
      totalEstimate: update.totalEstimate,
      pagesProcessed: update.pagesProcessed,
      itemsSeen: update.itemsSeen,
      itemsCreated: update.itemsCreated,
      itemsUpdated: update.itemsUpdated,
      itemsUnchanged: update.itemsUnchanged,
      priceChanges: update.priceChanges,
      revision: revision + 1,
      heartbeatAt: new Date(),
      updatedAt: new Date(),
    },
  });
  if (updated.count !== 1) {
    return null;
  }
  return findDiscoveryRun(runId);
}

export async function completeDiscoveryRun(
  runId: string,
  revision: number,
  update: {
    itemsDelisted: number;
    nextRefreshAt: Date | null;
    totalEstimate?: number | null;
    pagesProcessed: number;
    itemsSeen: number;
    itemsCreated: number;
    itemsUpdated: number;
    itemsUnchanged: number;
    priceChanges: number;
  },
): Promise<CatalogueDiscoveryRunRecord | null> {
  const now = new Date();
  const run = await db.$transaction(async (tx) => {
    const updated = await tx.catalogueDiscoveryRun.updateMany({
      where: { id: runId, revision, status: "RUNNING" },
      data: {
        status: "COMPLETED",
        cursor: Prisma.DbNull,
        totalEstimate: update.totalEstimate,
        pagesProcessed: update.pagesProcessed,
        itemsSeen: update.itemsSeen,
        itemsCreated: update.itemsCreated,
        itemsUpdated: update.itemsUpdated,
        itemsUnchanged: update.itemsUnchanged,
        priceChanges: update.priceChanges,
        itemsDelisted: update.itemsDelisted,
        finishedAt: now,
        heartbeatAt: now,
        error: null,
        revision: revision + 1,
        updatedAt: now,
      },
    });
    if (updated.count !== 1) {
      return null;
    }

    const finished = await tx.catalogueDiscoveryRun.findUnique({
      where: { id: runId },
      select: { retailerId: true },
    });
    if (finished) {
      await tx.retailerCatalogue.update({
        where: { retailerId: finished.retailerId },
        data: {
          lastSuccessfulRunAt: now,
          nextRefreshAt: update.nextRefreshAt,
        },
      });
    }

    return tx.catalogueDiscoveryRun.findUnique({ where: { id: runId } });
  });
  return run;
}

export async function failDiscoveryRun(
  runId: string,
  error: string,
): Promise<void> {
  const now = new Date();
  await db.catalogueDiscoveryRun.updateMany({
    where: { id: runId, status: { in: ["QUEUED", "RUNNING"] } },
    data: {
      status: "FAILED",
      error: error.slice(0, 2_000),
      finishedAt: now,
      heartbeatAt: now,
      updatedAt: now,
    },
  });
}

/**
 * Mark abandoned runs as failed. Heartbeats are written on every page; a run
 * with no heartbeat for this long has no live worker (for example a process
 * crash between BullMQ retries). It can then be restarted manually or by the
 * daily scheduler.
 */
export async function recoverStaleDiscoveryRuns(
  staleAfterMinutes = 60,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMinutes * 60_000);
  const result = await db.catalogueDiscoveryRun.updateMany({
    where: {
      status: { in: ["QUEUED", "RUNNING"] },
      OR: [
        { heartbeatAt: { lt: cutoff } },
        { heartbeatAt: null, createdAt: { lt: cutoff } },
      ],
    },
    data: {
      status: "FAILED",
      error: "Discovery run heartbeat expired before completion",
      finishedAt: new Date(),
      updatedAt: new Date(),
    },
  });
  return result.count;
}

export async function listDueCatalogues(
  now: Date = new Date(),
): Promise<RetailerCatalogueRecord[]> {
  return db.retailerCatalogue.findMany({
    where: {
      discoveryEnabled: true,
      OR: [
        { nextRefreshAt: null },
        { nextRefreshAt: { lte: now } },
      ],
    },
    orderBy: { nextRefreshAt: "asc" },
  });
}

export interface RetailerCatalogueStats {
  retailerId: string;
  productCount: number;
  inStockCount: number;
  categoryCount: number;
  brandCount: number;
  lastSuccessfulRunAt: Date | null;
  latestRun: CatalogueDiscoveryRunRecord | null;
}

export async function getRetailerCatalogueStats(
  retailerId: string,
): Promise<RetailerCatalogueStats> {
  const [productCount, inStockCount, categoryRows, brandRows, catalogue, latestRun] =
    await Promise.all([
      db.retailerListing.count({ where: { retailerId } }),
      db.retailerListing.count({
        where: { retailerId, currentAvailability: "IN_STOCK" },
      }),
      db.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT "category")::bigint AS count
        FROM "retailer_listings"
        WHERE "retailer_id" = ${retailerId} AND "category" IS NOT NULL
      `,
      db.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT "brand")::bigint AS count
        FROM "retailer_listings"
        WHERE "retailer_id" = ${retailerId} AND "brand" IS NOT NULL
      `,
      getRetailerCatalogue(retailerId),
      findLatestDiscoveryRun(retailerId),
    ]);

  return {
    retailerId,
    productCount,
    inStockCount,
    categoryCount: Number(categoryRows[0]?.count ?? 0),
    brandCount: Number(brandRows[0]?.count ?? 0),
    lastSuccessfulRunAt: catalogue.lastSuccessfulRunAt,
    latestRun,
  };
}

export async function listCatalogueCategories(
  retailerId: string,
  limit = 500,
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ category: string }>>`
    SELECT DISTINCT "category"
    FROM "retailer_listings"
    WHERE "retailer_id" = ${retailerId} AND "category" IS NOT NULL
    ORDER BY "category" ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => row.category);
}

export async function listCatalogueBrands(
  retailerId: string,
  limit = 500,
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ brand: string }>>`
    SELECT DISTINCT "brand"
    FROM "retailer_listings"
    WHERE "retailer_id" = ${retailerId} AND "brand" IS NOT NULL
    ORDER BY "brand" ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => row.brand);
}
