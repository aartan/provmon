import { describe, expect, it } from "vitest";

import {
  normalizeBrandKey,
  normalizeGtin,
  normalizeMpnKey,
} from "@/modules/catalogue/identifiers";

describe("normalizeGtin", () => {
  it("accepts valid GTIN-8, GTIN-12 and GTIN-13 values", () => {
    expect(normalizeGtin("96385074")).toBe("96385074");
    expect(normalizeGtin("036000291452")).toBe("036000291452");
    expect(normalizeGtin("4006381333931")).toBe("4006381333931");
  });

  it("strips formatting before validating", () => {
    expect(normalizeGtin("4006381 333931")).toBe("4006381333931");
  });

  it("rejects invalid check digits and unsupported lengths", () => {
    expect(normalizeGtin("4006381333932")).toBeNull();
    expect(normalizeGtin("12345")).toBeNull();
    expect(normalizeGtin("")).toBeNull();
    expect(normalizeGtin(undefined)).toBeNull();
  });

  it("rejects non-numeric values with the right digit count", () => {
    expect(normalizeGtin("gtin-4006381333931")).toBe("4006381333931");
    expect(normalizeGtin("abcdefghijklm")).toBeNull();
  });
});

describe("identifier normalisation", () => {
  it("normalises brand and MPN keys consistently", () => {
    expect(normalizeBrandKey("Apple Inc.")).toBe("APPLEINC");
    expect(normalizeBrandKey("  apple   inc ")).toBe("APPLEINC");
    expect(normalizeMpnKey("a2141")).toBe("A2141");
    expect(normalizeMpnKey("A-2141")).toBe("A2141");
  });

  it("returns null for empty values", () => {
    expect(normalizeBrandKey("")).toBeNull();
    expect(normalizeBrandKey("!!!")).toBeNull();
    expect(normalizeMpnKey(undefined)).toBeNull();
  });
});
