import {
  CATALOGUE_SORTS,
  CATALOGUE_STOCK_FILTERS,
  type CatalogueBrowseFilters,
  type CatalogueSort,
  type CatalogueStockFilter,
} from "@/modules/catalogue/browse.repository";

export type SearchParamValue = string | string[] | undefined;

export function firstSearchParam(
  value: SearchParamValue,
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function parseDecimalToMinor(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.round(parsed * 100);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Parse browse filters from URL/search params. Invalid optional filters are
 * ignored rather than turning a bookmarked URL into an error page.
 */
export function parseCatalogueFilters(
  params: Record<string, SearchParamValue>,
  retailerId: string,
): CatalogueBrowseFilters {
  const q = firstSearchParam(params.q)?.trim().slice(0, 200) || undefined;
  const category = firstSearchParam(params.category)?.trim() || undefined;
  const brand = firstSearchParam(params.brand)?.trim() || undefined;

  let minPriceMinor = parseDecimalToMinor(firstSearchParam(params.minPrice));
  let maxPriceMinor = parseDecimalToMinor(firstSearchParam(params.maxPrice));
  if (
    minPriceMinor !== null &&
    maxPriceMinor !== null &&
    minPriceMinor > maxPriceMinor
  ) {
    [minPriceMinor, maxPriceMinor] = [maxPriceMinor, minPriceMinor];
  }

  const stockParam = firstSearchParam(params.stock);
  const stock: CatalogueStockFilter = (
    CATALOGUE_STOCK_FILTERS as readonly string[]
  ).includes(stockParam ?? "")
    ? (stockParam as CatalogueStockFilter)
    : "all";

  const sortParam = firstSearchParam(params.sort);
  const sort: CatalogueSort = (
    CATALOGUE_SORTS as readonly string[]
  ).includes(sortParam ?? "")
    ? (sortParam as CatalogueSort)
    : "relevance";

  return {
    retailerId,
    q,
    category,
    brand,
    minPriceMinor,
    maxPriceMinor,
    stock,
    sort,
    page: parsePositiveInt(firstSearchParam(params.page), 1),
    pageSize: Math.min(
      100,
      Math.max(12, parsePositiveInt(firstSearchParam(params.pageSize), 24)),
    ),
  };
}
