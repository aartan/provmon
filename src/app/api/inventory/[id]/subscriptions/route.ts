import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { logger } from "@/lib/logger";
import { decimalToMinor } from "@/lib/money";
import {
  attachMonitoringToInventoryItem,
  InventoryServiceError,
} from "@/modules/catalogue/inventory.service";
import { snapshotIntervalMinutesSchema } from "@/modules/monitoring/schemas";

const attachSchema = z.object({
  retailerListingId: z.string().min(1),
  targetPrice: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      if (value === null) {
        return null;
      }
      if (value === undefined || value === "") {
        return undefined;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0
        ? decimalToMinor(parsed)
        : undefined;
    }),
  condition: z.enum(["BACK_IN_STOCK", "PRICE_DROP", "BOTH"]),
  intervalMinutes: z.coerce.number().int(),
  snapshotIntervalMinutes: snapshotIntervalMinutesSchema.optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof attachSchema>;
  try {
    body = attachSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { id } = await context.params;
  try {
    const subscription = await attachMonitoringToInventoryItem({
      userId: session.user.id,
      inventoryItemId: id,
      retailerListingId: body.retailerListingId,
      targetPriceMinor:
        body.targetPrice === null ? undefined : body.targetPrice,
      condition: body.condition,
      intervalMinutes: body.intervalMinutes,
      snapshotIntervalMinutes: body.snapshotIntervalMinutes,
    });
    return NextResponse.json({ subscription }, { status: 201 });
  } catch (error) {
    if (error instanceof InventoryServiceError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }
    logger.error(
      { component: "api", inventoryItemId: id, err: error },
      "inventory monitoring attach failed",
    );
    return NextResponse.json(
      { error: "Could not start monitoring this listing." },
      { status: 500 },
    );
  }
}
