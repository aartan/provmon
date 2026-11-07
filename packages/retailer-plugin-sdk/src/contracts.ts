import type { ZodType } from "zod";

/**
 * Public plugin contracts. These types are the entire retailer-facing
 * surface of ProvMon: plugin packages must not import anything from the
 * ProvMon application itself.
 */

export const PLUGIN_API_VERSION = 1;

export const AVAILABILITY_STATUSES = [
  "IN_STOCK",
  "OUT_OF_STOCK",
  "PREORDER",
  "UNKNOWN",
] as const;

export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

/**
 * Normalised product snapshot returned by every retailer plugin.
 *
 * `priceMinor` is an integer amount in minor units (pence, cents) paired
 * with the ISO 4217 `currency` code. It is undefined when the retailer does
 * not expose a price. `availability` of UNKNOWN means the adapter could not
 * determine stock; it must never be coerced to OUT_OF_STOCK by plugins or
 * by the engine.
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
  /** Canonicalised URL the plugin instance will fetch. */
  url: string;
}

/**
 * Optional retailer-wide catalogue enumeration capability.
 *
 * Discovery is deliberately cursor-based rather than an async iterator:
 * the catalogue module persists the cursor after every page so a crashed
 * worker resumes from the same place instead of restarting the scan.
 *
 * Cursors are opaque to the caller. Plugins may encode any state they need
 * (page numbers, partitioned queries, pending price buckets).
 */
export interface CatalogueDiscoveryPage {
  /** Normalised product snapshots for this page. */
  items: ProductDetails[];
  /** Cursor for the next page, or null when the scan is complete. */
  nextCursor: string | null;
  /** Estimated total number of products in the retailer's catalogue. */
  totalEstimate?: number;
  /** Optional 0..1 progress hint when the adapter can compute it. */
  progress?: number;
}

export interface CatalogueDiscovery {
  /** Stable page size hint for UI/progress purposes. */
  readonly pageSize?: number;
  /**
   * Fetch one page. Implementations must be idempotent for a given cursor:
   * a retried page may be imported twice, and the importer treats that as
   * a no-op when no price or availability changed.
   */
  fetchPage(cursor: string | null): Promise<CatalogueDiscoveryPage>;
}

export type PluginCapability =
  | "url-monitoring"
  | "catalogue-discovery"
  | (string & {});

export interface PluginConfigurationField {
  /** Key in the config object passed to the plugin. */
  key: string;
  /** Environment variable that supplies the value. */
  env: string;
  /** Default used when the environment variable is unset. */
  default?: string | number | boolean;
  /** Fail loading when neither the env variable nor a default exists. */
  required?: boolean;
  /** Never log or include this value in errors. */
  secret?: boolean;
}

export interface RetailerPluginLimits {
  /** Hard cap on items accepted from one catalogue page. */
  maxCataloguePageItems?: number;
}

export interface RetailerPluginManifest {
  apiVersion: number;
  id: string;
  name: string;
  /** Entry point relative to the package root. */
  entry: string;
  supportedDomains: string[];
  currency: string;
  minCheckIntervalMs: number;
  treatNotFoundAsOutOfStock: boolean;
  capabilities: PluginCapability[];
  limits?: RetailerPluginLimits;
  configuration?: PluginConfigurationField[];
}

export interface PluginLogger {
  debug(fields: Record<string, unknown>, message?: string): void;
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}

export interface PluginContext<TConfig = Record<string, unknown>> {
  config: TConfig;
  logger: PluginLogger;
  plugin: {
    id: string;
    version: string;
  };
}

/**
 * The object returned by a plugin's `create()` hook. Everything retailer
 * specific lives behind this interface.
 */
export interface RetailerPluginInstance {
  /**
   * Parse and validate a product URL for this retailer. Throws
   * InvalidProductUrlError when the URL is not a product URL this plugin
   * can handle.
   */
  parseProductUrl(url: string): ParsedProductUrl;

  /**
   * Fetch the current state of a product. Throws RetailerError subclasses
   * on failure; the returned ProductDetails is always in the normalised
   * shape defined by the SDK.
   */
  getProduct(url: string): Promise<ProductDetails>;

  /**
   * Optional retailer-wide catalogue enumeration. Plugins without this
   * capability only support monitoring products added by URL.
   */
  catalogue?: CatalogueDiscovery;

  /** Optional cleanup hook, called when the application shuts down. */
  dispose?(): Promise<void>;
}

/**
 * The default export of every retailer plugin package.
 */
export interface RetailerPlugin<TConfig = unknown> {
  /** Validates the config object built from the manifest's env mapping. */
  configSchema?: ZodType<TConfig>;
  create(
    context: PluginContext<TConfig>,
  ): RetailerPluginInstance | Promise<RetailerPluginInstance>;
}
