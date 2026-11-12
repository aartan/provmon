import { describe, expect, it } from "vitest";

import {
  decimalToMinor,
  formatMinor,
  MAX_PRICE_MINOR,
  minorToDecimal,
  parsePriceToMinor,
  safePriceMinor,
} from "@/lib/money";

describe("decimalToMinor", () => {
  it("converts decimal currency amounts to integer minor units", () => {
    expect(decimalToMinor(299.99)).toBe(29999);
    expect(decimalToMinor(0.05)).toBe(5);
    expect(decimalToMinor(2500)).toBe(250000);
  });

  it("rounds to the nearest minor unit", () => {
    expect(decimalToMinor(1.005)).toBe(101);
    expect(decimalToMinor(1.004)).toBe(100);
  });

  it("rejects non-finite values", () => {
    expect(() => decimalToMinor(Number.NaN)).toThrow();
    expect(() => decimalToMinor(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("minorToDecimal", () => {
  it("returns null for missing amounts", () => {
    expect(minorToDecimal(null)).toBeNull();
    expect(minorToDecimal(undefined)).toBeNull();
  });

  it("converts minor units back to decimal", () => {
    expect(minorToDecimal(29999)).toBe(299.99);
    expect(minorToDecimal(5)).toBe(0.05);
  });
});

describe("parsePriceToMinor", () => {
  it("parses plain decimal strings", () => {
    expect(parsePriceToMinor("299.99")).toBe(29999);
    expect(parsePriceToMinor("3499.99")).toBe(349999);
  });

  it("parses strings with currency symbols", () => {
    expect(parsePriceToMinor("£299.99")).toBe(29999);
    expect(parsePriceToMinor("$1,234.56")).toBe(123456);
  });

  it("trims whitespace", () => {
    expect(parsePriceToMinor("  199.99 ")).toBe(19999);
  });

  it("parses numeric input", () => {
    expect(parsePriceToMinor(299.99)).toBe(29999);
  });

  it("returns null for missing or unparseable input", () => {
    expect(parsePriceToMinor(null)).toBeNull();
    expect(parsePriceToMinor(undefined)).toBeNull();
    expect(parsePriceToMinor("")).toBeNull();
    expect(parsePriceToMinor("no price")).toBeNull();
  });

  it("returns null for negative amounts", () => {
    expect(parsePriceToMinor("-5.00")).toBeNull();
  });

  it("rejects retailer missing-price sentinels", () => {
    expect(parsePriceToMinor("999999999900")).toBeNull();
  });

  it("rejects prices above the storable catalogue limit", () => {
    expect(parsePriceToMinor(MAX_PRICE_MINOR / 100)).toBe(MAX_PRICE_MINOR);
    expect(parsePriceToMinor(MAX_PRICE_MINOR / 100 + 0.01)).toBeNull();
  });
});

describe("safePriceMinor", () => {
  it("accepts valid integer minor amounts", () => {
    expect(safePriceMinor(0)).toBe(0);
    expect(safePriceMinor(29999)).toBe(29999);
    expect(safePriceMinor(MAX_PRICE_MINOR)).toBe(MAX_PRICE_MINOR);
  });

  it("rejects missing, negative, fractional, and out-of-range values", () => {
    expect(safePriceMinor(null)).toBeNull();
    expect(safePriceMinor(undefined)).toBeNull();
    expect(safePriceMinor(-1)).toBeNull();
    expect(safePriceMinor(1.5)).toBeNull();
    expect(safePriceMinor(MAX_PRICE_MINOR + 1)).toBeNull();
    expect(safePriceMinor(99_999_999_990_000)).toBeNull();
  });
});

describe("formatMinor", () => {
  it("formats minor units with the currency symbol", () => {
    expect(formatMinor(29999, "GBP")).toBe("£299.99");
    expect(formatMinor(29999, "GBP", "en-GB")).toBe("£299.99");
  });

  it("renders a placeholder for missing amounts", () => {
    expect(formatMinor(null, "GBP")).toBe("—");
  });

  it("renders unknown currency codes literally", () => {
    // Intl does not throw for unrecognized codes; it renders them as-is.
    expect(formatMinor(29999, "ZZZ")).toContain("299.99");
  });
});
