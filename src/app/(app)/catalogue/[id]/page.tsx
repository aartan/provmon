import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";

import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import {
  findCatalogueListing,
  getCatalogueListingHistory,
} from "@/modules/catalogue/browse.repository";
import { intervalOptionsForRetailer } from "@/modules/monitoring/service";
import { registerBuiltInAdapters } from "@/modules/retailers/adapters";
import { retailerRegistry } from "@/modules/retailers/core/retailer-registry";
import { CatalogueDetail } from "@/app/(app)/catalogue/[id]/catalogue-detail";

export const metadata: Metadata = {
  title: "Catalogue product",
};

// Session and database reads stream in behind a Suspense boundary; the
// prerendered shell must not read the session cookie.
export const instant = false;

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function CatalogueProductPage({ params }: PageProps) {
  return (
    <Suspense fallback={<CatalogueDetailFallback />}>
      <CatalogueProductContent params={params} />
    </Suspense>
  );
}

function CatalogueDetailFallback() {
  return (
    <div className="grid gap-6">
      <div className="h-8 w-40 animate-pulse rounded-md bg-muted" />
      <div className="h-56 animate-pulse rounded-xl bg-muted" />
      <div className="h-96 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}

async function CatalogueProductContent({ params }: PageProps) {
  await connection();
  const session = await auth();
  if (!session?.user) {
    redirect("/login?callbackUrl=/catalogue");
  }

  const { id } = await params;
  const [listing, history] = await Promise.all([
    findCatalogueListing(id, session.user.id),
    getCatalogueListingHistory(id, "90d"),
  ]);
  if (!listing) {
    notFound();
  }

  registerBuiltInAdapters();
  const adapter = retailerRegistry.getById(listing.retailerId);

  return (
    <div className="grid gap-4">
      <Button asChild variant="ghost" size="sm" className="w-fit">
        <Link href={`/catalogue?retailer=${encodeURIComponent(listing.retailerId)}`}>
          ← Back to catalogue
        </Link>
      </Button>
      <CatalogueDetail
        listing={{
          ...listing,
          lastCheckedAt: listing.lastCheckedAt?.toISOString() ?? null,
          lastCatalogueSeenAt:
            listing.lastCatalogueSeenAt?.toISOString() ?? null,
          delistedAt: listing.delistedAt?.toISOString() ?? null,
        }}
        retailer={{
          id: listing.retailerId,
          name: adapter?.name ?? listing.retailerId,
        }}
        initialHistory={history}
        intervalOptions={intervalOptionsForRetailer(listing.retailerId)}
      />
    </div>
  );
}
