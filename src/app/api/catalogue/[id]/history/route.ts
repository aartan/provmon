import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { getCatalogueListingHistory } from "@/modules/catalogue/browse.repository";
import {
  isCatalogueHistoryRange,
  type CatalogueHistoryRange,
} from "@/modules/catalogue/history";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/** Price history for one catalogue listing and a selectable range. */
export async function GET(request: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rangeParam = new URL(request.url).searchParams.get("range");
  const range: CatalogueHistoryRange = isCatalogueHistoryRange(rangeParam)
    ? rangeParam
    : "90d";

  const { id } = await context.params;
  const history = await getCatalogueListingHistory(id, range);
  if (!history) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ history });
}
