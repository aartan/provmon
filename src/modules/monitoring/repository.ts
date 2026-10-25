import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Prisma } from "@/generated/prisma/client";
import { ensureInventoryItem } from "@/modules/catalogue/inventory.repository";
import {
  DEFAULT_SNAPSHOT_INTERVAL_MINUTES,
} from "@/modules/monitoring/snapshot-config";
import type {
  MonitoringCondition,
  SubscriptionStatus,
} from "@/modules/monitoring/types";
import { defaultNotificationState } from "@/modules/monitoring/types";
import type { SubscriptionNotificationState } from "@/modules/monitoring/types";
import { subscriptionNotificationStateSchema } from "@/modules/monitoring/schemas";

const listingSummarySelect = {
  id: true,
  canonicalProductId: true,
  retailerId: true,
  retailerProductId: true,
  sku: true,
  gtin: true,
  mpn: true,
  brand: true,
  model: true,
  name: true,
  url: true,
  imageUrl: true,
  currency: true,
  currentPriceMinor: true,
  currentOriginalPriceMinor: true,
  currentDiscountPct: true,
  currentAvailability: true,
  lastCheckedAt: true,
  lastSuccessfulAt: true,
  lastSeenAt: true,
} as const;

type SubscriptionRow = Prisma.MonitoringSubscriptionGetPayload<{
  include: { retailerListing: { select: typeof listingSummarySelect } };
}>;

export interface RetailerListingSummary {
  id: string;
  canonicalProductId: string;
  retailerId: string;
  retailerProductId: string | null;
  sku: string | null;
  gtin: string | null;
  mpn: string | null;
  brand: string | null;
  model: string | null;
  name: string;
  url: string;
  imageUrl: string | null;
  currency: string;
  currentPriceMinor: number | null;
  currentOriginalPriceMinor: number | null;
  currentDiscountPct: number | null;
  currentAvailability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN";
  lastCheckedAt: Date | null;
  lastSuccessfulAt: Date | null;
  lastSeenAt: Date | null;
}

export interface SubscriptionWithProduct {
  id: string;
  userId: string;
  retailerListingId: string;
  targetPriceMinor: number | null;
  condition: MonitoringCondition;
  intervalMinutes: number;
  snapshotIntervalMinutes: number;
  status: SubscriptionStatus;
  nextCheckAt: Date | null;
  archivedAt: Date | null;
  /** Untrusted JSON from the database; parse with the zod schema. */
  notificationState: Prisma.JsonValue;
  lastNotifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  retailerListing: RetailerListingSummary;
  /**
   * Backwards-compatible alias for `retailerListing`. Existing API clients
   * and the current UI read `subscription.product`.
   */
  product: RetailerListingSummary;
}

function withListingAlias(row: SubscriptionRow): SubscriptionWithProduct {
  return {
    ...row,
    retailerListing: row.retailerListing,
    product: row.retailerListing,
  };
}

export interface CreateSubscriptionInput {
  userId: string;
  retailerListingId: string;
  targetPriceMinor?: number;
  condition: MonitoringCondition;
  intervalMinutes: number;
  /** Defaults to SNAPSHOT_INTERVAL_MINUTES or daily. 0 disables snapshots. */
  snapshotIntervalMinutes?: number;
  /** Availability observed at subscription time — seeds the dedup state. */
  initialAvailability?: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN";
}

/**
 * Resolve the deployment-wide snapshot cadence. Invalid values fall back to
 * the safe daily default rather than failing subscription creation.
 */
function defaultSnapshotIntervalMinutes(): number {
  const raw = process.env.SNAPSHOT_INTERVAL_MINUTES;
  if (!raw) {
    return DEFAULT_SNAPSHOT_INTERVAL_MINUTES;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_SNAPSHOT_INTERVAL_MINUTES;
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<SubscriptionWithProduct> {
  const listing = await db.retailerListing.findUnique({
    where: { id: input.retailerListingId },
    select: { canonicalProductId: true },
  });
  if (!listing) {
    throw new Error(`Retailer listing ${input.retailerListingId} not found`);
  }

  // Monitoring implies the product is in the user's inventory, but the
  // inventory item exists independently from this subscription.
  await ensureInventoryItem(input.userId, listing.canonicalProductId);

  const row = await db.monitoringSubscription.create({
    data: {
      userId: input.userId,
      retailerListingId: input.retailerListingId,
      targetPriceMinor: input.targetPriceMinor ?? null,
      condition: input.condition,
      intervalMinutes: input.intervalMinutes,
      snapshotIntervalMinutes:
        input.snapshotIntervalMinutes ?? defaultSnapshotIntervalMinutes(),
      status: "ACTIVE",
      // First check runs on the next sweep.
      nextCheckAt: new Date(),
      notificationState: defaultNotificationState(
        input.initialAvailability ?? null,
      ) as unknown as Prisma.InputJsonValue,
    },
    include: {
      retailerListing: { select: listingSummarySelect },
    },
  });
  return withListingAlias(row);
}

export async function findSubscription(
  subscriptionId: string,
  userId?: string,
): Promise<SubscriptionWithProduct | null> {
  const row = await db.monitoringSubscription.findFirst({
    where: { id: subscriptionId, ...(userId ? { userId } : {}) },
    include: {
      retailerListing: { select: listingSummarySelect },
    },
  });
  return row ? withListingAlias(row) : null;
}

export async function listSubscriptionsForUser(
  userId: string,
): Promise<SubscriptionWithProduct[]> {
  const rows = await db.monitoringSubscription.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      retailerListing: { select: listingSummarySelect },
    },
  });
  return rows.map(withListingAlias);
}

export async function updateSubscription(
  subscriptionId: string,
  userId: string,
  data: {
    targetPriceMinor?: number | null;
    condition?: MonitoringCondition;
    intervalMinutes?: number;
    snapshotIntervalMinutes?: number;
    status?: SubscriptionStatus;
  },
): Promise<SubscriptionWithProduct | null> {
  const existing = await db.monitoringSubscription.findFirst({
    where: { id: subscriptionId, userId },
  });
  if (!existing) {
    return null;
  }

  const nextStatus = data.status ?? existing.status;

  // Changing the interval resets the schedule so the new cadence applies
  // from now rather than the previously computed next check. Resuming a
  // paused or archived subscription also schedules a check immediately.
  let nextCheckAt = existing.nextCheckAt;
  if (nextStatus === "ARCHIVED") {
    nextCheckAt = null;
  } else if (nextStatus === "ACTIVE" && existing.status !== "ACTIVE") {
    nextCheckAt = new Date();
  } else if (
    data.intervalMinutes !== undefined &&
    data.intervalMinutes !== existing.intervalMinutes
  ) {
    nextCheckAt = new Date();
  }

  const archivedAt =
    nextStatus === "ARCHIVED"
      ? (existing.archivedAt ?? new Date())
      : null;

  const row = await db.monitoringSubscription.update({
    where: { id: subscriptionId },
    data: {
      targetPriceMinor: data.targetPriceMinor,
      condition: data.condition,
      intervalMinutes: data.intervalMinutes,
      snapshotIntervalMinutes: data.snapshotIntervalMinutes,
      status: data.status,
      nextCheckAt,
      archivedAt,
    },
    include: {
      retailerListing: { select: listingSummarySelect },
    },
  });
  return withListingAlias(row);
}

/**
 * Archive a subscription: stop future checks and notifications without
 * deleting the subscription, its checks, or its notification history.
 */
export async function archiveSubscription(
  subscriptionId: string,
  userId: string,
): Promise<SubscriptionWithProduct | null> {
  return updateSubscription(subscriptionId, userId, { status: "ARCHIVED" });
}

/**
 * Find active subscriptions whose nextCheckAt is due. The caller claims
 * each one via `claimDueSubscription` before enqueueing.
 */
export async function findDueSubscriptions(
  limit: number,
): Promise<Array<{ id: string; retailerListingId: string }>> {
  return db.monitoringSubscription.findMany({
    where: {
      status: "ACTIVE",
      nextCheckAt: { lte: new Date() },
    },
    select: { id: true, retailerListingId: true },
    take: limit,
    orderBy: { nextCheckAt: "asc" },
  });
}

/**
 * Atomically claim a due subscription: advances nextCheckAt by its
 * interval only if it was still due. Returns the claimed row (with
 * interval) or null when someone else claimed it first or it was
 * paused/archived — this prevents duplicate concurrent checks.
 */
export async function claimDueSubscription(id: string): Promise<{
  intervalMinutes: number;
} | null> {
  const subscription = await db.monitoringSubscription.findUnique({
    where: { id },
    select: { intervalMinutes: true, status: true, nextCheckAt: true },
  });
  if (!subscription || subscription.status !== "ACTIVE") {
    return null;
  }
  if (subscription.nextCheckAt && subscription.nextCheckAt > new Date()) {
    return null;
  }

  const nextCheckAt = new Date(
    Date.now() + subscription.intervalMinutes * 60_000,
  );
  const updated = await db.monitoringSubscription.updateMany({
    where: {
      id,
      status: "ACTIVE",
      OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }],
    },
    data: { nextCheckAt },
  });

  if (updated.count !== 1) {
    return null; // Claimed by a concurrent sweeper.
  }
  return { intervalMinutes: subscription.intervalMinutes };
}

export async function getSubscriptionNotificationState(
  subscriptionId: string,
): Promise<SubscriptionNotificationState> {
  const subscription = await db.monitoringSubscription.findUnique({
    where: { id: subscriptionId },
    select: { notificationState: true },
  });
  if (!subscription) {
    throw new Error(`Subscription ${subscriptionId} not found`);
  }
  const parsed = subscriptionNotificationStateSchema.safeParse(
    subscription.notificationState,
  );
  if (parsed.success) {
    return parsed.data;
  }
  logger.warn(
    { component: "monitoring", subscriptionId },
    "invalid notification state in database; resetting to default",
  );
  return defaultNotificationState();
}

export async function saveSubscriptionNotificationState(
  subscriptionId: string,
  state: SubscriptionNotificationState,
): Promise<void> {
  await db.monitoringSubscription.update({
    where: { id: subscriptionId },
    data: {
      notificationState: state as unknown as Prisma.InputJsonValue,
      lastNotifiedAt: new Date(),
    },
  });
}

export interface RecordCheckInput {
  subscriptionId: string;
  retailerListingId: string;
  status: "SUCCESS" | "ERROR";
  availability?: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN";
  priceMinor?: number | null;
  errorCode?: string;
  errorMessage?: string;
  durationMs?: number;
}

export async function recordCheck(input: RecordCheckInput): Promise<void> {
  await db.monitoringCheck.create({
    data: {
      subscriptionId: input.subscriptionId,
      retailerListingId: input.retailerListingId,
      status: input.status,
      availability: input.availability ?? null,
      priceMinor: input.priceMinor ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      durationMs: input.durationMs ?? null,
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });
}

export async function listRecentChecks(
  subscriptionId: string,
  limit: number,
): Promise<
  Array<{
    id: string;
    status: "SUCCESS" | "ERROR" | "SKIPPED";
    availability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN" | null;
    priceMinor: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    durationMs: number | null;
    startedAt: Date;
    finishedAt: Date | null;
  }>
> {
  return db.monitoringCheck.findMany({
    where: { subscriptionId },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
}
