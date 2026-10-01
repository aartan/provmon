import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { logger } from "@/lib/logger";
import { decimalToMinor } from "@/lib/money";
import {
  deleteSubscription,
  findSubscription,
  listRecentChecks,
  updateSubscription,
} from "@/modules/monitoring/repository";
import { intervalOptionsForRetailer } from "@/modules/monitoring/service";
import { getProductHistory } from "@/modules/products/product.repository";
import { listNotificationsForUser } from "@/modules/notifications/notification.service";
import { monitorQueue } from "@/lib/queue";
import { CHECK_JOB_NAME } from "@/modules/monitoring/types";

const updateSchema = z.object({
  targetPrice: z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v === null) {
        return null; // Explicitly remove the target price.
      }
      if (v === undefined || v === "") {
        return undefined;
      }
      const parsed = Number(v);
      return Number.isFinite(parsed) && parsed > 0 ? decimalToMinor(parsed) : undefined;
    }),
  condition: z.enum(["BACK_IN_STOCK", "PRICE_DROP", "BOTH"]).optional(),
  intervalMinutes: z.coerce.number().int().optional(),
  status: z.enum(["ACTIVE", "PAUSED"]).optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function loadOwnedSubscription(id: string) {
  const session = await auth();
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const subscription = await findSubscription(id, session.user.id);
  if (!subscription) {
    return {
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }
  return { userId: session.user.id, subscription };
}

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const result = await loadOwnedSubscription(id);
  if ("error" in result) {
    return result.error;
  }

  const [{ priceObservations, availabilityObservations }, checks, notifications] =
    await Promise.all([
      getProductHistory(result.subscription.productId),
      listRecentChecks(id, 50),
      listNotificationsForUser(result.userId, 50).then((all) =>
        all.filter((n) => n.subscriptionId === id),
      ),
    ]);

  return NextResponse.json({
    subscription: result.subscription,
    history: { priceObservations, availabilityObservations },
    checks,
    notifications,
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  const result = await loadOwnedSubscription(id);
  if ("error" in result) {
    return result.error;
  }

  let body: z.infer<typeof updateSchema>;
  try {
    body = updateSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const patch: {
    targetPriceMinor?: number | null;
    condition?: "BACK_IN_STOCK" | "PRICE_DROP" | "BOTH";
    intervalMinutes?: number;
    status?: "ACTIVE" | "PAUSED";
  } = {};

  if (body.targetPrice !== undefined) {
    patch.targetPriceMinor = body.targetPrice;
  }
  if (body.condition !== undefined) {
    patch.condition = body.condition;
  }
  if (body.intervalMinutes !== undefined) {
    const allowed = intervalOptionsForRetailer(
      result.subscription.product.retailerId,
    );
    if (!allowed.includes(body.intervalMinutes)) {
      return NextResponse.json(
        { error: `Interval must be one of: ${allowed.join(", ")} minutes` },
        { status: 400 },
      );
    }
    patch.intervalMinutes = body.intervalMinutes;
  }
  if (body.status !== undefined) {
    patch.status = body.status;
  }

  // A PRICE_DROP/BOTH condition needs a target price.
  const nextCondition = patch.condition ?? result.subscription.condition;
  const nextTarget = patch.targetPriceMinor !== undefined
    ? patch.targetPriceMinor
    : result.subscription.targetPriceMinor;
  if (
    (nextCondition === "PRICE_DROP" || nextCondition === "BOTH") &&
    nextTarget === null
  ) {
    return NextResponse.json(
      { error: "A target price is required for price monitoring" },
      { status: 400 },
    );
  }

  const updated = await updateSubscription(id, result.userId, patch);
  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ subscription: updated });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const result = await loadOwnedSubscription(id);
  if ("error" in result) {
    return result.error;
  }

  const deleted = await deleteSubscription(id, result.userId);
  if (!deleted) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

/** Trigger an immediate check outside the sweep cadence. */
export async function POST(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const result = await loadOwnedSubscription(id);
  if ("error" in result) {
    return result.error;
  }

  try {
    await monitorQueue.add(
      CHECK_JOB_NAME,
      { subscriptionId: id },
      { jobId: id },
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error({ component: "api", subscriptionId: id, err: error }, "check trigger failed");
    return NextResponse.json(
      { error: "Could not trigger a check" },
      { status: 500 },
    );
  }
}
