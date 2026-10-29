"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { AvailabilityBadge } from "@/components/availability-badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { formatMinor } from "@/lib/money";

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
}

export function AddInventoryForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, startPreview] = useTransition();
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
    });
  }

  function save() {
    setSaveError(null);
    startSaving(async () => {
      const response = await fetch("/api/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = (await response.json()) as {
        inventoryItem?: { id: string };
        created?: boolean;
        error?: string;
      };
      if (!response.ok || !data.inventoryItem) {
        setSaveError(data.error ?? "Could not add the product to inventory.");
        return;
      }
      toast.success(
        data.created
          ? "Product added to your inventory"
          : "Product is already in your inventory",
      );
      router.push(`/inventory/${data.inventoryItem.id}`);
      router.refresh();
    });
  }

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Product URL</CardTitle>
          <CardDescription>
            Paste a product URL from a supported retailer. We will fetch its
            current price and stock.
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
          {previewError && (
            <p className="text-sm text-destructive">{previewError}</p>
          )}
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
          <CardContent>
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
                  {formatMinor(
                    preview.product.priceMinor,
                    preview.product.currency,
                    "en-GB",
                  )}
                </div>
                <AvailabilityBadge
                  availability={preview.product.availability}
                />
              </div>
            </div>
            {saveError && (
              <p className="mt-4 text-sm text-destructive">{saveError}</p>
            )}
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
            <Button onClick={save} disabled={saving}>
              {saving ? "Adding…" : "Add to inventory"}
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
