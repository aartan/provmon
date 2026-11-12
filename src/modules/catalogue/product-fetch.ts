import { logger } from "@/lib/logger";
import type { RetailerAdapter } from "@/modules/retailers/core/adapter.interface";
import {
  isRetailerError,
  UnsupportedRetailerError,
} from "@/modules/retailers/core/errors";
import { resolveRetailerUrl } from "@/modules/retailers/core/retailer-resolver";
import { productDetailsSchema } from "@/modules/retailers/core/schemas";
import type { ProductDetails } from "@/modules/retailers/core/types";
import { ensureRetailerPluginsLoaded } from "@/modules/retailers";

/** User-facing product-fetch failure shared by inventory and monitoring. */
export class ProductFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductFetchError";
  }
}

export interface ResolvedProductUrl {
  adapter: RetailerAdapter;
  /** Canonical product URL produced by the adapter. */
  url: string;
}

/** Resolve a user-pasted URL to a registered adapter and canonical URL. */
export async function resolveProductUrl(
  rawUrl: string,
): Promise<ResolvedProductUrl> {
  await ensureRetailerPluginsLoaded();
  try {
    const { adapter, parsed } = resolveRetailerUrl(rawUrl);
    return { adapter, url: parsed.url };
  } catch (error) {
    if (error instanceof UnsupportedRetailerError) {
      throw new ProductFetchError(
        "This retailer is not supported yet. Please check the URL and try again.",
      );
    }
    if (isRetailerError(error)) {
      throw new ProductFetchError(
        `This URL does not look like a valid product URL: ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * Fetch and validate one product through its adapter. The returned shape is
 * the only product shape allowed to reach persistence.
 */
export async function fetchProductDetails(
  adapter: RetailerAdapter,
  url: string,
): Promise<ProductDetails> {
  let rawDetails: ProductDetails;
  try {
    rawDetails = await adapter.getProduct(url);
  } catch (error) {
    if (isRetailerError(error)) {
      throw new ProductFetchError(
        `Could not load the product from ${adapter.name}: ${error.message}`,
      );
    }
    throw error;
  }

  const validated = productDetailsSchema.safeParse(rawDetails);
  if (!validated.success) {
    logger.error(
      {
        component: "catalogue",
        retailerId: adapter.id,
        issues: validated.error.issues,
      },
      "adapter returned invalid product details",
    );
    throw new ProductFetchError(
      `Could not load the product from ${adapter.name} (invalid data)`,
    );
  }

  return validated.data;
}

export async function fetchProductFromUrl(
  rawUrl: string,
): Promise<{ adapter: RetailerAdapter; details: ProductDetails }> {
  const resolved = await resolveProductUrl(rawUrl);
  const details = await fetchProductDetails(resolved.adapter, resolved.url);
  return { adapter: resolved.adapter, details };
}
