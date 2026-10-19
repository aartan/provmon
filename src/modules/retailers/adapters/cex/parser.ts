import { parsePriceToMinor } from "@/lib/money";
import { InvalidProductUrlError } from "@/modules/retailers/core/errors";
import type {
  ParsedProductUrl,
  ProductDetails,
} from "@/modules/retailers/core/types";
import type { CeXProductHit } from "@/modules/retailers/adapters/cex/schemas";

export const CEX_DOMAIN = "webuy.com";
export const CEX_SITE_URL = "https://uk.webuy.com";

/**
 * CeX product ("box") ids: uppercase letters and digits, e.g.
 * SLAPAPPMP16146SGB. Loose bounds to tolerate future formats.
 */
const BOX_ID_PATTERN = /^[A-Z0-9]{6,32}$/;

export function extractBoxId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    if (
      parsed.hostname !== CEX_DOMAIN &&
      !parsed.hostname.endsWith(`.${CEX_DOMAIN}`)
    ) {
      return undefined;
    }
    const path = parsed.pathname.replace(/\/+$/, "");
    if (path !== "/product-detail") {
      return undefined;
    }
    const id = parsed.searchParams.get("id");
    if (!id || !BOX_ID_PATTERN.test(id)) {
      return undefined;
    }
    return id;
  } catch {
    return undefined;
  }
}

/** Canonical product page URL for a box id. */
export function canonicalProductUrl(boxId: string): string {
  return `${CEX_SITE_URL}/product-detail?id=${encodeURIComponent(boxId)}`;
}

/**
 * CeX returns image URLs with literal spaces in the path. Normalise them
 * so they remain valid URLs once they cross the adapter boundary.
 */
export function normalizeImageUrl(
  url: string | null | undefined,
): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return new URL(url).toString();
  } catch {
    return undefined;
  }
}

/**
 * Map an Algolia search hit into the normalised shape. This function is
 * the only place CeX field names exist as domain concepts.
 *
 * Availability: a box is in stock when it is not discontinued and has
 * units either online (ecomQuantity) or in-store (collectionQuantity).
 * Both zero means currently out of stock everywhere.
 */
export function parseProductHit(hit: CeXProductHit): ProductDetails {
  const inStock =
    hit.discontinued !== 1 &&
    (hit.ecomQuantity > 0 || hit.collectionQuantity > 0);
  const imageUrl = normalizeImageUrl(
    hit.imageUrls?.large ?? hit.imageUrls?.medium ?? hit.imageUrls?.small,
  );
  // Many media box ids are EAN/UPC codes. Treat a purely numeric id as a
  // candidate GTIN; the catalogue layer validates it before matching.
  const gtin = /^\d{8,14}$/.test(hit.boxId) ? hit.boxId : undefined;

  return {
    retailerId: "cex",
    retailerProductId: hit.boxId,
    gtin,
    name: hit.boxName,
    url: canonicalProductUrl(hit.boxId),
    imageUrl,
    currency: "GBP",
    brand: hit.Manufacturer?.[0],
    category: hit.categoryFriendlyName ?? undefined,
    // CeX's "Model Number" is a model family identifier, not a unique
    // manufacturer part number, so it is not used for canonical matching.
    model: hit["Model Name"]?.[0] ?? hit["Model Number"]?.[0],
    // sellPrice is an integer amount in major units.
    priceMinor: parsePriceToMinor(hit.sellPrice) ?? undefined,
    availability: inStock ? "IN_STOCK" : "OUT_OF_STOCK",
    lastUpdated: new Date(),
  };
}

/** Canonical URL extraction shared by the resolver and the adapter. */
export function parseCeXUrl(url: string): ParsedProductUrl {
  const boxId = extractBoxId(url);
  if (!boxId) {
    throw new InvalidProductUrlError("cex", url);
  }
  return { retailerProductId: boxId, url };
}
