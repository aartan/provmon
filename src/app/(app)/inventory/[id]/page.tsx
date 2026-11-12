import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";

import { auth } from "@/auth";
import { InventoryDetail } from "@/app/(app)/inventory/[id]/inventory-detail";
import type { InventoryListingView } from "@/app/(app)/inventory/[id]/inventory-detail";
import {
  getProductIntelligence,
} from "@/modules/analytics/analytics.repository";
import { toProductIntelligenceView } from "@/modules/analytics/view";
import { findInventoryItemForUser } from "@/modules/catalogue/inventory.repository";
import { intervalOptionsForRetailer } from "@/modules/monitoring/service";

export const metadata: Metadata = {
  title: "Inventory item",
};

// Session and database reads stream in behind a Suspense boundary; the
// prerendered shell must not read the session cookie.
export const instant = false;

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function InventoryItemPage({ params }: PageProps) {
  return (
    <Suspense fallback={<InventoryItemFallback />}>
      <InventoryItemContent params={params} />
    </Suspense>
  );
}

function InventoryItemFallback() {
  return (
    <div className="grid gap-6">
      <div className="h-8 w-64 animate-pulse rounded-md bg-muted" />
      <div className="h-36 w-full animate-pulse rounded-xl bg-muted" />
    </div>
  );
}

async function InventoryItemContent({ params }: PageProps) {
  await connection();
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return null;
  }

  const inventoryItem = await findInventoryItemForUser(id, session.user.id);
  if (!inventoryItem) {
    notFound();
  }

  const intelligence = await getProductIntelligence(
    inventoryItem.canonicalProductId,
    { userId: session.user.id },
  );
  const intelligenceView = toProductIntelligenceView(intelligence);
  const intelligenceByListing = new Map(
    (intelligenceView?.listings ?? []).map((listing) => [listing.id, listing]),
  );
  const currencyBest = new Map(
    (intelligenceView?.byCurrency ?? []).map((currency) => [
      currency.currency,
      currency,
    ]),
  );

  const listings: InventoryListingView[] = await Promise.all(
    inventoryItem.canonicalProduct.listings.map(async (listing) => {
      const listingIntelligence = intelligenceByListing.get(listing.id);
      const subscription = listing.subscriptions[0] ?? null;
      return {
        id: listing.id,
        retailerId: listing.retailerId,
        name: listing.name,
        url: listing.url,
        imageUrl: listing.imageUrl,
        currency: listing.currency,
        currentPriceMinor: listing.currentPriceMinor,
        currentOriginalPriceMinor: listing.currentOriginalPriceMinor,
        currentDiscountPct: listing.currentDiscountPct,
        currentAvailability: listing.currentAvailability,
        lastCheckedAt: listing.lastCheckedAt?.toISOString() ?? null,
        bestForCurrency:
          currencyBest.get(listing.currency)?.bestCurrent?.listingId ===
          listing.id,
        windows: listingIntelligence?.windows ?? [],
        intervalOptions: await intervalOptionsForRetailer(
          listing.retailerId,
        ),
        subscription: subscription
          ? {
              id: subscription.id,
              status: subscription.status,
              condition: subscription.condition,
              targetPriceMinor: subscription.targetPriceMinor,
              intervalMinutes: subscription.intervalMinutes,
              snapshotIntervalMinutes: subscription.snapshotIntervalMinutes,
              nextCheckAt:
                subscription.nextCheckAt?.toISOString() ?? null,
              archivedAt: subscription.archivedAt?.toISOString() ?? null,
            }
          : null,
      };
    }),
  );

  return (
    <InventoryDetail
      item={{
        id: inventoryItem.id,
        name: inventoryItem.canonicalProduct.name,
        brand: inventoryItem.canonicalProduct.brand,
        model: inventoryItem.canonicalProduct.model,
        gtin: inventoryItem.canonicalProduct.gtin,
        mpn: inventoryItem.canonicalProduct.mpn,
      }}
      listings={listings}
      byCurrency={intelligenceView?.byCurrency ?? []}
      alertRules={inventoryItem.alertRules.map((rule) => ({
        id: rule.id,
        type: rule.type,
        currency: rule.currency,
        enabled: rule.enabled,
        thresholdPct: rule.thresholdPct,
      }))}
    />
  );
}
