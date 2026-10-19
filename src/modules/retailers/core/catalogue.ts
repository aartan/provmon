import type { ProductDetails } from "@/modules/retailers/core/types";

/**
 * Optional retailer-wide catalogue enumeration capability.
 *
 * Discovery is deliberately cursor-based rather than an async iterator:
 * the catalogue module persists the cursor after every page so a crashed
 * worker resumes from the same place instead of restarting the scan.
 *
 * Cursors are opaque to the caller. Adapters may encode any state they
 * need (page numbers, partitioned queries, pending price buckets).
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
