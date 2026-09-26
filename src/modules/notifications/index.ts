/**
 * Notifications module public surface.
 */
export type { NotificationProvider, EmailMessage } from "@/modules/notifications/notification-provider.interface";
export { evaluateNotificationRules } from "@/modules/notifications/rules";
export type { NotificationEvent, RulesEvaluation, RulesInput } from "@/modules/notifications/rules";
export {
  handleCheckOutcome,
  sendTestEmail,
  getNotificationPreferences,
  listNotificationsForUser,
} from "@/modules/notifications/notification.service";
export { getActiveNotificationProvider } from "@/modules/notifications/providers";
