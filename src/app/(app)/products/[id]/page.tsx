import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { connection } from "next/server";

import { auth } from "@/auth";
import { findSubscription, listRecentChecks } from "@/modules/monitoring/repository";
import {
  getListingAnalytics,
  getProductIntelligence,
} from "@/modules/analytics/analytics.repository";
import {
  toListingAnalyticsView,
  toProductIntelligenceView,
} from "@/modules/analytics/view";
import { getListingHistory } from "@/modules/catalogue/catalogue.repository";
import { listNotificationsForUser } from "@/modules/notifications/notification.service";
import { ProductDetail } from "@/app/(app)/products/[id]/product-detail";

export const metadata: Metadata = {
  title: "Product",
};

// Session and database reads stream in behind a Suspense boundary; the
// prerendered shell must not read the session cookie.
export const instant = false;

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function ProductDetailPage({ params }: PageProps) {
  return (
    <Suspense fallback={<ProductDetailFallback />}>
      <ProductDetailContent params={params} />
    </Suspense>
  );
}

function ProductDetailFallback() {
  return (
    <div className="grid gap-6">
      <div className="h-8 w-64 animate-pulse rounded-md bg-muted" />
      <div className="h-64 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}

async function ProductDetailContent({ params }: PageProps) {
  // Stop prerendering here; session and database reads run at request time.
  await connection();
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return null;
  }

  const subscription = await findSubscription(id, session.user.id);
  if (!subscription) {
    notFound();
  }

  const [
    { priceObservations, availabilityObservations },
    checks,
    notifications,
    analytics,
    productIntelligence,
  ] = await Promise.all([
    getListingHistory(subscription.retailerListingId),
    listRecentChecks(id, 50),
    listNotificationsForUser(session.user.id, 50).then((all) =>
      all.filter((n) => n.subscriptionId === id),
    ),
    getListingAnalytics(subscription.retailerListingId),
    getProductIntelligence(subscription.retailerListing.canonicalProductId, {
      userId: session.user.id,
    }),
  ]);

  return (
    <ProductDetail
      subscription={{
        id: subscription.id,
        retailerListingId: subscription.retailerListingId,
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
        snapshotIntervalMinutes: subscription.snapshotIntervalMinutes,
        status: subscription.status,
      }}
      priceObservations={priceObservations.map((o) => ({
        priceMinor: o.priceMinor,
        observedAt: o.observedAt.toISOString(),
      }))}
      availabilityObservations={availabilityObservations.map((o) => ({
        availability: o.availability,
        observedAt: o.observedAt.toISOString(),
      }))}
      checks={checks.map((c) => ({
        id: c.id,
        status: c.status,
        availability: c.availability,
        priceMinor: c.priceMinor,
        errorCode: c.errorCode,
        errorMessage: c.errorMessage,
        durationMs: c.durationMs,
        startedAt: c.startedAt.toISOString(),
      }))}
      notifications={notifications.map((n) => ({
        id: n.id,
        type: n.type,
        subject: n.subject,
        status: n.status,
        priceMinor: n.priceMinor,
        availability: n.availability,
        sentAt: n.sentAt.toISOString(),
      }))}
      analytics={toListingAnalyticsView(analytics)}
      productIntelligence={toProductIntelligenceView(productIntelligence)}
    />
  );
}
