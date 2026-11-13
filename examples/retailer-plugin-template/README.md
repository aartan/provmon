# Example retailer plugin

A minimal, fictional retailer plugin using the ProvMon SDK. Copy this
directory to start a new integration.

## What it demonstrates

- `provmon.plugin.json` metadata and environment config
- URL parsing and typed invalid-URL errors
- Price normalisation to integer minor units
- Availability normalisation
- Optional cursor-based catalogue discovery
- The shared contract test suite

## Run the tests

From this directory, with the ProvMon SDK available:

```bash
npm install
npm test
npm run typecheck
npm run build
```

## Install into ProvMon

```bash
# From the ProvMon checkout
npm install --prefix plugins /absolute/path/to/this/plugin
```

Add `@provmon-example/retailer-example` to `plugins/provmon.plugins.json`,
set `EXAMPLE_API_KEY`, and restart ProvMon.

This plugin is not loaded automatically and is not part of the ProvMon
production build.
