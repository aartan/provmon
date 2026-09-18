import { z } from "zod";

import { AVAILABILITY_STATUSES } from "@/modules/retailers/core/types";

/**
 * Zod schemas for the normalised shapes. The monitoring engine validates
 * every adapter result against these schemas before persisting anything,
 * so a buggy adapter can never corrupt the database with retailer-shaped
 * data.
 */

export const availabilityStatusSchema = z.enum(AVAILABILITY_STATUSES);

export const parsedProductUrlSchema = z.object({
  retailerProductId: z.string().min(1).optional(),
  url: z.string().url(),
});

export const productDetailsSchema = z.object({
  retailerId: z.string().min(1),
  retailerProductId: z.string().min(1).optional(),
  name: z.string().min(1),
  url: z.string().url(),
  imageUrl: z.union([z.string().url(), z.literal("")]).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 code"),
  priceMinor: z.number().int().nonnegative().optional(),
  availability: availabilityStatusSchema,
  lastUpdated: z.date(),
});

export type ValidatedProductDetails = z.infer<typeof productDetailsSchema>;
