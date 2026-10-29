import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { decimalToMinor } from "@/lib/money";
import { logger } from "@/lib/logger";
import {
  addCatalogueListingsToMonitoring,
  CatalogueServiceError,
  MAX_BULK_CATALOGUE_LISTINGS,
} from "@/modules/catalogue/catalogue.service";
import { snapshotIntervalMinutesSchema } from "@/modules/monitoring/schemas";

const bodySchema = z.object({
  listingIds: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(MAX_BULK_CATALOGUE_LISTINGS),
  condition: z.enum(["BACK_IN_STOCK", "PRICE_DROP", "BOTH"]).optional(),
  targetPrice: z.union([z.string(), z.number(), z.null()]).optional(),
  intervalMinutes: z.coerce.number().int().positive().optional(),
  snapshotIntervalMinutes: snapshotIntervalMinutesSchema.optional(),
});

/**
 * Start monitoring one or more catalogue listings. Monitoring implies the
 * product is saved to the user's inventory, exactly like URL-based adds.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  let targetPriceMinor: number | undefined;
  if (body.targetPrice !== undefined && body.targetPrice !== null) {
    const parsed = Number(body.targetPrice);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json(
        { error: "Invalid target price" },
        { status: 400 },
      );
    }
    targetPriceMinor = decimalToMinor(parsed);
  }

  try {
    const result = await addCatalogueListingsToMonitoring(
      session.user.id,
      body.listingIds,
      {
        condition: body.condition,
        targetPriceMinor,
        intervalMinutes: body.intervalMinutes,
        snapshotIntervalMinutes: body.snapshotIntervalMinutes,
      },
    );
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof CatalogueServiceError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }
    logger.error(
      { component: "api", err: error },
      "catalogue bulk monitoring add failed",
    );
    return NextResponse.json(
      { error: "Could not start monitoring the selected products" },
      { status: 500 },
    );
  }
}
