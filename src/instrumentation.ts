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
    const { startInProcessWorker } = await import("@/modules/monitoring/worker");
    await startInProcessWorker();
  }
}
