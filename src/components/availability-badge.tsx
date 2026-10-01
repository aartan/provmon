import { Badge } from "@/components/ui/badge";
import type { AvailabilityStatus } from "@/modules/retailers/core/types";

const AVAILABILITY_CONFIG: Record<
  AvailabilityStatus,
  { label: string; className: string }
> = {
  IN_STOCK: { label: "In stock", className: "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400" },
  OUT_OF_STOCK: { label: "Out of stock", className: "border-red-600/30 bg-red-600/10 text-red-700 dark:text-red-400" },
  PREORDER: { label: "Preorder", className: "border-blue-600/30 bg-blue-600/10 text-blue-700 dark:text-blue-400" },
  UNKNOWN: { label: "Unknown", className: "border-zinc-500/30 bg-zinc-500/10 text-zinc-600 dark:text-zinc-400" },
};

export function AvailabilityBadge({ availability }: { availability: AvailabilityStatus }) {
  const config = AVAILABILITY_CONFIG[availability];
  return (
    <Badge variant="outline" className={config.className}>
      {config.label}
    </Badge>
  );
}

export const AVAILABILITY_LABELS: Record<AvailabilityStatus, string> = Object.fromEntries(
  Object.entries(AVAILABILITY_CONFIG).map(([key, value]) => [key, value.label]),
) as Record<AvailabilityStatus, string>;
