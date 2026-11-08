import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type { PluginLogger } from "@provmon/retailer-plugin-sdk";

import { RetailerRegistry } from "@/modules/retailers/core/retailer-registry";
import { RetailerParseError } from "@/modules/retailers/core/errors";
import {
  loadRetailerPlugins,
  resetRetailerPluginsForTests,
} from "@/modules/retailers/plugin/loader";

const pluginDir = path.resolve("test/fixtures/plugins");

const noopLogger: PluginLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const baseEnv: Record<string, string> = {
  EXAMPLE_REQUIRED_TOKEN: "token",
  EXAMPLE_PRICE_MINOR: "4321",
};

describe("retailer plugin loader", () => {
  beforeEach(() => {
    resetRetailerPluginsForTests();
  });

  it("loads a plugin package, validates it, and wraps it as an adapter", async () => {
    const registry = new RetailerRegistry();
    const result = await loadRetailerPlugins({
      pluginDir,
      env: baseEnv,
      registry,
      pluginLogger: () => noopLogger,
    });

    expect(result.failed).toBe(0);
    expect(result.loaded).toBe(1);

    const adapter = registry.getById("example");
    expect(adapter).toBeDefined();
    expect(adapter?.name).toBe("Example Retailer");
    expect(adapter?.version).toBe("1.2.3");
    expect(adapter?.currency).toBe("GBP");
    expect(adapter?.treatNotFoundAsOutOfStock).toBe(false);
    expect(adapter?.catalogue).toBeDefined();

    const parsed = adapter!.parseProductUrl(
      "https://example-retailer.test/products/item-1",
    );
    expect(parsed.retailerProductId).toBe("item-1");

    const details = await adapter!.getProduct(
      "https://example-retailer.test/products/item-1",
    );
    expect(details).toMatchObject({
      retailerId: "example",
      retailerProductId: "item-1",
      currency: "GBP",
      priceMinor: 4321,
      availability: "IN_STOCK",
    });

    const page = await adapter!.catalogue!.fetchPage(null);
    expect(page.items.map((item) => item.retailerProductId)).toEqual([
      "catalogue-valid",
    ]);
    expect(page.nextCursor).toBe("done");
    expect(page.totalEstimate).toBe(2);

    const lastPage = await adapter!.catalogue!.fetchPage("done");
    expect(lastPage.items).toEqual([]);
    expect(lastPage.nextCursor).toBeNull();
  });

  it("rejects product data whose retailer id or currency is wrong", async () => {
    const registry = new RetailerRegistry();
    await loadRetailerPlugins({
      pluginDir,
      env: baseEnv,
      registry,
      pluginLogger: () => noopLogger,
    });

    const adapter = registry.getById("example")!;
    await expect(
      adapter.getProduct("https://example-retailer.test/products/invalid"),
    ).rejects.toBeInstanceOf(RetailerParseError);
  });

  it("reports a failed plugin without preventing other plugins from loading", async () => {
    const registry = new RetailerRegistry();
    const result = await loadRetailerPlugins({
      pluginDir,
      env: { EXAMPLE_PRICE_MINOR: "4321" },
      registry,
      pluginLogger: () => noopLogger,
    });

    expect(result.loaded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.statuses[0]?.error).toContain("EXAMPLE_REQUIRED_TOKEN");
    expect(registry.has("example")).toBe(false);
  });

  it("treats a missing plugin directory as no configured plugins", async () => {
    const registry = new RetailerRegistry();
    const result = await loadRetailerPlugins({
      pluginDir: path.resolve("test/fixtures/no-such-plugin-dir"),
      env: baseEnv,
      registry,
      pluginLogger: () => noopLogger,
    });

    expect(result.loaded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.statuses).toEqual([]);
  });
});
