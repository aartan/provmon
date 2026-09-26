import { Resend } from "resend";

import { env } from "@/lib/env";
import type {
  EmailMessage,
  NotificationProvider,
  SendResult,
} from "@/modules/notifications/notification-provider.interface";

/**
 * Resend email provider. Active when RESEND_API_KEY is configured —
 * the production delivery path.
 */
export class ResendNotificationProvider implements NotificationProvider {
  readonly id = "resend";

  private readonly client: Resend;

  constructor(apiKey: string = env.RESEND_API_KEY) {
    if (!apiKey) {
      throw new Error("RESEND_API_KEY is not configured");
    }
    this.client = new Resend(apiKey);
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const { data, error } = await this.client.emails.send({
      from: env.EMAIL_FROM || "ProvMon <onboarding@resend.dev>",
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    if (error || !data?.id) {
      throw new Error(`Resend failed to send email: ${error?.message ?? "unknown error"}`);
    }
    return { providerMessageId: data.id };
  }
}
