import { describe, expect, it, vi } from "vitest";

import { CeXDiscovery } from "@/modules/retailers/adapters/cex/discovery";
import {
  RetailerRateLimitedError,
} from "@/modules/retailers/core/errors";

interface StubCall {
  url: string;
  params: URLSearchParams;
}

function parseCall(url: string, init?: RequestInit): StubCall {
  const body = JSON.parse(String(init?.body)) as {
    requests: Array<{ params: string }>;
  };
  return {
    url,
    params: new URLSearchParams(body.requests[0]?.params ?? ""),
  };
}

function jsonResponse(result: unknown): Response {
  return new Response(JSON.stringify({ results: [result] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function hit(boxId: string, sellPrice = 10) {
  return {
    boxId,
    boxName: `Product ${boxId}`,
    sellPrice,
    ecomQuantity: 1,
    collectionQuantity: 0,
    discontinued: 0,
  };
}

function createDiscovery(
  handler: (call: StubCall) => Response,
  calls: StubCall[] = [],
) {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const call = parseCall(url, init);
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;

  return new CeXDiscovery({
    fetchImpl,
    baseUrl: "https://stub.example",
    applicationId: "app",
    apiKey: "key",
    indexName: "index",
    timeoutMs: 1_000,
  });
}

describe("CeXDiscovery", () => {
  it("lists categories, excludes service categories, and imports a small category", async () => {
    const calls: StubCall[] = [];
    const discovery = createDiscovery((call) => {
      if (call.params.get("hitsPerPage") === "0") {
        return jsonResponse({
          hits: [],
          nbHits: 0,
          facets: {
            categoryFriendlyName: { Consoles: 2, Repairs: 10 },
          },
        });
      }
      return jsonResponse({
        hits: [hit("console-a"), hit("console-b")],
        nbHits: 2,
      });
    }, calls);

    const page = await discovery.fetchPage(null);
    expect(page.items.map((item) => item.retailerProductId)).toEqual([
      "console-a",
      "console-b",
    ]);
    expect(page.nextCursor).toBeNull();
    expect(page.totalEstimate).toBe(2);

    const categoryQuery = calls[1];
    const categoryFilters = JSON.parse(
      categoryQuery?.params.get("facetFilters") ?? "[]",
    ) as string[];
    expect(categoryFilters).toContain('categoryFriendlyName:"Consoles"');
    expect(
      calls.some((call) =>
        call.params.get("facetFilters")?.includes("Repairs"),
      ),
    ).toBe(false);
  });

  it("bisects an oversized price partition and persists the remaining ranges", async () => {
    const calls: StubCall[] = [];
    const discovery = createDiscovery((call) => {
      if (call.params.get("hitsPerPage") === "0") {
        return jsonResponse({
          hits: [],
          facets: { categoryFriendlyName: { Consoles: 1_500 } },
        });
      }
      const filters = call.params.get("numericFilters") ?? "";
      if (!filters.includes("sellPrice")) {
        return jsonResponse({ hits: [hit("base")], nbHits: 1_500 });
      }
      // The first two split buckets are empty; the third is under the cap.
      if (filters.includes("sellPrice>=1000.00")) {
        return jsonResponse({ hits: [], nbHits: 0 });
      }
      if (
        filters.includes("sellPrice>=500.00") &&
        filters.includes("sellPrice<1000.00")
      ) {
        return jsonResponse({ hits: [hit("mid-range")], nbHits: 600 });
      }
      return jsonResponse({ hits: [], nbHits: 0 });
    }, calls);

    const page = await discovery.fetchPage(null);
    expect(page.items.map((item) => item.retailerProductId)).toEqual([
      "mid-range",
    ]);
    expect(page.nextCursor).not.toBeNull();
    expect(page.totalEstimate).toBe(1_500);

    const midRange = calls.find(
      (call) =>
        call.params.get("numericFilters")?.includes("sellPrice>=500.00") &&
        call.params.get("numericFilters")?.includes("sellPrice<1000.00"),
    );
    expect(midRange).toBeDefined();
  });

  it("splits an oversized exact-price bucket by store", async () => {
    const calls: StubCall[] = [];
    const discovery = createDiscovery((call) => {
      if (call.params.get("hitsPerPage") === "0") {
        return jsonResponse({
          hits: [],
          facets: { categoryFriendlyName: { Consoles: 1_500 } },
        });
      }
      const filters = call.params.get("numericFilters") ?? "";
      if (!filters.includes("sellPrice")) {
        return jsonResponse({ hits: [hit("base")], nbHits: 1_500 });
      }

      const lower = Number(
        filters.match(/sellPrice>=([\d.]+)/)?.[1] ?? "-1",
      );
      const upperMatch = filters.match(/sellPrice<([\d.]+)/);
      const upper = upperMatch ? Number(upperMatch[1]) : Number.POSITIVE_INFINITY;
      // Only ranges containing the £10 target stay over the hit cap, so the
      // adapter bisects straight down to the exact-price bucket.
      if (!(lower <= 10 && upper > 10)) {
        return jsonResponse({ hits: [], nbHits: 0 });
      }

      const facets = JSON.parse(
        call.params.get("facetFilters") ?? "[]",
      ) as string[];
      if (facets.includes('stores:"Store B"')) {
        return jsonResponse({ hits: [hit("store-b")], nbHits: 700 });
      }
      if (facets.includes('stores:"Store A"')) {
        return jsonResponse({ hits: [hit("store-a")], nbHits: 800 });
      }
      return jsonResponse({
        hits: [hit("store-base")],
        nbHits: 1_500,
        facets: { stores: { "Store A": 800, "Store B": 700 } },
      });
    }, calls);

    let page = await discovery.fetchPage(null);
    let guard = 0;
    while (page.items.length === 0 && page.nextCursor !== null) {
      guard += 1;
      expect(guard).toBeLessThan(30);
      page = await discovery.fetchPage(page.nextCursor);
    }

    expect(page.items.map((item) => item.retailerProductId)).toEqual([
      "store-base",
    ]);
    expect(page.nextCursor).not.toBeNull();

    const second = await discovery.fetchPage(page.nextCursor);
    expect(second.items.map((item) => item.retailerProductId)).toEqual([
      "store-b",
    ]);
    const storeQuery = calls.find((call) => {
      const filters = JSON.parse(
        call.params.get("facetFilters") ?? "[]",
      ) as string[];
      return filters.includes('stores:"Store B"');
    });
    expect(storeQuery?.params.get("numericFilters")).toContain(
      "sellPrice>=10.00",
    );
    expect(storeQuery?.params.get("numericFilters")).toContain(
      "sellPrice<10.01",
    );
  });

  it("skips malformed hits without failing the page", async () => {
    const discovery = createDiscovery((call) => {
      if (call.params.get("hitsPerPage") === "0") {
        return jsonResponse({
          hits: [],
          facets: { categoryFriendlyName: { Consoles: 2 } },
        });
      }
      return jsonResponse({
        hits: [hit("valid"), { boxId: "missing-name" }],
        nbHits: 2,
      });
    });

    const page = await discovery.fetchPage(null);
    expect(page.items.map((item) => item.retailerProductId)).toEqual(["valid"]);
  });

  it("falls back to the whole index when the category facet is empty", async () => {
    const calls: StubCall[] = [];
    const discovery = createDiscovery((call) => {
      if (call.params.get("hitsPerPage") === "0") {
        return jsonResponse({ hits: [], facets: {} });
      }
      return jsonResponse({ hits: [hit("fallback")], nbHits: 1 });
    }, calls);

    const page = await discovery.fetchPage(null);
    expect(page.items.map((item) => item.retailerProductId)).toEqual([
      "fallback",
    ]);
    expect(page.nextCursor).toBeNull();
    expect(page.totalEstimate).toBeUndefined();
    expect(calls[1]?.params.get("facetFilters")).toBeNull();
  });

  it("maps rate limits to a typed retailer error", async () => {
    const discovery = createDiscovery(
      () => new Response("rate limited", { status: 429 }),
    );

    await expect(discovery.fetchPage(null)).rejects.toBeInstanceOf(
      RetailerRateLimitedError,
    );
  });
});
