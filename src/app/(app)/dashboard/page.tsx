import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { formatMinor } from "@/lib/money";
import { AvailabilityBadge } from "@/components/availability-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDistanceToNow } from "@/lib/time";

export const metadata: Metadata = {
  title: "Dashboard",
};

// Session and database reads stream in behind a Suspense boundary; the
// prerendered shell must not read the session cookie.
export const instant = false;

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardFallback />}>
      <DashboardContent />
    </Suspense>
  );
}

function DashboardFallback() {
  return (
    <div className="grid gap-6">
      <div className="h-8 w-44 animate-pulse rounded-md bg-muted" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
      <div className="h-48 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}

async function DashboardContent() {
  // Stop prerendering here; session and database reads run at request time.
  await connection();
  const session = await auth();
  if (!session?.user) {
    return null; // The proxy redirects, but stay safe.
  }
  const userId = session.user.id;

  const [subscriptions, notifications, recentChecks, prefs, notificationCount] =
    await Promise.all([
      db.monitoringSubscription.findMany({
        where: { userId, status: { not: "ARCHIVED" } },
        include: {
          retailerListing: {
            select: {
              name: true,
              url: true,
              currency: true,
              currentPriceMinor: true,
              currentAvailability: true,
              lastCheckedAt: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      db.notification.findMany({
        where: { userId },
        orderBy: { sentAt: "desc" },
        take: 8,
      }),
      db.monitoringCheck.findMany({
        where: { subscription: { userId } },
        orderBy: { startedAt: "desc" },
        take: 8,
        include: {
          subscription: {
            select: {
              retailerListing: { select: { name: true, currency: true } },
            },
          },
        },
      }),
      db.notificationPreference.findUnique({ where: { userId } }),
      db.notification.count({ where: { userId, status: "SENT" } }),
    ]);

  const inStock = subscriptions.filter(
    (s) => s.retailerListing.currentAvailability === "IN_STOCK",
  ).length;
  const meetingTarget = subscriptions.filter((s) => {
    if (
      s.targetPriceMinor === null ||
      s.retailerListing.currentPriceMinor === null
    ) {
      return false;
    }
    return (
      s.retailerListing.currentAvailability === "IN_STOCK" &&
      s.retailerListing.currentPriceMinor <= s.targetPriceMinor
    );
  }).length;

  const attention = subscriptions.filter(
    (s) => s.retailerListing.currentAvailability === "OUT_OF_STOCK",
  );
  const hasMonitoredProducts = subscriptions.length > 0;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Welcome back{session.user.name ? `, ${session.user.name}` : ""}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link href="/catalogue">Browse catalogue</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/inventory/add">Add by URL</Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Monitored products", value: subscriptions.length },
          { label: "In stock", value: inStock },
          { label: "Meeting target price", value: meetingTarget },
          {
            label: "Notifications sent",
            value: notificationCount,
          },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{stat.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent notifications</CardTitle>
            <CardDescription>Emails sent by your monitoring rules.</CardDescription>
          </CardHeader>
          <CardContent>
            {notifications.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {hasMonitoredProducts ? (
                  "No notifications yet. Alerts will appear here when a monitoring rule triggers."
                ) : (
                  <>
                    No notifications yet.{" "}
                    <Link href="/inventory" className="underline underline-offset-4">
                      Start monitoring a product
                    </Link>{" "}
                    to receive alerts.
                  </>
                )}
              </p>
            ) : (
              <ul className="grid gap-3">
                {notifications.map((notification) => (
                  <li key={notification.id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{notification.subject}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(notification.sentAt)} ago ·{" "}
                        {notification.provider}
                      </p>
                    </div>
                    <Badge
                      variant={notification.status === "SENT" ? "secondary" : "destructive"}
                    >
                      {notification.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Needs attention</CardTitle>
              <CardDescription>
                {hasMonitoredProducts
                  ? "Products currently out of stock."
                  : "Once you monitor a product, out-of-stock items will show up here."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {attention.length === 0 ? (
                hasMonitoredProducts ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing waiting — every product is in stock or unknown.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    You’re not monitoring any products yet.{" "}
                    <Link href="/inventory" className="underline underline-offset-4">
                      Pick a product from your inventory
                    </Link>{" "}
                    to start tracking its price and stock.
                  </p>
                )
              ) : (
                <ul className="grid gap-3">
                  {attention.map((subscription) => (
                    <li key={subscription.id}>
                      <Link
                        href={`/products/${subscription.id}`}
                        className="flex items-center justify-between gap-3 rounded-md p-2 hover:bg-muted"
                      >
                        <span className="truncate text-sm font-medium">
                          {subscription.retailerListing.name}
                        </span>
                        <AvailabilityBadge
                          availability={subscription.retailerListing.currentAvailability}
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent checks</CardTitle>
            </CardHeader>
            <CardContent>
              {recentChecks.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {hasMonitoredProducts
                    ? "No checks run yet."
                    : "No checks yet. Checks run automatically once you start monitoring a product."}
                </p>
              ) : (
                <ul className="grid gap-3">
                  {recentChecks.map((check) => (
                    <li key={check.id} className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {check.subscription.retailerListing.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDistanceToNow(check.startedAt)} ago
                          {check.durationMs !== null ? ` · ${check.durationMs} ms` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {check.priceMinor !== null && (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {formatMinor(
                              check.priceMinor,
                              check.subscription.retailerListing.currency,
                              "en-GB",
                            )}
                          </span>
                        )}
                        <Badge
                          variant={check.status === "SUCCESS" ? "secondary" : "destructive"}
                        >
                          {check.status}
                        </Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {prefs && !prefs.emailEnabled && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Email notifications are currently disabled.{" "}
            <Link href="/settings" className="underline underline-offset-4">
              Enable them in settings
            </Link>
            .
          </CardContent>
        </Card>
      )}
    </div>
  );
}
