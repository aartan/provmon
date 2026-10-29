import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";

import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import {
  browseCatalogue,
  getCatalogueFilterOptions,
  listCatalogueRetailers,
} from "@/modules/catalogue/browse.repository";
import { parseCatalogueFilters } from "@/modules/catalogue/query";
import { CatalogueBrowser } from "@/app/(app)/catalogue/catalogue-browser";

export const metadata: Metadata = {
  title: "Catalogue",
};

// Session and database reads stream in behind a Suspense boundary; the
// prerendered shell must not read the session cookie.
export const instant = false;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default function CataloguePage({ searchParams }: PageProps) {
  return (
    <Suspense fallback={<CatalogueFallback />}>
      <CatalogueContent searchParams={searchParams} />
    </Suspense>
  );
}

function CatalogueFallback() {
  return (
    <div className="grid gap-6">
      <div className="h-8 w-48 animate-pulse rounded-md bg-muted" />
      <div className="h-24 animate-pulse rounded-xl bg-muted" />
      <div className="h-96 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}

async function CatalogueContent({ searchParams }: PageProps) {
  await connection();
  const session = await auth();
  if (!session?.user) {
    redirect("/login?callbackUrl=/catalogue");
  }

  const params = await searchParams;
  const retailers = await listCatalogueRetailers();

  const requestedRaw = params.retailer;
  const requested = Array.isArray(requestedRaw) ? requestedRaw[0] : requestedRaw;
  const selectedRetailer =
    retailers.find((retailer) => retailer.id === requested) ??
    retailers.find((retailer) => retailer.productCount > 0) ??
    retailers[0] ??
    null;

  if (!selectedRetailer) {
    return (
      <div className="grid gap-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Catalogue</h1>
          <p className="text-sm text-muted-foreground">
            Browse retailer-wide product catalogues with continuous price
            history.
          </p>
        </div>
        <div className="rounded-xl border border-dashed p-10 text-center">
          <h2 className="text-lg font-medium">No catalogue products yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Enable catalogue discovery for a supported retailer to import its
            products. You can still monitor individual product URLs.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button asChild>
              <Link href="/retailers">Manage retailers</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/inventory/add">Add by URL</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const filters = parseCatalogueFilters(params, selectedRetailer.id);
  const [result, options] = await Promise.all([
    browseCatalogue(filters, session.user.id),
    getCatalogueFilterOptions(selectedRetailer.id),
  ]);

  return (
    <CatalogueBrowser
      key={`${selectedRetailer.id}:${filters.q ?? ""}:${filters.category ?? ""}:${filters.brand ?? ""}:${filters.stock}:${filters.sort}:${filters.minPriceMinor ?? ""}:${filters.maxPriceMinor ?? ""}:${filters.pageSize}:${filters.page}`}
      retailers={retailers.map((retailer) => ({
        id: retailer.id,
        name: retailer.name,
        productCount: retailer.productCount,
        inStockCount: retailer.inStockCount,
        supportsCatalogue: retailer.supportsCatalogue,
      }))}
      selectedRetailer={selectedRetailer}
      filters={filters}
      options={options}
      result={result}
    />
  );
}
