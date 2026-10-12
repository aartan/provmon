"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
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
import { Input } from "@/components/ui/input";
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
import type { ProductRow } from "@/app/(app)/products/page";

function ProductImage({
  src,
  name,
}: {
  src: string | null;
  name: string;
}) {
  if (!src) {
    return (
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">
        {name.slice(0, 2).toUpperCase()}
      </div>
    );
  }
  return (
    <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md bg-muted">
      {/* eslint-disable-next-line @next/next/no-img-element -- external retailer images */}
      <img
        src={src}
        alt={name}
        className="h-full w-full object-cover"
        referrerPolicy="no-referrer"
      />
    </div>
  );
}

const AVAILABILITY_FILTERS = [
  { value: "ALL", label: "All statuses" },
  { value: "IN_STOCK", label: "In stock" },
  { value: "OUT_OF_STOCK", label: "Out of stock" },
  { value: "PREORDER", label: "Preorder" },
  { value: "UNKNOWN", label: "Unknown" },
] as const;

export function ProductsTable({ rows }: { rows: ProductRow[] }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<string>("ALL");
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter !== "ALL" && row.availability !== filter) {
        return false;
      }
      if (!query) {
        return true;
      }
      return (
        row.productName.toLowerCase().includes(query) ||
        row.retailerId.toLowerCase().includes(query)
      );
    });
  }, [rows, search, filter]);

  async function setStatus(id: string, status: "ACTIVE" | "PAUSED") {
    startTransition(async () => {
      const response = await fetch(`/api/subscriptions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (response.ok) {
        router.refresh();
        toast.success(status === "ACTIVE" ? "Monitoring resumed" : "Monitoring paused");
      } else {
        toast.error("Could not update the subscription");
      }
    });
  }

  async function remove(id: string, name: string) {
    startTransition(async () => {
      const response = await fetch(`/api/subscriptions/${id}`, { method: "DELETE" });
      if (response.ok) {
        router.refresh();
        toast.success(`Removed "${name}"`);
      } else {
        toast.error("Could not delete the subscription");
      }
    });
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          placeholder="Search by name or retailer…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="sm:max-w-xs"
        />
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AVAILABILITY_FILTERS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm text-muted-foreground">
            {rows.length === 0 ? (
              <>
                No products yet.{" "}
                <Link href="/products/add" className="underline underline-offset-4">
                  Add your first product
                </Link>
                .
              </>
            ) : (
              "No products match your search."
            )}
          </p>
        </div>
      ) : (
        <div className="min-w-0 rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Condition</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last checked</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      href={`/products/${row.id}`}
                      className="flex min-w-0 items-center gap-3"
                    >
                      <ProductImage src={row.imageUrl} name={row.productName} />
                      <div className="min-w-0">
                        <p className="truncate font-medium hover:underline">
                          {row.productName}
                        </p>
                        <p className="text-xs capitalize text-muted-foreground">
                          {row.retailerId} · every {formatInterval(row.intervalMinutes)}
                        </p>
                      </div>
                    </Link>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatMinor(row.currentPriceMinor, row.currency, "en-GB")}
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {row.targetPriceMinor !== null
                      ? formatMinor(row.targetPriceMinor, row.currency, "en-GB")
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{CONDITION_LABELS[row.condition]}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="grid gap-1">
                      <AvailabilityBadge availability={row.availability} />
                      {row.status === "PAUSED" && (
                        <span className="text-xs text-muted-foreground">Paused</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.lastCheckedAt
                      ? `${formatDistanceToNow(row.lastCheckedAt)} ago`
                      : "Never"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          setStatus(row.id, row.status === "ACTIVE" ? "PAUSED" : "ACTIVE")
                        }
                      >
                        {row.status === "ACTIVE" ? "Pause" : "Resume"}
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline" size="sm" disabled={pending}>
                            Delete
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Stop monitoring this product?</AlertDialogTitle>
                            <AlertDialogDescription>
                              “{row.productName}” and its history will be removed from
                              your account. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => remove(row.id, row.productName)}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
