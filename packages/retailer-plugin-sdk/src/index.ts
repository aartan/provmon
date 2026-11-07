import type { RetailerPlugin } from "./contracts.js";

export * from "./contracts.js";
export * from "./errors.js";
export * from "./money.js";
export * from "./retry-after.js";
export * from "./schemas.js";
export * from "./manifest.js";

/**
 * Identity helper that gives plugin authors type inference without adding
 * runtime coupling to the ProvMon application.
 */
export function defineRetailerPlugin<TConfig = unknown>(
  plugin: RetailerPlugin<TConfig>,
): RetailerPlugin<TConfig> {
  return plugin;
}
