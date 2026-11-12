/**
 * Money helpers. All monetary amounts are stored and compared as integer
 * minor units (pence, cents) alongside an ISO 4217 currency code.
 *
 * Parsing and safety helpers live in the retailer plugin SDK so plugins and
 * core share the same rules; display helpers remain in the app.
 */

export {
  MAX_PRICE_MINOR,
  decimalToMinor,
  parsePriceToMinor,
  safePriceMinor,
} from "@provmon/retailer-plugin-sdk/money";

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
