import { env } from "@/lib/env";
import type { NotificationProvider } from "@/modules/notifications/notification-provider.interface";
import { ResendNotificationProvider } from "@/modules/notifications/providers/resend.provider";
import { SmtpNotificationProvider } from "@/modules/notifications/providers/smtp.provider";

/**
 * Choose the active delivery provider: Resend in production (API key set),
 * SMTP/Mailpit otherwise. Cached per process.
 */
const globalForProviders = globalThis as unknown as {
  notificationProvider?: NotificationProvider;
};

export function getActiveNotificationProvider(): NotificationProvider {
  if (!globalForProviders.notificationProvider) {
    globalForProviders.notificationProvider = env.RESEND_API_KEY
      ? new ResendNotificationProvider()
      : new SmtpNotificationProvider();
  }
  return globalForProviders.notificationProvider;
}
