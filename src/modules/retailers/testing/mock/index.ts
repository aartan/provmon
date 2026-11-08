import { MockRetailerAdapter } from "@/modules/retailers/testing/mock/adapter";
import { createDefaultMockStore } from "@/modules/retailers/testing/mock/store";
import type { DefaultMockStore } from "@/modules/retailers/testing/mock/types";

export { MockRetailerAdapter } from "@/modules/retailers/testing/mock/adapter";
export { createDefaultMockStore, createMockStore } from "@/modules/retailers/testing/mock/store";
export * from "@/modules/retailers/testing/mock/types";

/**
 * In-process mock adapter used by integration tests and local fixtures.
 * External retailer plugins are not loaded in the test environment.
 */
export const mockRetailer = new MockRetailerAdapter(createDefaultMockStore());

/** Controllable store backing the built-in mock adapter. */
export const mockRetailerStore = mockRetailer.store as DefaultMockStore;
