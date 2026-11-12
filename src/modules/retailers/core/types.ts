/**
 * Core retailer domain types.
 *
 * The canonical definitions live in `@provmon/retailer-plugin-sdk` so that
 * external plugins and ProvMon core share one contract. Re-exported here
 * to keep existing imports stable.
 */

export {
  AVAILABILITY_STATUSES,
  type AvailabilityStatus,
  type CatalogueDiscovery,
  type CatalogueDiscoveryPage,
  type ParsedProductUrl,
  type PluginCapability,
  type PluginConfigurationField,
  type PluginContext,
  type PluginLogger,
  type ProductDetails,
  type RetailerPlugin,
  type RetailerPluginInstance,
  type RetailerPluginLimits,
  type RetailerPluginManifest,
} from "@provmon/retailer-plugin-sdk";
