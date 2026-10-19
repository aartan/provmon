import { env } from "@/lib/env";
import type { RetailerAdapter } from "@/modules/retailers/core/adapter.interface";
import type { CatalogueDiscovery } from "@/modules/retailers/core/catalogue";
import {
  ProductNotFoundError,
  RetailerBlockedError,
  RetailerNetworkError,
  RetailerParseError,
  RetailerRateLimitedError,
  RetailerTimeoutError,
} from "@/modules/retailers/core/errors";
import type { ParsedProductUrl, ProductDetails } from "@/modules/retailers/core/types";
import {
  CASHCONVERTERS_DOMAIN,
  parseCashConvertersUrl,
  parseProductListItem,
} from "@/modules/retailers/adapters/cashconverters/parser";
import { searchResultsSchema } from "@/modules/retailers/adapters/cashconverters/schemas";
import { CashConvertersDiscovery } from "@/modules/retailers/adapters/cashconverters/discovery";

export interface CashConvertersAdapterOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** API base URL, e.g. https://www.cashconverters.co.uk/c3api. */
  baseUrl?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "ProvMon/1.0 (price monitoring; contact: provmon@example.com)";

/**
 * Cash Converters UK adapter.
 *
 * Data source: the public search API used by their own website
 * (https://www.cashconverters.co.uk/c3api/search/results?query=<code>).
 * No authentication or CAPTCHA bypass is involved. Request cadence is
 * limited by the engine to this adapter's minCheckIntervalMs floor.
 *
 * Availability semantics: Cash Converters sells unique second-hand items,
 * so a sold item simply disappears from the search API. getProduct throws
 * ProductNotFoundError in that case and the engine records OUT_OF_STOCK
 * (see treatNotFoundAsOutOfStock).
 */
export class CashConvertersAdapter implements RetailerAdapter {
  readonly id = "cashconverters";
  readonly name = "Cash Converters";
  readonly supportedDomains = [CASHCONVERTERS_DOMAIN];
  readonly minCheckIntervalMs = 5 * 60_000;
  readonly currency = "GBP";
  readonly treatNotFoundAsOutOfStock = true;
  readonly catalogue: CatalogueDiscovery;

  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: CashConvertersAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? env.CASHCONVERTERS_API_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.catalogue = new CashConvertersDiscovery({
      fetchImpl: this.fetchImpl,
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs,
      userAgent: USER_AGENT,
    });
  }

  parseProductUrl(url: string): ParsedProductUrl {
    return parseCashConvertersUrl(url);
  }

  async getProduct(url: string): Promise<ProductDetails> {
    const { retailerProductId } = this.parseProductUrl(url);
    const code = retailerProductId ?? "";

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/search/results?Sort=default&page=1&query=${encodeURIComponent(code)}`,
        {
          headers: {
            "user-agent": USER_AGENT,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
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

    const parsed = searchResultsSchema.safeParse(json);
    if (!parsed.success) {
      throw new RetailerParseError(this.id, parsed.error);
    }
    if (!parsed.data.WasSuccessful) {
      throw new RetailerParseError(this.id, new Error("WasSuccessful=false"));
    }

    const items = parsed.data.Value.ProductList.ProductListItems;
    const match = items.find((item) => item.Code === code);
    if (!match) {
      // Sold items disappear from the search API.
      throw new ProductNotFoundError(this.id, code);
    }

    return parseProductListItem(match);
  }
}
