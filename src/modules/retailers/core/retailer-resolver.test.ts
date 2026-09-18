import { describe, expect, it } from "vitest";

import { MockRetailerAdapter } from "@/modules/retailers/adapters/mock/adapter";
import { createMockStore } from "@/modules/retailers/adapters/mock/store";
import { registerBuiltInAdapters } from "@/modules/retailers/adapters";
import {
  InvalidProductUrlError,
  UnsupportedRetailerError,
} from "@/modules/retailers/core/errors";
import { resolveRetailerUrl } from "@/modules/retailers/core/retailer-resolver";
import { retailerRegistry, RetailerRegistry } from "@/modules/retailers/core/retailer-registry";

function isolatedRegistry() {
  const registry = new RetailerRegistry();
  registry.register(new MockRetailerAdapter(createMockStore()));
  return registry;
}

describe("resolveRetailerUrl", () => {
  it("identifies the mock retailer from a product URL", () => {
    const result = resolveRetailerUrl(
      "https://mock-retailer.test/products/in-stock",
      isolatedRegistry(),
    );
    expect(result.adapter.id).toBe("mock");
    expect(result.parsed).toEqual({
      retailerProductId: "in-stock",
      url: "https://mock-retailer.test/products/in-stock",
    });
  });

  it("matches subdomains and www prefixes", () => {
    const result = resolveRetailerUrl(
      "https://www.mock-retailer.test/products/x",
      isolatedRegistry(),
    );
    expect(result.adapter.id).toBe("mock");
  });

  it("throws UnsupportedRetailerError for unknown domains", () => {
    expect(() =>
      resolveRetailerUrl("https://unknown-shop.example/products/x", isolatedRegistry()),
    ).toThrow(UnsupportedRetailerError);
  });

  it("throws UnsupportedRetailerError for non-http(s) protocols", () => {
    expect(() =>
      resolveRetailerUrl("ftp://mock-retailer.test/products/x", isolatedRegistry()),
    ).toThrow(UnsupportedRetailerError);
  });

  it("throws UnsupportedRetailerError for malformed URLs", () => {
    expect(() => resolveRetailerUrl("not a url", isolatedRegistry())).toThrow(
      UnsupportedRetailerError,
    );
  });

  it("delegates URL validation to the adapter (InvalidProductUrlError)", () => {
    expect(() =>
      resolveRetailerUrl("https://mock-retailer.test/", isolatedRegistry()),
    ).toThrow(InvalidProductUrlError);
    expect(() =>
      resolveRetailerUrl(
        "https://mock-retailer.test/search?q=laptop",
        isolatedRegistry(),
      ),
    ).toThrow(InvalidProductUrlError);
  });

  it("trims whitespace around pasted URLs", () => {
    const result = resolveRetailerUrl(
      "  https://mock-retailer.test/products/in-stock  ",
      isolatedRegistry(),
    );
    expect(result.adapter.id).toBe("mock");
  });
});

describe("registerBuiltInAdapters", () => {
  it("registers the mock adapter with the shared registry exactly once", () => {
    expect(retailerRegistry.has("mock")).toBe(false);
    registerBuiltInAdapters();
    registerBuiltInAdapters();
    expect(retailerRegistry.getById("mock")?.name).toBe("Mock Retailer");
  });
});
