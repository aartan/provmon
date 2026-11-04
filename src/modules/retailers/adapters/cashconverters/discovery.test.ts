import { describe, expect, it, vi } from "vitest";

import { CashConvertersDiscovery } from "@/modules/retailers/adapters/cashconverters/discovery";
import {
  RetailerBlockedError,
  RetailerParseError,
} from "@/modules/retailers/core/errors";

interface StubCall {
  url: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pageBody(
  items: unknown[],
  total: number,
): unknown {
  return {
    WasSuccessful: true,
    Value: {
      ProductList: {
        ProductListItemCount: total,
        ProductListItems: items,
      },
    },
  };
}

function item(code: string, title = `Product ${code}`) {
  return {
    Code: code,
    Title: title,
    Url: `/shop/product/${code}`,
    Sp: "19.99",
    Category: "Laptop",
    Brand: "Acme",
  };
}

function createDiscovery(
  handler: (call: StubCall) => Response,
  calls: StubCall[] = [],
) {
  const fetchImpl = vi.fn(async (url: string) => {
    const call = { url };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;

  return new CashConvertersDiscovery({
    fetchImpl,
    baseUrl: "https://stub.example",
    timeoutMs: 1_000,
  });
}

describe("CashConvertersDiscovery", () => {
  it("paginates by page number and terminates after the last page", async () => {
    const calls: StubCall[] = [];
    const discovery = createDiscovery((call) => {
      const page = new URL(call.url).searchParams.get("page");
      if (page === "1") {
        return jsonResponse(pageBody([item("a"), item("b")], 3));
      }
      return jsonResponse(pageBody([item("c")], 3));
    }, calls);

    const first = await discovery.fetchPage(null);
    expect(first.items.map((entry) => entry.retailerProductId)).toEqual([
      "a",
      "b",
    ]);
    expect(first.totalEstimate).toBe(3);
    expect(first.progress).toBeCloseTo(2 / 3);
    expect(first.nextCursor).not.toBeNull();

    const second = await discovery.fetchPage(first.nextCursor);
    expect(second.items.map((entry) => entry.retailerProductId)).toEqual(["c"]);
    expect(second.nextCursor).toBeNull();
    expect(second.progress).toBe(1);

    expect(calls.map((call) => new URL(call.url).searchParams.get("page"))).toEqual([
      "1",
      "2",
    ]);
  });

  it("stops when the API returns an empty page", async () => {
    const discovery = createDiscovery(() =>
      jsonResponse(pageBody([], 100)),
    );

    const page = await discovery.fetchPage(null);
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it("normalises product fields into the shared shape", async () => {
    const discovery = createDiscovery(() =>
      jsonResponse(pageBody([item("abc")], 1)),
    );

    const page = await discovery.fetchPage(null);
    expect(page.items[0]).toMatchObject({
      retailerId: "cashconverters",
      retailerProductId: "abc",
      name: "Product abc",
      currency: "GBP",
      priceMinor: 1999,
      availability: "IN_STOCK",
      category: "Laptop",
      brand: "Acme",
    });
    expect(page.items[0]?.url).toBe(
      "https://www.cashconverters.co.uk/shop/product/abc",
    );
  });

  it("maps failures to typed retailer errors", async () => {
    await expect(
      createDiscovery(
        () =>
          new Response("limited", {
            status: 429,
            headers: { "retry-after": "90" },
          }),
      ).fetchPage(null),
    ).rejects.toMatchObject({
      name: "RetailerRateLimitedError",
      retryAfterMs: 90_000,
    });

    await expect(
      createDiscovery(
        () => new Response("blocked", { status: 403 }),
      ).fetchPage(null),
    ).rejects.toBeInstanceOf(RetailerBlockedError);

    await expect(
      createDiscovery(
        () => jsonResponse({ Value: { ProductList: {} } }),
      ).fetchPage(null),
    ).rejects.toBeInstanceOf(RetailerParseError);
  });
});
