import { z } from "zod";

import {
  AVAILABILITY_STATUSES,
  PLUGIN_API_VERSION,
  type RetailerPluginManifest,
} from "./contracts.js";
import { MAX_PRICE_MINOR } from "./money.js";

/**
 * Zod schemas for the normalised shapes. ProvMon validates every plugin
 * result against these schemas before persisting anything, so a buggy
 * plugin can never corrupt the database with retailer-shaped data.
 */

export const httpUrlSchema = z
  .string()
  .max(4_096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL");

export const availabilityStatusSchema = z.enum(AVAILABILITY_STATUSES);

export const parsedProductUrlSchema = z.object({
  retailerProductId: z.string().min(1).max(512).optional(),
  url: httpUrlSchema,
});

export const productDetailsSchema = z.object({
  retailerId: z.string().min(1).max(64),
  retailerProductId: z.string().min(1).max(512).optional(),
  sku: z.string().min(1).max(512).optional(),
  gtin: z.string().min(1).max(64).optional(),
  mpn: z.string().min(1).max(512).optional(),
  brand: z.string().min(1).max(512).optional(),
  model: z.string().min(1).max(512).optional(),
  category: z.string().min(1).max(512).optional(),
  name: z.string().min(1).max(2_000),
  url: httpUrlSchema,
  imageUrl: z.union([httpUrlSchema, z.literal("")]).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 code"),
  priceMinor: z.number().int().nonnegative().max(MAX_PRICE_MINOR).optional(),
  originalPriceMinor: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_PRICE_MINOR)
    .optional(),
  discountPct: z.number().int().min(0).max(100).optional(),
  availability: availabilityStatusSchema,
  lastUpdated: z.date(),
});

export type ValidatedProductDetails = z.infer<typeof productDetailsSchema>;

export const catalogueDiscoveryPageSchema = z.object({
  items: z.array(productDetailsSchema).max(20_000),
  nextCursor: z.string().max(262_144).nullable(),
  totalEstimate: z.number().int().nonnegative().optional(),
  progress: z.number().min(0).max(1).optional(),
});

/**
 * Envelope used by the core adapter wrapper: items are validated
 * individually so one malformed product cannot fail a whole page.
 */
export const catalogueDiscoveryPageEnvelopeSchema = z.object({
  items: z.array(z.unknown()).max(20_000),
  nextCursor: z.string().max(262_144).nullable(),
  totalEstimate: z.number().int().nonnegative().optional(),
  progress: z.number().min(0).max(1).optional(),
});

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
    "must be a bare hostname",
  );

export const pluginConfigurationFieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "must be a config key"),
  env: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Z][A-Z0-9_]*$/, "must be an environment variable name"),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
});

export const retailerPluginLimitsSchema = z.object({
  maxCataloguePageItems: z.number().int().positive().max(20_000).optional(),
});

export const retailerPluginManifestSchema = z
  .object({
    apiVersion: z.number().int().positive(),
    id: z.string().regex(PLUGIN_ID_PATTERN, "must be a plugin id"),
    name: z.string().min(1).max(200),
    entry: z.string().min(1).max(512),
    supportedDomains: z.array(domainSchema).min(1).max(20),
    currency: z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 code"),
    minCheckIntervalMs: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60 * 1_000),
    treatNotFoundAsOutOfStock: z.boolean(),
    capabilities: z
      .array(z.string().min(1).max(64))
      .min(1)
      .refine(
        (values) => new Set(values).size === values.length,
        "capabilities must be unique",
      ),
    limits: retailerPluginLimitsSchema.optional(),
    configuration: z.array(pluginConfigurationFieldSchema).optional(),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.apiVersion !== PLUGIN_API_VERSION) {
      ctx.addIssue({
        code: "custom",
        path: ["apiVersion"],
        message: `Unsupported plugin API version ${manifest.apiVersion}; this build supports ${PLUGIN_API_VERSION}`,
      });
    }

    const configuration = manifest.configuration ?? [];
    const keys = new Set<string>();
    const envs = new Set<string>();
    for (const [index, field] of configuration.entries()) {
      if (keys.has(field.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["configuration", index, "key"],
          message: `Duplicate configuration key "${field.key}"`,
        });
      }
      if (envs.has(field.env)) {
        ctx.addIssue({
          code: "custom",
          path: ["configuration", index, "env"],
          message: `Duplicate configuration env "${field.env}"`,
        });
      }
      keys.add(field.key);
      envs.add(field.env);
    }
  });

export function parseRetailerPluginManifest(
  value: unknown,
): RetailerPluginManifest {
  return retailerPluginManifestSchema.parse(value) as RetailerPluginManifest;
}
