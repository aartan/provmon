"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";

import { AvailabilityBadge, AVAILABILITY_LABELS } from "@/components/availability-badge";
import {
  CONDITION_LABELS,
  formatInterval,
} from "@/components/monitoring-labels";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  ListingAnalyticsView,
  ProductIntelligenceView,
  WindowMetricsView,
} from "@/modules/analytics/view";
import { formatMinor, minorToDecimal } from "@/lib/money";
import { formatSnapshotInterval } from "@/modules/monitoring/snapshot-config";
import { formatDateTime, formatDistanceToNow } from "@/lib/time";

export interface ProductDetailProps {
  subscription: {
    id: string;
    retailerListingId: string;
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
    snapshotIntervalMinutes: number;
    status: "ACTIVE" | "PAUSED" | "ARCHIVED";
  };
  priceObservations: Array<{ priceMinor: number; observedAt: string }>;
  availabilityObservations: Array<{
    availability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN";
    observedAt: string;
  }>;
  checks: Array<{
    id: string;
    status: "SUCCESS" | "ERROR" | "SKIPPED";
    availability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN" | null;
    priceMinor: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    durationMs: number | null;
    startedAt: string;
  }>;
  notifications: Array<{
    id: string;
    type:
      | "BACK_IN_STOCK"
      | "PRICE_DROP"
      | "PRICE_DROP_SUBSEQUENT"
      | "HISTORICAL_ALERT"
      | "TEST";
    subject: string;
    status: "SENT" | "FAILED";
    priceMinor: number | null;
    availability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN" | null;
    sentAt: string;
  }>;
  analytics: ListingAnalyticsView | null;
  productIntelligence: ProductIntelligenceView | null;
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function formatDays(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} days`;
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function ProductDetail({
  subscription,
  priceObservations,
  availabilityObservations,
  checks,
  notifications,
  analytics,
  productIntelligence,
}: ProductDetailProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [removing, setRemoving] = useState(false);
  const [analyticsWindowDays, setAnalyticsWindowDays] = useState(90);

  const selectedMetrics = useMemo<WindowMetricsView | null>(() => {
    if (!analytics) {
      return null;
    }
    return (
      analytics.windows.find(
        (window) => window.windowDays === analyticsWindowDays,
      ) ??
      analytics.windows[0] ??
      null
    );
  }, [analytics, analyticsWindowDays]);

  const chartData = useMemo(() => {
    const points = priceObservations.map((observation) => ({
      label: new Date(observation.observedAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      price: minorToDecimal(observation.priceMinor),
    }));
    if (subscription.currentPriceMinor !== null) {
      points.push({
        label: "now",
        price: minorToDecimal(subscription.currentPriceMinor),
      });
    }
    return points;
  }, [priceObservations, subscription.currentPriceMinor]);

  const targetDecimal = minorToDecimal(subscription.targetPriceMinor);

  function mutate(path: string, options: RequestInit, successMessage: string) {
    startTransition(async () => {
      const response = await fetch(path, options);
      if (response.ok) {
        router.refresh();
        toast.success(successMessage);
      } else {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error ?? "Something went wrong");
      }
    });
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-4">
          {subscription.imageUrl && (
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md bg-muted">
              {/* eslint-disable-next-line @next/next/no-img-element -- external retailer image */}
              <img
                src={subscription.imageUrl}
                alt={subscription.productName}
                className="h-full w-full object-cover"
                referrerPolicy="no-referrer"
              />
            </div>
          )}
          <div className="grid gap-1">
            <h1 className="text-2xl font-semibold">{subscription.productName}</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="capitalize">{subscription.retailerId}</span>
              <Badge
                variant={
                  subscription.status === "ACTIVE" ? "secondary" : "outline"
                }
              >
                {subscription.status === "ACTIVE"
                  ? "Active"
                  : subscription.status === "PAUSED"
                    ? "Paused"
                    : "Archived"}
              </Badge>
              <span>·</span>
              <AvailabilityBadge availability={subscription.availability} />
              <span>·</span>
              <span>
                {subscription.lastCheckedAt
                  ? `checked ${formatDistanceToNow(subscription.lastCheckedAt)} ago`
                  : "never checked"}
              </span>
            </div>
            <Link
              href={subscription.productUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline underline-offset-4"
            >
              View on retailer
            </Link>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              mutate(
                `/api/subscriptions/${subscription.id}`,
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    status: subscription.status === "ACTIVE" ? "PAUSED" : "ACTIVE",
                  }),
                },
                subscription.status === "ACTIVE" ? "Monitoring paused" : "Monitoring resumed",
              )
            }
          >
            {subscription.status === "ACTIVE" ? "Pause monitoring" : "Resume monitoring"}
          </Button>
          <Button
            size="sm"
            disabled={pending || subscription.status !== "ACTIVE"}
            onClick={() =>
              mutate(
                `/api/subscriptions/${subscription.id}`,
                { method: "POST" },
                "Check triggered — results appear shortly",
              )
            }
          >
            Check now
          </Button>
          {subscription.status !== "ARCHIVED" && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" disabled={pending || removing}>
                  Archive
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Archive monitoring?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This stops future checks and email alerts. Your inventory
                    item, price history, and past notifications are kept.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={async () => {
                      setRemoving(true);
                      const response = await fetch(
                        `/api/subscriptions/${subscription.id}`,
                        { method: "DELETE" },
                      );
                      if (response.ok) {
                        toast.success("Monitoring archived");
                        router.refresh();
                      } else {
                        toast.error("Could not archive monitoring");
                      }
                      setRemoving(false);
                    }}
                  >
                    Archive
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Current price
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-semibold tabular-nums">
              {formatMinor(subscription.currentPriceMinor, subscription.currency, "en-GB")}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Target price
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-semibold tabular-nums">
              {subscription.targetPriceMinor !== null
                ? formatMinor(subscription.targetPriceMinor, subscription.currency, "en-GB")
                : "—"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Condition
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-semibold">
              {CONDITION_LABELS[subscription.condition]}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Check frequency
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-semibold">
              {formatInterval(subscription.intervalMinutes)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              History snapshots
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-xl font-semibold">
              {formatSnapshotInterval(subscription.snapshotIntervalMinutes)}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Price intelligence</CardTitle>
              <CardDescription>
                {analytics
                  ? `Time-weighted metrics in ${analytics.currency}. Snapshots extend durations; only real price changes count.`
                  : "No price observations yet."}
              </CardDescription>
            </div>
            {analytics && (
              <div className="flex gap-1">
                {analytics.windows.map((window) => (
                  <Button
                    key={window.windowDays}
                    size="sm"
                    variant={
                      selectedMetrics?.windowDays === window.windowDays
                        ? "default"
                        : "outline"
                    }
                    onClick={() => setAnalyticsWindowDays(window.windowDays)}
                  >
                    {window.windowDays}d
                  </Button>
                ))}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!analytics || !selectedMetrics ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Price intelligence appears after the first successful check.
            </p>
          ) : !selectedMetrics.hasData ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No observations in this window yet.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric
                label={`Lowest (${selectedMetrics.windowDays}d)`}
                value={formatMinor(
                  selectedMetrics.minPriceMinor,
                  analytics.currency,
                  "en-GB",
                )}
              />
              <Metric
                label={`Highest (${selectedMetrics.windowDays}d)`}
                value={formatMinor(
                  selectedMetrics.maxPriceMinor,
                  analytics.currency,
                  "en-GB",
                )}
              />
              <Metric
                label="Price percentile"
                value={formatPercent(selectedMetrics.percentile)}
                hint="0 = cheapest, 100 = most expensive"
              />
              <Metric
                label="Volatility"
                value={formatPercent(selectedMetrics.volatilityPct)}
                hint="Time-weighted coefficient of variation"
              />
              <Metric
                label="Time above current"
                value={formatPercent(selectedMetrics.aboveCurrentPct)}
              />
              <Metric
                label="Time below current"
                value={formatPercent(selectedMetrics.belowCurrentPct)}
              />
              <Metric
                label="Price changes"
                value={String(selectedMetrics.priceChangeCount)}
                hint="Repeated snapshots are not changes"
              />
              <Metric
                label="Avg. days between changes"
                value={formatDays(selectedMetrics.avgDaysBetweenChanges)}
              />
              <Metric
                label="Sale frequency"
                value={formatPercent(selectedMetrics.saleFrequencyPct)}
                hint="Only time with recorded RRP data"
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="price">
        <TabsList className="flex-wrap">
          <TabsTrigger value="price">Price history</TabsTrigger>
          <TabsTrigger value="availability">Availability</TabsTrigger>
          <TabsTrigger value="retailers">Retailers</TabsTrigger>
          <TabsTrigger value="checks">Checks</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
        </TabsList>

        <TabsContent value="price">
          <Card>
            <CardHeader>
              <CardTitle>Price history</CardTitle>
              <CardDescription>
                Observed prices since monitoring started.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {chartData.length < 2 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  Not enough price data yet — the chart appears after prices change.
                </p>
              ) : (
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                      <YAxis
                        tick={{ fontSize: 11 }}
                        domain={["auto", "auto"]}
                        tickFormatter={(value: number) =>
                          formatMinor(Math.round(value * 100), subscription.currency)
                        }
                        width={64}
                      />
                      <Tooltip
                        formatter={(value) => [
                          formatMinor(Math.round(Number(value) * 100), subscription.currency, "en-GB"),
                          "Price",
                        ]}
                      />
                      {targetDecimal !== null && (
                        <ReferenceLine
                          y={targetDecimal}
                          stroke="var(--destructive)"
                          strokeDasharray="4 4"
                          label={{ value: "Target", fontSize: 11, fill: "var(--destructive)" }}
                        />
                      )}
                      <Line
                        type="monotone"
                        dataKey="price"
                        stroke="var(--primary)"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="availability">
          <Card>
            <CardHeader>
              <CardTitle>Availability history</CardTitle>
              <CardDescription>Recorded stock transitions.</CardDescription>
            </CardHeader>
            <CardContent>
              {availabilityObservations.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No transitions recorded yet.
                </p>
              ) : (
                <ul className="grid gap-2">
                  {[...availabilityObservations].reverse().map((observation) => (
                    <li
                      key={observation.observedAt}
                      className="flex items-center justify-between rounded-md border p-3"
                    >
                      <AvailabilityBadge availability={observation.availability} />
                      <span className="text-sm text-muted-foreground">
                        {formatDateTime(observation.observedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="checks">
          <Card>
            <CardHeader>
              <CardTitle>Recent checks</CardTitle>
            </CardHeader>
            <CardContent>
              {checks.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No checks yet.
                </p>
              ) : (
                <ul className="grid gap-2">
                  {checks.map((check) => (
                    <li
                      key={check.id}
                      className="flex items-start justify-between gap-3 rounded-md border p-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={check.status === "SUCCESS" ? "secondary" : "destructive"}
                          >
                            {check.status}
                          </Badge>
                          {check.availability && (
                            <span className="text-xs text-muted-foreground">
                              {AVAILABILITY_LABELS[check.availability]}
                            </span>
                          )}
                        </div>
                        {check.errorCode && (
                          <p className="mt-1 text-xs text-destructive">
                            {check.errorCode}
                            {check.errorMessage ? ` — ${check.errorMessage}` : ""}
                          </p>
                        )}
                      </div>
                      <div className="text-right text-sm text-muted-foreground">
                        <p>{formatDateTime(check.startedAt)}</p>
                        {check.durationMs !== null && (
                          <p className="text-xs">{check.durationMs} ms</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notifications">
          <Card>
            <CardHeader>
              <CardTitle>Notification history</CardTitle>
              <CardDescription>Emails sent for this product.</CardDescription>
            </CardHeader>
            <CardContent>
              {notifications.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No notifications yet.
                </p>
              ) : (
                <ul className="grid gap-2">
                  {notifications.map((notification) => (
                    <li
                      key={notification.id}
                      className="rounded-md border p-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="min-w-0 truncate text-sm font-medium">
                          {notification.subject}
                        </p>
                        <Badge
                          variant={notification.status === "SENT" ? "secondary" : "destructive"}
                        >
                          {notification.status}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatDateTime(notification.sentAt)} ·{" "}
                        {notification.type.replaceAll("_", " ")}
                        {notification.priceMinor !== null
                          ? ` · ${formatMinor(notification.priceMinor, subscription.currency, "en-GB")}`
                          : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="retailers">
          <Card>
            <CardHeader>
              <CardTitle>Retailer comparison</CardTitle>
              <CardDescription>
                Per-currency comparison across listings for this product.
                Best prices and historical lows are never averaged across
                retailers.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!productIntelligence ||
              productIntelligence.byCurrency.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No retailer listings to compare yet.
                </p>
              ) : (
                <div className="grid gap-8">
                  {productIntelligence.byCurrency.map((currency) => {
                    const currencyListings = productIntelligence.listings.filter(
                      (listing) => listing.currency === currency.currency,
                    );
                    return (
                      <div key={currency.currency} className="grid gap-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="text-sm font-semibold">
                            {currency.currency}
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            {currency.listingCount} listing
                            {currency.listingCount === 1 ? "" : "s"} ·{" "}
                            {currency.inStockCount} in stock
                            {currency.bestCurrent
                              ? ` · best ${formatMinor(
                                  currency.bestCurrent.priceMinor,
                                  currency.currency,
                                  "en-GB",
                                )} at ${currency.bestCurrent.retailerId}`
                              : ""}
                          </p>
                        </div>

                        <div className="grid gap-2">
                          {currencyListings.map((listing) => {
                            const isCurrent =
                              listing.id === subscription.retailerListingId;
                            const lowWindow =
                              listing.windows.find(
                                (window) => window.windowDays === 90,
                              ) ??
                              listing.windows[0] ??
                              null;
                            return (
                              <div
                                key={listing.id}
                                className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3"
                              >
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="truncate text-sm font-medium">
                                      {listing.name}
                                    </span>
                                    <span className="text-xs capitalize text-muted-foreground">
                                      {listing.retailerId}
                                    </span>
                                    {isCurrent && (
                                      <Badge variant="outline">
                                        This listing
                                      </Badge>
                                    )}
                                    {listing.bestForCurrency && (
                                      <Badge>Best price</Badge>
                                    )}
                                  </div>
                                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                    <AvailabilityBadge
                                      availability={listing.currentAvailability}
                                    />
                                    {lowWindow?.hasData &&
                                      lowWindow.minPriceMinor !== null && (
                                        <span>
                                          Low ({lowWindow.windowDays}d):{" "}
                                          {formatMinor(
                                            lowWindow.minPriceMinor,
                                            listing.currency,
                                            "en-GB",
                                          )}
                                        </span>
                                      )}
                                    {listing.lastCheckedAt && (
                                      <span>
                                        checked{" "}
                                        {formatDistanceToNow(
                                          listing.lastCheckedAt,
                                        )}{" "}
                                        ago
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="flex items-center gap-3">
                                  <div className="text-right">
                                    <p className="text-sm font-semibold tabular-nums">
                                      {formatMinor(
                                        listing.currentPriceMinor,
                                        listing.currency,
                                        "en-GB",
                                      )}
                                    </p>
                                    {listing.currentOriginalPriceMinor !==
                                      null &&
                                      listing.currentPriceMinor !== null &&
                                      listing.currentOriginalPriceMinor >
                                        listing.currentPriceMinor && (
                                        <p className="text-xs text-muted-foreground line-through">
                                          {formatMinor(
                                            listing.currentOriginalPriceMinor,
                                            listing.currency,
                                            "en-GB",
                                          )}
                                        </p>
                                      )}
                                    {listing.currentDiscountPct !== null &&
                                      listing.currentDiscountPct > 0 && (
                                        <p className="text-xs text-destructive">
                                          {listing.currentDiscountPct}% off
                                        </p>
                                      )}
                                  </div>
                                  <Link
                                    href={listing.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs underline underline-offset-4"
                                  >
                                    View
                                  </Link>
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {currency.lowestByWindow.some(
                          (window) => window.priceMinor !== null,
                        ) && (
                          <p className="text-xs text-muted-foreground">
                            Lowest observed:{" "}
                            {currency.lowestByWindow
                              .map(
                                (window) =>
                                  `${window.windowDays}d ${
                                    window.priceMinor !== null
                                      ? formatMinor(
                                          window.priceMinor,
                                          currency.currency,
                                          "en-GB",
                                        )
                                      : "—"
                                  }`,
                              )
                              .join(" · ")}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
