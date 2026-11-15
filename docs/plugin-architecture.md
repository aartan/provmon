# Retailer Plugin Architecture

ProvMon core is retailer-agnostic. Retailer integrations are external npm
packages that implement the `@provmon/retailer-plugin-sdk` contract and are
loaded at runtime from a deployment-owned plugin directory.

This keeps retailer-specific code, credentials, fixtures and documentation
out of the public ProvMon codebase while preserving one normalised interface
for the monitoring, catalogue and notification engines.

## Process model

Plugins run in-process. The goal is codebase separation and independent
versioning, not hostile-code isolation.

```
ProvMon core
  └── RetailerRegistry
        ├── PluginRetailerAdapter ──► external plugin package
        └── PluginRetailerAdapter ──► external plugin package
```

Plugins are trusted code and must only depend on the SDK and their own
dependencies. They must not import ProvMon application modules.

## Responsibilities

| Core | Plugin |
| --- | --- |
| Discover installed plugin packages | Implement the retailer contract |
| Validate manifests and config | Read the retailer website or API |
| Load `create()` and validate the instance | Normalise data before returning it |
| Validate every returned product/page | Throw typed retailer errors |
| Schedule checks and catalogue pages | Manage retailer-specific pagination |
| Persist catalogue, history and subscriptions | Own cursor encoding/versioning |
| Rate limits, retries, logging and status | Respect the declared check interval |
| UI, notifications and discovery management | Nothing user-facing |

## Loading flow

1. Read `PROVMON_PLUGIN_DIR` (default `plugins`).
2. Read the enabled package list from `plugins/provmon.plugins.json` or the
   `PROVMON_PLUGINS` environment variable.
3. Resolve each package from the plugin directory.
4. Read and validate its static `provmon.plugin.json`.
5. Build config from the environment variables declared by the manifest.
6. Dynamically import the package entry point.
7. Validate config through the plugin's Zod schema.
8. Call `create()` and validate the returned instance.
9. Wrap the instance in `PluginRetailerAdapter` and register it.

A failing plugin is recorded in the plugin status view and skipped. Other
plugins continue loading. `ensureRetailerPluginsLoaded()` is idempotent and
runs before the web server or worker starts handling work.

## Manifest

Every package ships `provmon.plugin.json`:

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
  "limits": { "maxCataloguePageItems": 5000 },
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

The manifest is read without executing plugin code. Plugin ids are immutable
because catalogue listings and history are keyed by `retailer_id`.

## Data contracts

The SDK owns the canonical types and Zod schemas:

- `ProductDetails` — normalised product, price and availability snapshot.
- `AvailabilityStatus` — `IN_STOCK`, `OUT_OF_STOCK`, `PREORDER`, `UNKNOWN`.
- `ParsedProductUrl` — retailer product id and canonical URL.
- `CatalogueDiscoveryPage` — normalised items plus the next opaque cursor.
- `RetailerError` classes — stable error codes and retry semantics.

Prices are integer minor units with an ISO 4217 currency. Product URLs must
use http/https and match the plugin's declared domains. `UNKNOWN`
availability is never coerced to out-of-stock.

The adapter wrapper validates every product and catalogue page before it
reaches persistence. Invalid catalogue items are dropped with a warning;
invalid single-product responses fail the call.

## Configuration and secrets

Configuration is environment-only in API version 1:

- The manifest declares exactly which environment variables a plugin reads.
- Core builds a config object and passes it to `create()`.
- The plugin's own Zod schema validates the values.
- `secret: true` values are redacted from loader errors and are never logged
  by core.
- Plugins should use `ctx.config`, not `process.env`.

This matches the existing deployment model and keeps credentials out of the
database.

## Versioning

- `PLUGIN_API_VERSION` is `1`. Core rejects manifests with another API version.
- Each plugin package has its own semver version.
- `provmon.plugin.json` is validated on every boot.
- Discovery cursors are owned by the plugin. Breaking a cursor format requires
  a new cursor version and a migration path for saved cursors.
- Retailer ids and domain ownership are immutable.

## Failure handling

- Manifest, config and import failures mark the plugin `FAILED` and do not
  crash the application.
- Unknown plugin exceptions are logged and converted to non-retryable
  `RetailerParseError`s so the monitoring engine stays in control.
- Typed network, timeout, rate-limit, blocked and not-found errors preserve
  their existing retry semantics.
- The retailer admin page shows plugin version, status, capabilities and the
  last safe error.
- A startup warning lists persisted retailer ids with no loaded plugin.

## Trust model

Plugins are trusted deployment artifacts. Installing a plugin grants it the
same process access as ProvMon itself. Only install plugins from sources you
trust, pin versions in `plugins/package.json`, and review plugin updates.
