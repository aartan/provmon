import { z } from "zod";

/**
 * Zod schemas for the subset of the CeX Algolia search response we
 * consume. CeX exposes their own website's search index publicly via the
 * Algolia multi-query endpoint at search.webuy.io (read-only search
 * credentials). Everything else in the response is deliberately ignored — only these fields may reach the
 * rest of the application, and only through the normalised
 * ProductDetails shape.
 */

/**
 * Image URLs are plain strings here: CeX returns them with literal
 * spaces in the path, which the parser percent-encodes before they are
 * allowed to cross the adapter boundary.
 */
export const imageUrlsSchema = z.object({
  large: z.string().min(1).nullable().optional(),
  medium: z.string().min(1).nullable().optional(),
  small: z.string().min(1).nullable().optional(),
});

export const productHitSchema = z.object({
  /** CeX "box" id; unique per product type (shared across stores). */
  boxId: z.string().min(1),
  boxName: z.string().min(1),
  /** Selling price in integer major units (GBP). */
  sellPrice: z.number(),
  /** Units available for online purchase. */
  ecomQuantity: z.number().default(0),
  /** Units available for in-store collection. */
  collectionQuantity: z.number().default(0),
  /** 1 when the product is no longer sold. */
  discontinued: z.number().default(0),
  imageUrls: imageUrlsSchema.nullable().optional(),
  /** Descriptive attributes used for catalogue presentation. */
  Manufacturer: z.array(z.string()).nullable().optional(),
  "Model Name": z.array(z.string()).nullable().optional(),
  "Model Number": z.array(z.string()).nullable().optional(),
  categoryFriendlyName: z.string().min(1).nullable().optional(),
});

export const searchResultSchema = z.object({
  hits: z.array(productHitSchema),
  /** Catalogue discovery metadata; absent from single-product responses. */
  nbHits: z.number().int().nonnegative().optional(),
  nbPages: z.number().int().nonnegative().optional(),
  page: z.number().int().nonnegative().optional(),
  hitsPerPage: z.number().int().positive().optional(),
  facets: z
    .record(z.string(), z.record(z.string(), z.number().int().nonnegative()))
    .optional(),
});

export const searchResponseSchema = z.object({
  results: z.array(searchResultSchema),
});

export type CeXProductHit = z.infer<typeof productHitSchema>;
