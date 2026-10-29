import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { logger } from "@/lib/logger";
import { listInventoryItemsForUser } from "@/modules/catalogue/inventory.repository";
import {
  addInventoryItem,
  InventoryServiceError,
} from "@/modules/catalogue/inventory.service";

const addSchema = z.object({
  url: z.string().trim().min(1),
});

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inventoryItems = await listInventoryItemsForUser(session.user.id);
  return NextResponse.json({ inventoryItems });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: z.infer<typeof addSchema>;
  try {
    body = addSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const result = await addInventoryItem({
      userId: session.user.id,
      url: body.url,
    });
    return NextResponse.json(
      {
        inventoryItem: result.inventoryItem,
        created: result.created,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof InventoryServiceError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }
    logger.error({ component: "api", err: error }, "inventory add failed");
    return NextResponse.json(
      { error: "Could not add the product to inventory." },
      { status: 500 },
    );
  }
}
