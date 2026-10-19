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
 * Map a search-API product item into the normalised shape. This function
 * is the only place Cash Converters' field names exist as domain concepts.
 */
export function parseProductListItem(
  item: CashConvertersProductListItem,
): ProductDetails {
  // Sp is the selling price; fall back to Rrp when Sp is missing.
  const priceSource = item.Sp ?? item.Rrp ?? null;
  const originalPriceMinor = parsePriceToMinor(item.Rrp) ?? undefined;
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
    priceMinor: parsePriceToMinor(priceSource) ?? undefined,
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
