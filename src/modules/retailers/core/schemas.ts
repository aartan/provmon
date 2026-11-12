/**
 * Zod schemas for normalised retailer shapes. The canonical definitions
 * live in `@provmon/retailer-plugin-sdk`; re-exported here to keep core
 * imports stable.
 */

export {
  availabilityStatusSchema,
  catalogueDiscoveryPageEnvelopeSchema,
  catalogueDiscoveryPageSchema,
  httpUrlSchema,
  parsedProductUrlSchema,
  productDetailsSchema,
  retailerPluginManifestSchema,
  type ValidatedProductDetails,
} from "@provmon/retailer-plugin-sdk";
