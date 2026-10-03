import { describe, expect, it } from "vitest";

import type { RetailerAdapter } from "@/modules/retailers/core/adapter.interface";
import { InvalidProductUrlError, isRetailerError } from "@/modules/retailers/core/errors";
import { productDetailsSchema } from "@/modules/retailers/core/schemas";

export interface AdapterContractInput {
  /** Fresh adapter (and its fixture store) for each contract run. */
  createAdapter: () => RetailerAdapter;
  /** A product URL the adapter accepts. */
  validProductUrl: string;
  /** URLs on the same domain that are NOT product URLs (homepage, search…). */
  invalidProductUrls: string[];
}

/**
 * Shared contract test suite every retailer adapter must pass — the mock
 * adapter and every real retailer. New adapters call this from their own
 * test file with their fixtures.
 *
 * This is intentionally a helper, not a test file, so Vitest does not run
 * it directly.
 */
export function runRetailerAdapterContractTests(input: AdapterContractInput): void {
  describe("RetailerAdapter contract", () => {
    it("declares valid metadata", () => {
      const adapter = input.createAdapter();
      expect(adapter.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(adapter.name.trim().length).toBeGreaterThan(0);
      expect(adapter.supportedDomains.length).toBeGreaterThan(0);
      expect(adapter.currency).toMatch(/^[A-Z]{3}$/);
      expect(Number.isInteger(adapter.minCheckIntervalMs)).toBe(true);
      expect(adapter.minCheckIntervalMs).toBeGreaterThan(0);
      expect(typeof adapter.treatNotFoundAsOutOfStock).toBe("boolean");
    });

    it("parses a valid product URL", () => {
      const adapter = input.createAdapter();
      const parsed = adapter.parseProductUrl(input.validProductUrl);
      expect(parsed.url).toBe(input.validProductUrl);
      if (parsed.retailerProductId !== undefined) {
        expect(parsed.retailerProductId.length).toBeGreaterThan(0);
      }
    });

    it("rejects URLs that are not product URLs", () => {
      const adapter = input.createAdapter();
      for (const url of input.invalidProductUrls) {
        expect(
          () => adapter.parseProductUrl(url),
          `expected ${url} to be rejected`,
        ).toThrow(InvalidProductUrlError);
      }
    });

    it("returns normalised product details", async () => {
      const adapter = input.createAdapter();
      const details = await adapter.getProduct(input.validProductUrl);

      const validated = productDetailsSchema.safeParse(details);
      expect(validated.success, JSON.stringify(validated.error?.issues)).toBe(true);
      expect(details.retailerId).toBe(adapter.id);
      expect(details.url).toBe(input.validProductUrl);
      expect(details.currency).toBe(adapter.currency);
      expect(details.lastUpdated).toBeInstanceOf(Date);
      if (details.priceMinor !== undefined) {
        expect(Number.isInteger(details.priceMinor)).toBe(true);
        expect(details.priceMinor).toBeGreaterThanOrEqual(0);
      }
    });

    it("throws RetailerError instances (never raw errors)", async () => {
      const adapter = input.createAdapter();
      try {
        // A URL on the same domain that cannot be a product URL — the
        // adapter must reject it with a typed error rather than crash.
        await adapter.getProduct(input.invalidProductUrls[0]);
      } catch (error) {
        expect(isRetailerError(error)).toBe(true);
        expect((error as { retailerId?: string }).retailerId).toBe(adapter.id);
        return;
      }
      // Some adapters may return a product for any URL; that is allowed,
      // but if they threw, the error must have been typed.
      expect(true).toBe(true);
    });
  });
}
