import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";

import { auth } from "@/auth";
import { listSubscriptionsForUser } from "@/modules/monitoring/repository";
import { ProductsTable } from "@/app/(app)/products/products-table";

export const metadata: Metadata = {
  title: "Monitored products",
};

// Session and database reads stream in behind a Suspense boundary; the
// prerendered shell must not read the session cookie.
export const instant = false;

export interface ProductRow {
  id: string;
  productName: string;
  productUrl: string;
  imageUrl: string | null;
  retailerId: string;
  currency: string;
  currentPriceMinor: number | null;
  availability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN";
  lastCheckedAt: string | null;
  targetPriceMinor: number | null;
  condition: "BACK_IN_STOCK" | "PRICE_DROP" | "BOTH";
  intervalMinutes: number;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
}

export default function ProductsPage() {
  return (
    <Suspense fallback={<ProductsFallback />}>
      <ProductsContent />
    </Suspense>
  );
}

function ProductsFallback() {
  return (
    <div className="grid gap-6">
      <div className="h-8 w-56 animate-pulse rounded-md bg-muted" />
      <div className="h-64 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}

async function ProductsContent() {
  // Stop prerendering here; session and database reads run at request time.
  await connection();
  const session = await auth();
  if (!session?.user) {
    return null;
  }

  const subscriptions = await listSubscriptionsForUser(session.user.id);
  const activeSubscriptions = subscriptions.filter(
    (subscription) => subscription.status !== "ARCHIVED",
  );
  const rows: ProductRow[] = activeSubscriptions.map((subscription) => ({
    id: subscription.id,
    productName: subscription.product.name,
    productUrl: subscription.product.url,
    imageUrl: subscription.product.imageUrl,
    retailerId: subscription.product.retailerId,
    currency: subscription.product.currency,
    currentPriceMinor: subscription.product.currentPriceMinor,
    availability: subscription.product.currentAvailability,
    lastCheckedAt: subscription.product.lastCheckedAt?.toISOString() ?? null,
    targetPriceMinor: subscription.targetPriceMinor,
    condition: subscription.condition,
    intervalMinutes: subscription.intervalMinutes,
    status: subscription.status,
  }));

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Monitored products</h1>
        <p className="text-sm text-muted-foreground">
          {activeSubscriptions.length} product
          {activeSubscriptions.length === 1 ? "" : "s"} being monitored.
        </p>
      </div>
      <ProductsTable rows={rows} />
    </div>
  );
}
