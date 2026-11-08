import { describe, expect, it } from "vitest";

import { MockRetailerAdapter } from "@/modules/retailers/testing/mock/adapter";
import { createMockStore } from "@/modules/retailers/testing/mock/store";
import { mockProductUrl, MOCK_PRODUCT_URLS } from "@/modules/retailers/testing/mock/types";
import {
  ProductNotFoundError,
  RetailerBlockedError,
  RetailerNetworkError,
  RetailerRateLimitedError,
  RetailerTimeoutError,
  isRetailerError,
} from "@/modules/retailers/core/errors";

const baseStates = {
  "in-stock": {
    name: "In stock product",
    currency: "GBP",
    priceMinor: 12345,
    availability: "IN_STOCK" as const,
  },
  "out-of-stock": {
    name: "Out of stock product",
    currency: "GBP",
    priceMinor: undefined,
    availability: "OUT_OF_STOCK" as const,
  },
  preorder: {
    name: "Preorder product",
    currency: "GBP",
    priceMinor: 9999,
    availability: "PREORDER" as const,
  },
};

function createHarness() {
  const store = createMockStore(baseStates);
  const adapter = new MockRetailerAdapter(store);
  return { store, adapter };
}

describe("MockRetailerAdapter", () => {
  it("maps an in-stock fixture to normalised details", async () => {
    const { adapter } = createHarness();
    const details = await adapter.getProduct(mockProductUrl("in-stock"));

    expect(details).toMatchObject({
      retailerId: "mock",
      retailerProductId: "in-stock",
      name: "In stock product",
      currency: "GBP",
      priceMinor: 12345,
      availability: "IN_STOCK",
    });
    expect(details.url).toBe(mockProductUrl("in-stock"));
  });

  it("returns out-of-stock without a price", async () => {
    const { adapter } = createHarness();
    const details = await adapter.getProduct(mockProductUrl("out-of-stock"));

    expect(details.availability).toBe("OUT_OF_STOCK");
    expect(details.priceMinor).toBeUndefined();
  });

  it("reflects price changes made through the store", async () => {
    const { store, adapter } = createHarness();
    const url = mockProductUrl("in-stock");

    expect((await adapter.getProduct(url)).priceMinor).toBe(12345);

    store.setPrice("in-stock", 9999);
    expect((await adapter.getProduct(url)).priceMinor).toBe(9999);

    store.setPrice("in-stock", undefined);
    expect((await adapter.getProduct(url)).priceMinor).toBeUndefined();
  });

  it("reflects availability changes made through the store", async () => {
    const { store, adapter } = createHarness();
    const url = mockProductUrl("in-stock");

    store.setAvailability("in-stock", "OUT_OF_STOCK");
    expect((await adapter.getProduct(url)).availability).toBe("OUT_OF_STOCK");

    store.setAvailability("in-stock", "IN_STOCK");
    expect((await adapter.getProduct(url)).availability).toBe("IN_STOCK");
  });

  it("throws ProductNotFoundError for products removed from the catalogue", async () => {
    const { store, adapter } = createHarness();
    store.delete("in-stock");

    await expect(adapter.getProduct(mockProductUrl("in-stock"))).rejects.toBeInstanceOf(
      ProductNotFoundError,
    );
  });

  it.each([
    ["NETWORK", RetailerNetworkError, true],
    ["TIMEOUT", RetailerTimeoutError, true],
    ["RATE_LIMITED", RetailerRateLimitedError, true],
    ["BLOCKED", RetailerBlockedError, false],
    ["PRODUCT_NOT_FOUND", ProductNotFoundError, false],
  ] as const)(
    "simulates %s errors with the correct type and retryable flag",
    async (code, errorClass, retryable) => {
      const { store, adapter } = createHarness();
      store.setError("in-stock", { code, message: `${code} happened` });

      try {
        await adapter.getProduct(mockProductUrl("in-stock"));
        expect.unreachable("expected an error");
      } catch (error) {
        expect(error).toBeInstanceOf(errorClass);
        expect(isRetailerError(error)).toBe(true);
        if (isRetailerError(error)) {
          expect(error.retryable).toBe(retryable);
          expect(error.retailerId).toBe("mock");
        }
      }
    },
  );

  it("clears simulated errors so checks can recover", async () => {
    const { store, adapter } = createHarness();
    const url = mockProductUrl("in-stock");

    store.setError("in-stock", { code: "NETWORK", message: "down" });
    await expect(adapter.getProduct(url)).rejects.toBeInstanceOf(RetailerNetworkError);

    store.setError("in-stock", undefined);
    expect((await adapter.getProduct(url)).availability).toBe("IN_STOCK");
  });

  it("exposes stable URLs for the dev UI", () => {
    expect(MOCK_PRODUCT_URLS.inStock).toBe(mockProductUrl("in-stock"));
    expect(MOCK_PRODUCT_URLS.outOfStock).toBe(mockProductUrl("out-of-stock"));
  });
});
