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
import {
  parseProductListItem,
} from "@/modules/retailers/adapters/cashconverters/parser";
import { searchResultsSchema } from "@/modules/retailers/adapters/cashconverters/schemas";

/**
 * Cash Converters catalogue discovery.
 *
 * Their public search API returns a fixed 24 items per page even when a
 * larger page size is requested, but supports deep pagination. The cursor
 * is therefore simply the next page number. An empty query returns the
 * whole live catalogue (sold items disappear from the API).
 */

export interface CashConvertersDiscoveryOptions {
  fetchImpl: typeof fetch;
  baseUrl: string;
  timeoutMs: number;
  userAgent?: string;
}

interface CashConvertersCursor {
  version: 1;
  nextPage: number;
}

const PAGE_SIZE = 24;

export class CashConvertersDiscovery implements CatalogueDiscovery {
  readonly pageSize = PAGE_SIZE;

  constructor(private readonly options: CashConvertersDiscoveryOptions) {}

  async fetchPage(cursor: string | null): Promise<CatalogueDiscoveryPage> {
    const state = cursor
      ? this.decodeCursor(cursor)
      : { version: 1 as const, nextPage: 1 };

    const url =
      `${this.options.baseUrl}/search/results?Sort=default` +
      `&page=${state.nextPage}&query=`;

    let response: Response;
    try {
      response = await this.options.fetchImpl(url, {
        headers: {
          "user-agent":
            this.options.userAgent ??
            "ProvMon/1.0 (price monitoring; contact: provmon@example.com)",
          accept: "application/json",
        },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new RetailerTimeoutError("cashconverters", error);
      }
      throw new RetailerNetworkError("cashconverters", error);
    }

    if (response.status === 429) {
      throw new RetailerRateLimitedError("cashconverters");
    }
    if (response.status === 403) {
      throw new RetailerBlockedError("cashconverters");
    }
    if (!response.ok) {
      throw new RetailerNetworkError(
        "cashconverters",
        new Error(`HTTP ${response.status}`),
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new RetailerParseError("cashconverters", error);
    }

    const parsed = searchResultsSchema.safeParse(json);
    if (!parsed.success) {
      throw new RetailerParseError("cashconverters", parsed.error);
    }
    if (!parsed.data.WasSuccessful) {
      throw new RetailerParseError(
        "cashconverters",
        new Error("WasSuccessful=false"),
      );
    }

    const list = parsed.data.Value.ProductList;
    const items: ProductDetails[] = [];
    for (const item of list.ProductListItems) {
      try {
        items.push(parseProductListItem(item));
      } catch {
        // Keep the remaining page importable if one item is malformed.
      }
    }

    const totalEstimate = list.ProductListItemCount;
    const seenThrough =
      (state.nextPage - 1) * PAGE_SIZE + list.ProductListItems.length;
    const hasMore =
      list.ProductListItems.length > 0 && seenThrough < totalEstimate;

    return {
      items,
      nextCursor: hasMore
        ? JSON.stringify({ version: 1, nextPage: state.nextPage + 1 })
        : null,
      totalEstimate,
      progress:
        totalEstimate > 0
          ? Math.min(1, seenThrough / totalEstimate)
          : undefined,
    };
  }

  private decodeCursor(cursor: string): CashConvertersCursor {
    try {
      const parsed = JSON.parse(cursor) as Partial<CashConvertersCursor>;
      if (
        parsed.version !== 1 ||
        typeof parsed.nextPage !== "number" ||
        !Number.isInteger(parsed.nextPage) ||
        parsed.nextPage < 1
      ) {
        throw new Error("Unsupported Cash Converters discovery cursor");
      }
      return { version: 1, nextPage: parsed.nextPage };
    } catch (error) {
      throw new RetailerParseError("cashconverters", error);
    }
  }
}
