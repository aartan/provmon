import type { AvailabilityStatus } from "@/modules/retailers/core/types";

/**
 * Monitoring domain types. These mirror the Prisma enums but live in the
 * module so domain code never depends on generated database types.
 */

export const MONITORING_CONDITIONS = [
  "BACK_IN_STOCK",
  "PRICE_DROP",
  "BOTH",
] as const;
export type MonitoringCondition = (typeof MONITORING_CONDITIONS)[number];

export const SUBSCRIPTION_STATUSES = ["ACTIVE", "PAUSED"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Selectable check intervals in minutes. */
export const INTERVAL_OPTIONS_MINUTES = [15, 30, 60, 360, 720, 1440] as const;
export type IntervalMinutes = (typeof INTERVAL_OPTIONS_MINUTES)[number];

/**
 * Per-subscription notification dedup state, stored as JSON on the
 * subscription row. The rules engine (Phase 4) reads and advances it so
 * users never receive duplicate notifications.
 */
export interface SubscriptionNotificationState {
  lastNotifiedAvailability: AvailabilityStatus | null;
  lastNotifiedPriceMinor: number | null;
  /** True while price is above the target (or unknown) — arms the next drop. */
  priceDropArmed: boolean;
}

/**
 * Initial state for a new subscription. `initialAvailability` records the
 * availability observed when the user subscribed, so a product that is
 * already in stock does not produce an instant "back in stock" email,
 * while one that is out of stock may notify when it returns.
 */
export function defaultNotificationState(
  initialAvailability: AvailabilityStatus | null = null,
): SubscriptionNotificationState {
  return {
    lastNotifiedAvailability: initialAvailability,
    lastNotifiedPriceMinor: null,
    priceDropArmed: true,
  };
}

/** Result of a single check, shared with the rules engine. */
export interface CheckOutcome {
  subscriptionId: string;
  productId: string;
  /** State before this check (from the product row). */
  previous: {
    availability: AvailabilityStatus;
    priceMinor: number | null;
  };
  /** State observed during this check. */
  current: {
    availability: AvailabilityStatus;
    priceMinor: number | null;
  };
  /** True when the retailer call succeeded. */
  success: boolean;
  errorCode?: string;
}

export interface CheckJobData {
  subscriptionId: string;
}

export const SWEEP_JOB_NAME = "sweep";
export const CHECK_JOB_NAME = "check";
