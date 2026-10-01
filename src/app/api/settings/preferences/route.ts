import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { getNotificationPreferences } from "@/modules/notifications/notification.service";
import { db } from "@/lib/db";
import { z } from "zod";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const preferences = await getNotificationPreferences(session.user.id);
  return NextResponse.json({ preferences });
}

const patchSchema = z.object({
  emailEnabled: z.boolean().optional(),
  notifyBackInStock: z.boolean().optional(),
  notifyPriceDrop: z.boolean().optional(),
  subsequentDropPct: z
    .union([z.coerce.number().int().min(1).max(99), z.literal(""), z.null()])
    .optional()
    .transform((v) => (v === "" || v === null || v === undefined ? null : v)),
});

export async function PATCH(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const preferences = await db.notificationPreference.upsert({
    where: { userId: session.user.id },
    create: { userId: session.user.id },
    update: {
      emailEnabled: body.emailEnabled,
      notifyBackInStock: body.notifyBackInStock,
      notifyPriceDrop: body.notifyPriceDrop,
      subsequentDropPct: body.subsequentDropPct,
    },
  });

  return NextResponse.json({ preferences });
}
