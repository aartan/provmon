import type { Metadata } from "next";
import Link from "next/link";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { formatMinor } from "@/lib/money";
import { AvailabilityBadge } from "@/components/availability-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDistanceToNow } from "@/lib/time";

export const metadata: Metadata = {
  title: "Dashboard",
};

// The page reads the session cookie, so it cannot prerender a static shell.
export const instant = false;

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    return null; // The proxy redirects, but stay safe.
  }
  const userId = session.user.id;

  const [subscriptions, notifications, recentChecks, prefs, notificationCount] =
    await Promise.all([
      db.monitoringSubscription.findMany({
        where: { userId },
        include: {
          product: {
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
              product: { select: { name: true, currency: true } },
            },
          },
        },
      }),
      db.notificationPreference.findUnique({ where: { userId } }),
      db.notification.count({ where: { userId, status: "SENT" } }),
    ]);

  const inStock = subscriptions.filter(
    (s) => s.product.currentAvailability === "IN_STOCK",
  ).length;
  const meetingTarget = subscriptions.filter((s) => {
    if (s.targetPriceMinor === null || s.product.currentPriceMinor === null) {
      return false;
    }
    return (
      s.product.currentAvailability === "IN_STOCK" &&
      s.product.currentPriceMinor <= s.targetPriceMinor
    );
  }).length;

  const attention = subscriptions.filter(
    (s) => s.product.currentAvailability === "OUT_OF_STOCK",
  );

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Welcome back{session.user.name ? `, ${session.user.name}` : ""}.
        </p>
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
                No notifications yet. Add a product to get started.
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
              <CardDescription>Products currently out of stock.</CardDescription>
            </CardHeader>
            <CardContent>
              {attention.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing waiting — every product is in stock or unknown.
                </p>
              ) : (
                <ul className="grid gap-3">
                  {attention.map((subscription) => (
                    <li key={subscription.id}>
                      <Link
                        href={`/products/${subscription.id}`}
                        className="flex items-center justify-between gap-3 rounded-md p-2 hover:bg-muted"
                      >
                        <span className="truncate text-sm font-medium">
                          {subscription.product.name}
                        </span>
                        <AvailabilityBadge
                          availability={subscription.product.currentAvailability}
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
                <p className="text-sm text-muted-foreground">No checks run yet.</p>
              ) : (
                <ul className="grid gap-3">
                  {recentChecks.map((check) => (
                    <li key={check.id} className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {check.subscription.product.name}
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
                              check.subscription.product.currency,
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
