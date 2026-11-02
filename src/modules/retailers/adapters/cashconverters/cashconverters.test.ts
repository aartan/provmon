import { describe, expect, it, vi } from "vitest";

import { CashConvertersAdapter } from "@/modules/retailers/adapters/cashconverters/adapter";
import {
  emptyResultsFixture,
  inStockItemFixture,
  markedDownItemFixture,
} from "@/modules/retailers/adapters/cashconverters/fixtures";
import {
  CASHCONVERTERS_SITE_URL,
  extractProductCode,
  parseProductListItem,
} from "@/modules/retailers/adapters/cashconverters/parser";
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
import { resolveRetailerUrl } from "@/modules/retailers/core/retailer-resolver";
import { RetailerRegistry } from "@/modules/retailers/core/retailer-registry";

const PRODUCT_URL = `${CASHCONVERTERS_SITE_URL}/shop/phones-cameras--computers/tablets--laptops/laptops/laptop/053700239842`;

function stubFetch(handler: (url: string) => { status: number; body: unknown }) {
  return vi.fn(async (url: string) => {
    const { status, body } = handler(url);
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
  return new CashConvertersAdapter({
    fetchImpl,
    baseUrl: options.baseUrl ?? "https://stub.example/c3api",
  });
}

runRetailerAdapterContractTests({
  createAdapter: () =>
    createAdapter(stubFetch(() => ({ status: 200, body: inStockItemFixture }))),
  validProductUrl: PRODUCT_URL,
  invalidProductUrls: [
    `${CASHCONVERTERS_SITE_URL}/`,
    `${CASHCONVERTERS_SITE_URL}/search?query=laptops`,
    `${CASHCONVERTERS_SITE_URL}/shop/phones-cameras--computers`,
  ],
});

describe("extractProductCode", () => {
  it("extracts the 12-digit code from a product URL", () => {
    expect(extractProductCode(PRODUCT_URL)).toBe("053700239842");
  });

  it("handles www subdomains and trailing slashes", () => {
    expect(
      extractProductCode(
        "https://www.cashconverters.co.uk/shop/x/y/053700239842/",
      ),
    ).toBe("053700239842");
  });

  it("rejects non-product paths", () => {
    expect(extractProductCode(`${CASHCONVERTERS_SITE_URL}/`)).toBeUndefined();
    expect(
      extractProductCode(`${CASHCONVERTERS_SITE_URL}/search?q=x`),
    ).toBeUndefined();
    expect(
      extractProductCode(`${CASHCONVERTERS_SITE_URL}/shop/laptop`),
    ).toBeUndefined();
  });

  it("rejects foreign domains and malformed URLs", () => {
    expect(
      extractProductCode("https://example.com/shop/x/053700239842"),
    ).toBeUndefined();
    expect(extractProductCode("not a url")).toBeUndefined();
  });
});

describe("parseProductListItem", () => {
  it("maps an in-stock item into normalised details", () => {
    const details = parseProductListItem(
      inStockItemFixture.Value.ProductList.ProductListItems[0],
    );
    expect(details).toMatchObject({
      retailerId: "cashconverters",
      retailerProductId: "053700239842",
      name: "Apple Macbook Pro 15,4 Silver",
      currency: "GBP",
      priceMinor: 29999,
      availability: "IN_STOCK",
    });
    expect(details.url).toBe(PRODUCT_URL);
    expect(details.imageUrl).toBe(
      "https://www.cashconverters.co.uk/globalassets/catalogs/c10c5451-41fb-41a9-b3b6-b4ff00cfe6fb.jpg",
    );
  });

  it("uses Sp (sale price) over Rrp for markdowns", () => {
    const details = parseProductListItem(
      markedDownItemFixture.Value.ProductList.ProductListItems[0],
    );
    expect(details.priceMinor).toBe(224999);
  });

  it("treats the missing-price RRP sentinel as absent", () => {
    const details = parseProductListItem({
      ...inStockItemFixture.Value.ProductList.ProductListItems[0],
      Rrp: "999999999900",
    });
    expect(details.priceMinor).toBe(29999);
    expect(details.originalPriceMinor).toBeUndefined();
  });

  it("falls back to a valid Rrp when Sp is the sentinel", () => {
    const details = parseProductListItem({
      ...inStockItemFixture.Value.ProductList.ProductListItems[0],
      Sp: "999999999900",
      Rrp: "199.99",
    });
    expect(details.priceMinor).toBe(19999);
    expect(details.originalPriceMinor).toBe(19999);
  });

  it("imports products with no usable price as price-less listings", () => {
    const details = parseProductListItem({
      ...inStockItemFixture.Value.ProductList.ProductListItems[0],
      Sp: "999999999900",
      Rrp: "999999999900",
    });
    expect(details.priceMinor).toBeUndefined();
    expect(details.originalPriceMinor).toBeUndefined();
  });

  it("resolves relative image URLs against the site", () => {
    const item = {
      ...inStockItemFixture.Value.ProductList.ProductListItems[0],
      AbsoluteImageUrl: null,
    };
    const details = parseProductListItem(item);
    expect(details.imageUrl).toBe(
      `${CASHCONVERTERS_SITE_URL}/globalassets/catalogs/c10c5451-41fb-41a9-b3b6-b4ff00cfe6fb.jpg`,
    );
  });
});

describe("CashConvertersAdapter.getProduct", () => {
  it("fetches by product code and returns normalised details", async () => {
    const fetchImpl = stubFetch((url) => {
      expect(url).toContain("query=053700239842");
      expect(url).toContain("stub.example/c3api/search/results");
      return { status: 200, body: inStockItemFixture };
    });
    const adapter = createAdapter(fetchImpl);

    const details = await adapter.getProduct(PRODUCT_URL);
    expect(details.name).toBe("Apple Macbook Pro 15,4 Silver");
    expect(details.priceMinor).toBe(29999);
    expect(details.availability).toBe("IN_STOCK");
  });

  it("throws ProductNotFoundError when the item is no longer listed", async () => {
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
      stubFetch(() => ({ status: 200, body: { WasSuccessful: true } })),
    );
    await expect(adapter.getProduct(PRODUCT_URL)).rejects.toBeInstanceOf(
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
      adapter.parseProductUrl(`${CASHCONVERTERS_SITE_URL}/`),
    ).toThrow(InvalidProductUrlError);
  });
});

describe("resolver integration", () => {
  it("identifies cashconverters.co.uk URLs and delegates parsing", () => {
    const registry = new RetailerRegistry();
    registry.register(
      createAdapter(stubFetch(() => ({ status: 200, body: inStockItemFixture }))),
    );

    const resolved = resolveRetailerUrl(PRODUCT_URL, registry);
    expect(resolved.adapter.id).toBe("cashconverters");
    expect(resolved.parsed.retailerProductId).toBe("053700239842");
  });
});
