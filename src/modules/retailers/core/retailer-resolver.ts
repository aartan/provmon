import type { RetailerAdapter } from "@/modules/retailers/core/adapter.interface";
import type { ParsedProductUrl } from "@/modules/retailers/core/types";
import { UnsupportedRetailerError } from "@/modules/retailers/core/errors";
import {
  retailerRegistry,
  type RetailerRegistry,
} from "@/modules/retailers/core/retailer-registry";

export interface ResolvedRetailer {
  adapter: RetailerAdapter;
  parsed: ParsedProductUrl;
}

/**
 * Identify the retailer for a product URL and delegate URL parsing to the
 * matching adapter.
 *
 * The resolver is the single entry point the application uses to turn a
 * user-pasted URL into an adapter + canonical product URL. It throws:
 *  - UnsupportedRetailerError when no adapter claims the domain
 *  - InvalidProductUrlError (from the adapter) when the URL is not a
 *    product URL the retailer's adapter can handle
 *
 * The registry parameter defaults to the shared registry; tests pass an
 * isolated instance.
 */
export function resolveRetailerUrl(
  rawUrl: string,
  registry: RetailerRegistry = retailerRegistry,
): ResolvedRetailer {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new UnsupportedRetailerError("(not a URL)");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsupportedRetailerError(url.hostname);
  }

  const adapter = registry.getByDomain(url.hostname);
  if (!adapter) {
    throw new UnsupportedRetailerError(url.hostname);
  }

  const parsed = adapter.parseProductUrl(url.toString());
  return { adapter, parsed };
}
