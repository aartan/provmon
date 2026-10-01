import type { Metadata } from "next";

import { auth } from "@/auth";
import { listSubscriptionsForUser } from "@/modules/monitoring/repository";
import { ProductsTable } from "@/app/(app)/products/products-table";

export const metadata: Metadata = {
  title: "Monitored products",
};

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
  status: "ACTIVE" | "PAUSED";
}

export default async function ProductsPage() {
  const session = await auth();
  if (!session?.user) {
    return null;
  }

  const subscriptions = await listSubscriptionsForUser(session.user.id);
  const rows: ProductRow[] = subscriptions.map((subscription) => ({
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
          {subscriptions.length} product{subscriptions.length === 1 ? "" : "s"} being
          monitored.
        </p>
      </div>
      <ProductsTable rows={rows} />
    </div>
  );
}
