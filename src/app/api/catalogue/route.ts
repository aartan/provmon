import { NextResponse } from "next/server";

import { auth } from "@/auth";
import {
  browseCatalogue,
  getCatalogueFilterOptions,
  listCatalogueRetailers,
} from "@/modules/catalogue/browse.repository";
import { parseCatalogueFilters } from "@/modules/catalogue/query";

/** Browse the shared retailer catalogue with filters and user annotations. */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const retailers = await listCatalogueRetailers();
  const requested = url.searchParams.get("retailer");
  const selected =
    retailers.find((retailer) => retailer.id === requested) ??
    retailers.find((retailer) => retailer.productCount > 0) ??
    retailers[0] ??
    null;

  if (!selected) {
    return NextResponse.json({
      retailers,
      selectedRetailer: null,
      filters: null,
      options: { categories: [], brands: [] },
      result: { items: [], total: 0, page: 1, pageSize: 24, totalPages: 1 },
    });
  }

  const params = Object.fromEntries(url.searchParams.entries());
  const filters = parseCatalogueFilters(params, selected.id);
  const [result, options] = await Promise.all([
    browseCatalogue(filters, session.user.id),
    getCatalogueFilterOptions(selected.id),
  ]);

  return NextResponse.json({
    retailers,
    selectedRetailer: selected,
    filters,
    options,
    result,
  });
}
