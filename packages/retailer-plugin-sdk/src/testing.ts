import { describe, expect, it } from "vitest";

import type {
  PluginLogger,
  RetailerPlugin,
  RetailerPluginInstance,
  RetailerPluginManifest,
} from "./contracts.js";
import {
  InvalidProductUrlError,
  isRetailerError,
} from "./errors.js";
import { validateRetailerPluginManifest } from "./manifest.js";
import {
  catalogueDiscoveryPageSchema,
  parsedProductUrlSchema,
  productDetailsSchema,
} from "./schemas.js";

const noopLogger: PluginLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface RetailerPluginContractInput<TConfig> {
  plugin: RetailerPlugin<TConfig>;
  /** The package's `provmon.plugin.json` payload. */
  manifest: RetailerPluginManifest | unknown;
  /** Fresh config object for each contract run. */
  createConfig: () => TConfig;
  /** Plugin package version, used only for the test context. */
  pluginVersion?: string;
  /** A product URL the plugin accepts. */
  validProductUrl: string;
  /** URLs on the same domain that are NOT product URLs. */
  invalidProductUrls: string[];
  /**
   * Optional cursor to resume. When supplied, the contract also checks
   * that a saved discovery cursor is accepted by `fetchPage`.
   */
  resumeCursor?: string;
}

/**
 * Shared contract suite every retailer plugin should pass. Plugins call
 * this from their own test file with fixture-backed instances so no test
 * touches a live retailer.
 */
export function runRetailerPluginContractTests<TConfig>(
  input: RetailerPluginContractInput<TConfig>,
): void {
  const manifest = validateRetailerPluginManifest(input.manifest);

  async function createInstance(): Promise<RetailerPluginInstance> {
    const config = input.createConfig();
    let parsedConfig = config;
    if (input.plugin.configSchema) {
      const parsed = input.plugin.configSchema.safeParse(config);
      if (!parsed.success) {
        throw new Error(
          `Invalid plugin test config: ${JSON.stringify(parsed.error.issues)}`,
        );
      }
      parsedConfig = parsed.data;
    }
    return input.plugin.create({
      config: parsedConfig,
      logger: noopLogger,
      plugin: {
        id: manifest.id,
        version: input.pluginVersion ?? "0.0.0-test",
      },
    });
  }

  describe(`${manifest.name} plugin contract`, () => {
    it("declares valid metadata", () => {
      expect(manifest.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(manifest.name.trim().length).toBeGreaterThan(0);
      expect(manifest.supportedDomains.length).toBeGreaterThan(0);
      expect(manifest.currency).toMatch(/^[A-Z]{3}$/);
      expect(Number.isInteger(manifest.minCheckIntervalMs)).toBe(true);
      expect(manifest.minCheckIntervalMs).toBeGreaterThan(0);
      expect(typeof manifest.treatNotFoundAsOutOfStock).toBe("boolean");
      expect(manifest.capabilities).toContain("url-monitoring");
    });

    it("parses a valid product URL", async () => {
      const instance = await createInstance();
      const parsed = instance.parseProductUrl(input.validProductUrl);
      const validated = parsedProductUrlSchema.safeParse(parsed);
      expect(validated.success, JSON.stringify(validated.error?.issues)).toBe(
        true,
      );
      expect(parsed.url).toBe(input.validProductUrl);
      if (parsed.retailerProductId !== undefined) {
        expect(parsed.retailerProductId.length).toBeGreaterThan(0);
      }
    });

    it("rejects URLs that are not product URLs", async () => {
      const instance = await createInstance();
      for (const url of input.invalidProductUrls) {
        try {
          instance.parseProductUrl(url);
          throw new Error(`expected ${url} to be rejected`);
        } catch (error) {
          expect(
            error instanceof InvalidProductUrlError ||
              (isRetailerError(error) && error.code === "INVALID_URL"),
            `expected ${url} to throw InvalidProductUrlError`,
          ).toBe(true);
        }
      }
    });

    it("returns normalised product details", async () => {
      const instance = await createInstance();
      const details = await instance.getProduct(input.validProductUrl);

      const validated = productDetailsSchema.safeParse(details);
      expect(validated.success, JSON.stringify(validated.error?.issues)).toBe(
        true,
      );
      expect(details.retailerId).toBe(manifest.id);
      expect(details.url).toBe(input.validProductUrl);
      expect(details.currency).toBe(manifest.currency);
      expect(details.lastUpdated).toBeInstanceOf(Date);
      if (details.priceMinor !== undefined) {
        expect(Number.isInteger(details.priceMinor)).toBe(true);
        expect(details.priceMinor).toBeGreaterThanOrEqual(0);
      }
    });

    it("throws RetailerError instances (never raw errors)", async () => {
      const instance = await createInstance();
      try {
        await instance.getProduct(input.invalidProductUrls[0]);
      } catch (error) {
        expect(isRetailerError(error)).toBe(true);
        expect((error as { retailerId?: string }).retailerId).toBe(manifest.id);
        return;
      }
      // Some plugins may return a product for any URL; that is allowed,
      // but if they threw, the error must have been typed.
      expect(true).toBe(true);
    });

    if (manifest.capabilities.includes("catalogue-discovery")) {
      it("exposes a valid catalogue page", async () => {
        const instance = await createInstance();
        expect(instance.catalogue).toBeDefined();
        const page = await instance.catalogue!.fetchPage(null);
        const validated = catalogueDiscoveryPageSchema.safeParse(page);
        expect(
          validated.success,
          JSON.stringify(validated.error?.issues),
        ).toBe(true);
        expect(page.nextCursor === null || page.nextCursor.length > 0).toBe(
          true,
        );
      });

      if (input.resumeCursor) {
        it("accepts a saved discovery cursor", async () => {
          const instance = await createInstance();
          expect(instance.catalogue).toBeDefined();
          const page = await instance.catalogue!.fetchPage(
            input.resumeCursor!,
          );
          const validated = catalogueDiscoveryPageSchema.safeParse(page);
          expect(
            validated.success,
            JSON.stringify(validated.error?.issues),
          ).toBe(true);
        });
      }
    }
  });
}
