import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CATALOGUE_COOLDOWN_MS,
  getRetailerCooldownUntil,
  noteCatalogueRateLimit,
  setRetailerCooldown,
} from "@/modules/catalogue/cooldown";
import { flushRedis } from "@test/helpers/integration";

describe("retailer cooldowns", () => {
  beforeEach(async () => {
    await flushRedis();
  });

  afterAll(async () => {
    await flushRedis();
  });

  it("stores a cooldown independently for each retailer", async () => {
    const before = Date.now();
    const retailerAUntil = await setRetailerCooldown("retailer-a", 5_000);

    expect(retailerAUntil).toBeGreaterThanOrEqual(before + 4_000);
    expect(await getRetailerCooldownUntil("retailer-a")).toBe(retailerAUntil);
    expect(await getRetailerCooldownUntil("retailer-b")).toBe(0);
  });

  it("never shortens an existing cooldown", async () => {
    const first = await setRetailerCooldown("retailer-a", 5_000);
    const second = await setRetailerCooldown("retailer-a", 1_000);
    expect(second).toBe(first);
    expect(await getRetailerCooldownUntil("retailer-a")).toBe(first);
  });

  it("uses Retry-After when noting a rate limit", async () => {
    const before = Date.now();
    const until = await noteCatalogueRateLimit("retailer-b", 120_000);
    expect(until).toBeGreaterThanOrEqual(before + 120_000);
    expect(until).toBeLessThanOrEqual(before + 132_000 + 1_000);
    expect(await getRetailerCooldownUntil("retailer-a")).toBe(0);
  });

  it("uses the default cooldown without Retry-After", async () => {
    const before = Date.now();
    const until = await noteCatalogueRateLimit("retailer-a");
    expect(until).toBeGreaterThanOrEqual(
      before + DEFAULT_CATALOGUE_COOLDOWN_MS,
    );
  });
});
