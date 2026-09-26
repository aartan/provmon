/**
 * Notification delivery abstraction. The notification service sends
 * through this interface only; adding another delivery channel (SMS, push,
 * Slack…) means implementing a provider and swapping it in — no changes to
 * the rules engine or monitoring loop.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body. */
  text: string;
  html?: string;
}

export interface SendResult {
  /** Provider-specific identifier, stored on the notification row. */
  providerMessageId: string;
}

export interface NotificationProvider {
  /** Stable id recorded on notification rows, e.g. "resend", "smtp". */
  readonly id: string;
  send(message: EmailMessage): Promise<SendResult>;
}
