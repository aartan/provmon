/**
 * Core retailer domain types. These are the only product shapes the
 * monitoring engine, notification rules, and UI are allowed to see —
 * retailer-specific formats never cross the adapter boundary.
 */

export const AVAILABILITY_STATUSES = [
  "IN_STOCK",
  "OUT_OF_STOCK",
  "PREORDER",
  "UNKNOWN",
] as const;

export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

/**
 * Normalised product snapshot returned by every retailer adapter.
 *
 * `priceMinor` is an integer amount in minor units (pence, cents) paired
 * with the ISO 4217 `currency` code. It is undefined when the retailer does
 * not expose a price. `availability` of UNKNOWN means the adapter could not
 * determine stock — it must never be coerced to OUT_OF_STOCK by adapters
 * or by the engine.
 */
export interface ProductDetails {
  retailerId: string;
  /** The retailer's own product identifier, when derivable from the URL. */
  retailerProductId?: string;
  /** The retailer's SKU when it differs from the product identifier. */
  sku?: string;
  /** GTIN/EAN/UPC when the retailer exposes one; validated before matching. */
  gtin?: string;
  /** Manufacturer part number when unambiguously available. */
  mpn?: string;
  brand?: string;
  model?: string;
  /** Retailer-side category label, when the adapter exposes one. */
  category?: string;
  name: string;
  /** Canonical product URL. */
  url: string;
  imageUrl?: string;
  currency: string;
  priceMinor?: number;
  /** Original price / RRP in minor units when the retailer exposes one. */
  originalPriceMinor?: number;
  /** Retailer-provided discount percentage, when available. */
  discountPct?: number;
  availability: AvailabilityStatus;
  lastUpdated: Date;
}

/** Result of parsing a retailer product URL. */
export interface ParsedProductUrl {
  /** Retailer-specific product identifier, if derivable from the URL. */
  retailerProductId?: string;
  /** Canonicalised URL the adapter will fetch. */
  url: string;
}
