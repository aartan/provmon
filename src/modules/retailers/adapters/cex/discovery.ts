import { z } from "zod";

import {
  RetailerBlockedError,
  RetailerNetworkError,
  RetailerParseError,
  RetailerRateLimitedError,
  RetailerTimeoutError,
} from "@/modules/retailers/core/errors";
import type {
  CatalogueDiscovery,
  CatalogueDiscoveryPage,
} from "@/modules/retailers/core/catalogue";
import type { ProductDetails } from "@/modules/retailers/core/types";
import { parseProductHit } from "@/modules/retailers/adapters/cex/parser";
import { productHitSchema } from "@/modules/retailers/adapters/cex/schemas";

/**
 * CeX catalogue discovery.
 *
 * Algolia's public index exposes at most 1,000 hits for any single query
 * (`hitsPerPage=1000` and `page=0`; later pages return zero). The CeX
 * catalogue is around 500k products, so enumeration is partitioned:
 *
 *  1. one facet request lists the categories (excluding service categories);
 *  2. each category is queried with a price range;
 *  3. any range still over the cap is bisected by sell price until it holds
 *     at most 1,000 products;
 *  4. an exact-price bucket that is still too large is split by store. Store
 *     membership is a facet on the public index; products without a store
 *     are covered by importing the first page of the oversized bucket.
 *
 * The cursor persists the pending partitions, so a worker can resume after
 * every page without repeating earlier requests. Cursors are opaque to the
 * caller and may change shape between adapter versions.
 */

export interface CeXDiscoveryOptions {
  fetchImpl: typeof fetch;
  baseUrl: string;
  applicationId: string;
  apiKey: string;
  indexName: string;
  timeoutMs: number;
  userAgent?: string;
}

interface CeXPartition {
  category: string | null;
  /** Inclusive lower bound in minor units. */
  sellMin: number | null;
  /** Exclusive upper bound in minor units. */
  sellMax: number | null;
  /** Exact Algolia store facet value, when partitioning by store. */
  store: string | null;
}

interface CeXDiscoveryCursor {
  version: 1;
  pending: CeXPartition[];
  pagesFetched: number;
  totalEstimate?: number;
}

interface QueryResult {
  /** Raw hits are validated per item so one malformed product cannot abort a page. */
  hits: unknown[];
  nbHits: number;
  stores: Record<string, number>;
}

const discoveryResponseSchema = z.object({
  results: z.array(
    z.object({
      hits: z.array(z.unknown()).default([]),
      nbHits: z.number().int().nonnegative().optional(),
      facets: z
        .record(
          z.string(),
          z.record(z.string(), z.number().int().nonnegative()),
        )
        .optional(),
    }),
  ),
});

const PAGE_SIZE = 1000;
const MAX_QUERIES_PER_CALL = 6;

/** CeX service categories that are not products. */
export const CEX_SERVICE_CATEGORIES = ["Repairs"] as const;

const ATTRIBUTES_TO_RETRIEVE = [
  "boxId",
  "boxName",
  "sellPrice",
  "ecomQuantity",
  "collectionQuantity",
  "discontinued",
  "imageUrls",
  "Manufacturer",
  "Model Name",
  "Model Number",
  "categoryFriendlyName",
].join(",");

function quoteFacetValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function priceToAlgolia(minor: number): string {
  return (minor / 100).toFixed(2);
}

function isExcludedCategory(
  category: string,
  excluded: readonly string[],
): boolean {
  const normalized = category.trim().toLowerCase();
  return excluded.some((value) => value.trim().toLowerCase() === normalized);
}

function splitPriceRange(
  min: number | null,
  max: number | null,
): Array<[number, number | null]> {
  if (min !== null && max !== null) {
    if (max - min <= 1) {
      return [];
    }
    const middle = Math.floor((min + max) / 2);
    return [
      [min, middle],
      [middle, max],
    ];
  }

  if (min === null || min <= 0) {
    return [
      [0, 100],
      [100, 500],
      [500, 1_000],
      [1_000, 5_000],
      [5_000, 10_000],
      [10_000, 50_000],
      [50_000, 100_000],
      [100_000, null],
    ];
  }

  // Open-ended upper bound: widen geometrically until the range is covered.
  return [
    [min, min * 2],
    [min * 2, null],
  ];
}

export class CeXDiscovery implements CatalogueDiscovery {
  readonly pageSize = PAGE_SIZE;

  constructor(private readonly options: CeXDiscoveryOptions) {}

  async fetchPage(cursor: string | null): Promise<CatalogueDiscoveryPage> {
    const state = cursor ? this.decodeCursor(cursor) : await this.initialCursor();

    for (let attempt = 0; attempt < MAX_QUERIES_PER_CALL; attempt += 1) {
      const partition = state.pending.pop();
      if (!partition) {
        return {
          items: [],
          nextCursor: null,
          totalEstimate: state.totalEstimate,
          progress: 1,
        };
      }

      const result = await this.query(partition);
      state.pagesFetched += 1;

      if (result.nbHits === 0) {
        continue;
      }

      if (result.nbHits <= PAGE_SIZE) {
        return this.pageResult(state, result.hits);
      }

      const split = this.split(partition, result);
      if (split.kind === "price") {
        state.pending.push(...split.partitions);
        continue;
      }

      if (split.kind === "store") {
        state.pending.push(...split.partitions);
        // Return the first page as well: store partitions cover products
        // available in a shop, while this page also covers online-only or
        // otherwise storeless products. Duplicate imports are no-ops.
        return this.pageResult(state, result.hits);
      }

      // No finer partition is available (for example an exact-price bucket
      // with no store facets). Import what the index exposes rather than
      // aborting the whole run.
      return this.pageResult(state, result.hits);
    }

    // The split ladder is deep; yield an empty page so the queue can persist
    // the cursor and continue in a fresh job instead of holding a worker.
    return {
      items: [],
      nextCursor: this.encodeCursor(state),
      totalEstimate: state.totalEstimate,
      progress: this.progress(state),
    };
  }

  private async initialCursor(): Promise<CeXDiscoveryCursor> {
    const params = new URLSearchParams({
      query: "",
      hitsPerPage: "0",
      facets: "categoryFriendlyName",
      maxValuesPerFacet: "1000",
      numericFilters: JSON.stringify(["discontinued=0"]),
    });

    const result = await this.request(params);
    const categories = result.facets?.categoryFriendlyName ?? {};
    const pending: CeXPartition[] = [];
    let totalEstimate = 0;

    for (const [category, count] of Object.entries(categories)) {
      if (count <= 0 || isExcludedCategory(category, CEX_SERVICE_CATEGORIES)) {
        continue;
      }
      totalEstimate += count;
      pending.push({
        category,
        sellMin: null,
        sellMax: null,
        store: null,
      });
    }

    if (pending.length === 0) {
      // The facet request returned no usable categories. Fall back to the
      // whole non-discontinued index; price partitioning still applies.
      pending.push({
        category: null,
        sellMin: null,
        sellMax: null,
        store: null,
      });
    }

    return {
      version: 1,
      pending,
      pagesFetched: 0,
      totalEstimate: totalEstimate > 0 ? totalEstimate : undefined,
    };
  }

  private split(
    partition: CeXPartition,
    result: QueryResult,
  ):
    | { kind: "price"; partitions: CeXPartition[] }
    | { kind: "store"; partitions: CeXPartition[] }
    | { kind: "none" } {
    // 1. Refine price until the bucket is exact or below the cap.
    if (partition.sellMin === null || partition.sellMax === null) {
      const ranges = splitPriceRange(partition.sellMin, partition.sellMax);
      if (ranges.length > 0) {
        return {
          kind: "price",
          partitions: ranges.map(([sellMin, sellMax]) => ({
            ...partition,
            sellMin,
            sellMax,
          })),
        };
      }
    } else if (partition.sellMax - partition.sellMin > 1) {
      const middle = Math.floor((partition.sellMin + partition.sellMax) / 2);
      return {
        kind: "price",
        partitions: [
          { ...partition, sellMin: partition.sellMin, sellMax: middle },
          { ...partition, sellMin: middle, sellMax: partition.sellMax },
        ],
      };
    }

    // 2. Exact price, still over the cap: use store membership.
    if (partition.store === null) {
      const stores = Object.entries(result.stores)
        .filter(([, count]) => count > 0)
        .sort(([left], [right]) => left.localeCompare(right));
      if (stores.length > 1) {
        return {
          kind: "store",
          partitions: stores.map(([store]) => ({ ...partition, store })),
        };
      }
      if (stores.length === 1) {
        return {
          kind: "store",
          partitions: [{ ...partition, store: stores[0][0] }],
        };
      }
    }

    return { kind: "none" };
  }

  private pageResult(
    state: CeXDiscoveryCursor,
    hits: unknown[],
  ): CatalogueDiscoveryPage {
    const items: ProductDetails[] = [];
    for (const raw of hits) {
      const parsed = productHitSchema.safeParse(raw);
      if (!parsed.success) {
        // A single malformed hit must not poison the page. The rest of the
        // catalogue is still importable; the next refresh retries it.
        continue;
      }
      try {
        items.push(parseProductHit(parsed.data));
      } catch {
        // Same policy for values the normaliser rejects.
      }
    }

    return {
      items,
      nextCursor:
        state.pending.length > 0 ? this.encodeCursor(state) : null,
      totalEstimate: state.totalEstimate,
      progress: this.progress(state),
    };
  }

  private progress(state: CeXDiscoveryCursor): number | undefined {
    if (!state.totalEstimate || state.totalEstimate <= 0) {
      return undefined;
    }
    return Math.min(
      0.99,
      (state.pagesFetched * PAGE_SIZE) / state.totalEstimate,
    );
  }

  private encodeCursor(state: CeXDiscoveryCursor): string {
    return JSON.stringify(state);
  }

  private decodeCursor(cursor: string): CeXDiscoveryCursor {
    try {
      const parsed = JSON.parse(cursor) as Partial<CeXDiscoveryCursor>;
      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.pending) ||
        typeof parsed.pagesFetched !== "number"
      ) {
        throw new Error("Unsupported CeX discovery cursor");
      }
      return {
        version: 1,
        pending: parsed.pending,
        pagesFetched: parsed.pagesFetched,
        totalEstimate: parsed.totalEstimate,
      };
    } catch (error) {
      throw new RetailerParseError("cex", error);
    }
  }

  private async query(partition: CeXPartition): Promise<QueryResult> {
    const numericFilters = ["discontinued=0"];
    if (partition.sellMin !== null) {
      numericFilters.push(
        `sellPrice>=${priceToAlgolia(partition.sellMin)}`,
      );
    }
    if (partition.sellMax !== null) {
      numericFilters.push(`sellPrice<${priceToAlgolia(partition.sellMax)}`);
    }

    const facetFilters: string[] = [];
    if (partition.category !== null) {
      facetFilters.push(
        `categoryFriendlyName:${quoteFacetValue(partition.category)}`,
      );
    }
    if (partition.store !== null) {
      facetFilters.push(`stores:${quoteFacetValue(partition.store)}`);
    }

    const params = new URLSearchParams({
      query: "",
      hitsPerPage: String(PAGE_SIZE),
      page: "0",
      attributesToRetrieve: ATTRIBUTES_TO_RETRIEVE,
      numericFilters: JSON.stringify(numericFilters),
      facets: "stores",
      maxValuesPerFacet: "1000",
    });
    if (facetFilters.length > 0) {
      params.set("facetFilters", JSON.stringify(facetFilters));
    }

    const result = await this.request(params);
    return {
      hits: result.hits,
      nbHits: result.nbHits ?? result.hits.length,
      stores: result.facets?.stores ?? {},
    };
  }

  private async request(
    params: URLSearchParams,
  ): Promise<{
    hits: unknown[];
    nbHits?: number;
    facets?: Record<string, Record<string, number>>;
  }> {
    let response: Response;
    try {
      response = await this.options.fetchImpl(
        `${this.options.baseUrl}/1/indexes/*/queries`,
        {
          method: "POST",
          headers: {
            "user-agent":
              this.options.userAgent ??
              "ProvMon/1.0 (price monitoring; contact: provmon@example.com)",
            accept: "application/json",
            "content-type": "application/json",
            "x-algolia-application-id": this.options.applicationId,
            "x-algolia-api-key": this.options.apiKey,
          },
          body: JSON.stringify({
            requests: [
              {
                indexName: this.options.indexName,
                params: params.toString(),
              },
            ],
          }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new RetailerTimeoutError("cex", error);
      }
      throw new RetailerNetworkError("cex", error);
    }

    if (response.status === 429) {
      throw new RetailerRateLimitedError("cex");
    }
    if (response.status === 403) {
      throw new RetailerBlockedError("cex");
    }
    if (!response.ok) {
      throw new RetailerNetworkError(
        "cex",
        new Error(`HTTP ${response.status}`),
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new RetailerParseError("cex", error);
    }

    const parsed = discoveryResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new RetailerParseError("cex", parsed.error);
    }

    const result = parsed.data.results[0];
    if (!result) {
      throw new RetailerParseError(
        "cex",
        new Error("Missing multi-query result"),
      );
    }
    return result;
  }
}
