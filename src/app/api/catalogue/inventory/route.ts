import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { logger } from "@/lib/logger";
import {
  addCatalogueListingsToInventory,
  CatalogueServiceError,
  MAX_BULK_CATALOGUE_LISTINGS,
} from "@/modules/catalogue/catalogue.service";

const bodySchema = z.object({
  listingIds: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(MAX_BULK_CATALOGUE_LISTINGS),
});

/** Save one or more catalogue listings to the signed-in user's inventory. */
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

  try {
    const result = await addCatalogueListingsToInventory(
      session.user.id,
      body.listingIds,
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
      "catalogue bulk inventory add failed",
    );
    return NextResponse.json(
      { error: "Could not save the selected products" },
      { status: 500 },
    );
  }
}
