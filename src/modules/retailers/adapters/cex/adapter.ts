import { env } from "@/lib/env";
import type { RetailerAdapter } from "@/modules/retailers/core/adapter.interface";
import {
  ProductNotFoundError,
  RetailerBlockedError,
  RetailerNetworkError,
  RetailerParseError,
  RetailerRateLimitedError,
  RetailerTimeoutError,
} from "@/modules/retailers/core/errors";
import type {
  ParsedProductUrl,
  ProductDetails,
} from "@/modules/retailers/core/types";
import {
  CEX_DOMAIN,
  parseCeXUrl,
  parseProductHit,
} from "@/modules/retailers/adapters/cex/parser";
import { searchResponseSchema } from "@/modules/retailers/adapters/cex/schemas";

export interface CeXAdapterOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** API base URL, e.g. https://search.webuy.io. */
  baseUrl?: string;
  /** Algolia application id; public search-only credential. */
  applicationId?: string;
  /** Algolia API key; public search-only credential. */
  apiKey?: string;
  /** Algolia index name. */
  indexName?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "ProvMon/1.0 (price monitoring; contact: provmon@example.com)";

/**
 * CeX (uk.webuy.com) adapter.
 *
 * Data source: the public Algolia search index CeX's own website uses
 * (search.webuy.io multi-query endpoint). The application id and
 * API key are public, read-only search credentials embedded in every
 * visitor's browser by uk.webuy.com — they are not secrets and grant no
 * write access. No authentication or CAPTCHA bypass is involved. Request
 * cadence is limited by the engine to this adapter's minCheckIntervalMs
 * floor.
 *
 * Availability semantics: a box (product type) is sold from stores and
 * online. A hit with zero units everywhere, or a box id that has
 * disappeared from the index entirely, means out of stock; the latter is
 * reported as ProductNotFoundError and the engine records OUT_OF_STOCK
 * (see treatNotFoundAsOutOfStock).
 */
export class CeXAdapter implements RetailerAdapter {
  readonly id = "cex";
  readonly name = "CeX";
  readonly supportedDomains = [CEX_DOMAIN];
  readonly minCheckIntervalMs = 5 * 60_000;
  readonly currency = "GBP";
  readonly treatNotFoundAsOutOfStock = true;

  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly applicationId: string;
  private readonly apiKey: string;
  private readonly indexName: string;
  private readonly timeoutMs: number;

  constructor(options: CeXAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? env.CEX_API_URL;
    this.applicationId =
      options.applicationId ?? env.CEX_ALGOLIA_APPLICATION_ID;
    this.apiKey = options.apiKey ?? env.CEX_ALGOLIA_API_KEY;
    this.indexName = options.indexName ?? env.CEX_ALGOLIA_INDEX;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  parseProductUrl(url: string): ParsedProductUrl {
    return parseCeXUrl(url);
  }

  async getProduct(url: string): Promise<ProductDetails> {
    const { retailerProductId } = this.parseProductUrl(url);
    const boxId = retailerProductId ?? "";

    // objectID is guaranteed filterable in every Algolia index; CeX uses
    // the box id as the object id. Limit the response to the fields the
    // parser consumes.
    const params = new URLSearchParams({
      filters: `objectID:${boxId}`,
      hitsPerPage: "1",
      attributesToRetrieve:
        "boxId,boxName,imageUrls,sellPrice,ecomQuantity,collectionQuantity,discontinued",
    });

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/1/indexes/*/queries`, {
        method: "POST",
        headers: {
          "user-agent": USER_AGENT,
          accept: "application/json",
          "content-type": "application/json",
          "x-algolia-application-id": this.applicationId,
          "x-algolia-api-key": this.apiKey,
        },
        body: JSON.stringify({
          requests: [{ indexName: this.indexName, params: params.toString() }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new RetailerTimeoutError(this.id, error);
      }
      throw new RetailerNetworkError(this.id, error);
    }

    if (response.status === 429) {
      throw new RetailerRateLimitedError(this.id);
    }
    if (response.status === 403) {
      throw new RetailerBlockedError(this.id);
    }
    if (!response.ok) {
      throw new RetailerNetworkError(
        this.id,
        new Error(`HTTP ${response.status}`),
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new RetailerParseError(this.id, error);
    }

    const parsed = searchResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new RetailerParseError(this.id, parsed.error);
    }

    const hit = parsed.data.results[0]?.hits[0];
    if (!hit) {
      // A box that no longer appears in the search index has sold out
      // everywhere or been delisted.
      throw new ProductNotFoundError(this.id, boxId);
    }

    return parseProductHit(hit);
  }
}
