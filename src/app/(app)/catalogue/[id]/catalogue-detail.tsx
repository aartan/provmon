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

import { AvailabilityBadge } from "@/components/availability-badge";
import { CONDITION_LABELS, formatInterval } from "@/components/monitoring-labels";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { formatMinor } from "@/lib/money";
import { formatDateTime, formatDistanceToNow } from "@/lib/time";
import type {
  CatalogueHistoryResult,
  CatalogueListingDetail,
} from "@/modules/catalogue/browse.repository";
import {
  CATALOGUE_HISTORY_RANGES,
  CATALOGUE_HISTORY_RANGE_LABELS,
  type CatalogueHistoryRange,
} from "@/modules/catalogue/history";

interface ClientListing
  extends Omit<
    CatalogueListingDetail,
    "lastCheckedAt" | "lastCatalogueSeenAt" | "delistedAt"
  > {
  lastCheckedAt: string | null;
  lastCatalogueSeenAt: string | null;
  delistedAt: string | null;
}

interface CatalogueDetailProps {
  listing: ClientListing;
  retailer: { id: string; name: string };
  initialHistory: CatalogueHistoryResult | null;
  intervalOptions: number[];
}

const CONDITION_OPTIONS = ["BACK_IN_STOCK", "PRICE_DROP", "BOTH"] as const;

function formatChartDate(t: string, range: CatalogueHistoryRange): string {
  const date = new Date(t);
  if (range === "7d" || range === "30d") {
    return date.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
    });
  }
  return date.toLocaleDateString("en-GB", {
    month: "short",
    year: "2-digit",
  });
}

function priceText(
  minor: number | null | undefined,
  currency: string,
): string {
  return formatMinor(minor, currency, "en-GB");
}

export function CatalogueDetail({
  listing,
  retailer,
  initialHistory,
  intervalOptions,
}: CatalogueDetailProps) {
  const router = useRouter();
  const [history, setHistory] = useState(initialHistory);
  const [range, setRange] = useState<CatalogueHistoryRange>("90d");
  const [loadingRange, setLoadingRange] = useState(false);
  const [condition, setCondition] =
    useState<(typeof CONDITION_OPTIONS)[number]>("BACK_IN_STOCK");
  const [targetPrice, setTargetPrice] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(
    intervalOptions[0] ?? 15,
  );
  const [pending, startTransition] = useTransition();
  const [action, setAction] = useState<string | null>(null);

  const chartData = useMemo(() => {
    if (!history) {
      return [];
    }
    return history.points.map((point) => ({
      t: point.t,
      label: formatChartDate(point.t, history.range),
      price: point.priceMinor / 100,
      priceMinor: point.priceMinor,
    }));
  }, [history]);

  const targetDecimal =
    history?.stats.currency && listing.subscription?.targetPriceMinor
      ? listing.subscription.targetPriceMinor / 100
      : null;

  async function changeRange(nextRange: CatalogueHistoryRange) {
    if (nextRange === range || loadingRange) {
      return;
    }
    const previousRange = range;
    setRange(nextRange);
    setLoadingRange(true);
    try {
      const response = await fetch(
        `/api/catalogue/${encodeURIComponent(listing.id)}/history?range=${nextRange}`,
      );
      const data = (await response.json()) as {
        history?: CatalogueHistoryResult;
        error?: string;
      };
      if (!response.ok || !data.history) {
        setRange(previousRange);
        toast.error(data.error ?? "Could not load that history range");
        return;
      }
      setHistory(data.history);
    } catch {
      setRange(previousRange);
      toast.error("Could not load that history range");
    } finally {
      setLoadingRange(false);
    }
  }

  async function addToInventory() {
    setAction("inventory");
    try {
      const response = await fetch("/api/catalogue/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingIds: [listing.id] }),
      });
      const data = (await response.json()) as {
        addedProducts?: number;
        error?: string;
      };
      if (!response.ok) {
        toast.error(data.error ?? "Could not save this product");
        return;
      }
      toast.success(
        (data.addedProducts ?? 0) > 0
          ? "Saved to your inventory"
          : "Already in your inventory",
      );
      router.refresh();
    } catch {
      toast.error("Could not save this product");
    } finally {
      setAction(null);
    }
  }

  async function startMonitoring() {
    if (
      (condition === "PRICE_DROP" || condition === "BOTH") &&
      !targetPrice.trim()
    ) {
      toast.error("Enter a target price for price monitoring");
      return;
    }
    setAction("monitor");
    try {
      const response = await fetch("/api/catalogue/monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listingIds: [listing.id],
          condition,
          targetPrice:
            condition === "BACK_IN_STOCK" ? undefined : targetPrice.trim(),
          intervalMinutes,
        }),
      });
      const data = (await response.json()) as {
        added?: number;
        resumed?: number;
        failed?: Array<{ message: string }>;
        error?: string;
      };
      if (!response.ok) {
        toast.error(data.error ?? "Could not start monitoring");
        return;
      }
      if (data.failed && data.failed.length > 0) {
        toast.error(data.failed[0]?.message ?? "Could not start monitoring");
        return;
      }
      toast.success("Monitoring started");
      router.refresh();
    } catch {
      toast.error("Could not start monitoring");
    } finally {
      setAction(null);
    }
  }

  function updateSubscription(status: "ACTIVE" | "PAUSED" | "ARCHIVED") {
    if (!listing.subscription) {
      return;
    }
    setAction(status);
    startTransition(async () => {
      try {
        const response = await fetch(
          `/api/subscriptions/${encodeURIComponent(listing.subscription!.id)}`,
          {
            method: status === "ARCHIVED" ? "DELETE" : "PATCH",
            headers: { "Content-Type": "application/json" },
            body:
              status === "ARCHIVED"
                ? undefined
                : JSON.stringify({ status }),
          },
        );
        const data = (await response.json()) as { error?: string };
        if (!response.ok) {
          toast.error(data.error ?? "Could not update monitoring");
          return;
        }
        toast.success(
          status === "ACTIVE"
            ? "Monitoring resumed"
            : status === "PAUSED"
              ? "Monitoring paused"
              : "Monitoring stopped",
        );
        router.refresh();
      } catch {
        toast.error("Could not update monitoring");
      } finally {
        setAction(null);
      }
    });
  }

  const discount =
    listing.currentDiscountPct !== null &&
    listing.currentDiscountPct > 0
      ? `−${listing.currentDiscountPct}%`
      : null;

  return (
    <div className="grid gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        {listing.imageUrl ? (
          <div className="h-36 w-36 shrink-0 overflow-hidden rounded-xl bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element -- external retailer image */}
            <img
              src={listing.imageUrl}
              alt={listing.name}
              className="h-full w-full object-contain"
              referrerPolicy="no-referrer"
            />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{retailer.name}</Badge>
            <AvailabilityBadge availability={listing.currentAvailability} />
            {listing.delistedAt ? (
              <Badge variant="destructive">Delisted</Badge>
            ) : null}
            {listing.subscription?.status === "ACTIVE" ? (
              <Badge variant="secondary">Monitoring</Badge>
            ) : null}
            {listing.inventoryItemId ? (
              <Badge variant="outline">In inventory</Badge>
            ) : null}
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            {listing.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {[listing.brand, listing.model, listing.category]
              .filter(Boolean)
              .join(" · ") || "No brand or category metadata"}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <span className="text-3xl font-semibold tabular-nums">
              {priceText(listing.currentPriceMinor, listing.currency)}
            </span>
            {listing.currentOriginalPriceMinor !== null &&
            listing.currentPriceMinor !== null &&
            listing.currentOriginalPriceMinor > listing.currentPriceMinor ? (
              <span className="pb-1 text-sm text-muted-foreground line-through">
                {priceText(
                  listing.currentOriginalPriceMinor,
                  listing.currency,
                )}
              </span>
            ) : null}
            {discount ? (
              <Badge variant="destructive" className="mb-1">
                {discount}
              </Badge>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              Last checked:{" "}
              {listing.lastCheckedAt
                ? `${formatDistanceToNow(listing.lastCheckedAt)} ago`
                : "never"}
            </span>
            <span>
              Catalogue last seen:{" "}
              {listing.lastCatalogueSeenAt
                ? `${formatDistanceToNow(listing.lastCatalogueSeenAt)} ago`
                : "—"}
            </span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={listing.url} target="_blank" rel="noreferrer">
                View at {retailer.name}
              </a>
            </Button>
            {listing.inventoryItemId ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/inventory/${listing.inventoryItemId}`}>
                  Open in inventory
                </Link>
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={addToInventory}
                disabled={action !== null}
              >
                {action === "inventory" ? "Saving…" : "Save to inventory"}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Current"
          value={priceText(history?.stats.currentPriceMinor, listing.currency)}
          hint="Latest observed price"
        />
        <StatCard
          title={`Lowest · ${CATALOGUE_HISTORY_RANGE_LABELS[range]}`}
          value={priceText(history?.stats.lowestPriceMinor, listing.currency)}
          hint="Observed low in this range"
        />
        <StatCard
          title={`Highest · ${CATALOGUE_HISTORY_RANGE_LABELS[range]}`}
          value={priceText(history?.stats.highestPriceMinor, listing.currency)}
          hint="Observed high in this range"
        />
        <StatCard
          title={`Average · ${CATALOGUE_HISTORY_RANGE_LABELS[range]}`}
          value={priceText(history?.stats.averagePriceMinor, listing.currency)}
          hint="Time-weighted mean"
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Price history</CardTitle>
              <CardDescription>
                Every catalogue refresh and monitored check appends shared
                history. Snapshots extend durations but do not create fake price
                changes.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-1">
              {CATALOGUE_HISTORY_RANGES.map((rangeOption) => (
                <Button
                  key={rangeOption}
                  size="sm"
                  variant={range === rangeOption ? "default" : "outline"}
                  onClick={() => changeRange(rangeOption)}
                  disabled={loadingRange}
                >
                  {CATALOGUE_HISTORY_RANGE_LABELS[rangeOption]}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {chartData.length < 2 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {loadingRange
                ? "Loading history…"
                : "Not enough price history yet. The chart appears after the first observation."}
            </p>
          ) : (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    domain={["auto", "auto"]}
                    tickFormatter={(value: number) =>
                      formatMinor(Math.round(value * 100), listing.currency)
                    }
                    width={64}
                  />
                  <Tooltip
                    labelFormatter={(_label, payload) => {
                      const point = payload?.[0]?.payload as
                        | { t?: string }
                        | undefined;
                      return point?.t ? formatDateTime(point.t) : "";
                    }}
                    formatter={(value) => [
                      formatMinor(
                        Math.round(Number(value) * 100),
                        listing.currency,
                        "en-GB",
                      ),
                      "Price",
                    ]}
                  />
                  {targetDecimal !== null ? (
                    <ReferenceLine
                      y={targetDecimal}
                      stroke="var(--destructive)"
                      strokeDasharray="4 4"
                      label={{
                        value: "Target",
                        fontSize: 11,
                        fill: "var(--destructive)",
                      }}
                    />
                  ) : null}
                  <Line
                    type="stepAfter"
                    dataKey="price"
                    stroke="var(--primary)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          {loadingRange ? (
            <p className="mt-2 text-center text-xs text-muted-foreground">
              Loading {CATALOGUE_HISTORY_RANGE_LABELS[range].toLowerCase()}…
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Tabs defaultValue="monitoring">
        <TabsList className="flex-wrap">
          <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
          <TabsTrigger value="details">Product details</TabsTrigger>
        </TabsList>

        <TabsContent value="monitoring">
          <MonitoringPanel
            listing={listing}
            retailerName={retailer.name}
            intervalOptions={intervalOptions}
            condition={condition}
            setCondition={setCondition}
            targetPrice={targetPrice}
            setTargetPrice={setTargetPrice}
            intervalMinutes={intervalMinutes}
            setIntervalMinutes={setIntervalMinutes}
            action={action}
            pending={pending}
            onStart={startMonitoring}
            onUpdateStatus={updateSubscription}
          />
        </TabsContent>

        <TabsContent value="details">
          <Card>
            <CardHeader>
              <CardTitle>Identifiers</CardTitle>
              <CardDescription>
                Shared catalogue metadata. Monitoring and alerts are always
                scoped to your account.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <Detail label="Retailer" value={retailer.name} />
                <Detail label="Category" value={listing.category ?? "—"} />
                <Detail label="Brand" value={listing.brand ?? "—"} />
                <Detail label="Model" value={listing.model ?? "—"} />
                <Detail label="SKU" value={listing.sku ?? "—"} />
                <Detail label="GTIN" value={listing.gtin ?? "—"} />
                <Detail label="MPN" value={listing.mpn ?? "—"} />
                <Detail
                  label="Retailer product ID"
                  value={listing.retailerProductId ?? "—"}
                />
                <Detail
                  label="Catalogue product ID"
                  value={listing.canonicalProductId}
                />
                <Detail
                  label="Last successful check"
                  value={
                    listing.lastCheckedAt
                      ? formatDateTime(listing.lastCheckedAt)
                      : "—"
                  }
                />
              </dl>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({
  title,
  value,
  hint,
}: {
  title: string;
  value: string;
  hint: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-semibold tabular-nums">{value}</div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}

function MonitoringPanel({
  listing,
  retailerName,
  intervalOptions,
  condition,
  setCondition,
  targetPrice,
  setTargetPrice,
  intervalMinutes,
  setIntervalMinutes,
  action,
  pending,
  onStart,
  onUpdateStatus,
}: {
  listing: ClientListing;
  retailerName: string;
  intervalOptions: number[];
  condition: (typeof CONDITION_OPTIONS)[number];
  setCondition: (value: (typeof CONDITION_OPTIONS)[number]) => void;
  targetPrice: string;
  setTargetPrice: (value: string) => void;
  intervalMinutes: number;
  setIntervalMinutes: (value: number) => void;
  action: string | null;
  pending: boolean;
  onStart: () => void;
  onUpdateStatus: (status: "ACTIVE" | "PAUSED" | "ARCHIVED") => void;
}) {
  const subscription = listing.subscription;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Monitor this listing</CardTitle>
        <CardDescription>
          {subscription
            ? `This ${retailerName} listing is linked to your account. Monitoring checks are shared, but alerts and conditions are per user.`
            : `Start optional monitoring for this ${retailerName} listing. Catalogue history is collected even without monitoring.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {subscription ? (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  subscription.status === "ACTIVE" ? "secondary" : "outline"
                }
              >
                {subscription.status}
              </Badge>
              <span className="text-sm">
                {CONDITION_LABELS[subscription.condition]}
              </span>
              <span className="text-sm text-muted-foreground">
                every {formatInterval(subscription.intervalMinutes)}
              </span>
              {subscription.targetPriceMinor !== null ? (
                <span className="text-sm text-muted-foreground">
                  target{" "}
                  {formatMinor(
                    subscription.targetPriceMinor,
                    listing.currency,
                    "en-GB",
                  )}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {subscription.status === "ACTIVE" ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending || action !== null}
                  onClick={() => onUpdateStatus("PAUSED")}
                >
                  {action === "PAUSED" ? "Pausing…" : "Pause monitoring"}
                </Button>
              ) : null}
              {subscription.status !== "ACTIVE" ? (
                <Button
                  size="sm"
                  disabled={pending || action !== null}
                  onClick={() => onUpdateStatus("ACTIVE")}
                >
                  {action === "ACTIVE" ? "Resuming…" : "Resume monitoring"}
                </Button>
              ) : null}
              {subscription.status !== "ARCHIVED" ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={pending || action !== null}
                    >
                      Stop monitoring
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Stop monitoring?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This archives your subscription. Price history and
                        notifications are kept, and you can resume later.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => onUpdateStatus("ARCHIVED")}
                      >
                        Stop monitoring
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label>Condition</Label>
              <Select
                value={condition}
                onValueChange={(value) =>
                  setCondition(
                    value as (typeof CONDITION_OPTIONS)[number],
                  )
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BACK_IN_STOCK">
                    Back in stock
                  </SelectItem>
                  <SelectItem value="PRICE_DROP">Price drop</SelectItem>
                  <SelectItem value="BOTH">Both</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="catalogue-target-price">
                Target price (£)
                {condition === "BACK_IN_STOCK" ? " (optional)" : ""}
              </Label>
              <Input
                id="catalogue-target-price"
                type="number"
                min="0.01"
                step="0.01"
                placeholder="e.g. 49.99"
                value={targetPrice}
                onChange={(event) => setTargetPrice(event.target.value)}
                disabled={condition === "BACK_IN_STOCK"}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Check frequency</Label>
              <Select
                value={String(intervalMinutes)}
                onValueChange={(value) =>
                  setIntervalMinutes(Number(value))
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {intervalOptions.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      {formatInterval(minutes)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="sm:col-span-3">
              <Button
                onClick={onStart}
                disabled={pending || action !== null}
              >
                {action === "monitor" ? "Starting…" : "Add to monitoring"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
