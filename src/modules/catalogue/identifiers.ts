/**
 * Identifier normalisation for canonical-product matching.
 *
 * Matching is intentionally conservative: only a valid GTIN or a
 * normalised brand + manufacturer part number can join an existing
 * canonical product. No title or fuzzy matching is performed.
 */

const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

function hasValidGtinCheckDigit(digits: string): boolean {
  const body = digits.slice(0, -1);
  let sum = 0;

  // Work from the rightmost body digit, alternating weights 3 and 1.
  for (let i = 0; i < body.length; i += 1) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }

  const expected = (10 - (sum % 10)) % 10;
  return expected === Number(digits[digits.length - 1]);
}

/**
 * Return valid GTIN-8/12/13/14 digits, or null when the value is absent
 * or fails validation. Invalid identifiers are ignored rather than
 * rejected so a single bad adapter field cannot block monitoring.
 */
export function normalizeGtin(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const digits = value.replace(/\D/g, "");
  if (!GTIN_LENGTHS.has(digits.length)) {
    return null;
  }
  return hasValidGtinCheckDigit(digits) ? digits : null;
}

function normalizeIdentifier(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

/** Normalised brand key used with an MPN for canonical matching. */
export function normalizeBrandKey(
  value: string | null | undefined,
): string | null {
  return normalizeIdentifier(value);
}

/** Normalised manufacturer part number used for canonical matching. */
export function normalizeMpnKey(
  value: string | null | undefined,
): string | null {
  return normalizeIdentifier(value);
}
