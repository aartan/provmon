import { z } from "zod";

import { availabilityStatusSchema } from "@/modules/retailers/core/schemas";
import {
  INTERVAL_OPTIONS_MINUTES,
  MONITORING_CONDITIONS,
  SUBSCRIPTION_STATUSES,
} from "@/modules/monitoring/types";

export const monitoringConditionSchema = z.enum(MONITORING_CONDITIONS);

export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);

export const intervalMinutesSchema = z.coerce
  .number()
  .int()
  .refine(
    (value) => (INTERVAL_OPTIONS_MINUTES as readonly number[]).includes(value),
    { message: "Invalid monitoring interval" },
  );

/**
 * Unchanged-state snapshot cadence in minutes. 0 disables snapshots. The
 * upper bound is one year.
 */
export const snapshotIntervalMinutesSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(525_600);

/** Input for creating a monitoring subscription (target price in minor units). */
export const createSubscriptionSchema = z.object({
  retailerListingId: z.string().min(1),
  targetPriceMinor: z.number().int().positive().optional(),
  condition: monitoringConditionSchema,
  intervalMinutes: intervalMinutesSchema,
  snapshotIntervalMinutes: snapshotIntervalMinutesSchema.optional(),
});

export const updateSubscriptionSchema = z
  .object({
    targetPriceMinor: z.number().int().positive().optional().nullable(),
    condition: monitoringConditionSchema.optional(),
    intervalMinutes: intervalMinutesSchema.optional(),
    snapshotIntervalMinutes: snapshotIntervalMinutesSchema.optional(),
    status: subscriptionStatusSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "No fields to update",
  });

export const subscriptionNotificationStateSchema = z.object({
  lastNotifiedAvailability: availabilityStatusSchema.nullable(),
  lastNotifiedPriceMinor: z.number().int().nonnegative().nullable(),
  priceDropArmed: z.boolean(),
});

/** A target price is required for PRICE_DROP and BOTH conditions. */
export function requiresTargetPrice(
  condition: z.infer<typeof monitoringConditionSchema>,
): boolean {
  return condition === "PRICE_DROP" || condition === "BOTH";
}
