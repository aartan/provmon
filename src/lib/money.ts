/**
 * Money helpers. All monetary amounts are stored and compared as integer
 * minor units (pence, cents) alongside an ISO 4217 currency code.
 * Floats are only used for display, never for comparisons.
 */

export function decimalToMinor(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot convert non-finite value to minor units: ${value}`);
  }
  // Number.EPSILON compensates for binary float representation so values
  // like 1.005 round up to 101 rather than down to 100.
  return Math.round((value + Number.EPSILON) * 100);
}

export function minorToDecimal(minor: number | null | undefined): number | null {
  if (minor === null || minor === undefined) {
    return null;
  }
  return minor / 100;
}

/**
 * Format a minor-unit amount for display using Intl.NumberFormat.
 * Falls back to a plain "12.34 GBP" rendering for unknown currency codes.
 */
export function formatMinor(
  minor: number | null | undefined,
  currency: string,
  locale?: string,
): string {
  if (minor === null || minor === undefined) {
    return "—";
  }
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * Parse a retailer-provided price string into minor units.
 * Accepts "299.99", "1,234.56", "£299.99", " 349.99 " etc.
 * Returns null when no number can be extracted.
 */
export function parsePriceToMinor(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const cleaned = String(value).trim().replace(/[^0-9.,-]/g, "");
  if (!cleaned) {
    return null;
  }
  // Thousands separators are ambiguous; treat commas as grouping and drop them.
  const normalized = cleaned.replace(/,/g, "");
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < 0) {
    return null;
  }
  return decimalToMinor(number);
}
