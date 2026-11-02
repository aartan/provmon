import type { ParsedProductUrl, ProductDetails } from "@/modules/retailers/core/types";
import { InvalidProductUrlError } from "@/modules/retailers/core/errors";
import { parsePriceToMinor } from "@/lib/money";
import type { CashConvertersProductListItem } from "@/modules/retailers/adapters/cashconverters/schemas";

export const CASHCONVERTERS_DOMAIN = "cashconverters.co.uk";
export const CASHCONVERTERS_SITE_URL = "https://www.cashconverters.co.uk";

/** 12-digit item code, e.g. 053700239842. */
const PRODUCT_CODE_PATTERN = /^\/shop\/.*\/(\d{12})\/?$/;

export function extractProductCode(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    if (
      parsed.hostname !== CASHCONVERTERS_DOMAIN &&
      !parsed.hostname.endsWith(`.${CASHCONVERTERS_DOMAIN}`)
    ) {
      return undefined;
    }
    const match = parsed.pathname.match(PRODUCT_CODE_PATTERN);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Cash Converters uses an enormous placeholder as its "no RRP" value. The
 * shared price parser also enforces a catalogue-wide maximum, but handling
 * the known sentinel here keeps the retailer-specific semantics explicit.
 */
const MISSING_PRICE_SENTINELS = new Set(["999999999900"]);

function parseCashConvertersPrice(
  value: string | null | undefined,
): number | undefined {
  const normalized = value?.trim();
  if (!normalized || MISSING_PRICE_SENTINELS.has(normalized)) {
    return undefined;
  }
  return parsePriceToMinor(normalized) ?? undefined;
}

/**
 * Map a search-API product item into the normalised shape. This function
 * is the only place Cash Converters' field names exist as domain concepts.
 */
export function parseProductListItem(
  item: CashConvertersProductListItem,
): ProductDetails {
  // Sp is the selling price; fall back to Rrp when Sp is missing or sentinel.
  const priceMinor =
    parseCashConvertersPrice(item.Sp) ?? parseCashConvertersPrice(item.Rrp);
  const originalPriceMinor = parseCashConvertersPrice(item.Rrp);
  const imageUrl =
    item.AbsoluteImageUrl ??
    (item.ImageUrl ? `${CASHCONVERTERS_SITE_URL}${item.ImageUrl}` : undefined);

  return {
    retailerId: "cashconverters",
    retailerProductId: item.Code,
    name: item.Title,
    url: `${CASHCONVERTERS_SITE_URL}${item.Url}`,
    imageUrl: imageUrl || undefined,
    currency: "GBP",
    brand: item.Brand ?? undefined,
    category: item.Category ?? item.ProductList ?? undefined,
    priceMinor,
    originalPriceMinor,
    availability: "IN_STOCK",
    lastUpdated: new Date(),
  };
}

/** Canonical URL extraction shared by the resolver and the adapter. */
export function parseCashConvertersUrl(url: string): ParsedProductUrl {
  const code = extractProductCode(url);
  if (!code) {
    throw new InvalidProductUrlError("cashconverters", url);
  }
  return { retailerProductId: code, url };
}
