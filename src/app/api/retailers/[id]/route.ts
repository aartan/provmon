import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { logger } from "@/lib/logger";
import { isCatalogueAdmin } from "@/modules/catalogue/admin";
import { CatalogueDiscoveryError } from "@/modules/catalogue/discovery.service";
import { updateRetailerDiscoverySettings } from "@/modules/catalogue/retailer-admin.service";

const patchSchema = z.object({
  discoveryEnabled: z.boolean().optional(),
  refreshIntervalHours: z.coerce.number().int().min(1).max(24).optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isCatalogueAdmin(session.user.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (
    body.discoveryEnabled === undefined &&
    body.refreshIntervalHours === undefined
  ) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { id } = await context.params;
  try {
    const retailer = await updateRetailerDiscoverySettings(id, body);
    return NextResponse.json({ retailer });
  } catch (error) {
    if (error instanceof CatalogueDiscoveryError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }
    logger.error(
      { component: "api", retailerId: id, err: error },
      "retailer discovery update failed",
    );
    return NextResponse.json(
      { error: "Could not update retailer discovery" },
      { status: 500 },
    );
  }
}
