
import { Worker, type Job } from "bullmq";

import { logger } from "@/lib/logger";
import { MONITOR_QUEUE } from "@/lib/queue";
import { redis } from "@/lib/redis";
import { registerBuiltInAdapters } from "@/modules/retailers/adapters";
import { ensureSweepRepeatJob, sweepDueSubscriptions, triggerSweepNow } from "@/modules/monitoring/scheduler";
import { processCheckJob } from "@/modules/monitoring/service";
import { CHECK_JOB_NAME, SWEEP_JOB_NAME } from "@/modules/monitoring/types";

const log = logger.child({ component: "monitoring-worker" });

async function processor(job: Job): Promise<unknown> {
  switch (job.name) {
    case SWEEP_JOB_NAME:
      return sweepDueSubscriptions();
    case CHECK_JOB_NAME:
      return processCheckJob(job.data as { subscriptionId: string });
    default:
      throw new Error(`Unknown job name: ${job.name}`);
  }
}

/**
 * Create the monitoring worker. In development the worker runs inside the
 * Next.js process (see `src/instrumentation.ts`); in production it runs as
 * a separate process via `src/worker.ts`.
 */
export function createMonitoringWorker(): Worker {
  const worker = new Worker(MONITOR_QUEUE, processor, {
    connection: redis,
    concurrency: 5,
  });

  worker.on("failed", (job, error) => {
    log.error(
      { jobId: job?.id, jobName: job?.name, err: error },
      "job failed after retries",
    );
  });

  worker.on("error", (error) => {
    log.error({ err: error }, "worker error");
  });

  log.info("monitoring worker started");
  return worker;
}

/**
 * Start the worker inside the current process (dev mode). Registers
 * adapters, creates the worker, and arms the recurring sweep plus an
 * immediate one so freshly added subscriptions are checked promptly.
 */
export async function startInProcessWorker(): Promise<Worker | null> {
  if (process.env.WORKER_ENABLED === "false") {
    log.info("worker disabled via WORKER_ENABLED=false");
    return null;
  }
  registerBuiltInAdapters();
  const worker = createMonitoringWorker();
  await ensureSweepRepeatJob();
  await triggerSweepNow();
  return worker;
}

export { CHECK_JOB_NAME, SWEEP_JOB_NAME };
