import { MockRetailerAdapter } from "@/modules/retailers/adapters/mock/adapter";
import { createDefaultMockStore } from "@/modules/retailers/adapters/mock/store";

export { MockRetailerAdapter } from "@/modules/retailers/adapters/mock/adapter";
export { createDefaultMockStore, createMockStore } from "@/modules/retailers/adapters/mock/store";
export * from "@/modules/retailers/adapters/mock/types";

/**
 * Built-in mock adapter used by the dev UI and as the reference
 * implementation in contract tests.
 */
export const mockRetailer = new MockRetailerAdapter(createDefaultMockStore());
