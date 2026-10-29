"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { AvailabilityBadge } from "@/components/availability-badge";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMinor } from "@/lib/money";
import { formatDistanceToNow } from "@/lib/time";
import type {
  CatalogueBrowseFilters,
  CatalogueBrowseResult,
  CatalogueFilterOptions,
  CatalogueListingRow,
  CatalogueRetailerSummary,
} from "@/modules/catalogue/browse.repository";

interface CatalogueBrowserProps {
  retailers: Array<
    Pick<
      CatalogueRetailerSummary,
      "id" | "name" | "productCount" | "inStockCount" | "supportsCatalogue"
    >
  >;
  selectedRetailer: CatalogueRetailerSummary;
  filters: CatalogueBrowseFilters;
  options: CatalogueFilterOptions;
  result: CatalogueBrowseResult;
}

type QueryOverrides = Record<string, string | null | undefined>;

const DEFAULT_PAGE_SIZE = 24;

function browseHref(
  retailerId: string,
  filters: CatalogueBrowseFilters,
  overrides: QueryOverrides = {},
): string {
  const params = new URLSearchParams();
  const values: Record<string, string | null | undefined> = {
    retailer: retailerId,
    q: filters.q,
    category: filters.category,
    brand: filters.brand,
    minPrice:
      filters.minPriceMinor !== null && filters.minPriceMinor !== undefined
        ? (filters.minPriceMinor / 100).toFixed(2)
        : undefined,
    maxPrice:
      filters.maxPriceMinor !== null && filters.maxPriceMinor !== undefined
        ? (filters.maxPriceMinor / 100).toFixed(2)
        : undefined,
    stock: filters.stock && filters.stock !== "all" ? filters.stock : undefined,
    sort:
      filters.sort && filters.sort !== "relevance" ? filters.sort : undefined,
    page: (filters.page ?? 1) > 1 ? String(filters.page) : undefined,
    pageSize:
      (filters.pageSize ?? DEFAULT_PAGE_SIZE) !== DEFAULT_PAGE_SIZE
        ? String(filters.pageSize)
        : undefined,
    ...overrides,
  };

  for (const [key, value] of Object.entries(values)) {
    if (value !== null && value !== undefined && value !== "") {
      params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `/catalogue?${query}` : "/catalogue";
}

function formatDiscount(discountPct: number | null): string | null {
  if (discountPct === null || discountPct <= 0) {
    return null;
  }
  return `−${discountPct}%`;
}

export function CatalogueBrowser({
  retailers,
  selectedRetailer,
  filters,
  options,
  result,
}: CatalogueBrowserProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [action, setAction] = useState<"inventory" | "monitor" | null>(null);

  const selectableIds = result.items.map((item) => item.id);
  const allSelected =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selected.has(id));

  function toggleAll() {
    setSelected((current) => {
      if (selectableIds.every((id) => current.has(id))) {
        return new Set();
      }
      return new Set(selectableIds);
    });
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function navigate(href: string) {
    startTransition(() => {
      router.push(href);
    });
  }

  async function bulkInventory() {
    const listingIds = [...selected];
    if (listingIds.length === 0) {
      return;
    }
    setAction("inventory");
    try {
      const response = await fetch("/api/catalogue/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingIds }),
      });
      const data = (await response.json()) as {
        addedProducts?: number;
        alreadyTrackedProducts?: number;
        error?: string;
      };
      if (!response.ok) {
        toast.error(data.error ?? "Could not save the selected products");
        return;
      }
      const added = data.addedProducts ?? 0;
      const already = data.alreadyTrackedProducts ?? 0;
      toast.success(
        added > 0
          ? `${added} product${added === 1 ? "" : "s"} saved to inventory`
          : "Selected products are already in your inventory",
        already > 0 && added > 0
          ? { description: `${already} already tracked` }
          : undefined,
      );
      setSelected(new Set());
      router.refresh();
    } catch {
      toast.error("Could not save the selected products");
    } finally {
      setAction(null);
    }
  }

  async function bulkMonitor() {
    const listingIds = [...selected];
    if (listingIds.length === 0) {
      return;
    }
    setAction("monitor");
    try {
      const response = await fetch("/api/catalogue/monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingIds }),
      });
      const data = (await response.json()) as {
        added?: number;
        resumed?: number;
        skipped?: number;
        failed?: Array<{ listingId: string; message: string }>;
        error?: string;
      };
      if (!response.ok) {
        toast.error(data.error ?? "Could not start monitoring");
        return;
      }
      const started = (data.added ?? 0) + (data.resumed ?? 0);
      if (started > 0) {
        toast.success(
          `${started} product${started === 1 ? "" : "s"} now monitoring`,
          data.skipped
            ? { description: `${data.skipped} already monitored` }
            : undefined,
        );
      } else {
        toast.info("Selected products are already monitored");
      }
      if (data.failed && data.failed.length > 0) {
        toast.error(
          `${data.failed.length} could not be monitored`,
          { description: data.failed[0]?.message },
        );
      }
      setSelected(new Set());
      router.refresh();
    } catch {
      toast.error("Could not start monitoring the selected products");
    } finally {
      setAction(null);
    }
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Catalogue</h1>
          <p className="text-sm text-muted-foreground">
            Search {selectedRetailer.name}&apos;s full catalogue and inspect
            continuous price history before adding anything to monitoring.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/retailers">Manage retailers</Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {retailers.map((retailer) => {
          const active = retailer.id === selectedRetailer.id;
          return (
            <Button
              key={retailer.id}
              asChild
              variant={active ? "default" : "outline"}
              size="sm"
            >
              <Link
                href={browseHref(retailer.id, filters, {
                  category: null,
                  brand: null,
                  minPrice: null,
                  maxPrice: null,
                  stock: null,
                  sort: null,
                  page: null,
                })}
              >
                {retailer.name}
                <Badge
                  variant={active ? "secondary" : "outline"}
                  className="ml-1"
                >
                  {retailer.productCount.toLocaleString()}
                </Badge>
              </Link>
            </Button>
          );
        })}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
          <CardDescription>
            Search by name, SKU, GTIN, or brand. All catalogue products keep
            collecting history even when you do not monitor them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            key={`${filters.q ?? ""}:${filters.minPriceMinor ?? ""}:${filters.maxPriceMinor ?? ""}`}
            className="grid gap-3 lg:grid-cols-12"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const q = String(form.get("q") ?? "").trim();
              const minPrice = String(form.get("minPrice") ?? "").trim();
              const maxPrice = String(form.get("maxPrice") ?? "").trim();
              navigate(
                browseHref(selectedRetailer.id, filters, {
                  q: q || null,
                  minPrice: minPrice || null,
                  maxPrice: maxPrice || null,
                  page: null,
                }),
              );
            }}
          >
            <div className="grid gap-1.5 lg:col-span-4">
              <Label htmlFor="catalogue-search">Search</Label>
              <Input
                id="catalogue-search"
                name="q"
                placeholder="Name, SKU, GTIN, or brand"
                defaultValue={filters.q ?? ""}
              />
            </div>
            <div className="grid gap-1.5 lg:col-span-2">
              <Label htmlFor="catalogue-min-price">Min price (£)</Label>
              <Input
                id="catalogue-min-price"
                name="minPrice"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                defaultValue={
                  filters.minPriceMinor !== null &&
                  filters.minPriceMinor !== undefined
                    ? (filters.minPriceMinor / 100).toFixed(2)
                    : ""
                }
              />
            </div>
            <div className="grid gap-1.5 lg:col-span-2">
              <Label htmlFor="catalogue-max-price">Max price (£)</Label>
              <Input
                id="catalogue-max-price"
                name="maxPrice"
                type="number"
                min="0"
                step="0.01"
                placeholder="Any"
                defaultValue={
                  filters.maxPriceMinor !== null &&
                  filters.maxPriceMinor !== undefined
                    ? (filters.maxPriceMinor / 100).toFixed(2)
                    : ""
                }
              />
            </div>
            <div className="flex items-end gap-2 lg:col-span-4">
              <Button type="submit" disabled={pending}>
                {pending ? "Applying…" : "Apply search"}
              </Button>
              <Button asChild variant="ghost">
                <Link
                  href={browseHref(selectedRetailer.id, filters, {
                    q: null,
                    category: null,
                    brand: null,
                    minPrice: null,
                    maxPrice: null,
                    stock: null,
                    sort: null,
                    page: null,
                  })}
                >
                  Clear all
                </Link>
              </Button>
            </div>

            <div className="grid gap-1.5 lg:col-span-3">
              <Label>Category</Label>
              <Select
                value={filters.category ?? "all"}
                onValueChange={(value) =>
                  navigate(
                    browseHref(selectedRetailer.id, filters, {
                      category: value === "all" ? null : value,
                      page: null,
                    }),
                  )
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {options.categories.map((category) => (
                    <SelectItem key={category} value={category}>
                      {category}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 lg:col-span-3">
              <Label>Brand</Label>
              <Select
                value={filters.brand ?? "all"}
                onValueChange={(value) =>
                  navigate(
                    browseHref(selectedRetailer.id, filters, {
                      brand: value === "all" ? null : value,
                      page: null,
                    }),
                  )
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All brands" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All brands</SelectItem>
                  {options.brands.map((brand) => (
                    <SelectItem key={brand} value={brand}>
                      {brand}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 lg:col-span-2">
              <Label>Stock</Label>
              <Select
                value={filters.stock ?? "all"}
                onValueChange={(value) =>
                  navigate(
                    browseHref(selectedRetailer.id, filters, {
                      stock: value === "all" ? null : value,
                      page: null,
                    }),
                  )
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All stock</SelectItem>
                  <SelectItem value="in">In stock</SelectItem>
                  <SelectItem value="out">Out of stock</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 lg:col-span-2">
              <Label>Sort</Label>
              <Select
                value={filters.sort ?? "relevance"}
                onValueChange={(value) =>
                  navigate(
                    browseHref(selectedRetailer.id, filters, {
                      sort: value === "relevance" ? null : value,
                      page: null,
                    }),
                  )
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="relevance">Name</SelectItem>
                  <SelectItem value="price_asc">Price: low to high</SelectItem>
                  <SelectItem value="price_desc">Price: high to low</SelectItem>
                  <SelectItem value="discount_desc">Biggest discount</SelectItem>
                  <SelectItem value="recent">Recently discovered</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 lg:col-span-2">
              <Label>Page size</Label>
              <Select
                value={String(filters.pageSize ?? DEFAULT_PAGE_SIZE)}
                onValueChange={(value) =>
                  navigate(
                    browseHref(selectedRetailer.id, filters, {
                      pageSize:
                        value === String(DEFAULT_PAGE_SIZE) ? null : value,
                      page: null,
                    }),
                  )
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="24">24</SelectItem>
                  <SelectItem value="48">48</SelectItem>
                  <SelectItem value="96">96</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-3 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {result.total.toLocaleString()} product
              {result.total === 1 ? "" : "s"} found
              {selected.size > 0 ? ` · ${selected.size} selected` : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={selected.size === 0 || action !== null}
                onClick={bulkInventory}
              >
                {action === "inventory" ? "Saving…" : "Save to inventory"}
              </Button>
              <Button
                size="sm"
                disabled={selected.size === 0 || action !== null}
                onClick={bulkMonitor}
              >
                {action === "monitor" ? "Starting…" : "Add to monitoring"}
              </Button>
            </div>
          </div>
          <p className="-mt-1 text-xs text-muted-foreground">
            Bulk monitoring starts back-in-stock checks every 15 minutes. Open a
            product to configure price-drop alerts.
          </p>

          {result.items.length === 0 ? (
            <div className="rounded-lg border border-dashed p-10 text-center">
              <h3 className="font-medium">No matching products</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {selectedRetailer.productCount === 0
                  ? "This retailer's catalogue has not been imported yet."
                  : "Try a different search or clear the filters."}
              </p>
              <div className="mt-4 flex justify-center gap-2">
                {selectedRetailer.productCount === 0 &&
                selectedRetailer.supportsCatalogue ? (
                  <Button asChild size="sm">
                    <Link href="/retailers">Start discovery</Link>
                  </Button>
                ) : null}
                <Button asChild size="sm" variant="outline">
                  <Link
                    href={browseHref(selectedRetailer.id, filters, {
                      q: null,
                      category: null,
                      brand: null,
                      minPrice: null,
                      maxPrice: null,
                      stock: null,
                      sort: null,
                      page: null,
                    })}
                  >
                    Clear filters
                  </Link>
                </Button>
              </div>
            </div>
          ) : (
            <>
              <CatalogueTable
                items={result.items}
                selected={selected}
                allSelected={allSelected}
                onToggleAll={toggleAll}
                onToggle={toggle}
              />
              <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
                <p className="text-xs text-muted-foreground">
                  Showing{" "}
                  {(result.page - 1) * result.pageSize + 1}–
                  {Math.min(result.page * result.pageSize, result.total)} of{" "}
                  {result.total.toLocaleString()}
                </p>
                <div className="flex items-center gap-2">
                  {result.page <= 1 ? (
                    <Button variant="outline" size="sm" disabled>
                      Previous
                    </Button>
                  ) : (
                    <Button asChild variant="outline" size="sm">
                      <Link
                        href={browseHref(selectedRetailer.id, filters, {
                          page:
                            result.page <= 2 ? null : String(result.page - 1),
                        })}
                      >
                        Previous
                      </Link>
                    </Button>
                  )}
                  <span className="text-xs text-muted-foreground">
                    Page {result.page} of {result.totalPages}
                  </span>
                  {result.page >= result.totalPages ? (
                    <Button variant="outline" size="sm" disabled>
                      Next
                    </Button>
                  ) : (
                    <Button asChild variant="outline" size="sm">
                      <Link
                        href={browseHref(selectedRetailer.id, filters, {
                          page: String(result.page + 1),
                        })}
                      >
                        Next
                      </Link>
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function CatalogueTable({
  items,
  selected,
  allSelected,
  onToggleAll,
  onToggle,
}: {
  items: CatalogueListingRow[];
  selected: Set<string>;
  allSelected: boolean;
  onToggleAll: () => void;
  onToggle: (id: string) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <input
              type="checkbox"
              aria-label="Select all products on this page"
              checked={allSelected}
              onChange={onToggleAll}
              className="size-4 accent-primary"
            />
          </TableHead>
          <TableHead>Product</TableHead>
          <TableHead className="hidden md:table-cell">Category</TableHead>
          <TableHead>Price</TableHead>
          <TableHead>Stock</TableHead>
          <TableHead className="hidden lg:table-cell">Checked</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          const discount = formatDiscount(item.currentDiscountPct);
          return (
            <TableRow key={item.id}>
              <TableCell>
                <input
                  type="checkbox"
                  aria-label={`Select ${item.name}`}
                  checked={selected.has(item.id)}
                  onChange={() => onToggle(item.id)}
                  className="size-4 accent-primary"
                />
              </TableCell>
              <TableCell className="min-w-56">
                <div className="flex items-start gap-3">
                  {item.imageUrl ? (
                    <div className="h-11 w-11 shrink-0 overflow-hidden rounded-md bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element -- external retailer image */}
                      <img
                        src={item.imageUrl}
                        alt=""
                        className="h-full w-full object-cover"
                        referrerPolicy="no-referrer"
                      />
                    </div>
                  ) : (
                    <div className="h-11 w-11 shrink-0 rounded-md bg-muted" />
                  )}
                  <div className="min-w-0">
                    <Link
                      href={`/catalogue/${item.id}`}
                      className="line-clamp-2 font-medium hover:underline"
                    >
                      {item.name}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                      {item.brand ? <span>{item.brand}</span> : null}
                      {item.sku ? <span>SKU {item.sku}</span> : null}
                    </div>
                  </div>
                </div>
              </TableCell>
              <TableCell className="hidden max-w-40 md:table-cell">
                <span className="line-clamp-2 text-sm text-muted-foreground">
                  {item.category ?? "—"}
                </span>
              </TableCell>
              <TableCell>
                <div className="font-medium tabular-nums">
                  {formatMinor(item.currentPriceMinor, item.currency, "en-GB")}
                </div>
                <div className="flex items-center gap-1.5">
                  {item.currentOriginalPriceMinor !== null &&
                  item.currentPriceMinor !== null &&
                  item.currentOriginalPriceMinor > item.currentPriceMinor ? (
                    <span className="text-xs text-muted-foreground line-through">
                      {formatMinor(
                        item.currentOriginalPriceMinor,
                        item.currency,
                        "en-GB",
                      )}
                    </span>
                  ) : null}
                  {discount ? (
                    <Badge variant="destructive" className="text-[10px]">
                      {discount}
                    </Badge>
                  ) : null}
                </div>
              </TableCell>
              <TableCell>
                <AvailabilityBadge availability={item.currentAvailability} />
              </TableCell>
              <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                {item.lastCheckedAt
                  ? `${formatDistanceToNow(item.lastCheckedAt)} ago`
                  : "—"}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {item.subscriptionStatus === "ACTIVE" ? (
                    <Badge variant="secondary">Monitoring</Badge>
                  ) : null}
                  {item.subscriptionStatus === "PAUSED" ? (
                    <Badge variant="outline">Paused</Badge>
                  ) : null}
                  {item.subscriptionStatus === "ARCHIVED" ? (
                    <Badge variant="outline">Archived</Badge>
                  ) : null}
                  {item.inInventory ? (
                    <Badge variant="outline">Inventory</Badge>
                  ) : null}
                  {!item.subscriptionStatus && !item.inInventory ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
