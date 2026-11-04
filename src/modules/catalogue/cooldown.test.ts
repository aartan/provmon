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
    const cexUntil = await setRetailerCooldown("cex", 5_000);

    expect(cexUntil).toBeGreaterThanOrEqual(before + 4_000);
    expect(await getRetailerCooldownUntil("cex")).toBe(cexUntil);
    expect(await getRetailerCooldownUntil("cashconverters")).toBe(0);
  });

  it("never shortens an existing cooldown", async () => {
    const first = await setRetailerCooldown("cex", 5_000);
    const second = await setRetailerCooldown("cex", 1_000);
    expect(second).toBe(first);
    expect(await getRetailerCooldownUntil("cex")).toBe(first);
  });

  it("uses Retry-After when noting a rate limit", async () => {
    const before = Date.now();
    const until = await noteCatalogueRateLimit("cashconverters", 120_000);
    expect(until).toBeGreaterThanOrEqual(before + 120_000);
    expect(until).toBeLessThanOrEqual(before + 132_000 + 1_000);
    expect(await getRetailerCooldownUntil("cex")).toBe(0);
  });

  it("uses the default cooldown without Retry-After", async () => {
    const before = Date.now();
    const until = await noteCatalogueRateLimit("cex");
    expect(until).toBeGreaterThanOrEqual(
      before + DEFAULT_CATALOGUE_COOLDOWN_MS,
    );
  });
});
