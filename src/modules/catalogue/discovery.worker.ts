import { Worker, type Job } from "bullmq";

import { logger } from "@/lib/logger";
import { CATALOGUE_QUEUE } from "@/lib/queue";
import { redis } from "@/lib/redis";
import { registerBuiltInAdapters } from "@/modules/retailers/adapters";
import {
  CATALOGUE_STEP_JOB_NAME,
  CATALOGUE_SWEEP_JOB_NAME,
  ensureCatalogueSweepRepeatJob,
  handleCatalogueStepFailure,
  processCatalogueDiscoveryStep,
  sweepDueCatalogues,
  triggerCatalogueSweepNow,
  type CatalogueStepJobData,
} from "@/modules/catalogue/discovery.service";

const log = logger.child({ component: "catalogue-worker" });

async function processor(job: Job): Promise<unknown> {
  switch (job.name) {
    case CATALOGUE_STEP_JOB_NAME: {
      const { runId } = job.data as CatalogueStepJobData;
      try {
        return await processCatalogueDiscoveryStep(runId);
      } catch (error) {
        // Mark the run as failed before BullMQ's final attempt is recorded,
        // so the retailer management UI never shows a permanently "running"
        // run after its retries are exhausted. Earlier attempts keep the
        // persisted cursor and are retried by BullMQ.
        const attempts = job.opts.attempts ?? 1;
        await handleCatalogueStepFailure(
          runId,
          error,
          job.attemptsMade + 1 >= attempts,
        );
        throw error;
      }
    }
    case CATALOGUE_SWEEP_JOB_NAME:
      return sweepDueCatalogues();
    default:
      throw new Error(`Unknown catalogue job name: ${job.name}`);
  }
}

/**
 * Worker for retailer catalogue discovery. Each page is a separate job so
 * the BullMQ lock is short, the cursor is checkpointed after every page,
 * and a single slow retailer can never block monitoring checks.
 */
export function createCatalogueWorker(): Worker {
  const worker = new Worker(CATALOGUE_QUEUE, processor, {
    connection: redis,
    // Concurrency is kept modest so a discovery run cannot saturate the
    // database or the retailer's public API. The final refresh step may
    // delist a large portion of a 500k-product catalogue, so the lock is
    // longer than a page import needs.
    concurrency: 3,
    lockDuration: 300_000,
  });

  worker.on("failed", (job, error) => {
    log.error(
      { jobId: job?.id, jobName: job?.name, err: error },
      "catalogue job failed",
    );
  });

  worker.on("error", (error) => {
    log.error({ err: error }, "catalogue worker error");
  });

  log.info("catalogue worker started");
  return worker;
}

/**
 * Start the catalogue worker in the current process. Used by the standalone
 * worker and by Next.js instrumentation in development.
 */
export async function startCatalogueWorker(): Promise<Worker | null> {
  if (process.env.WORKER_ENABLED === "false") {
    log.info("catalogue worker disabled via WORKER_ENABLED=false");
    return null;
  }
  registerBuiltInAdapters();
  const worker = createCatalogueWorker();
  await ensureCatalogueSweepRepeatJob();
  await triggerCatalogueSweepNow();
  return worker;
}

export { CATALOGUE_STEP_JOB_NAME, CATALOGUE_SWEEP_JOB_NAME };
