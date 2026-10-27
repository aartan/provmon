import "dotenv/config";

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { redis } from "@/lib/redis";
import { registerBuiltInAdapters } from "@/modules/retailers/adapters";
import { ensureSweepRepeatJob, triggerSweepNow } from "@/modules/monitoring/scheduler";
import { createMonitoringWorker } from "@/modules/monitoring/worker";
import {
  ensureCatalogueSweepRepeatJob,
  triggerCatalogueSweepNow,
} from "@/modules/catalogue/discovery.service";
import { createCatalogueWorker } from "@/modules/catalogue/discovery.worker";

/**
 * Standalone worker entry point for production: `tsx src/worker.ts`.
 * The web process runs with WORKER_ENABLED=false; this process runs the
 * BullMQ worker and the recurring sweep.
 */
async function main(): Promise<void> {
  const log = logger.child({ component: "worker-entry" });
  log.info({ env: env.NODE_ENV }, "worker starting");

  registerBuiltInAdapters();
  const worker = createMonitoringWorker();
  const catalogueWorker = createCatalogueWorker();
  await ensureSweepRepeatJob();
  await ensureCatalogueSweepRepeatJob();
  await triggerSweepNow();
  await triggerCatalogueSweepNow();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info({ signal }, "worker shutting down");
    await Promise.all([worker.close(), catalogueWorker.close()]);
    redis.disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  logger.error({ component: "worker-entry", err: error }, "worker crashed");
  process.exit(1);
});
