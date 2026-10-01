import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { sendTestEmail } from "@/modules/notifications/notification.service";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export async function POST() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rate = await checkRateLimit(`test-email:${session.user.id}`, 5, 300);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many test emails. Please wait a few minutes." },
      { status: 429 },
    );
  }

  try {
    const result = await sendTestEmail(session.user.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logger.error({ component: "api", userId: session.user.id, err: error }, "test email failed");
    return NextResponse.json(
      { error: "Test email failed to send. Check your delivery configuration." },
      { status: 500 },
    );
  }
}
