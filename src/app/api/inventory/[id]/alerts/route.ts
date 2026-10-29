import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { logger } from "@/lib/logger";
import {
  AlertServiceError,
  setInventoryAlertRule,
} from "@/modules/alerts/alert.service";
import { PRICE_ALERT_TYPES } from "@/modules/alerts/types";
import { findInventoryItemForUser } from "@/modules/catalogue/inventory.repository";

const updateSchema = z.object({
  type: z.enum(PRICE_ALERT_TYPES),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toUpperCase()),
  enabled: z.boolean(),
  thresholdPct: z.number().int().min(1).max(99).nullable().optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const inventoryItem = await findInventoryItemForUser(id, session.user.id);
  if (!inventoryItem) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ alertRules: inventoryItem.alertRules });
}

export async function PATCH(request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof updateSchema>;
  try {
    body = updateSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { id } = await context.params;
  try {
    const alertRule = await setInventoryAlertRule({
      userId: session.user.id,
      inventoryItemId: id,
      type: body.type,
      currency: body.currency,
      enabled: body.enabled,
      thresholdPct: body.thresholdPct,
    });
    return NextResponse.json({ alertRule });
  } catch (error) {
    if (error instanceof AlertServiceError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }
    logger.error(
      { component: "api", inventoryItemId: id, err: error },
      "alert rule update failed",
    );
    return NextResponse.json(
      { error: "Could not update the alert rule." },
      { status: 500 },
    );
  }
}
