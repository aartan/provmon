import { retailerRegistry } from "@/modules/retailers/core/retailer-registry";

import { mockRetailer } from "./mock";

export * from "./mock";

/**
 * Register the controllable mock retailer with the shared registry for
 * integration tests and local development. Safe to call repeatedly.
 */
export function registerTestMockRetailer(): void {
  if (!retailerRegistry.has(mockRetailer.id)) {
    retailerRegistry.register(mockRetailer);
  }
}
