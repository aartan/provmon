
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Prisma } from "@/generated/prisma/client";
import type { MonitoringCondition, SubscriptionStatus } from "@/modules/monitoring/types";
import { defaultNotificationState } from "@/modules/monitoring/types";
import type { SubscriptionNotificationState } from "@/modules/monitoring/types";
import { subscriptionNotificationStateSchema } from "@/modules/monitoring/schemas";

export interface SubscriptionWithProduct {
  id: string;
  userId: string;
  productId: string;
  targetPriceMinor: number | null;
  condition: MonitoringCondition;
  intervalMinutes: number;
  status: SubscriptionStatus;
  nextCheckAt: Date | null;
  /** Untrusted JSON from the database; parse with the zod schema. */
  notificationState: Prisma.JsonValue;
  lastNotifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  product: {
    id: string;
    retailerId: string;
    retailerProductId: string | null;
    name: string;
    url: string;
    imageUrl: string | null;
    currency: string;
    currentPriceMinor: number | null;
    currentAvailability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN";
    lastCheckedAt: Date | null;
  };
}

export interface CreateSubscriptionInput {
  userId: string;
  productId: string;
  targetPriceMinor?: number;
  condition: MonitoringCondition;
  intervalMinutes: number;
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<SubscriptionWithProduct> {
  return db.monitoringSubscription.create({
    data: {
      userId: input.userId,
      productId: input.productId,
      targetPriceMinor: input.targetPriceMinor ?? null,
      condition: input.condition,
      intervalMinutes: input.intervalMinutes,
      status: "ACTIVE",
      // First check runs on the next sweep.
      nextCheckAt: new Date(),
      notificationState:
        defaultNotificationState() as unknown as Prisma.InputJsonValue,
    },
    include: {
      product: {
        select: {
          id: true,
          retailerId: true,
          retailerProductId: true,
          name: true,
          url: true,
          imageUrl: true,
          currency: true,
          currentPriceMinor: true,
          currentAvailability: true,
          lastCheckedAt: true,
        },
      },
    },
  });
}

export async function findSubscription(
  subscriptionId: string,
  userId?: string,
): Promise<SubscriptionWithProduct | null> {
  return db.monitoringSubscription.findFirst({
    where: { id: subscriptionId, ...(userId ? { userId } : {}) },
    include: {
      product: {
        select: {
          id: true,
          retailerId: true,
          retailerProductId: true,
          name: true,
          url: true,
          imageUrl: true,
          currency: true,
          currentPriceMinor: true,
          currentAvailability: true,
          lastCheckedAt: true,
        },
      },
    },
  });
}

export async function listSubscriptionsForUser(
  userId: string,
): Promise<SubscriptionWithProduct[]> {
  return db.monitoringSubscription.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      product: {
        select: {
          id: true,
          retailerId: true,
          retailerProductId: true,
          name: true,
          url: true,
          imageUrl: true,
          currency: true,
          currentPriceMinor: true,
          currentAvailability: true,
          lastCheckedAt: true,
        },
      },
    },
  });
}

export async function updateSubscription(
  subscriptionId: string,
  userId: string,
  data: {
    targetPriceMinor?: number | null;
    condition?: MonitoringCondition;
    intervalMinutes?: number;
    status?: SubscriptionStatus;
  },
): Promise<SubscriptionWithProduct | null> {
  const existing = await db.monitoringSubscription.findFirst({
    where: { id: subscriptionId, userId },
  });
  if (!existing) {
    return null;
  }

  // Changing the interval resets the schedule so the new cadence applies
  // from now rather than the previously computed next check.
  const nextCheckAt =
    data.intervalMinutes !== undefined && data.intervalMinutes !== existing.intervalMinutes
      ? new Date()
      : existing.nextCheckAt;

  return db.monitoringSubscription.update({
    where: { id: subscriptionId },
    data: {
      targetPriceMinor: data.targetPriceMinor,
      condition: data.condition,
      intervalMinutes: data.intervalMinutes,
      status: data.status,
      nextCheckAt,
    },
    include: {
      product: {
        select: {
          id: true,
          retailerId: true,
          retailerProductId: true,
          name: true,
          url: true,
          imageUrl: true,
          currency: true,
          currentPriceMinor: true,
          currentAvailability: true,
          lastCheckedAt: true,
        },
      },
    },
  });
}

export async function deleteSubscription(
  subscriptionId: string,
  userId: string,
): Promise<boolean> {
  const result = await db.monitoringSubscription.deleteMany({
    where: { id: subscriptionId, userId },
  });
  return result.count === 1;
}

/**
 * Find active subscriptions whose nextCheckAt is due. The caller claims
 * each one via `claimDueSubscription` before enqueueing.
 */
export async function findDueSubscriptions(limit: number): Promise<Array<{ id: string }>> {
  return db.monitoringSubscription.findMany({
    where: {
      status: "ACTIVE",
      nextCheckAt: { lte: new Date() },
    },
    select: { id: true },
    take: limit,
    orderBy: { nextCheckAt: "asc" },
  });
}

/**
 * Atomically claim a due subscription: advances nextCheckAt by its
 * interval only if it was still due. Returns the claimed row (with
 * interval) or null when someone else claimed it first or it was
 * paused — this prevents duplicate concurrent checks.
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

  const nextCheckAt = new Date(Date.now() + subscription.intervalMinutes * 60_000);
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
  productId: string;
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
      productId: input.productId,
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
): Promise<Array<{
  id: string;
  status: "SUCCESS" | "ERROR" | "SKIPPED";
  availability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN" | null;
  priceMinor: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  startedAt: Date;
  finishedAt: Date | null;
}>> {
  return db.monitoringCheck.findMany({
    where: { subscriptionId },
    orderBy: { startedAt: "desc" },
    take: limit,
  });
}
