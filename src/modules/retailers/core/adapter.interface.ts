import type {
  ParsedProductUrl,
  ProductDetails,
} from "@/modules/retailers/core/types";
import type { CatalogueDiscovery } from "@/modules/retailers/core/catalogue";

/**
 * The contract every retailer integration implements inside ProvMon.
 *
 * Plugin packages implement the same operations through the plugin SDK;
 * `PluginRetailerAdapter` wraps a loaded plugin in this interface so the
 * monitoring engine, catalogue importer and UI never know whether an
 * adapter is a test fixture or an external plugin.
 *
 * `getProduct` is deliberately a single call per check: real retailers
 * expose price and availability from the same page or API response, so
 * splitting them would multiply requests and rate-limit exposure. Adapters
 * that must consult multiple retailer endpoints compose internally.
 */
export interface RetailerAdapter {
  /** Stable unique id, e.g. "mock", "example". */
  readonly id: string;
  /** Human-readable retailer name shown in the UI. */
  readonly name: string;
  /** Plugin package version when this adapter comes from an external plugin. */
  readonly version?: string;
  /** Hostnames this adapter claims (exact or subdomain matches). */
  readonly supportedDomains: string[];
  /**
   * Floor for the monitoring interval. The engine refuses to schedule
   * checks more often than this — a courtesy guardrail for retailers.
   */
  readonly minCheckIntervalMs: number;
  /** Primary ISO 4217 currency for this retailer. */
  readonly currency: string;
  /**
   * When true, a ProductNotFoundError from getProduct means the product
   * currently is not listed (typical for marketplaces selling unique
   * items) and the engine records OUT_OF_STOCK instead of an error. When
   * false, not-found is a permanent failure.
   */
  readonly treatNotFoundAsOutOfStock: boolean;

  /**
   * Optional retailer-wide catalogue enumeration. Adapters without this
   * capability only support monitoring products added by URL.
   */
  readonly catalogue?: CatalogueDiscovery;

  /**
   * Parse and validate a product URL for this retailer. Throws
   * InvalidProductUrlError when the URL is not a product URL this adapter
   * can handle. Called by the resolver before a product is created and by
   * `getProduct` implementations to extract the retailer product id.
   */
  parseProductUrl(url: string): ParsedProductUrl;

  /**
   * Fetch the current state of a product. Throws RetailerError subclasses
   * on failure; the returned ProductDetails is always in the normalised
   * shape defined by the core types.
   */
  getProduct(url: string): Promise<ProductDetails>;
}
