import type { AvailabilityStatus } from "@/modules/retailers/core/types";
import type { RetailerErrorCode } from "@/modules/retailers/core/errors";
import { hostnameMatches } from "@/modules/retailers/core/retailer-registry";

/**
 * Controllable state for a single mock product. Tests and the dev UI
 * mutate these to simulate stock changes, price changes, and errors.
 */
export interface MockProductState {
  name: string;
  imageUrl?: string;
  currency: string;
  priceMinor?: number;
  originalPriceMinor?: number;
  discountPct?: number;
  availability: AvailabilityStatus;
  sku?: string;
  gtin?: string;
  mpn?: string;
  brand?: string;
  model?: string;
}

export interface MockErrorState {
  code: Exclude<RetailerErrorCode, "INVALID_URL">;
  message: string;
}

/**
 * Control surface for the mock retailer. The store is the source of truth
 * the adapter reads from; tests mutate it between checks.
 */
export interface MockStore {
  get(sku: string): MockProductState | undefined;
  set(sku: string, state: MockProductState): void;
  setAvailability(sku: string, availability: AvailabilityStatus): void;
  setPrice(sku: string, priceMinor: number | undefined): void;
  setError(sku: string, error: MockErrorState | undefined): void;
  getError(sku: string): MockErrorState | undefined;
  delete(sku: string): void;
  clear(): void;
  /** Snapshot of every product currently in the mock catalogue. */
  list(): Array<{ sku: string; state: MockProductState }>;
}

/** Default store with a reset() that restores the seeded fixtures. */
export interface DefaultMockStore extends MockStore {
  reset(): void;
}

export const MOCK_RETAILER_DOMAIN = "mock-retailer.test";

/** Stable SKUs the dev UI and tests can rely on. */
export const MOCK_PRODUCT_URLS = {
  inStock: `https://${MOCK_RETAILER_DOMAIN}/products/in-stock`,
  outOfStock: `https://${MOCK_RETAILER_DOMAIN}/products/out-of-stock`,
  priceDrops: `https://${MOCK_RETAILER_DOMAIN}/products/price-drops`,
  flaky: `https://${MOCK_RETAILER_DOMAIN}/products/flaky`,
  preorder: `https://${MOCK_RETAILER_DOMAIN}/products/preorder`,
} as const;

export function mockProductUrl(sku: string): string {
  return `https://${MOCK_RETAILER_DOMAIN}/products/${encodeURIComponent(sku)}`;
}

/** SKU extracted from a mock product URL, or undefined when invalid. */
export function mockSkuFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!hostnameMatches(parsed.hostname, MOCK_RETAILER_DOMAIN)) {
      return undefined;
    }
    const match = parsed.pathname.match(/^\/products\/([^/]+)\/?$/);
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}
