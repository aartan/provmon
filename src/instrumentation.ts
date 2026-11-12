/**
 * Next.js instrumentation: runs once when a server instance starts.
 * In development the BullMQ worker runs inside the Next.js process; set
 * WORKER_ENABLED=false when running the standalone worker instead.
 */
export async function register() {
  // Skip during build; the worker needs a live Redis.
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return;
  }
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const [
      { ensureRetailerPluginsLoaded },
      { warnAboutMissingRetailerPlugins },
      { startInProcessWorker },
      { startCatalogueWorker },
    ] = await Promise.all([
      import("@/modules/retailers"),
      import("@/modules/retailers/plugin/health"),
      import("@/modules/monitoring/worker"),
      import("@/modules/catalogue/discovery.worker"),
    ]);

    await ensureRetailerPluginsLoaded();
    await warnAboutMissingRetailerPlugins();
    await Promise.all([startInProcessWorker(), startCatalogueWorker()]);
  }
}
