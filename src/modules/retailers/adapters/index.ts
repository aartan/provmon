import { cashConvertersRetailer } from "@/modules/retailers/adapters/cashconverters";
import { mockRetailer } from "@/modules/retailers/adapters/mock";
import { retailerRegistry } from "@/modules/retailers/core/retailer-registry";

/**
 * Register every built-in retailer adapter with the shared registry.
 * Idempotent and safe to call from the web process and the worker.
 *
 * Adding a new retailer means importing and registering its adapter here —
 * that is the only wiring change required; the monitoring engine, rules,
 * and UI are untouched.
 */
export function registerBuiltInAdapters(): void {
  for (const adapter of [mockRetailer, cashConvertersRetailer]) {
    if (!retailerRegistry.has(adapter.id)) {
      retailerRegistry.register(adapter);
    }
  }
}
