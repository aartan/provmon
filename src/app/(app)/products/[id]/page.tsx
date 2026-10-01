import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { auth } from "@/auth";
import { findSubscription, listRecentChecks } from "@/modules/monitoring/repository";
import { getProductHistory } from "@/modules/products/product.repository";
import { listNotificationsForUser } from "@/modules/notifications/notification.service";
import { ProductDetail } from "@/app/(app)/products/[id]/product-detail";

export const metadata: Metadata = {
  title: "Product",
};

export const instant = false;

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ProductDetailPage({ params }: PageProps) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    return null;
  }

  const subscription = await findSubscription(id, session.user.id);
  if (!subscription) {
    notFound();
  }

  const [{ priceObservations, availabilityObservations }, checks, notifications] =
    await Promise.all([
      getProductHistory(subscription.productId),
      listRecentChecks(id, 50),
      listNotificationsForUser(session.user.id, 50).then((all) =>
        all.filter((n) => n.subscriptionId === id),
      ),
    ]);

  return (
    <ProductDetail
      subscription={{
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
    />
  );
}
