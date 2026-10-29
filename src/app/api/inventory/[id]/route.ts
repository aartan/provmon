import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { logger } from "@/lib/logger";
import { getProductIntelligence } from "@/modules/analytics/analytics.repository";
import {
  findInventoryItemForUser,
  removeInventoryItemForUser,
} from "@/modules/catalogue/inventory.repository";

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

  const productIntelligence = await getProductIntelligence(
    inventoryItem.canonicalProductId,
    { userId: session.user.id },
  );

  return NextResponse.json({ inventoryItem, productIntelligence });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  try {
    const removed = await removeInventoryItemForUser(id, session.user.id);
    if (!removed) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error(
      { component: "api", inventoryItemId: id, err: error },
      "inventory removal failed",
    );
    return NextResponse.json(
      { error: "Could not remove the product from inventory." },
      { status: 500 },
    );
  }
}
