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
import { formatMinor, minorToDecimal } from "@/lib/money";
import { formatDateTime, formatDistanceToNow } from "@/lib/time";

export interface ProductDetailProps {
  subscription: {
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
    type: "BACK_IN_STOCK" | "PRICE_DROP" | "PRICE_DROP_SUBSEQUENT" | "TEST";
    subject: string;
    status: "SENT" | "FAILED";
    priceMinor: number | null;
    availability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN" | null;
    sentAt: string;
  }>;
}

export function ProductDetail({
  subscription,
  priceObservations,
  availabilityObservations,
  checks,
  notifications,
}: ProductDetailProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [removing, setRemoving] = useState(false);

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
            disabled={pending || subscription.status === "PAUSED"}
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
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" disabled={pending || removing}>
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Stop monitoring this product?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the subscription and its history from your account.
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
                      toast.success("Subscription removed");
                      router.push("/products");
                      router.refresh();
                    } else {
                      toast.error("Could not delete the subscription");
                      setRemoving(false);
                    }
                  }}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
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
      </div>

      <Tabs defaultValue="price">
        <TabsList>
          <TabsTrigger value="price">Price history</TabsTrigger>
          <TabsTrigger value="availability">Availability</TabsTrigger>
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
      </Tabs>
    </div>
  );
}
