import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { logger } from "@/lib/logger";
import { isCatalogueAdmin } from "@/modules/catalogue/admin";
import { CatalogueDiscoveryError } from "@/modules/catalogue/discovery.service";
import { startRetailerCatalogueDiscovery } from "@/modules/catalogue/retailer-admin.service";

const bodySchema = z.object({
  mode: z.enum(["initial", "refresh"]).default("refresh"),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Start (or nudge) a manual catalogue discovery/refresh run. */
export async function POST(request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isCatalogueAdmin(session.user.email)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    const json = await request.json().catch(() => ({}));
    body = bodySchema.parse(json);
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { id } = await context.params;
  try {
    const run = await startRetailerCatalogueDiscovery(id, body.mode);
    return NextResponse.json({ run }, { status: 202 });
  } catch (error) {
    if (error instanceof CatalogueDiscoveryError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }
    logger.error(
      { component: "api", retailerId: id, err: error },
      "catalogue discovery start failed",
    );
    return NextResponse.json(
      { error: "Could not start catalogue discovery" },
      { status: 500 },
    );
  }
}
