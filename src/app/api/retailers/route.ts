import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { isCatalogueAdmin } from "@/modules/catalogue/admin";
import { listRetailerAdminViews } from "@/modules/catalogue/retailer-admin.service";

/** Retailer discovery configuration, counts, and latest run status. */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const retailers = await listRetailerAdminViews();
  return NextResponse.json({
    retailers,
    canManage: isCatalogueAdmin(session.user.email),
  });
}
