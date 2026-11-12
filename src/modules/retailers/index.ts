/**
 * Retailer module public surface.
 */
export * from "@/modules/retailers/core/types";
export * from "@/modules/retailers/core/errors";
export type { RetailerAdapter } from "@/modules/retailers/core/adapter.interface";
export { retailerRegistry } from "@/modules/retailers/core/retailer-registry";
export { resolveRetailerUrl } from "@/modules/retailers/core/retailer-resolver";
export {
  ensureRetailerPluginsLoaded,
  getPluginStatus,
  listPluginStatuses,
  loadRetailerPlugins,
  resetRetailerPluginsForTests,
  shutdownRetailerPlugins,
  type LoadRetailerPluginsOptions,
  type LoadRetailerPluginsResult,
  type PluginStatusRecord,
} from "@/modules/retailers/plugin";
