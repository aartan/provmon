import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { decimalToMinor } from "@/lib/money";
import { logger } from "@/lib/logger";
import { listSubscriptionsForUser } from "@/modules/monitoring/repository";
import {
  MonitoringServiceError,
  addMonitoringSubscription,
} from "@/modules/monitoring/service";
import { snapshotIntervalMinutesSchema } from "@/modules/monitoring/schemas";
import { z } from "zod";

const createSchema = z.object({
  url: z.string().trim().min(1),
  targetPrice: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === "" ? undefined : v)),
  condition: z.enum(["BACK_IN_STOCK", "PRICE_DROP", "BOTH"]),
  intervalMinutes: z.coerce.number().int(),
  snapshotIntervalMinutes: snapshotIntervalMinutesSchema.optional(),
});

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const subscriptions = await listSubscriptionsForUser(session.user.id);
  return NextResponse.json({ subscriptions });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof createSchema>;
  try {
    body = createSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  let targetPriceMinor: number | undefined;
  if (body.targetPrice !== undefined) {
    const parsed = Number(body.targetPrice);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json({ error: "Invalid target price" }, { status: 400 });
    }
    targetPriceMinor = decimalToMinor(parsed);
  }

  try {
    const subscription = await addMonitoringSubscription({
      userId: session.user.id,
      url: body.url,
      targetPriceMinor,
      condition: body.condition,
      intervalMinutes: body.intervalMinutes,
      snapshotIntervalMinutes: body.snapshotIntervalMinutes,
    });
    return NextResponse.json({ subscription }, { status: 201 });
  } catch (error) {
    if (error instanceof MonitoringServiceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logger.error({ component: "api", err: error }, "subscription creation failed");
    return NextResponse.json(
      { error: "Could not create the monitoring subscription." },
      { status: 500 },
    );
  }
}
