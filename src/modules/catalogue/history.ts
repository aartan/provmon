/**
 * Catalogue history chart ranges.
 *
 * "all" intentionally has no cutoff. The repository still caps the number
 * of rendered points, but statistics are computed over the full history.
 */

export const CATALOGUE_HISTORY_RANGES = [
  "7d",
  "30d",
  "90d",
  "180d",
  "1y",
  "all",
] as const;

export type CatalogueHistoryRange = (typeof CATALOGUE_HISTORY_RANGES)[number];

export const CATALOGUE_HISTORY_RANGE_LABELS: Record<
  CatalogueHistoryRange,
  string
> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  "180d": "6 months",
  "1y": "1 year",
  all: "All time",
};

const RANGE_DAYS: Record<Exclude<CatalogueHistoryRange, "all">, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "1y": 365,
};

const MS_PER_DAY = 86_400_000;

export function isCatalogueHistoryRange(
  value: string | null | undefined,
): value is CatalogueHistoryRange {
  return (
    value !== null &&
    value !== undefined &&
    (CATALOGUE_HISTORY_RANGES as readonly string[]).includes(value)
  );
}

export function catalogueHistoryCutoff(
  range: CatalogueHistoryRange,
  now: Date = new Date(),
): Date | null {
  if (range === "all") {
    return null;
  }
  return new Date(now.getTime() - RANGE_DAYS[range] * MS_PER_DAY);
}

export { catalogueHistoryCutoff as rangeCutoff };
