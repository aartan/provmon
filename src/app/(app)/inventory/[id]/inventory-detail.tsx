"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { AvailabilityBadge } from "@/components/availability-badge";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { formatMinor } from "@/lib/money";
import { formatDateTime, formatDistanceToNow } from "@/lib/time";
import type {
  ProductCurrencyView,
  WindowMetricsView,
} from "@/modules/analytics/view";
import {
  ALERT_RULE_DESCRIPTIONS,
  ALERT_RULE_LABELS,
  PRICE_ALERT_TYPES,
  type PriceAlertType,
} from "@/modules/alerts/types";
import type { MonitoringCondition } from "@/modules/monitoring/types";
import {
  SNAPSHOT_INTERVAL_OPTIONS_MINUTES,
  formatSnapshotInterval,
} from "@/modules/monitoring/snapshot-config";

export interface InventoryItemView {
  id: string;
  name: string;
  brand: string | null;
  model: string | null;
  gtin: string | null;
  mpn: string | null;
}

export interface InventorySubscriptionView {
  id: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
  condition: MonitoringCondition;
  targetPriceMinor: number | null;
  intervalMinutes: number;
  snapshotIntervalMinutes: number;
  nextCheckAt: string | null;
  archivedAt: string | null;
}

export interface InventoryListingView {
  id: string;
  retailerId: string;
  name: string;
  url: string;
  imageUrl: string | null;
  currency: string;
  currentPriceMinor: number | null;
  currentOriginalPriceMinor: number | null;
  currentDiscountPct: number | null;
  currentAvailability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN";
  lastCheckedAt: string | null;
  bestForCurrency: boolean;
  windows: WindowMetricsView[];
  intervalOptions: number[];
  subscription: InventorySubscriptionView | null;
}

export interface InventoryAlertRuleView {
  id: string;
  type: PriceAlertType;
  currency: string;
  enabled: boolean;
  thresholdPct: number | null;
}

export interface InventoryDetailProps {
  item: InventoryItemView;
  listings: InventoryListingView[];
  byCurrency: ProductCurrencyView[];
  alertRules: InventoryAlertRuleView[];
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

export function InventoryDetail({
  item,
  listings,
  byCurrency,
  alertRules,
}: InventoryDetailProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const inStockCount = listings.filter(
    (listing) => listing.currentAvailability === "IN_STOCK",
  ).length;
  const activeMonitoringCount = listings.filter(
    (listing) => listing.subscription?.status === "ACTIVE",
  ).length;
  const monitoredListingCount = listings.filter(
    (listing) => listing.subscription !== null,
  ).length;

  const descriptor = [
    item.brand,
    item.model,
    item.gtin ? `GTIN ${item.gtin}` : null,
    item.mpn ? `MPN ${item.mpn}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const currencies = [...new Set(listings.map((listing) => listing.currency))]
    .sort((left, right) => left.localeCompare(right))
    .map((currency) => ({
      currency,
      listings: listings.filter((listing) => listing.currency === currency),
      summary:
        byCurrency.find((summary) => summary.currency === currency) ?? null,
    }));

  function removeFromInventory() {
    startTransition(async () => {
      const response = await fetch(`/api/inventory/${item.id}`, {
        method: "DELETE",
      });
      if (response.ok) {
        toast.success("Product removed from inventory");
        router.push("/inventory");
        router.refresh();
      } else {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        toast.error(data.error ?? "Could not remove the product");
      }
    });
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/inventory"
            className="text-xs text-muted-foreground underline underline-offset-4"
          >
            ← Inventory
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{item.name}</h1>
          {descriptor ? (
            <p className="text-sm text-muted-foreground">{descriptor}</p>
          ) : null}
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm" disabled={pending}>
              Remove from inventory
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove from inventory?</AlertDialogTitle>
              <AlertDialogDescription>
                This removes “{item.name}” from your inventory. Any monitoring
                subscriptions for it will be archived, not deleted. Price
                history and past notifications are kept.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={removeFromInventory}>
                Remove
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Retailer listings" value={listings.length} />
        <SummaryCard label="In stock" value={inStockCount} />
        <SummaryCard label="Monitored listings" value={monitoredListingCount} />
        <SummaryCard label="Active monitors" value={activeMonitoringCount} />
      </div>

      {byCurrency.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Best prices by currency</CardTitle>
            <CardDescription>
              Best current in-stock price and lowest observed prices per
              currency. No cross-retailer averages.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {byCurrency.map((currency) => (
              <div key={currency.currency} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{currency.currency}</p>
                  <p className="text-xs text-muted-foreground">
                    {currency.inStockCount}/{currency.listingCount} in stock
                  </p>
                </div>
                <p className="mt-2 text-lg font-semibold tabular-nums">
                  {currency.bestCurrent
                    ? formatMinor(
                        currency.bestCurrent.priceMinor,
                        currency.currency,
                        "en-GB",
                      )
                    : "—"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {currency.bestCurrent
                    ? `Best at ${currency.bestCurrent.retailerId}`
                    : "No in-stock price"}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
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
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <AlertRulesPanel
        inventoryItemId={item.id}
        currencies={currencies.map(({ currency }) => currency)}
        initialRules={alertRules}
      />

      <div className="grid gap-4">
        <div>
          <h2 className="text-lg font-semibold">Retailer listings</h2>
          <p className="text-sm text-muted-foreground">
            Monitoring is optional. Add alerts to any listing without leaving
            your inventory.
          </p>
        </div>

        {listings.length === 0 ? (
          <div className="rounded-lg border border-dashed p-10 text-center">
            <p className="text-sm text-muted-foreground">
              No retailer listings are attached to this product yet.
            </p>
          </div>
        ) : (
          currencies.map(({ currency, listings: currencyListings, summary }) => (
            <div key={currency} className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{currency}</h3>
                <p className="text-xs text-muted-foreground">
                  {currencyListings.length} listing
                  {currencyListings.length === 1 ? "" : "s"}
                  {summary?.bestCurrent
                    ? ` · best ${formatMinor(
                        summary.bestCurrent.priceMinor,
                        currency,
                        "en-GB",
                      )} at ${summary.bestCurrent.retailerId}`
                    : ""}
                </p>
              </div>
              {currencyListings.map((listing) => (
                <ListingCard
                  key={listing.id}
                  inventoryItemId={item.id}
                  listing={listing}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ListingCard({
  inventoryItemId,
  listing,
}: {
  inventoryItemId: string;
  listing: InventoryListingView;
}) {
  const lowWindow =
    listing.windows.find((window) => window.windowDays === 90) ??
    listing.windows[0] ??
    null;

  return (
    <Card>
      <CardContent className="grid gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {listing.imageUrl ? (
              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element -- external retailer image */}
                <img
                  src={listing.imageUrl}
                  alt={listing.name}
                  className="h-full w-full object-cover"
                  referrerPolicy="no-referrer"
                />
              </div>
            ) : (
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">
                {listing.name.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {listing.name}
                </span>
                <span className="text-xs capitalize text-muted-foreground">
                  {listing.retailerId}
                </span>
                {listing.bestForCurrency && <Badge>Best price</Badge>}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <AvailabilityBadge availability={listing.currentAvailability} />
                {lowWindow?.hasData && lowWindow.minPriceMinor !== null && (
                  <span>
                    Low ({lowWindow.windowDays}d):{" "}
                    {formatMinor(
                      lowWindow.minPriceMinor,
                      listing.currency,
                      "en-GB",
                    )}
                  </span>
                )}
                {lowWindow && (
                  <span>
                    {lowWindow.priceChangeCount} price change
                    {lowWindow.priceChangeCount === 1 ? "" : "s"}
                  </span>
                )}
                {listing.lastCheckedAt && (
                  <span>
                    checked {formatDistanceToNow(listing.lastCheckedAt)} ago
                  </span>
                )}
              </div>
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
              {listing.currentOriginalPriceMinor !== null &&
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
            <Button variant="outline" size="sm" asChild>
              <Link
                href={listing.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                View
              </Link>
            </Button>
          </div>
        </div>

        <div className="border-t pt-3">
          {listing.subscription ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge
                  variant={
                    listing.subscription.status === "ACTIVE"
                      ? "secondary"
                      : "outline"
                  }
                >
                  {listing.subscription.status === "ACTIVE"
                    ? "Active"
                    : listing.subscription.status === "PAUSED"
                      ? "Paused"
                      : "Archived"}
                </Badge>
                <span>
                  {CONDITION_LABELS[listing.subscription.condition]}
                </span>
                <span>
                  every {formatInterval(listing.subscription.intervalMinutes)}
                </span>
                <span>
                  snapshots{" "}
                  {formatSnapshotInterval(
                    listing.subscription.snapshotIntervalMinutes,
                  )}
                </span>
                {listing.subscription.targetPriceMinor !== null && (
                  <span>
                    target{" "}
                    {formatMinor(
                      listing.subscription.targetPriceMinor,
                      listing.currency,
                      "en-GB",
                    )}
                  </span>
                )}
                {listing.subscription.status === "ACTIVE" &&
                  listing.subscription.nextCheckAt && (
                    <span>
                      next check{" "}
                      {formatDateTime(listing.subscription.nextCheckAt)}
                    </span>
                  )}
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/products/${listing.subscription.id}`}>
                  Open monitoring
                </Link>
              </Button>
            </div>
          ) : (
            <AttachMonitoringForm
              inventoryItemId={inventoryItemId}
              listing={listing}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AttachMonitoringForm({
  inventoryItemId,
  listing,
}: {
  inventoryItemId: string;
  listing: InventoryListingView;
}) {  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [condition, setCondition] =
    useState<MonitoringCondition>("BACK_IN_STOCK");
  const [targetPrice, setTargetPrice] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(() => {
    const options = listing.intervalOptions;
    return String(options.includes(60) ? 60 : options[0] ?? 60);
  });
  const [snapshotIntervalMinutes, setSnapshotIntervalMinutes] =
    useState("1440");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const needsTarget =
    condition === "PRICE_DROP" || condition === "BOTH";
  const targetValid =
    !needsTarget || (targetPrice !== "" && Number(targetPrice) > 0);

  function attach() {
    setError(null);
    startTransition(async () => {
      const response = await fetch(
        `/api/inventory/${inventoryItemId}/subscriptions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            retailerListingId: listing.id,
            targetPrice,
            condition,
            intervalMinutes,
            snapshotIntervalMinutes,
          }),
        },
      );
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setError(data.error ?? "Could not start monitoring");
        return;
      }
      toast.success("Monitoring started");
      setOpen(false);
      router.refresh();
    });
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Not monitored. Add price or stock alerts for this listing.
        </p>
        <Button size="sm" onClick={() => setOpen(true)} disabled={pending}>
          Monitor this listing
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-3 rounded-md border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label>Notify me when</Label>
          <Select
            value={condition}
            onValueChange={(value) =>
              setCondition(value as MonitoringCondition)
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="BACK_IN_STOCK">Back in stock</SelectItem>
              <SelectItem value="PRICE_DROP">Price drop</SelectItem>
              <SelectItem value="BOTH">Both</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>Check every</Label>
          <Select
            value={intervalMinutes}
            onValueChange={setIntervalMinutes}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(listing.intervalOptions.length > 0
                ? listing.intervalOptions
                : [60]
              ).map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {formatInterval(minutes)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>
            Target price {needsTarget ? "" : "(optional)"}
          </Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            placeholder={`0.00 ${listing.currency}`}
            value={targetPrice}
            onChange={(event) => setTargetPrice(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label>History snapshots</Label>
          <Select
            value={snapshotIntervalMinutes}
            onValueChange={setSnapshotIntervalMinutes}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SNAPSHOT_INTERVAL_OPTIONS_MINUTES.map((minutes) => (
                <SelectItem key={minutes} value={String(minutes)}>
                  {formatSnapshotInterval(minutes)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={attach}
          disabled={pending || !targetValid}
        >
          {pending ? "Starting…" : "Start monitoring"}
        </Button>
      </div>
    </div>
  );
}

function alertKey(currency: string, type: PriceAlertType): string {
  return `${currency}:${type}`;
}

interface RuleState {
  enabled: boolean;
  thresholdPct: number | null;
}

function AlertRulesPanel({
  inventoryItemId,
  currencies,
  initialRules,
}: {
  inventoryItemId: string;
  currencies: string[];
  initialRules: InventoryAlertRuleView[];
}) {
  const [rules, setRules] = useState<Record<string, RuleState>>(() => {
    const initial: Record<string, RuleState> = {};
    for (const rule of initialRules) {
      initial[alertKey(rule.currency, rule.type)] = {
        enabled: rule.enabled,
        thresholdPct: rule.thresholdPct,
      };
    }
    return initial;
  });
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  async function patchRule(
    currency: string,
    type: PriceAlertType,
    next: RuleState,
    successMessage: string,
  ): Promise<boolean> {
    const key = alertKey(currency, type);
    setPendingKey(key);
    try {
      const response = await fetch(
        `/api/inventory/${inventoryItemId}/alerts`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            currency,
            enabled: next.enabled,
            thresholdPct: next.thresholdPct,
          }),
        },
      );
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        toast.error(data.error ?? "Could not update the alert");
        return false;
      }
      toast.success(successMessage);
      return true;
    } finally {
      setPendingKey(null);
    }
  }

  async function toggle(
    currency: string,
    type: PriceAlertType,
    enabled: boolean,
  ) {
    const key = alertKey(currency, type);
    const previous = rules[key] ?? {
      enabled: false,
      thresholdPct: type === "BELOW_90_DAY_AVERAGE" ? 10 : null,
    };
    const next: RuleState = { ...previous, enabled };
    setRules((current) => ({ ...current, [key]: next }));
    const ok = await patchRule(
      currency,
      type,
      next,
      enabled ? "Alert enabled" : "Alert disabled",
    );
    if (!ok) {
      setRules((current) => ({ ...current, [key]: previous }));
    }
  }

  if (currencies.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Historical alerts</CardTitle>
          <CardDescription>
            Add a retailer listing before configuring historical alerts.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Historical alerts</CardTitle>
        <CardDescription>
          Inventory-wide rules evaluated per currency and per listing. Rules
          never compare prices across currencies.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <p className="text-xs text-muted-foreground">
          Alert-only inventory is checked daily. If a listing is monitored,
          alerts are evaluated after its normal checks. Historical alerts
          follow your email and price-alert preferences.
        </p>

        {currencies.map((currency) => (
          <div key={currency} className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{currency}</h3>
              <p className="text-xs text-muted-foreground">
                Rules compare {currency} listings only.
              </p>
            </div>

            {PRICE_ALERT_TYPES.map((type) => {
              const key = alertKey(currency, type);
              const rule = rules[key] ?? {
                enabled: false,
                thresholdPct:
                  type === "BELOW_90_DAY_AVERAGE" ? 10 : null,
              };
              const pending = pendingKey === key;

              return (
                <div
                  key={type}
                  className="flex items-start justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">
                        {ALERT_RULE_LABELS[type]}
                      </p>
                      {rule.enabled && (
                        <Badge variant="secondary">On</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {ALERT_RULE_DESCRIPTIONS[type]}
                    </p>
                    {type === "BELOW_90_DAY_AVERAGE" && (
                      <div className="mt-2 flex items-center gap-2">
                        <Input
                          type="number"
                          min={1}
                          max={99}
                          value={rule.thresholdPct ?? 10}
                          disabled={pending}
                          onChange={(event) => {
                            const parsed = Number(event.target.value);
                            setRules((current) => ({
                              ...current,
                              [key]: {
                                ...rule,
                                thresholdPct: Number.isFinite(parsed)
                                  ? parsed
                                  : null,
                              },
                            }));
                          }}
                          onBlur={() => {
                            if (rule.enabled) {
                              void patchRule(
                                currency,
                                type,
                                rule,
                                "Alert threshold updated",
                              );
                            }
                          }}
                          className="h-8 w-20"
                        />
                        <span className="text-xs text-muted-foreground">
                          % below average
                        </span>
                      </div>
                    )}
                  </div>
                  <Switch
                    checked={rule.enabled}
                    disabled={pending}
                    onCheckedChange={(checked) =>
                      void toggle(currency, type, checked)
                    }
                  />
                </div>
              );
            })}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
