import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { mockRetailerStore } from "@/modules/retailers/adapters/mock";
import { mockProductUrl } from "@/modules/retailers/adapters/mock/types";
import {
  addMonitoringSubscription,
  performListingCheck,
  processCheckJob,
} from "@/modules/monitoring/service";
import {
  getNotificationPreferences,
  handleCheckOutcome,
  listNotificationsForUser,
  sendTestEmail,
} from "@/modules/notifications/notification.service";
import { createTestUser, resetTestState } from "@test/helpers/integration";

const MAILPIT_API = "http://localhost:8025/api/v1/messages";

async function mailpitMessageCount(): Promise<number> {
  const response = await fetch(MAILPIT_API);
  const data = (await response.json()) as { total: number };
  return data.total;
}

async function createPriceSubscription(
  userId: string,
  sku = "price-drops",
  targetPriceMinor = 20000,
) {
  return addMonitoringSubscription({
    userId,
    url: mockProductUrl(sku),
    condition: "PRICE_DROP",
    targetPriceMinor,
    intervalMinutes: 15,
  });
}

describe("notification delivery (integration, SMTP/Mailpit)", () => {
  beforeEach(async () => {
    await resetTestState();
    mockRetailerStore.reset();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("sends exactly one email when the price crosses the target", async () => {
    const userId = await createTestUser();
    const subscription = await createPriceSubscription(userId, "price-drops", 20000);
    const before = await mailpitMessageCount();

    // price-drops starts at £149.99 — already below the target of £200.
    // One check should fire a PRICE_DROP notification.
    const outcome = await processCheckJob({ subscriptionId: subscription.id });
    expect(outcome.success).toBe(true);

    const notifications = await listNotificationsForUser(userId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("PRICE_DROP");
    expect(notifications[0].status).toBe("SENT");
    expect(notifications[0].subject).toContain("Price drop");
    expect(notifications[0].body).toContain("£149.99");

    const after = await mailpitMessageCount();
    expect(after).toBe(before + 1);
  });

  it("does not send duplicate emails while the price stays below the target", async () => {
    const userId = await createTestUser();
    const subscription = await createPriceSubscription(userId, "price-drops", 20000);

    await processCheckJob({ subscriptionId: subscription.id });
    expect(await listNotificationsForUser(userId)).toHaveLength(1);

    // Same price again: no new notification.
    await processCheckJob({ subscriptionId: subscription.id });
    await processCheckJob({ subscriptionId: subscription.id });
    expect(await listNotificationsForUser(userId)).toHaveLength(1);
  });

  it("re-arms and notifies again after the price rises above the target", async () => {
    const userId = await createTestUser();
    const subscription = await createPriceSubscription(userId, "price-drops", 20000);

    // Fire once below target.
    await processCheckJob({ subscriptionId: subscription.id });
    expect(await listNotificationsForUser(userId)).toHaveLength(1);

    // Price rises above the target: re-arm, no email.
    mockRetailerStore.setPrice("price-drops", 25000);
    await processCheckJob({ subscriptionId: subscription.id });
    expect(await listNotificationsForUser(userId)).toHaveLength(1);

    // Price drops below the target again: second email.
    mockRetailerStore.setPrice("price-drops", 18000);
    await processCheckJob({ subscriptionId: subscription.id });
    const notifications = await listNotificationsForUser(userId);
    expect(notifications).toHaveLength(2);
    expect(notifications[0].priceMinor).toBe(18000);
  });

  it("sends a back-in-stock email on OUT_OF_STOCK -> IN_STOCK, once", async () => {
    const userId = await createTestUser("stock@example.com");
    mockRetailerStore.setAvailability("in-stock", "OUT_OF_STOCK");

    const subscription = await addMonitoringSubscription({
      userId,
      url: mockProductUrl("in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });
    expect(subscription.notificationState).toMatchObject({
      lastNotifiedAvailability: "OUT_OF_STOCK",
    });

    // Still out of stock: no email.
    await processCheckJob({ subscriptionId: subscription.id });
    expect(await listNotificationsForUser(userId)).toHaveLength(0);

    // Comes back: exactly one email.
    mockRetailerStore.setAvailability("in-stock", "IN_STOCK");
    await processCheckJob({ subscriptionId: subscription.id });
    const notifications = await listNotificationsForUser(userId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("BACK_IN_STOCK");
    expect(notifications[0].subject).toContain("back in stock");

    // Stays in stock: no repeat.
    await processCheckJob({ subscriptionId: subscription.id });
    expect(await listNotificationsForUser(userId)).toHaveLength(1);
  });

  it("sends a combined (BOTH) email only when back in stock AND below target", async () => {
    const userId = await createTestUser("both@example.com");
    mockRetailerStore.setAvailability("in-stock", "OUT_OF_STOCK");

    const subscription = await addMonitoringSubscription({
      userId,
      url: mockProductUrl("in-stock"),
      condition: "BOTH",
      targetPriceMinor: 25000,
      intervalMinutes: 15,
    });

    // Back in stock but above the target (£299.99 > £250): no email.
    mockRetailerStore.setAvailability("in-stock", "IN_STOCK");
    mockRetailerStore.setPrice("in-stock", 29999);
    await processCheckJob({ subscriptionId: subscription.id });
    expect(await listNotificationsForUser(userId)).toHaveLength(0);

    // Price later drops below target without a stock transition: still none.
    mockRetailerStore.setPrice("in-stock", 20000);
    await processCheckJob({ subscriptionId: subscription.id });
    expect(await listNotificationsForUser(userId)).toHaveLength(0);

    // Out of stock again, then back with a good price: one email.
    mockRetailerStore.setAvailability("in-stock", "OUT_OF_STOCK");
    await processCheckJob({ subscriptionId: subscription.id });
    mockRetailerStore.setAvailability("in-stock", "IN_STOCK");
    await processCheckJob({ subscriptionId: subscription.id });
    const notifications = await listNotificationsForUser(userId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("BACK_IN_STOCK");
  });

  it("does not email while email notifications are disabled", async () => {
    const userId = await createTestUser("off@example.com");
    await db.notificationPreference.update({
      where: { userId },
      data: { emailEnabled: false },
    });
    const subscription = await createPriceSubscription(userId, "price-drops", 20000);

    const outcome = await processCheckJob({ subscriptionId: subscription.id });
    expect(outcome.success).toBe(true);
    expect(await listNotificationsForUser(userId)).toHaveLength(0);

    // State must not have advanced while disabled.
    const state = await db.monitoringSubscription.findUnique({
      where: { id: subscription.id },
      select: { notificationState: true },
    });
    expect(state?.notificationState).toMatchObject({
      priceDropArmed: true,
    });
  });

  it("respects the per-type preference toggles", async () => {
    const userId = await createTestUser("toggles@example.com");
    await db.notificationPreference.update({
      where: { userId },
      data: { notifyPriceDrop: false },
    });
    const subscription = await createPriceSubscription(userId, "price-drops", 20000);

    await processCheckJob({ subscriptionId: subscription.id });
    expect(await listNotificationsForUser(userId)).toHaveLength(0);

    // State still advances so re-enabling does not flood old events.
    const prefs = await getNotificationPreferences(userId);
    expect(prefs.notifyPriceDrop).toBe(false);
  });

  it("sends a test email and records it as type TEST", async () => {
    const userId = await createTestUser("testmail@example.com");
    const before = await mailpitMessageCount();

    const result = await sendTestEmail(userId);
    expect(result.provider).toBe("smtp");
    expect(result.to).toBe("testmail@example.com");

    const notifications = await listNotificationsForUser(userId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe("TEST");
    expect(notifications[0].status).toBe("SENT");

    expect(await mailpitMessageCount()).toBe(before + 1);
  });

  it("handleCheckOutcome returns the number of notifications sent", async () => {
    const userId = await createTestUser("count@example.com");
    const subscription = await createPriceSubscription(userId, "price-drops", 20000);

    const outcome = await processCheckJob({ subscriptionId: subscription.id });
    const sent = await handleCheckOutcome(subscription.id, outcome);
    expect(sent).toBe(0); // Already evaluated inside processCheckJob: state advanced.

    // A fresh subscription re-check below target would fire; verify count API
    // shape via a synthetic second subscription.
    const second = await addMonitoringSubscription({
      userId,
      url: mockProductUrl("out-of-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });
    const secondOutcome = await processCheckJob({ subscriptionId: second.id });
    expect(secondOutcome.success).toBe(true);
    const sentAgain = await handleCheckOutcome(second.id, {
      ...secondOutcome,
      current: { availability: "IN_STOCK", priceMinor: 5000 },
    });
    expect(sentAgain).toBe(1);
  });
});

// Resend rejects example.com recipients, so shared-listing notification
// assertions are only meaningful against the local SMTP/Mailpit provider.
const describeWithSmtp = process.env.RESEND_API_KEY ? describe.skip : describe;

describeWithSmtp("shared listing notification isolation (SMTP/Mailpit)", () => {
  beforeEach(async () => {
    await resetTestState();
    mockRetailerStore.reset();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("notifies each user monitoring a shared listing independently and skips paused users", async () => {
    const userA = await createTestUser("shared-notify-a@example.com");
    const userB = await createTestUser("shared-notify-b@example.com");
    const pausedUser = await createTestUser("shared-notify-paused@example.com");

    const subscriptionA = await createPriceSubscription(userA, "price-drops", 20000);
    const subscriptionB = await createPriceSubscription(userB, "price-drops", 20000);
    const pausedSubscription = await createPriceSubscription(
      pausedUser,
      "price-drops",
      20000,
    );
    expect(subscriptionA.retailerListingId).toBe(
      subscriptionB.retailerListingId,
    );

    await db.monitoringSubscription.update({
      where: { id: pausedSubscription.id },
      data: { status: "PAUSED" },
    });

    const run = await performListingCheck(subscriptionA.retailerListingId, {
      force: true,
    });
    expect(run.outcomes.size).toBe(2);

    const notificationsA = await listNotificationsForUser(userA);
    const notificationsB = await listNotificationsForUser(userB);
    const pausedNotifications = await listNotificationsForUser(pausedUser);
    expect(notificationsA).toHaveLength(1);
    expect(notificationsB).toHaveLength(1);
    expect(notificationsA[0].type).toBe("PRICE_DROP");
    expect(notificationsB[0].type).toBe("PRICE_DROP");
    expect(notificationsA[0].status).toBe("SENT");
    expect(notificationsB[0].status).toBe("SENT");
    expect(pausedNotifications).toHaveLength(0);
  });
});
