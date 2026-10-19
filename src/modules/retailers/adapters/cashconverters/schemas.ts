import { z } from "zod";

/**
 * Zod schemas for the subset of the Cash Converters search API response we
 * consume. Everything else in the response is deliberately ignored — only
 * these fields may reach the rest of the application, and only through the
 * normalised ProductDetails shape.
 */
export const productListItemSchema = z.object({
  Code: z.string(),
  Title: z.string(),
  Url: z.string(),
  Sp: z.string().nullable().optional(),
  Rrp: z.string().nullable().optional(),
  Brand: z.string().nullable().optional(),
  Category: z.string().nullable().optional(),
  ProductList: z.string().nullable().optional(),
  ItemType: z.string().nullable().optional(),
  AbsoluteImageUrl: z.string().nullable().optional(),
  ImageUrl: z.string().nullable().optional(),
});

export const searchResultsSchema = z.object({
  WasSuccessful: z.boolean(),
  Value: z.object({
    ProductList: z.object({
      ProductListItemCount: z.number().int(),
      ProductListItems: z.array(productListItemSchema),
    }),
  }),
});

export type CashConvertersProductListItem = z.infer<typeof productListItemSchema>;
