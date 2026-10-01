"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { AvailabilityBadge } from "@/components/availability-badge";
import {
  CONDITION_DESCRIPTIONS,
  CONDITION_LABELS,
  formatInterval,
} from "@/components/monitoring-labels";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
import { Skeleton } from "@/components/ui/skeleton";
import { formatMinor } from "@/lib/money";
import type { MonitoringCondition } from "@/modules/monitoring/types";

interface PreviewProduct {
  retailerProductId: string | null;
  name: string;
  url: string;
  imageUrl: string | null;
  currency: string;
  priceMinor: number | null;
  availability: "IN_STOCK" | "OUT_OF_STOCK" | "PREORDER" | "UNKNOWN";
}

interface Preview {
  retailer: { id: string; name: string };
  product: PreviewProduct;
  intervalOptions: number[];
}

const CONDITIONS: MonitoringCondition[] = ["BACK_IN_STOCK", "PRICE_DROP", "BOTH"];

export function AddProductForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, startPreview] = useTransition();

  const [condition, setCondition] = useState<MonitoringCondition>("BACK_IN_STOCK");
  const [targetPrice, setTargetPrice] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState<string>("");
  const [saving, startSaving] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);

  function previewProduct() {
    setPreviewError(null);
    setPreview(null);
    startPreview(async () => {
      const response = await fetch("/api/products/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await response.json()) as Preview & { error?: string };
      if (!response.ok || !data.product) {
        setPreviewError(data.error ?? "Could not load the product.");
        return;
      }
      setPreview(data);
      setIntervalMinutes(String(data.intervalOptions[0] ?? ""));
      setCondition("BACK_IN_STOCK");
      setTargetPrice("");
    });
  }

  function save() {
    setSaveError(null);
    startSaving(async () => {
      const response = await fetch("/api/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          targetPrice,
          condition,
          intervalMinutes,
        }),
      });
      const data = (await response.json()) as {
        subscription?: { id: string };
        error?: string;
      };
      if (!response.ok || !data.subscription) {
        setSaveError(data.error ?? "Could not save the subscription.");
        return;
      }
      toast.success("Product added — monitoring started");
      router.push(`/products/${data.subscription.id}`);
      router.refresh();
    });
  }

  const needsTarget = condition === "PRICE_DROP" || condition === "BOTH";
  const targetValid = !needsTarget || (targetPrice !== "" && Number(targetPrice) > 0);

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Product URL</CardTitle>
          <CardDescription>
            Supported retailers: mock-retailer.test (demo). More retailers are
            added over time.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder="https://mock-retailer.test/products/in-stock"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && url.trim()) {
                  previewProduct();
                }
              }}
              disabled={loadingPreview}
            />
            <Button
              onClick={previewProduct}
              disabled={loadingPreview || !url.trim()}
            >
              {loadingPreview ? "Loading…" : "Preview"}
            </Button>
          </div>
          {previewError && <p className="text-sm text-destructive">{previewError}</p>}
        </CardContent>
      </Card>

      {loadingPreview && (
        <Card>
          <CardContent className="grid gap-3 pt-6">
            <Skeleton className="h-10 w-10 rounded-md" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </CardContent>
        </Card>
      )}

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>{preview.product.name}</CardTitle>
            <CardDescription className="capitalize">
              {preview.retailer.name}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <div className="flex items-start gap-4">
              {preview.product.imageUrl ? (
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element -- external retailer image */}
                  <img
                    src={preview.product.imageUrl}
                    alt={preview.product.name}
                    className="h-full w-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                </div>
              ) : null}
              <div className="grid gap-1">
                <div className="text-lg font-semibold tabular-nums">
                  {formatMinor(preview.product.priceMinor, preview.product.currency, "en-GB")}
                </div>
                <AvailabilityBadge availability={preview.product.availability} />
              </div>
            </div>

            <div className="grid gap-4">
              <div>
                <Label>Notify me when…</Label>
                <div className="mt-2 grid gap-2">
                  {CONDITIONS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setCondition(option)}
                      className={`rounded-lg border p-3 text-left text-sm transition-colors ${
                        condition === option
                          ? "border-primary bg-primary/5"
                          : "hover:bg-muted"
                      }`}
                    >
                      <span className="font-medium">{CONDITION_LABELS[option]}</span>
                      <span className="mt-0.5 block text-muted-foreground">
                        {CONDITION_DESCRIPTIONS[option]}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="targetPrice">
                    Target price {needsTarget ? "" : "(optional)"}
                  </Label>
                  <Input
                    id="targetPrice"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder={`0.00 ${preview.product.currency}`}
                    value={targetPrice}
                    onChange={(event) => setTargetPrice(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {needsTarget
                      ? "Required for this condition."
                      : "Optional for this condition — stored for reference."}
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="interval">Check every</Label>
                  <Select value={intervalMinutes} onValueChange={setIntervalMinutes}>
                    <SelectTrigger id="interval">
                      <SelectValue placeholder="Select interval" />
                    </SelectTrigger>
                    <SelectContent>
                      {preview.intervalOptions.map((minutes) => (
                        <SelectItem key={minutes} value={String(minutes)}>
                          {formatInterval(minutes)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            {saveError && <p className="text-sm text-destructive">{saveError}</p>}
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setPreview(null);
                setPreviewError(null);
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={saving || !targetValid || !intervalMinutes}
            >
              {saving ? "Saving…" : "Start monitoring"}
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
