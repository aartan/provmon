import { describe, expect, it, vi } from "vitest";

import { CeXAdapter } from "@/modules/retailers/adapters/cex/adapter";
import {
  discontinuedHitFixture,
  emptyResultsFixture,
  inStockHitFixture,
  outOfStockEverywhereHitFixture,
} from "@/modules/retailers/adapters/cex/fixtures";
import {
  CEX_SITE_URL,
  canonicalProductUrl,
  extractBoxId,
  normalizeImageUrl,
  parseProductHit,
} from "@/modules/retailers/adapters/cex/parser";
import { runRetailerAdapterContractTests } from "@/modules/retailers/core/adapter.contract";
import {
  InvalidProductUrlError,
  ProductNotFoundError,
  RetailerBlockedError,
  RetailerNetworkError,
  RetailerParseError,
  RetailerRateLimitedError,
  RetailerTimeoutError,
} from "@/modules/retailers/core/errors";
import { RetailerRegistry } from "@/modules/retailers/core/retailer-registry";
import { resolveRetailerUrl } from "@/modules/retailers/core/retailer-resolver";

const BOX_ID = "SLAPAPPMP16146SGB";
const PRODUCT_URL = `${CEX_SITE_URL}/product-detail?id=${BOX_ID}`;

interface StubCall {
  url: string;
  init?: RequestInit;
}

function stubFetch(
  handler: (call: StubCall) => { status: number; body: unknown },
) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const { status, body } = handler({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function createAdapter(
  fetchImpl: typeof fetch,
  options: { baseUrl?: string } = {},
) {
  return new CeXAdapter({
    fetchImpl,
    baseUrl: options.baseUrl ?? "https://stub.example",
  });
}

runRetailerAdapterContractTests({
  createAdapter: () =>
    createAdapter(stubFetch(() => ({ status: 200, body: inStockHitFixture }))),
  validProductUrl: PRODUCT_URL,
  invalidProductUrls: [
    `${CEX_SITE_URL}/`,
    `${CEX_SITE_URL}/search?stext=macbook`,
    `${CEX_SITE_URL}/product-detail`,
    `${CEX_SITE_URL}/product-detail?id=`,
    `${CEX_SITE_URL}/product-detail?id=nope`,
  ],
});

describe("extractBoxId", () => {
  it("extracts the box id from a product-detail URL", () => {
    expect(extractBoxId(PRODUCT_URL)).toBe(BOX_ID);
  });

  it("handles www subdomains and trailing slashes", () => {
    expect(
      extractBoxId(`https://www.webuy.com/product-detail/?id=${BOX_ID}`),
    ).toBe(BOX_ID);
  });

  it("rejects non-product paths and missing or malformed ids", () => {
    expect(extractBoxId(`${CEX_SITE_URL}/`)).toBeUndefined();
    expect(extractBoxId(`${CEX_SITE_URL}/search?stext=x`)).toBeUndefined();
    expect(extractBoxId(`${CEX_SITE_URL}/product-detail`)).toBeUndefined();
    expect(
      extractBoxId(`${CEX_SITE_URL}/product-detail?id=short`),
    ).toBeUndefined();
  });

  it("rejects foreign domains and malformed URLs", () => {
    expect(
      extractBoxId(`https://example.com/product-detail?id=${BOX_ID}`),
    ).toBeUndefined();
    expect(extractBoxId("not a url")).toBeUndefined();
  });
});

describe("parseProductHit", () => {
  it("maps an in-stock hit into normalised details", () => {
    const details = parseProductHit(inStockHitFixture.results[0].hits[0]);
    expect(details).toMatchObject({
      retailerId: "cex",
      retailerProductId: BOX_ID,
      name: 'MacBook Pro 16,1/i9-9880H/16GB/1TB SSD/5500M 4GB/16"/SG/B',
      currency: "GBP",
      priceMinor: 51000,
      availability: "IN_STOCK",
    });
    expect(details.url).toBe(PRODUCT_URL);
    expect(details.imageUrl).toBe(
      "https://uk.static.webuy.com/product_images/Computing/Laptops%20-%20Apple%20Mac/SLAPAPPMP16146SGB_l.jpg",
    );
  });

  it("maps zero units everywhere to OUT_OF_STOCK", () => {
    const details = parseProductHit(
      outOfStockEverywhereHitFixture.results[0].hits[0],
    );
    expect(details.availability).toBe("OUT_OF_STOCK");
  });

  it("maps discontinued hits to OUT_OF_STOCK", () => {
    const details = parseProductHit(discontinuedHitFixture.results[0].hits[0]);
    expect(details.availability).toBe("OUT_OF_STOCK");
  });

  it("falls back to smaller image sizes and tolerates missing images", () => {
    const hit = {
      ...inStockHitFixture.results[0].hits[0],
      imageUrls: {
        large: null,
        medium: "https://uk.static.webuy.com/product_images/x_m.jpg",
        small: null,
      },
    };
    expect(parseProductHit(hit).imageUrl).toBe(
      "https://uk.static.webuy.com/product_images/x_m.jpg",
    );

    const noImage = { ...hit, imageUrls: null };
    expect(parseProductHit(noImage).imageUrl).toBeUndefined();
  });
});

describe("normalizeImageUrl", () => {
  it("percent-encodes spaces in image URLs", () => {
    expect(
      normalizeImageUrl(
        "https://uk.static.webuy.com/product_images/Laptops - Apple Mac/x_l.jpg",
      ),
    ).toBe(
      "https://uk.static.webuy.com/product_images/Laptops%20-%20Apple%20Mac/x_l.jpg",
    );
  });

  it("returns undefined for missing or invalid URLs", () => {
    expect(normalizeImageUrl(null)).toBeUndefined();
    expect(normalizeImageUrl("")).toBeUndefined();
    expect(normalizeImageUrl("not a url")).toBeUndefined();
  });
});

describe("canonicalProductUrl", () => {
  it("builds the product-detail URL for a box id", () => {
    expect(canonicalProductUrl(BOX_ID)).toBe(PRODUCT_URL);
  });
});

describe("CeXAdapter.getProduct", () => {
  it("posts an objectID-filtered query and returns normalised details", async () => {
    const fetchImpl = stubFetch(({ url, init }) => {
      expect(url).toBe("https://stub.example/1/indexes/*/queries");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as {
        requests: { indexName: string; params: string }[];
      };
      expect(body.requests[0].indexName).toBe("prod_cex_uk");
      expect(body.requests[0].params).toContain(
        `filters=${encodeURIComponent(`objectID:${BOX_ID}`)}`,
      );
      return { status: 200, body: inStockHitFixture };
    });
    const adapter = createAdapter(fetchImpl);

    const details = await adapter.getProduct(PRODUCT_URL);
    expect(details.name).toContain("MacBook Pro 16,1");
    expect(details.priceMinor).toBe(51000);
    expect(details.availability).toBe("IN_STOCK");
  });

  it("throws ProductNotFoundError when the box is no longer listed", async () => {
    const adapter = createAdapter(
      stubFetch(() => ({ status: 200, body: emptyResultsFixture })),
    );
    await expect(adapter.getProduct(PRODUCT_URL)).rejects.toBeInstanceOf(
      ProductNotFoundError,
    );
  });

  it("maps HTTP errors to typed retailer errors", async () => {
    const cases = [
      [429, RetailerRateLimitedError],
      [403, RetailerBlockedError],
      [500, RetailerNetworkError],
    ] as const;

    for (const [status, errorClass] of cases) {
      const adapter = createAdapter(
        stubFetch(() => ({ status, body: {} })),
      );
      await expect(adapter.getProduct(PRODUCT_URL)).rejects.toBeInstanceOf(
        errorClass,
      );
    }
  });

  it("maps malformed responses to RetailerParseError", async () => {
    const adapter = createAdapter(
      stubFetch(() => ({ status: 200, body: { results: [] } })),
    );
    // An empty results array is valid JSON but means the box is gone.
    await expect(adapter.getProduct(PRODUCT_URL)).rejects.toBeInstanceOf(
      ProductNotFoundError,
    );

    const malformed = createAdapter(
      stubFetch(() => ({ status: 200, body: { hits: 42 } })),
    );
    await expect(malformed.getProduct(PRODUCT_URL)).rejects.toBeInstanceOf(
      RetailerParseError,
    );

    const notJson = createAdapter(
      vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
    );
    await expect(notJson.getProduct(PRODUCT_URL)).rejects.toBeInstanceOf(
      RetailerParseError,
    );
  });

  it("maps timeouts to RetailerTimeoutError", async () => {
    const adapter = createAdapter(
      vi.fn(async () => {
        const error = new Error("timed out");
        error.name = "TimeoutError";
        throw error;
      }) as unknown as typeof fetch,
    );
    await expect(adapter.getProduct(PRODUCT_URL)).rejects.toBeInstanceOf(
      RetailerTimeoutError,
    );
  });

  it("rejects invalid product URLs", async () => {
    const adapter = createAdapter(stubFetch(() => ({ status: 200, body: {} })));
    expect(() =>
      adapter.parseProductUrl(`${CEX_SITE_URL}/`),
    ).toThrow(InvalidProductUrlError);
  });
});

describe("resolver integration", () => {
  it("identifies webuy.com URLs and delegates parsing", () => {
    const registry = new RetailerRegistry();
    registry.register(
      createAdapter(stubFetch(() => ({ status: 200, body: inStockHitFixture }))),
    );

    const resolved = resolveRetailerUrl(PRODUCT_URL, registry);
    expect(resolved.adapter.id).toBe("cex");
    expect(resolved.parsed.retailerProductId).toBe(BOX_ID);
  });
});
