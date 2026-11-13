import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { runRetailerPluginContractTests } from "@provmon/retailer-plugin-sdk/testing";

import { createExamplePlugin } from "./index.js";

const manifest = JSON.parse(
  readFileSync(new URL("../provmon.plugin.json", import.meta.url), "utf8"),
) as unknown;

const product = {
  id: "widget",
  title: "Example Widget",
  price: "19.99",
  inStock: true,
  imageUrl: "https://cdn.example-retailer.test/widget.jpg",
};

function stubFetch() {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/products?page=1")) {
      return new Response(
        JSON.stringify({ items: [product], total: 1, hasMore: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/products/widget")) {
      return new Response(JSON.stringify(product), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

runRetailerPluginContractTests({
  plugin: createExamplePlugin(stubFetch()),
  manifest,
  createConfig: () => ({
    apiUrl: "https://api.example-retailer.test",
    apiKey: "test",
  }),
  validProductUrl: "https://example-retailer.test/products/widget",
  invalidProductUrls: [
    "https://example-retailer.test/",
    "https://example-retailer.test/search?q=widget",
  ],
});

describe("example plugin", () => {
  it("normalises price and availability", async () => {
    const instance = await createExamplePlugin(stubFetch()).create({
      config: {
        apiUrl: "https://api.example-retailer.test",
        apiKey: "test",
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      plugin: { id: "example", version: "1.0.0" },
    });
    const details = await instance.getProduct(
      "https://example-retailer.test/products/widget",
    );
    expect(details.priceMinor).toBe(1999);
    expect(details.availability).toBe("IN_STOCK");
  });
});
