# Migrating to Retailer Plugins

ProvMon no longer ships retailer integrations in the core repository. This
guide covers a one-step cutover for a deployment that previously used
built-in retailer adapters.

## Before upgrading

1. Build or obtain the plugin packages for every retailer in use.
2. Install them into the deployment plugin directory:

   ```bash
   npm install --prefix plugins @your-scope/retailer-example@^1
   ```

3. Add the package names to `plugins/provmon.plugins.json`:

   ```json
   {
     "plugins": ["@your-scope/retailer-example"]
   }
   ```

4. Keep the existing plugin-specific environment variables. Plugin manifests
   declare the same variable names the built-in adapter used, so no credential
   or endpoint changes are required.
5. Run `npm run plugins:validate` to check manifests, API compatibility and
   required configuration.

Install and validate plugins **before** deploying the core release that
removes the built-in adapters.

## Data compatibility

No database migration is required when the plugin keeps the same retailer id.

- `retailer_listings.retailer_id` values are unchanged.
- Catalogue listings, canonical products, observations, subscriptions and
  notifications are untouched.
- `retailer_catalogues` rows remain valid.
- Existing `catalogue_discovery_runs.cursor` values remain valid when the
  plugin keeps its v1 cursor decoder.
- No catalogue re-import or price-history rewrite is needed.

The core startup logs a warning if persisted retailer ids have no loaded
plugin. The retailer admin page marks those retailers as “Plugin missing”.

## Verification checklist

Use a database snapshot from before the cutover:

1. Start ProvMon with the plugin packages installed.
2. Confirm `/retailers` shows the plugin version and `LOADED` status.
3. Browse existing catalogue listings for each retailer.
4. Open a listing detail page and confirm price history is unchanged.
5. Run a check for an existing listing and confirm no duplicate observation
   is written when price and availability are unchanged.
6. Resume a failed discovery run from its saved cursor and confirm progress
   continues rather than restarting.
7. Start a normal refresh and confirm the run completes.
8. Compare listing, observation and subscription counts before and after.

## Rolling back

Rolling back to a release with built-in adapters does not require a database
change: both implementations use the same retailer ids, tables and cursor
formats. Keep the plugin directory in place so it is ready for the next
upgrade.
