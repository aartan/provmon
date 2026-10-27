import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { catalogueQueue } from "@/lib/queue";
import { registerBuiltInAdapters } from "@/modules/retailers/adapters";
import { retailerRegistry } from "@/modules/retailers/core/retailer-registry";
import {
  advanceDiscoveryRun,
  claimDiscoveryRunStep,
  completeDiscoveryRun,
  createDiscoveryRun,
  failDiscoveryRun,
  findActiveDiscoveryRun,
  findDiscoveryRun,
  getRetailerCatalogue,
  listDueCatalogues,
  recoverStaleDiscoveryRuns,
  type CatalogueDiscoveryRunRecord,
} from "@/modules/catalogue/discovery.repository";
import {
  delistUnseenCatalogueListings,
  importCataloguePage,
} from "@/modules/catalogue/discovery.importer";

/**
 * Retailer catalogue discovery orchestration.
 *
 * A run is deliberately advanced one page per BullMQ job. The adapter cursor
 * is persisted after every page, so a crash, deploy, or rate-limit backoff
 * resumes exactly where the last successful page stopped. The next page is
 * queued with a small delay to stay inside the retailer's public API limits.
 */

export const CATALOGUE_STEP_JOB_NAME = "catalogue-step";
export const CATALOGUE_SWEEP_JOB_NAME = "catalogue-sweep";
export const CATALOGUE_SWEEP_INTERVAL_MS = 15 * 60_000;

export interface CatalogueStepJobData {
  runId: string;
}

export class CatalogueDiscoveryError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "CatalogueDiscoveryError";
  }
}

export function catalogueAdapter(retailerId: string) {
  registerBuiltInAdapters();
  const adapter = retailerRegistry.getById(retailerId);
  if (!adapter) {
    throw new CatalogueDiscoveryError(`Unknown retailer: ${retailerId}`, 404);
  }
  if (!adapter.catalogue) {
    throw new CatalogueDiscoveryError(
      `${adapter.name} does not support catalogue discovery yet. Add products by URL instead.`,
      409,
    );
  }
  return adapter;
}

export async function enqueueCatalogueStep(
  runId: string,
  revision: number,
  delayMs = 0,
): Promise<void> {
  await catalogueQueue.add(
    CATALOGUE_STEP_JOB_NAME,
    { runId } satisfies CatalogueStepJobData,
    {
      jobId: `catalogue-${runId}-${revision}`,
      delay: delayMs,
      // A page import is retried from the same persisted cursor. Only the
      // final failed attempt marks the run as failed.
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 500,
      removeOnFail: 500,
    },
  );
}

export interface StartCatalogueDiscoveryInput {
  retailerId: string;
  trigger: "MANUAL" | "SCHEDULED";
  /** Force a full refresh even if no successful run exists yet. */
  forceRefresh?: boolean;
}

/**
 * Start a discovery run, or return the already-active run for this retailer.
 * The unique partial index on (retailer_id) WHERE status IN ('QUEUED',
 * 'RUNNING') is the final arbiter when two requests race.
 */
export async function startCatalogueDiscovery(
  input: StartCatalogueDiscoveryInput,
): Promise<CatalogueDiscoveryRunRecord> {
  catalogueAdapter(input.retailerId);

  const active = await findActiveDiscoveryRun(input.retailerId);
  if (active) {
    await enqueueCatalogueStep(active.id, active.revision);
    return active;
  }

  const catalogue = await getRetailerCatalogue(input.retailerId);
  const mode =
    input.forceRefresh || catalogue.lastSuccessfulRunAt
      ? "REFRESH"
      : "INITIAL";

  const run = await createDiscoveryRun({
    retailerId: input.retailerId,
    mode,
    trigger: input.trigger,
  });

  // A concurrent starter may have won the unique active-run index. Queueing
  // the same revision is harmless: the worker's revision guard skips it.
  await enqueueCatalogueStep(run.id, run.revision);
  return run;
}

export interface CatalogueDiscoveryStepResult {
  runId: string;
  status: "SKIPPED" | "RUNNING" | "COMPLETED";
  imported?: {
    itemsSeen: number;
    itemsCreated: number;
    itemsUpdated: number;
    itemsUnchanged: number;
    priceChanges: number;
  };
  nextCursor?: string | null;
}

export async function processCatalogueDiscoveryStep(
  runId: string,
): Promise<CatalogueDiscoveryStepResult> {
  const current = await findDiscoveryRun(runId);
  if (!current || (current.status !== "QUEUED" && current.status !== "RUNNING")) {
    return { runId, status: "SKIPPED" };
  }

  const run = await claimDiscoveryRunStep(runId, current.revision);
  if (!run) {
    return { runId, status: "SKIPPED" };
  }

  const adapter = catalogueAdapter(run.retailerId);
  const discovery = adapter.catalogue;
  if (!discovery) {
    throw new CatalogueDiscoveryError(
      `${adapter.name} does not support catalogue discovery`,
    );
  }

  const cursor =
    typeof run.cursor === "string"
      ? run.cursor
      : run.cursor === null
        ? null
        : JSON.stringify(run.cursor);

  const page = await discovery.fetchPage(cursor);
  if (page.nextCursor !== null && page.nextCursor === cursor) {
    throw new CatalogueDiscoveryError(
      "Retailer discovery cursor did not advance",
    );
  }

  const seenAt = new Date();
  const imported = await importCataloguePage({
    retailerId: run.retailerId,
    items: page.items,
    seenAt,
  });

  const totals = {
    pagesProcessed: run.pagesProcessed + 1,
    itemsSeen: run.itemsSeen + imported.itemsSeen,
    itemsCreated: run.itemsCreated + imported.itemsCreated,
    itemsUpdated: run.itemsUpdated + imported.itemsUpdated,
    itemsUnchanged: run.itemsUnchanged + imported.itemsUnchanged,
    priceChanges: run.priceChanges + imported.priceChanges,
    totalEstimate: page.totalEstimate ?? run.totalEstimate,
  };

  if (page.nextCursor === null) {
    let itemsDelisted = 0;
    if (run.mode === "REFRESH") {
      itemsDelisted = await delistUnseenCatalogueListings({
        retailerId: run.retailerId,
        runStartedAt: run.startedAt ?? run.createdAt,
        itemsSeen: totals.itemsSeen,
      });
    }

    const catalogue = await getRetailerCatalogue(run.retailerId);
    const nextRefreshAt = catalogue.discoveryEnabled
      ? new Date(
          Date.now() + catalogue.refreshIntervalHours * 60 * 60_000,
        )
      : null;

    await completeDiscoveryRun(run.id, run.revision, {
      itemsDelisted,
      nextRefreshAt,
      totalEstimate: totals.totalEstimate,
      pagesProcessed: totals.pagesProcessed,
      itemsSeen: totals.itemsSeen,
      itemsCreated: totals.itemsCreated,
      itemsUpdated: totals.itemsUpdated,
      itemsUnchanged: totals.itemsUnchanged,
      priceChanges: totals.priceChanges,
    });

    logger.info(
      {
        component: "catalogue-discovery",
        retailerId: run.retailerId,
        runId: run.id,
        mode: run.mode,
        ...totals,
        itemsDelisted,
      },
      "catalogue discovery completed",
    );

    return {
      runId,
      status: "COMPLETED",
      imported,
      nextCursor: null,
    };
  }

  const advanced = await advanceDiscoveryRun(run.id, run.revision, {
    cursor: page.nextCursor,
    totalEstimate: totals.totalEstimate,
    pagesProcessed: totals.pagesProcessed,
    itemsSeen: totals.itemsSeen,
    itemsCreated: totals.itemsCreated,
    itemsUpdated: totals.itemsUpdated,
    itemsUnchanged: totals.itemsUnchanged,
    priceChanges: totals.priceChanges,
  });
  if (advanced) {
    await enqueueCatalogueStep(
      run.id,
      advanced.revision,
      env.CATALOGUE_PAGE_DELAY_MS,
    );
  }

  return {
    runId,
    status: "RUNNING",
    imported,
    nextCursor: page.nextCursor,
  };
}

/**
 * BullMQ exposes the number of previous attempts on a failed job. Only the
 * final attempt marks the run as failed; earlier attempts are retried from
 * the same persisted cursor.
 */
export async function handleCatalogueStepFailure(
  runId: string,
  error: unknown,
  isFinalAttempt: boolean,
): Promise<void> {
  if (!isFinalAttempt) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  await failDiscoveryRun(runId, message);
  logger.error(
    { component: "catalogue-discovery", runId, err: error },
    "catalogue discovery failed after retries",
  );
}

export interface CatalogueSweepResult {
  recovered: number;
  started: number;
}

/**
 * Daily/periodic sweep. Disabled catalogues are ignored; due catalogues get
 * one run (or their existing active run is nudged forward), and abandoned
 * runs are failed so they can be restarted.
 */
export async function sweepDueCatalogues(): Promise<CatalogueSweepResult> {
  const recovered = await recoverStaleDiscoveryRuns();
  const due = await listDueCatalogues();
  let started = 0;

  for (const catalogue of due) {
    try {
      const run = await startCatalogueDiscovery({
        retailerId: catalogue.retailerId,
        trigger: "SCHEDULED",
      });
      if (run.status === "QUEUED") {
        started += 1;
      }
    } catch (error) {
      logger.warn(
        {
          component: "catalogue-discovery",
          retailerId: catalogue.retailerId,
          err: error,
        },
        "could not start scheduled catalogue discovery",
      );
    }
  }

  logger.info(
    { component: "catalogue-discovery", due: due.length, started, recovered },
    "catalogue sweep complete",
  );
  return { recovered, started };
}

export async function ensureCatalogueSweepRepeatJob(): Promise<void> {
  await catalogueQueue.upsertJobScheduler(
    "catalogue-sweep",
    { every: CATALOGUE_SWEEP_INTERVAL_MS },
    { name: CATALOGUE_SWEEP_JOB_NAME, data: {} },
  );
}

export async function triggerCatalogueSweepNow(): Promise<void> {
  await catalogueQueue.add(CATALOGUE_SWEEP_JOB_NAME, {});
}
