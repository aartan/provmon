import { describe, expect, it } from "vitest";

import { parseRetryAfterHeader } from "@/modules/retailers/core/retry-after";

describe("parseRetryAfterHeader", () => {
  it("parses seconds", () => {
    expect(parseRetryAfterHeader("120")).toBe(120_000);
    expect(parseRetryAfterHeader("0")).toBe(0);
    expect(parseRetryAfterHeader(" 2.5 ")).toBe(2_500);
  });

  it("parses HTTP dates relative to now", () => {
    const header = new Date(Date.now() + 5_000).toUTCString();
    const parsed = parseRetryAfterHeader(header);
    expect(parsed).toBeGreaterThan(3_000);
    expect(parsed).toBeLessThanOrEqual(5_000);
  });

  it("returns undefined for missing or invalid values", () => {
    expect(parseRetryAfterHeader(null)).toBeUndefined();
    expect(parseRetryAfterHeader(undefined)).toBeUndefined();
    expect(parseRetryAfterHeader("")).toBeUndefined();
    expect(parseRetryAfterHeader("not-a-date")).toBeUndefined();
    expect(parseRetryAfterHeader("-5")).toBeUndefined();
  });
});
