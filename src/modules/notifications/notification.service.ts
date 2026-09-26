import { formatMinor } from "@/lib/money";
import { logger } from "@/lib/logger";
import { db } from "@/lib/db";
import type { AvailabilityStatus } from "@/modules/retailers/core/types";
import type {
  MonitoringCondition,
  SubscriptionNotificationState,
} from "@/modules/monitoring/types";
import type { CheckOutcome } from "@/modules/monitoring/types";
import {
  getSubscriptionNotificationState,
  saveSubscriptionNotificationState,
} from "@/modules/monitoring/repository";
import { evaluateNotificationRules } from "@/modules/notifications/rules";
import type { NotificationEvent } from "@/modules/notifications/rules";
import { getActiveNotificationProvider } from "@/modules/notifications/providers";

const log = logger.child({ component: "notifications" });

/**
 * Create a notification row.
 *
 * Prisma 7.10's generator treats the optional `subscription` relation as
 * required in both its types and its runtime validation (generator bug:
 * nullable relations are modelled as required), so rows without a
 * subscription (TEST emails) go through a raw insert. Rows with a
 * subscription use the normal client API.
 */
function createNotificationRow(data: {
  subscriptionId: string | null;
  userId: string;
  type: "BACK_IN_STOCK" | "PRICE_DROP" | "PRICE_DROP_SUBSEQUENT" | "TEST";
  subject: string;
  body: string;
  provider: string;
  providerMessageId?: string;
  status: "SENT" | "FAILED";
  priceMinor?: number | null;
  availability?: AvailabilityStatus | null;
}) {
  if (data.subscriptionId !== null) {
    return db.notification.create({
      data: {
        subscriptionId: data.subscriptionId,
        userId: data.userId,
        type: data.type,
        subject: data.subject,
        body: data.body,
        provider: data.provider,
        providerMessageId: data.providerMessageId ?? null,
        status: data.status,
        priceMinor: data.priceMinor ?? null,
        availability: data.availability ?? null,
        sentAt: new Date(),
      },
    });
  }

  return db.$executeRaw`
    INSERT INTO "notifications" (
      "id", "subscription_id", "user_id", "type", "subject", "body",
      "provider", "provider_message_id", "status", "price_minor",
      "availability", "sent_at"
    )
    VALUES (
      ${`n-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`},
      NULL,
      ${data.userId},
      ${data.type}::"NotificationType",
      ${data.subject},
      ${data.body},
      ${data.provider},
      ${data.providerMessageId ?? null},
      ${data.status}::"NotificationStatus",
      ${data.priceMinor ?? null},
      ${data.availability ?? null},
      NOW()
    )
  `;
}

export interface NotificationPreferences {
  emailEnabled: boolean;
  notifyBackInStock: boolean;
  notifyPriceDrop: boolean;
  subsequentDropPct: number | null;
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  emailEnabled: true,
  notifyBackInStock: true,
  notifyPriceDrop: true,
  subsequentDropPct: null,
};

export async function getNotificationPreferences(
  userId: string,
): Promise<NotificationPreferences> {
  const prefs = await db.notificationPreference.findUnique({
    where: { userId },
  });
  if (!prefs) {
    return DEFAULT_PREFERENCES;
  }
  return {
    emailEnabled: prefs.emailEnabled,
    notifyBackInStock: prefs.notifyBackInStock,
    notifyPriceDrop: prefs.notifyPriceDrop,
    subsequentDropPct: prefs.subsequentDropPct,
  };
}

interface SubscriptionContext {
  id: string;
  userId: string;
  condition: MonitoringCondition;
  targetPriceMinor: number | null;
  user: { email: string; name: string | null };
  product: {
    name: string;
    url: string;
    retailerId: string;
    currency: string;
  };
}

async function loadSubscriptionContext(
  subscriptionId: string,
): Promise<SubscriptionContext | null> {
  const subscription = await db.monitoringSubscription.findUnique({
    where: { id: subscriptionId },
    select: {
      id: true,
      userId: true,
      condition: true,
      targetPriceMinor: true,
      user: { select: { email: true, name: true } },
      product: {
        select: {
          name: true,
          url: true,
          retailerId: true,
          currency: true,
        },
      },
    },
  });
  return subscription as SubscriptionContext | null;
}

function buildEmail(
  event: NotificationEvent,
  context: SubscriptionContext,
): { subject: string; text: string } {
  const price = event.priceMinor !== null
    ? formatMinor(event.priceMinor, context.product.currency, "en-GB")
    : null;

  switch (event.type) {
    case "BACK_IN_STOCK": {
      const subject = `${context.product.name} is back in stock`;
      const text = [
        `${context.product.name} is back in stock.`,
        price ? `Current price: ${price}` : null,
        `View the product: ${context.product.url}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      return { subject, text };
    }
    case "PRICE_DROP":
    case "PRICE_DROP_SUBSEQUENT": {
      const target = context.targetPriceMinor !== null
        ? formatMinor(context.targetPriceMinor, context.product.currency, "en-GB")
        : null;
      const subject = event.type === "PRICE_DROP"
        ? `Price drop: ${context.product.name}`
        : `Price dropped again: ${context.product.name}`;
      const text = [
        `${context.product.name} is now ${price}${target ? ` — at or below your target of ${target}` : ""}.`,
        `View the product: ${context.product.url}`,
      ].join("\n\n");
      return { subject, text };
    }
  }
}

/**
 * Evaluate rules for a successful check outcome, send the due
 * notifications, and advance the dedup state.
 *
 * A failed delivery does not advance the state, so the notification is
 * retried on the next check — while a delivered notification never
 * repeats thanks to the state machine.
 */
export async function handleCheckOutcome(
  subscriptionId: string,
  outcome: CheckOutcome,
): Promise<number> {
  if (!outcome.success) {
    return 0;
  }

  const context = await loadSubscriptionContext(subscriptionId);
  if (!context) {
    log.warn({ subscriptionId }, "notification evaluation for missing subscription");
    return 0;
  }

  const prefs = await getNotificationPreferences(context.userId);
  if (!prefs.emailEnabled) {
    return 0;
  }

  const state = await getSubscriptionNotificationState(subscriptionId);
  const evaluation = evaluateNotificationRules({
    condition: context.condition,
    targetPriceMinor: context.targetPriceMinor,
    current: outcome.current,
    state,
    subsequentDropPct: prefs.subsequentDropPct,
  });

  const provider = getActiveNotificationProvider();
  let sent = 0;

  const newState: SubscriptionNotificationState = { ...state };
  let applyBackInStockUpdate = true;
  let applyPriceUpdate = true;

  for (const event of evaluation.events) {
    const enabled =
      event.type === "BACK_IN_STOCK"
        ? prefs.notifyBackInStock
        : prefs.notifyPriceDrop;

    if (!enabled) {
      continue; // Preference off: still advance state so re-enabling does not flood.
    }

    const { subject, text } = buildEmail(event, context);
    try {
      const result = await provider.send({
        to: context.user.email,
        subject,
        text,
      });
      await createNotificationRow({
        subscriptionId,
        userId: context.userId,
        type: event.type,
        subject,
        body: text,
        provider: provider.id,
        providerMessageId: result.providerMessageId,
        status: "SENT",
        priceMinor: event.priceMinor,
        availability: event.availability,
      });
      sent += 1;
      log.info(
        { subscriptionId, type: event.type, provider: provider.id },
        "notification sent",
      );
    } catch (error) {
      log.error(
        { subscriptionId, type: event.type, err: error },
        "notification delivery failed",
      );
      await createNotificationRow({
        subscriptionId,
        userId: context.userId,
        type: event.type,
        subject,
        body: text,
        provider: provider.id,
        status: "FAILED",
        priceMinor: event.priceMinor,
        availability: event.availability,
      });
      if (event.type === "BACK_IN_STOCK") {
        applyBackInStockUpdate = false;
      } else {
        applyPriceUpdate = false;
      }
    }
  }

  if (applyBackInStockUpdate && evaluation.backInStockState) {
    Object.assign(newState, evaluation.backInStockState);
  }
  if (applyPriceUpdate && evaluation.priceState) {
    Object.assign(newState, evaluation.priceState);
  }

  if (JSON.stringify(newState) !== JSON.stringify(state)) {
    await saveSubscriptionNotificationState(subscriptionId, newState);
  }

  return sent;
}

/** Send a test email so users can verify delivery from the settings page. */
export async function sendTestEmail(userId: string): Promise<{
  provider: string;
  to: string;
}> {
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error("User not found");
  }

  const provider = getActiveNotificationProvider();
  const subject = "ProvMon test email";
  const text =
    "This is a test email from ProvMon. Your notification delivery is working correctly.";

  try {
    const result = await provider.send({ to: user.email, subject, text });
    await createNotificationRow({
      subscriptionId: null,
      userId,
      type: "TEST",
      subject,
      body: text,
      provider: provider.id,
      providerMessageId: result.providerMessageId,
      status: "SENT",
    });
    return { provider: provider.id, to: user.email };
  } catch (error) {
    await createNotificationRow({
      subscriptionId: null,
      userId,
      type: "TEST",
      subject,
      body: text,
      provider: provider.id,
      status: "FAILED",
    });
    log.error({ userId, err: error }, "test email failed");
    throw new Error(`Test email failed to send: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export type StoredNotification = {
  id: string;
  subscriptionId: string | null;
  type: "BACK_IN_STOCK" | "PRICE_DROP" | "PRICE_DROP_SUBSEQUENT" | "TEST";
  subject: string;
  body: string;
  provider: string;
  status: "SENT" | "FAILED";
  priceMinor: number | null;
  availability: AvailabilityStatus | null;
  sentAt: Date;
};

export async function listNotificationsForUser(
  userId: string,
  limit = 50,
): Promise<StoredNotification[]> {
  return db.notification.findMany({
    where: { userId },
    orderBy: { sentAt: "desc" },
    take: limit,
  });
}
