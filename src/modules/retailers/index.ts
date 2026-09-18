/**
 * Retailer module public surface.
 */
export * from "@/modules/retailers/core/types";
export * from "@/modules/retailers/core/errors";
export type { RetailerAdapter } from "@/modules/retailers/core/adapter.interface";
export { retailerRegistry } from "@/modules/retailers/core/retailer-registry";
export { resolveRetailerUrl } from "@/modules/retailers/core/retailer-resolver";
export { registerBuiltInAdapters } from "@/modules/retailers/adapters";
