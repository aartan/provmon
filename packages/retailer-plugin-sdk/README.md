# @provmon/retailer-plugin-sdk

Contracts and helpers for building ProvMon retailer plugins.

A plugin package:

1. Implements `RetailerPlugin` from this SDK.
2. Ships a static `provmon.plugin.json` manifest.
3. Exports the plugin as its default export.
4. Declares this SDK as a peer dependency.

```ts
import { defineRetailerPlugin, z } from "@provmon/retailer-plugin-sdk";

export default defineRetailerPlugin({
  configSchema: z.object({ apiUrl: z.string().url() }),
  create({ config, logger }) {
    return {
      parseProductUrl(url) {
        // ...
      },
      async getProduct(url) {
        // ...
      },
    };
  },
});
```

The plugin instance contract is intentionally small:

- `parseProductUrl(url)` — validate a user-supplied URL and extract the retailer product id.
- `getProduct(url)` — return one normalised price/stock snapshot.
- `catalogue?` — optional cursor-based catalogue enumeration.
- `dispose?` — optional cleanup.

Plugins must not import ProvMon application code. They should only depend on
this SDK and their own dependencies.

```ts
import { runRetailerPluginContractTests } from "@provmon/retailer-plugin-sdk/testing";
```

See the ProvMon documentation for the full plugin development guide.
