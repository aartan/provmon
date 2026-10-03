import type { RetailerAdapter } from "@/modules/retailers/core/adapter.interface";
import {
  InvalidProductUrlError,
  ProductNotFoundError,
  RetailerBlockedError,
  RetailerNetworkError,
  RetailerParseError,
  RetailerRateLimitedError,
  RetailerTimeoutError,
} from "@/modules/retailers/core/errors";
import type { ProductDetails } from "@/modules/retailers/core/types";
import {
  MOCK_RETAILER_DOMAIN,
  mockSkuFromUrl,
  type MockErrorState,
  type MockStore,
} from "@/modules/retailers/adapters/mock/types";

function errorStateToError(retailerId: string, sku: string, error: MockErrorState) {
  switch (error.code) {
    case "NETWORK":
      return new RetailerNetworkError(retailerId);
    case "TIMEOUT":
      return new RetailerTimeoutError(retailerId);
    case "RATE_LIMITED":
      return new RetailerRateLimitedError(retailerId);
    case "BLOCKED":
      return new RetailerBlockedError(retailerId);
    case "PARSE":
      return new RetailerParseError(retailerId);
    case "PRODUCT_NOT_FOUND":
      return new ProductNotFoundError(retailerId, sku);
  }
}

/**
 * Mock retailer adapter backed by a controllable fixture store. It is the
 * reference implementation of the RetailerAdapter contract and doubles as
 * a demo retailer in the dev UI: any SKU added via
 * https://mock-retailer.test/products/<sku> exists and is in stock.
 *
 * Tests simulate retailer behaviour by mutating the store:
 *  - store.setAvailability / store.setPrice — stock and price changes
 *  - store.setError(sku, { code, message }) — retailer errors
 *  - store.delete(sku) — product removed from the catalogue
 */
export class MockRetailerAdapter implements RetailerAdapter {
  readonly id = "mock";
  readonly name = "Mock Retailer";
  readonly supportedDomains = [MOCK_RETAILER_DOMAIN];
  readonly minCheckIntervalMs = 60_000;
  readonly currency = "GBP";
  readonly treatNotFoundAsOutOfStock = false;

  constructor(readonly store: MockStore) {}

  parseProductUrl(url: string) {
    const sku = mockSkuFromUrl(url);
    if (!sku) {
      throw new InvalidProductUrlError(this.id, url);
    }
    return { retailerProductId: sku, url };
  }

  async getProduct(url: string): Promise<ProductDetails> {
    const { retailerProductId: sku } = this.parseProductUrl(url);

    const error = this.store.getError(sku);
    if (error) {
      throw errorStateToError(this.id, sku, error);
    }

    const state = this.store.get(sku);
    if (!state) {
      throw new ProductNotFoundError(this.id, sku);
    }

    return {
      retailerId: this.id,
      retailerProductId: sku,
      name: state.name,
      url,
      imageUrl: state.imageUrl || undefined,
      currency: state.currency,
      priceMinor: state.priceMinor,
      availability: state.availability,
      lastUpdated: new Date(),
    };
  }
}
