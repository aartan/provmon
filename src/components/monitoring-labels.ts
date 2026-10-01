import type { MonitoringCondition } from "@/modules/monitoring/types";

export const CONDITION_LABELS: Record<MonitoringCondition, string> = {
  BACK_IN_STOCK: "Back in stock",
  PRICE_DROP: "Price drop",
  BOTH: "Back in stock + price",
};

export const CONDITION_DESCRIPTIONS: Record<MonitoringCondition, string> = {
  BACK_IN_STOCK: "Email me when this product becomes available again, regardless of price.",
  PRICE_DROP: "Email me when the product is available at or below my target price.",
  BOTH: "Email me only when it comes back in stock and meets my target price.",
};

export function formatInterval(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  if (minutes < 1440) {
    return `${minutes / 60} h`;
  }
  return `${minutes / 1440} day${minutes > 1440 ? "s" : ""}`;
}
