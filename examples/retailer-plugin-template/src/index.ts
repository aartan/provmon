import {
  defineRetailerPlugin,
  InvalidProductUrlError,
  ProductNotFoundError,
  RetailerNetworkError,
  RetailerTimeoutError,
  parsePriceToMinor,
  type CatalogueDiscoveryPage,
  type ParsedProductUrl,
  type ProductDetails,
  type RetailerPlugin,
  type RetailerPluginInstance,
} from "@provmon/retailer-plugin-sdk";
import { z } from "zod";

export const configSchema = z.object({
  apiUrl: z.string().url(),
  apiKey: z.string().min(1),
});

export type ExampleConfig = z.infer<typeof configSchema>;

const PLUGIN_ID = "example";
const DOMAIN = "example-retailer.test";
const TIMEOUT_MS = 10_000;

interface ExampleApiProduct {
  id: string;
  title: string;
  price: string;
  inStock: boolean;
  imageUrl?: string;
}

interface ExampleCatalogueResponse {
  items: ExampleApiProduct[];
  total: number;
  hasMore: boolean;
}

function extractProductId(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidProductUrlError(PLUGIN_ID, url);
  }
  if (parsed.hostname !== DOMAIN) {
    throw new InvalidProductUrlError(PLUGIN_ID, url);
  }
  const match = parsed.pathname.match(/^\/products\/([^/]+)\/?$/);
  if (!match) {
    throw new InvalidProductUrlError(PLUGIN_ID, url);
  }
  return decodeURIComponent(match[1]);
}

function canonicalUrl(id: string): string {
  return `https://${DOMAIN}/products/${encodeURIComponent(id)}`;
}

function toDetails(product: ExampleApiProduct): ProductDetails {
  return {
    retailerId: PLUGIN_ID,
    retailerProductId: product.id,
    name: product.title,
    url: canonicalUrl(product.id),
    imageUrl: product.imageUrl,
    currency: "GBP",
    priceMinor: parsePriceToMinor(product.price) ?? undefined,
    availability: product.inStock ? "IN_STOCK" : "OUT_OF_STOCK",
    lastUpdated: new Date(),
  };
}

async function getJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  config: ExampleConfig,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new RetailerTimeoutError(PLUGIN_ID, error);
    }
    throw new RetailerNetworkError(PLUGIN_ID, error);
  }

  if (response.status === 404) {
    throw new ProductNotFoundError(PLUGIN_ID, url);
  }
  if (!response.ok) {
    throw new RetailerNetworkError(
      PLUGIN_ID,
      new Error(`HTTP ${response.status}`),
    );
  }

  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new RetailerNetworkError(PLUGIN_ID, error);
  }
}

export function createExampleInstance(
  config: ExampleConfig,
  fetchImpl: typeof fetch = fetch,
): RetailerPluginInstance {
  return {
    parseProductUrl(url: string): ParsedProductUrl {
      return { retailerProductId: extractProductId(url), url };
    },

    async getProduct(url: string): Promise<ProductDetails> {
      const id = extractProductId(url);
      const product = await getJson<ExampleApiProduct>(
        fetchImpl,
        `${config.apiUrl}/products/${encodeURIComponent(id)}`,
        config,
      );
      return toDetails(product);
    },

    catalogue: {
      pageSize: 100,
      async fetchPage(cursor: string | null): Promise<CatalogueDiscoveryPage> {
        const page = cursor ? Number.parseInt(cursor, 10) : 1;
        const body = await getJson<ExampleCatalogueResponse>(
          fetchImpl,
          `${config.apiUrl}/products?page=${page}`,
          config,
        );
        return {
          items: body.items.map(toDetails),
          nextCursor: body.hasMore ? String(page + 1) : null,
          totalEstimate: body.total,
        };
      },
    },
  };
}

export function createExamplePlugin(
  fetchImpl: typeof fetch = fetch,
): RetailerPlugin<ExampleConfig> {
  return defineRetailerPlugin<ExampleConfig>({
    configSchema,
    create({ config, logger }) {
      logger.debug({ plugin: PLUGIN_ID }, "creating example plugin instance");
      return createExampleInstance(config, fetchImpl);
    },
  });
}

export default createExamplePlugin();
