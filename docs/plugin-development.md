# Retailer Plugin Development

A retailer plugin is an independently versioned npm package that teaches
ProvMon how to resolve, fetch and optionally enumerate one retailer.

Start from [`examples/retailer-plugin-template`](../examples/retailer-plugin-template)
or follow the steps below.

## 1. Create the package

```bash
mkdir provmon-retailer-example
cd provmon-retailer-example
npm init -y
npm install @provmon/retailer-plugin-sdk zod
npm install -D typescript vitest @types/node
```

`package.json` requirements:

- `"type": "module"` (ESM is recommended).
- A built entry point, normally `./dist/index.js`.
- The SDK as a peer dependency and a dev dependency.
- `provmon.plugin.json` and `dist` in `files` when publishing.

## 2. Add the manifest

`provmon.plugin.json` is static metadata. Core reads it without executing any
plugin code.

```json
{
  "apiVersion": 1,
  "id": "example",
  "name": "Example Retailer",
  "entry": "./dist/index.js",
  "supportedDomains": ["example-retailer.test"],
  "currency": "GBP",
  "minCheckIntervalMs": 300000,
  "treatNotFoundAsOutOfStock": false,
  "capabilities": ["url-monitoring", "catalogue-discovery"],
  "limits": { "maxCataloguePageItems": 1000 },
  "configuration": [
    {
      "key": "apiUrl",
      "env": "EXAMPLE_API_URL",
      "default": "https://example-retailer.test/api"
    },
    {
      "key": "apiKey",
      "env": "EXAMPLE_API_KEY",
      "required": true,
      "secret": true
    }
  ]
}
```

The `id` must be a stable lowercase slug. It becomes the `retailer_id` stored
in catalogue listings and history.

## 3. Implement the contract

```ts
import {
  defineRetailerPlugin,
  InvalidProductUrlError,
  ProductNotFoundError,
  RetailerNetworkError,
  RetailerTimeoutError,
  parsePriceToMinor,
  type ProductDetails,
} from "@provmon/retailer-plugin-sdk";
import { z } from "zod";

const configSchema = z.object({
  apiUrl: z.string().url(),
  apiKey: z.string().min(1),
});

const DOMAIN = "example-retailer.test";

function productIdFromUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname !== DOMAIN) {
    throw new InvalidProductUrlError("example", url);
  }
  const match = parsed.pathname.match(/^\/products\/([^/]+)\/?$/);
  if (!match) {
    throw new InvalidProductUrlError("example", url);
  }
  return decodeURIComponent(match[1]);
}

export default defineRetailerPlugin<z.infer<typeof configSchema>>({
  configSchema,
  create({ config, logger }) {
    return {
      parseProductUrl(url) {
        return { retailerProductId: productIdFromUrl(url), url };
      },

      async getProduct(url): Promise<ProductDetails> {
        const id = productIdFromUrl(url);

        let response: Response;
        try {
          response = await fetch(`${config.apiUrl}/products/${id}`, {
            headers: { authorization: `Bearer ${config.apiKey}` },
            signal: AbortSignal.timeout(10_000),
          });
        } catch (error) {
          if (error instanceof Error && error.name === "TimeoutError") {
            throw new RetailerTimeoutError("example", error);
          }
          throw new RetailerNetworkError("example", error);
        }

        if (response.status === 404) {
          throw new ProductNotFoundError("example", id);
        }
        if (!response.ok) {
          throw new RetailerNetworkError(
            "example",
            new Error(`HTTP ${response.status}`),
          );
        }

        const product = (await response.json()) as {
          title: string;
          price: string;
          inStock: boolean;
          image?: string;
        };

        logger.debug({ productId: id }, "fetched example product");

        return {
          retailerId: "example",
          retailerProductId: id,
          name: product.title,
          url: `https://${DOMAIN}/products/${id}`,
          imageUrl: product.image,
          currency: "GBP",
          priceMinor: parsePriceToMinor(product.price) ?? undefined,
          availability: product.inStock ? "IN_STOCK" : "OUT_OF_STOCK",
          lastUpdated: new Date(),
        };
      },
    };
  },
});
```

Rules:

- `parseProductUrl` must reject non-product URLs with
  `InvalidProductUrlError`.
- `getProduct` performs one logical fetch and returns normalised data.
- Prices are integer minor units; use `parsePriceToMinor` and
  `safePriceMinor`.
- Availability is one of the four SDK statuses. Never coerce `UNKNOWN`.
- Throw SDK error classes for network, timeout, rate-limit, blocked, parse and
  not-found failures.
- Use `ctx.config` for credentials, not `process.env`.
- Do not import ProvMon application code.

### Rate limits

Core enforces the manifest's `minCheckIntervalMs`, spaces catalogue page jobs,
and retries typed retryable failures with backoff. On a retailer `429`, throw
`RetailerRateLimitedError` with the parsed `Retry-After` value:

```ts
throw new RetailerRateLimitedError(
  "example",
  undefined,
  parseRetryAfterHeader(response.headers.get("retry-after")),
);
```

Do not aggressively retry inside the plugin; let core apply the retailer-wide
cooldown.

## 4. Add catalogue discovery (optional)

Declare `"catalogue-discovery"` in the manifest capabilities and expose a
`catalogue` object:

```ts
catalogue: {
  pageSize: 100,
  async fetchPage(cursor) {
    const page = cursor ? Number(cursor) : 1;
    const response = await fetch(`${config.apiUrl}/products?page=${page}`);
    if (!response.ok) {
      throw new RetailerNetworkError("example", new Error(`HTTP ${response.status}`));
    }
    const body = (await response.json()) as {
      items: Array<{ id: string; title: string; price: string; stock: boolean }>;
      total: number;
      hasMore: boolean;
    };

    return {
      items: body.items.map((item) => ({
        retailerId: "example",
        retailerProductId: item.id,
        name: item.title,
        url: `https://${DOMAIN}/products/${item.id}`,
        currency: "GBP",
        priceMinor: parsePriceToMinor(item.price) ?? undefined,
        availability: item.stock ? "IN_STOCK" : "OUT_OF_STOCK",
        lastUpdated: new Date(),
      })),
      nextCursor: body.hasMore ? String(page + 1) : null,
      totalEstimate: body.total,
      progress: body.hasMore ? undefined : 1,
    };
  },
},
```

Cursors are opaque to core and persisted after every page. `fetchPage` must
be idempotent for a given cursor. If you change the cursor format, keep
decoding older saved cursors or provide an explicit migration. A cursor must
advance: returning the same cursor for the same input is rejected.

## 5. Configuration

The manifest's `configuration` array maps environment variables to config
keys. Core reads only the declared variables and passes them to `create()`.
The plugin's `configSchema` validates the resulting object.

- `required: true` fails plugin loading when the variable is absent and no
  default exists.
- `secret: true` values are redacted from core errors and logs.
- Defaults belong in the manifest, not in retailer code.
- Never log config values or credentials.

## 6. Test with the contract suite

```ts
import { readFileSync } from "node:fs";
import { runRetailerPluginContractTests } from "@provmon/retailer-plugin-sdk/testing";
import plugin from "./index.js";

const manifest = JSON.parse(
  readFileSync(new URL("../provmon.plugin.json", import.meta.url), "utf8"),
) as unknown;

runRetailerPluginContractTests({
  plugin,
  manifest,
  createConfig: () => ({ apiUrl: "https://example-retailer.test/api", apiKey: "test" }),
  validProductUrl: "https://example-retailer.test/products/widget",
  invalidProductUrls: [
    "https://example-retailer.test/",
    "https://example-retailer.test/search?q=widget",
  ],
});
```

Use fixture-backed `fetch` implementations so tests never touch the live
retailer. Add retailer-specific tests for pagination, error mapping, price
parsing, URL variants and saved discovery cursors.

## 7. Build, validate and install

```bash
npm run build
npm pack --dry-run
```

In the ProvMon checkout:

```bash
# From the ProvMon repository
npm install --prefix plugins @your-scope/retailer-example@^1
```

Add the package to `plugins/provmon.plugins.json`:

```json
{
  "plugins": ["@your-scope/retailer-example"]
}
```

For local development, link a package directory instead of publishing:

```bash
npm run plugins:link-local -- /absolute/path/to/your-plugin
```

Set the declared environment variables, then validate and restart:

```bash
npm run plugins:validate
npm run plugins:list
npm run dev
```

Core logs loaded plugin ids and versions. The `/retailers` page displays
plugin status and any safe load error.

When running with Docker Compose, add the plugin's environment variables to
both the `app` and `worker` services (or use an `env_file`) so both processes
can initialise the plugin.

## 8. Versioning and compatibility

- `apiVersion` must match the core-supported plugin API version (`1`).
- Use semantic versioning for the plugin package.
- Keep retailer ids and declared domains stable.
- Additive capabilities and new optional fields are non-breaking. Removing or
  changing contract behavior requires a plugin API version bump.
- Saved discovery cursors are part of the plugin's public compatibility
  surface.

## 9. Publishing

Publish to a private registry, or distribute `npm pack` tarballs:

```bash
npm pack
npm publish --registry=https://your-private-registry.example
```

ProvMon core does not depend on retailer packages in its own `package.json`.
The plugin directory is the deployment boundary.
