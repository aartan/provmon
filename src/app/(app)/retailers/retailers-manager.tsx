"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { formatDateTime, formatDistanceToNow } from "@/lib/time";
import type {
  RetailerAdminView,
  RetailerRunView,
} from "@/modules/catalogue/retailer-admin.service";
import type { PluginStatusRecord } from "@/modules/retailers/plugin";

interface RetailersManagerProps {
  retailers: RetailerAdminView[];
  plugins: PluginStatusRecord[];
  canManage: boolean;
}

const RUN_STATUS_VARIANT: Record<
  RetailerRunView["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  COMPLETED: "secondary",
  RUNNING: "default",
  QUEUED: "outline",
  FAILED: "destructive",
  CANCELLED: "outline",
};

const REFRESH_INTERVAL_OPTIONS = [1, 2, 4, 6, 8, 12, 24] as const;

function runProgress(run: RetailerRunView): number | null {
  if (!run.totalEstimate || run.totalEstimate <= 0) {
    return null;
  }
  return Math.min(100, Math.round((run.itemsSeen / run.totalEstimate) * 100));
}

export function RetailersManager({
  retailers,
  plugins,
  canManage,
}: RetailersManagerProps) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const pluginIssues = plugins.filter(
    (plugin) => plugin.status === "FAILED" && !plugin.id,
  );
  const hasActiveRun = retailers.some(
    (retailer) =>
      retailer.latestRun?.status === "QUEUED" ||
      retailer.latestRun?.status === "RUNNING",
  );

  useEffect(() => {
    if (!hasActiveRun) {
      return;
    }
    const timer = window.setInterval(() => {
      router.refresh();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, router]);

  async function patchRetailer(
    retailer: RetailerAdminView,
    body: { discoveryEnabled?: boolean; refreshIntervalHours?: number },
  ) {
    setPending(retailer.id);
    try {
      const response = await fetch(
        `/api/retailers/${encodeURIComponent(retailer.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        toast.error(data.error ?? "Could not update the retailer");
        return;
      }
      toast.success(
        body.discoveryEnabled === false
          ? "Scheduled discovery disabled"
          : body.discoveryEnabled === true
            ? "Scheduled discovery enabled"
            : "Refresh interval updated",
      );
      router.refresh();
    } catch {
      toast.error("Could not update the retailer");
    } finally {
      setPending(null);
    }
  }

  async function startDiscovery(
    retailer: RetailerAdminView,
    mode: "initial" | "refresh" | "resume",
  ) {
    setPending(retailer.id);
    try {
      const response = await fetch(
        `/api/retailers/${encodeURIComponent(retailer.id)}/discovery`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        },
      );
      const data = (await response.json()) as {
        run?: { status?: string };
        error?: string;
      };
      if (!response.ok) {
        toast.error(data.error ?? "Could not start discovery");
        return;
      }
      toast.success(
        mode === "resume"
          ? "Catalogue discovery resumed"
          : data.run?.status === "RUNNING"
            ? "Discovery is already running"
            : "Catalogue discovery queued",
        {
          description:
            "Progress updates automatically. A large catalogue can take a while.",
        },
      );
      router.refresh();
    } catch {
      toast.error("Could not start discovery");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Retailers</h1>
          <p className="text-sm text-muted-foreground">
            Import and refresh retailer-wide catalogues. URL-based monitoring
            keeps working for retailers without discovery support.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/catalogue">Browse catalogue</Link>
        </Button>
      </div>

      {!canManage ? (
        <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
          You can view discovery status, but only accounts on the
          <code className="mx-1 rounded bg-background px-1 py-0.5 text-xs">
            CATALOGUE_ADMIN_EMAILS
          </code>
          allowlist can change retailer settings.
        </div>
      ) : null}

      {pluginIssues.length > 0 ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="font-medium">Some retailer plugins could not load</p>
          <ul className="mt-2 grid gap-1 text-muted-foreground">
            {pluginIssues.map((plugin) => (
              <li key={plugin.packageName}>
                <code className="rounded bg-background px-1 py-0.5 text-xs">
                  {plugin.packageName}
                </code>{" "}
                — {plugin.error ?? "Unknown plugin error"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {retailers.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <h2 className="text-lg font-medium">No retailer plugins found</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Install a retailer plugin package and list it in{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              plugins/provmon.plugins.json
            </code>
            . See the plugin development guide.
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {retailers.map((retailer) => {
            const run = retailer.latestRun;
            const active =
              run?.status === "QUEUED" || run?.status === "RUNNING";
            const resumable = run?.status === "FAILED" && run.resumable;
            const progress = run ? runProgress(run) : null;
            const busy = pending === retailer.id;
            const pluginUnavailable =
              retailer.pluginStatus === "FAILED" ||
              retailer.pluginStatus === "MISSING";
            return (
              <Card key={retailer.id}>
                <CardHeader>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle className="flex flex-wrap items-center gap-2">
                        {retailer.name}
                        {retailer.supportsCatalogue ? (
                          <Badge variant="outline">Discovery</Badge>
                        ) : (
                          <Badge variant="outline">URL monitoring only</Badge>
                        )}
                        {retailer.pluginVersion ? (
                          <Badge variant="outline">
                            plugin v{retailer.pluginVersion}
                          </Badge>
                        ) : null}
                        {retailer.pluginStatus === "FAILED" ? (
                          <Badge variant="destructive">Plugin failed</Badge>
                        ) : retailer.pluginStatus === "MISSING" ? (
                          <Badge variant="destructive">Plugin missing</Badge>
                        ) : null}
                        {retailer.discoveryEnabled ? (
                          <Badge variant="secondary">Scheduled</Badge>
                        ) : null}
                      </CardTitle>
                      <CardDescription>
                        {retailer.productCount.toLocaleString()} products ·{" "}
                        {retailer.inStockCount.toLocaleString()} in stock
                        {retailer.lastSuccessfulRunAt
                          ? ` · last success ${formatDistanceToNow(
                              retailer.lastSuccessfulRunAt,
                            )} ago`
                          : " · no successful discovery yet"}
                      </CardDescription>
                      {retailer.pluginError ? (
                        <p className="mt-1 text-xs text-destructive">
                          {retailer.pluginError}
                        </p>
                      ) : null}
                    </div>
                    {canManage && retailer.supportsCatalogue ? (
                      <div className="flex items-center gap-2">
                        <Label
                          htmlFor={`discovery-${retailer.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          Scheduled discovery
                        </Label>
                        <Switch
                          id={`discovery-${retailer.id}`}
                          checked={retailer.discoveryEnabled}
                          disabled={busy || pluginUnavailable}
                          onCheckedChange={(checked) =>
                            patchRetailer(retailer, {
                              discoveryEnabled: checked,
                            })
                          }
                        />
                      </div>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent className="grid gap-4">
                  {!retailer.supportsCatalogue ? (
                    <p className="text-sm text-muted-foreground">
                      This retailer does not expose a public catalogue
                      endpoint. Add individual product URLs to monitor them.
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-end gap-3">
                        {canManage ? (
                          <>
                            <div className="grid gap-1.5">
                              <Label className="text-xs text-muted-foreground">
                                Refresh interval
                              </Label>
                              <Select
                                value={String(retailer.refreshIntervalHours)}
                                disabled={busy || pluginUnavailable}
                                onValueChange={(value) =>
                                  patchRetailer(retailer, {
                                    refreshIntervalHours: Number(value),
                                  })
                                }
                              >
                                <SelectTrigger
                                  size="sm"
                                  className="w-32"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {!REFRESH_INTERVAL_OPTIONS.includes(
                                    retailer.refreshIntervalHours as (typeof REFRESH_INTERVAL_OPTIONS)[number],
                                  ) ? (
                                    <SelectItem
                                      value={String(retailer.refreshIntervalHours)}
                                    >
                                      Every {retailer.refreshIntervalHours}h
                                    </SelectItem>
                                  ) : null}
                                  {REFRESH_INTERVAL_OPTIONS.map((hours) => (
                                    <SelectItem key={hours} value={String(hours)}>
                                      Every {hours}h
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            {resumable ? (
                              <>
                                <Button
                                  size="sm"
                                  disabled={busy || pluginUnavailable}
                                  onClick={() =>
                                    startDiscovery(retailer, "resume")
                                  }
                                >
                                  {busy ? "Starting…" : "Resume discovery"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy || pluginUnavailable}
                                  onClick={() =>
                                    startDiscovery(
                                      retailer,
                                      retailer.lastSuccessfulRunAt
                                        ? "refresh"
                                        : "initial",
                                    )
                                  }
                                >
                                  Start over
                                </Button>
                              </>
                            ) : (
                              <Button
                                size="sm"
                                disabled={busy || active || pluginUnavailable}
                                onClick={() =>
                                  startDiscovery(
                                    retailer,
                                    retailer.lastSuccessfulRunAt
                                      ? "refresh"
                                      : "initial",
                                  )
                                }
                              >
                                {busy
                                  ? "Starting…"
                                  : active
                                    ? "Discovery running"
                                    : retailer.lastSuccessfulRunAt
                                      ? "Refresh now"
                                      : "Start initial discovery"}
                              </Button>
                            )}
                            <Button asChild size="sm" variant="outline">
                              <Link
                                href={`/catalogue?retailer=${encodeURIComponent(
                                  retailer.id,
                                )}`}
                              >
                                Browse products
                              </Link>
                            </Button>
                          </>
                        ) : null}
                        {retailer.nextRefreshAt ? (
                          <p className="text-xs text-muted-foreground">
                            Next scheduled refresh:{" "}
                            {formatDateTime(retailer.nextRefreshAt)}
                          </p>
                        ) : null}
                      </div>

                      {run ? (
                        <div className="grid gap-2 rounded-lg border p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={RUN_STATUS_VARIANT[run.status]}>
                              {run.status}
                            </Badge>
                            <span className="text-sm">
                              {run.mode === "INITIAL"
                                ? "Initial discovery"
                                : "Full refresh"}{" "}
                              · {run.trigger.toLowerCase()}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {run.finishedAt
                                ? `finished ${formatDistanceToNow(
                                    run.finishedAt,
                                  )} ago`
                                : run.startedAt
                                  ? `started ${formatDistanceToNow(
                                      run.startedAt,
                                    )} ago`
                                  : `queued ${formatDistanceToNow(
                                      run.createdAt,
                                    )} ago`}
                            </span>
                          </div>
                          {progress !== null ? (
                            <div className="grid gap-1">
                              <div className="h-2 overflow-hidden rounded-full bg-muted">
                                <div
                                  className="h-full rounded-full bg-primary transition-all"
                                  style={{ width: `${progress}%` }}
                                />
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {progress}% estimated ·{" "}
                                {run.itemsSeen.toLocaleString()} seen ·{" "}
                                {run.pagesProcessed.toLocaleString()} pages ·{" "}
                                {run.itemsCreated.toLocaleString()} created ·{" "}
                                {run.itemsUpdated.toLocaleString()} updated
                              </p>
                            </div>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              {run.itemsSeen.toLocaleString()} seen ·{" "}
                              {run.pagesProcessed.toLocaleString()} pages ·{" "}
                              {run.itemsCreated.toLocaleString()} created ·{" "}
                              {run.itemsUpdated.toLocaleString()} updated
                            </p>
                          )}
                          {run.itemsDelisted > 0 ? (
                            <p className="text-xs text-muted-foreground">
                              {run.itemsDelisted.toLocaleString()} products
                              delisted (history preserved)
                            </p>
                          ) : null}
                          {run.error ? (
                            <p className="text-xs text-destructive">
                              {run.error}
                            </p>
                          ) : null}
                          {run.resumable ? (
                            <p className="text-xs text-muted-foreground">
                              This failed run can continue from its saved
                              cursor.
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          No discovery run yet. Start an initial discovery to
                          import this retailer&apos;s catalogue.
                        </p>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
