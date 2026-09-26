import nodemailer from "nodemailer";

import { env } from "@/lib/env";
import type {
  EmailMessage,
  NotificationProvider,
  SendResult,
} from "@/modules/notifications/notification-provider.interface";

/**
 * Plain SMTP provider. Used locally against Mailpit (docker-compose) and
 * in tests so email delivery is exercised without a Resend API key.
 */
export class SmtpNotificationProvider implements NotificationProvider {
  readonly id = "smtp";

  private readonly transporter: nodemailer.Transporter;

  constructor(
    options: { host?: string; port?: number } = {},
  ) {
    this.transporter = nodemailer.createTransport({
      host: options.host ?? env.DEV_SMTP_HOST,
      port: options.port ?? env.DEV_SMTP_PORT,
    });
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const info = await this.transporter.sendMail({
      from: env.EMAIL_FROM || "ProvMon <provmon@localhost>",
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { providerMessageId: info.messageId };
  }
}
