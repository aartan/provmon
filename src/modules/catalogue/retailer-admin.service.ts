import { db } from "@/lib/db";
import { registerBuiltInAdapters } from "@/modules/retailers/adapters";
import { retailerRegistry } from "@/modules/retailers/core/retailer-registry";
import {
  getRetailerCatalogue,
  upsertRetailerCatalogue,
} from "@/modules/catalogue/discovery.repository";
import {
  CatalogueDiscoveryError,
  startCatalogueDiscovery,
} from "@/modules/catalogue/discovery.service";
import type { CatalogueDiscoveryRunRecord } from "@/modules/catalogue/discovery.repository";

/**
 * Retailer discovery management: configuration, schedule, and run status.
 * This is global catalogue state, not user-owned data.
 */

export interface RetailerRunView {
  id: string;
  mode: "INITIAL" | "REFRESH";
  trigger: "MANUAL" | "SCHEDULED";
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  totalEstimate: number | null;
  pagesProcessed: number;
  itemsSeen: number;
  itemsCreated: number;
  itemsUpdated: number;
  itemsUnchanged: number;
  itemsDelisted: number;
  priceChanges: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface RetailerAdminView {
  id: string;
  name: string;
  currency: string;
  supportsCatalogue: boolean;
  discoveryEnabled: boolean;
  refreshIntervalHours: number;
  nextRefreshAt: string | null;
  lastSuccessfulRunAt: string | null;
  productCount: number;
  inStockCount: number;
  latestRun: RetailerRunView | null;
}

function toRunView(run: CatalogueDiscoveryRunRecord): RetailerRunView {
  return {
    id: run.id,
    mode: run.mode,
    trigger: run.trigger,
    status: run.status,
    totalEstimate: run.totalEstimate,
    pagesProcessed: run.pagesProcessed,
    itemsSeen: run.itemsSeen,
    itemsCreated: run.itemsCreated,
    itemsUpdated: run.itemsUpdated,
    itemsUnchanged: run.itemsUnchanged,
    itemsDelisted: run.itemsDelisted,
    priceChanges: run.priceChanges,
    error: run.error,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

export async function listRetailerAdminViews(): Promise<RetailerAdminView[]> {
  registerBuiltInAdapters();

  const [counts, catalogues, latestRuns] = await Promise.all([
    db.retailerListing.groupBy({
      by: ["retailerId", "currentAvailability"],
      where: { delistedAt: null },
      _count: { _all: true },
    }),
    db.retailerCatalogue.findMany(),
    db.catalogueDiscoveryRun.findMany({
      distinct: ["retailerId"],
      orderBy: [{ retailerId: "asc" }, { createdAt: "desc" }],
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
  const runByRetailer = new Map(
    latestRuns.map((run) => [run.retailerId, run]),
  );

  const views: RetailerAdminView[] = [];
  for (const adapter of retailerRegistry.list()) {
    const count = countByRetailer.get(adapter.id);
    const catalogue = catalogueByRetailer.get(adapter.id);
    const latestRun = runByRetailer.get(adapter.id);
    if (!adapter.catalogue && !count && !catalogue) {
      continue;
    }
    views.push({
      id: adapter.id,
      name: adapter.name,
      currency: adapter.currency,
      supportsCatalogue: Boolean(adapter.catalogue),
      discoveryEnabled: catalogue?.discoveryEnabled ?? false,
      refreshIntervalHours: catalogue?.refreshIntervalHours ?? 24,
      nextRefreshAt: catalogue?.nextRefreshAt?.toISOString() ?? null,
      lastSuccessfulRunAt:
        catalogue?.lastSuccessfulRunAt?.toISOString() ?? null,
      productCount: count?.total ?? 0,
      inStockCount: count?.inStock ?? 0,
      latestRun: latestRun ? toRunView(latestRun) : null,
    });
  }

  // Preserve visibility of imported catalogues whose adapter is no longer
  // registered; their history is still useful and must not disappear.
  for (const [retailerId, count] of countByRetailer) {
    if (views.some((view) => view.id === retailerId)) {
      continue;
    }
    const catalogue = catalogueByRetailer.get(retailerId);
    const latestRun = runByRetailer.get(retailerId);
    views.push({
      id: retailerId,
      name: retailerId,
      currency: "GBP",
      supportsCatalogue: false,
      discoveryEnabled: catalogue?.discoveryEnabled ?? false,
      refreshIntervalHours: catalogue?.refreshIntervalHours ?? 24,
      nextRefreshAt: catalogue?.nextRefreshAt?.toISOString() ?? null,
      lastSuccessfulRunAt:
        catalogue?.lastSuccessfulRunAt?.toISOString() ?? null,
      productCount: count.total,
      inStockCount: count.inStock,
      latestRun: latestRun ? toRunView(latestRun) : null,
    });
  }

  return views.sort((left, right) => left.name.localeCompare(right.name));
}

export async function updateRetailerDiscoverySettings(
  retailerId: string,
  input: {
    discoveryEnabled?: boolean;
    refreshIntervalHours?: number;
  },
): Promise<RetailerAdminView> {
  registerBuiltInAdapters();
  const adapter = retailerRegistry.getById(retailerId);
  if (!adapter) {
    throw new CatalogueDiscoveryError(`Unknown retailer: ${retailerId}`, 404);
  }
  if (input.discoveryEnabled && !adapter.catalogue) {
    throw new CatalogueDiscoveryError(
      `${adapter.name} does not support catalogue discovery. Use URL monitoring instead.`,
      409,
    );
  }
  if (
    input.refreshIntervalHours !== undefined &&
    (!Number.isInteger(input.refreshIntervalHours) ||
      input.refreshIntervalHours < 1 ||
      input.refreshIntervalHours > 24)
  ) {
    throw new CatalogueDiscoveryError(
      "Refresh interval must be between 1 and 24 hours",
      400,
    );
  }

  await upsertRetailerCatalogue(retailerId, input);
  const views = await listRetailerAdminViews();
  const view = views.find((candidate) => candidate.id === retailerId);
  if (!view) {
    throw new CatalogueDiscoveryError("Retailer not found", 404);
  }
  return view;
}

export async function startRetailerCatalogueDiscovery(
  retailerId: string,
  mode: "initial" | "refresh" = "refresh",
) {
  registerBuiltInAdapters();
  const adapter = retailerRegistry.getById(retailerId);
  if (!adapter) {
    throw new CatalogueDiscoveryError(`Unknown retailer: ${retailerId}`, 404);
  }
  if (!adapter.catalogue) {
    throw new CatalogueDiscoveryError(
      `${adapter.name} does not support catalogue discovery. Use URL monitoring instead.`,
      409,
    );
  }

  const run = await startCatalogueDiscovery({
    retailerId,
    trigger: "MANUAL",
    forceRefresh: mode === "refresh",
  });

  return {
    ...toRunView(run),
    catalogue: await getRetailerCatalogue(retailerId),
  };
}
