import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";

import { auth } from "@/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatMinor } from "@/lib/money";
import { formatDistanceToNow } from "@/lib/time";
import { listInventoryItemsForUser } from "@/modules/catalogue/inventory.repository";

export const metadata: Metadata = {
  title: "Inventory",
};

// Session and database reads stream in behind a Suspense boundary; the
// prerendered shell must not read the session cookie.
export const instant = false;

export default function InventoryPage() {
  return (
    <Suspense fallback={<InventoryFallback />}>
      <InventoryContent />
    </Suspense>
  );
}

function InventoryFallback() {
  return (
    <div className="grid gap-6">
      <div className="h-8 w-40 animate-pulse rounded-md bg-muted" />
      <div className="h-40 w-full animate-pulse rounded-xl bg-muted" />
    </div>
  );
}

async function InventoryContent() {
  await connection();
  const session = await auth();
  if (!session?.user) {
    return null;
  }

  const items = await listInventoryItemsForUser(session.user.id);

  const rows = items.map((item) => {
    const listings = item.canonicalProduct.listings;
    const activeMonitoringCount = listings.reduce(
      (count, listing) =>
        count +
        listing.subscriptions.filter(
          (subscription) => subscription.status === "ACTIVE",
        ).length,
      0,
    );
    const inStockCount = listings.filter(
      (listing) => listing.currentAvailability === "IN_STOCK",
    ).length;

    const bestByCurrency = new Map<
      string,
      { priceMinor: number; retailerId: string }
    >();
    for (const listing of listings) {
      if (
        listing.currentAvailability !== "IN_STOCK" ||
        listing.currentPriceMinor === null
      ) {
        continue;
      }
      const current = bestByCurrency.get(listing.currency);
      if (!current || listing.currentPriceMinor < current.priceMinor) {
        bestByCurrency.set(listing.currency, {
          priceMinor: listing.currentPriceMinor,
          retailerId: listing.retailerId,
        });
      }
    }

    const imageUrl =
      listings.find((listing) => listing.imageUrl !== null)?.imageUrl ?? null;
    const lastCheckedAt =
      listings
        .map((listing) => listing.lastCheckedAt)
        .filter((value): value is Date => value !== null)
        .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;

    const descriptor = [
      item.canonicalProduct.brand,
      item.canonicalProduct.model,
      item.canonicalProduct.gtin
        ? `GTIN ${item.canonicalProduct.gtin}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return {
      id: item.id,
      name: item.canonicalProduct.name,
      descriptor,
      imageUrl,
      listingCount: listings.length,
      inStockCount,
      activeMonitoringCount,
      best: [...bestByCurrency.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
      lastCheckedAt,
    };
  });

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Inventory</h1>
          <p className="text-sm text-muted-foreground">
            {items.length} product{items.length === 1 ? "" : "s"} saved across
            all retailers.
          </p>
        </div>
        <Button asChild>
          <Link href="/inventory/add">Add to inventory</Link>
        </Button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm text-muted-foreground">
            Your inventory is empty.{" "}
            <Link
              href="/inventory/add"
              className="underline underline-offset-4"
            >
              Add your first product
            </Link>
            .
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {rows.map((row) => (
            <Link key={row.id} href={`/inventory/${row.id}`}>
              <Card className="transition-colors hover:bg-muted/40">
                <CardContent className="flex items-start gap-4 p-4">
                  {row.imageUrl ? (
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element -- external retailer image */}
                      <img
                        src={row.imageUrl}
                        alt={row.name}
                        className="h-full w-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    </div>
                  ) : (
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">
                      {row.name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-sm font-semibold">
                        {row.name}
                      </h2>
                      {row.activeMonitoringCount > 0 ? (
                        <Badge variant="secondary">Monitoring</Badge>
                      ) : (
                        <Badge variant="outline">Not monitored</Badge>
                      )}
                    </div>
                    {row.descriptor ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {row.descriptor}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span>
                        {row.listingCount} retailer listing
                        {row.listingCount === 1 ? "" : "s"}
                      </span>
                      <span>{row.inStockCount} in stock</span>
                      <span>
                        {row.activeMonitoringCount} active monitor
                        {row.activeMonitoringCount === 1 ? "" : "s"}
                      </span>
                      {row.best.map(([currency, best]) => (
                        <span key={currency}>
                          Best {currency}:{" "}
                          <span className="font-medium text-foreground">
                            {formatMinor(best.priceMinor, currency, "en-GB")}
                          </span>{" "}
                          at {best.retailerId}
                        </span>
                      ))}
                      {row.lastCheckedAt && (
                        <span>
                          updated {formatDistanceToNow(row.lastCheckedAt)} ago
                        </span>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
