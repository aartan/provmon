import { describe, expect, it } from "vitest";

import { evaluateNotificationRules } from "@/modules/notifications/rules";
import { defaultNotificationState } from "@/modules/monitoring/types";
import type { RulesInput } from "@/modules/notifications/rules";

function state(overrides: Partial<ReturnType<typeof defaultNotificationState>> = {}) {
  return { ...defaultNotificationState(null), ...overrides };
}

function input(overrides: Partial<RulesInput> = {}): RulesInput {
  return {
    condition: "BACK_IN_STOCK",
    targetPriceMinor: null,
    current: { availability: "IN_STOCK", priceMinor: 10000 },
    state: state({ lastNotifiedAvailability: "OUT_OF_STOCK" }),
    ...overrides,
  };
}

describe("back-in-stock rule", () => {
  it("fires on OUT_OF_STOCK -> IN_STOCK", () => {
    const result = evaluateNotificationRules(input());
    expect(result.events).toEqual([
      { type: "BACK_IN_STOCK", priceMinor: 10000, availability: "IN_STOCK" },
    ]);
    expect(result.backInStockState?.lastNotifiedAvailability).toBe("IN_STOCK");
  });

  it("fires on PREORDER -> IN_STOCK", () => {
    const result = evaluateNotificationRules(
      input({ state: state({ lastNotifiedAvailability: "PREORDER" }) }),
    );
    expect(result.events.map((e) => e.type)).toEqual(["BACK_IN_STOCK"]);
  });

  it("does not fire on UNKNOWN -> IN_STOCK", () => {
    const result = evaluateNotificationRules(
      input({ state: state({ lastNotifiedAvailability: "UNKNOWN" }) }),
    );
    expect(result.events).toEqual([]);
  });

  it("does not fire while already in stock", () => {
    const result = evaluateNotificationRules(
      input({ state: state({ lastNotifiedAvailability: "IN_STOCK" }) }),
    );
    expect(result.events).toEqual([]);
    expect(result.backInStockState).toBeUndefined();
  });

  it("does not fire on the very first check after subscribing", () => {
    const result = evaluateNotificationRules(
      input({ state: state({ lastNotifiedAvailability: null }) }),
    );
    expect(result.events).toEqual([]);
  });

  it("re-arms when the product goes out of stock", () => {
    const first = evaluateNotificationRules(
      input({ state: state({ lastNotifiedAvailability: "OUT_OF_STOCK" }) }),
    );
    expect(first.events).toHaveLength(1);

    // Goes out of stock again (re-arm), then comes back (fire again).
    const wentOut = evaluateNotificationRules(
      input({
        state: state({ lastNotifiedAvailability: "IN_STOCK" }),
        current: { availability: "OUT_OF_STOCK", priceMinor: null },
      }),
    );
    expect(wentOut.events).toEqual([]);
    expect(wentOut.backInStockState?.lastNotifiedAvailability).toBe("OUT_OF_STOCK");

    const cameBack = evaluateNotificationRules(
      input({
        state: state({ lastNotifiedAvailability: "OUT_OF_STOCK" }),
        current: { availability: "IN_STOCK", priceMinor: 9000 },
      }),
    );
    expect(cameBack.events).toHaveLength(1);
  });

  it("UNKNOWN does not re-arm or disarm", () => {
    const result = evaluateNotificationRules(
      input({
        state: state({ lastNotifiedAvailability: "IN_STOCK" }),
        current: { availability: "UNKNOWN", priceMinor: null },
      }),
    );
    expect(result.events).toEqual([]);
    expect(result.backInStockState).toBeUndefined();
  });
});

describe("price-drop rule", () => {
  const base = {
    condition: "PRICE_DROP" as const,
    targetPriceMinor: 8000,
    current: { availability: "IN_STOCK" as const, priceMinor: 7500 },
    state: state({ priceDropArmed: true }),
  };

  it("fires when the price crosses below the target while in stock", () => {
    const result = evaluateNotificationRules(input(base));
    expect(result.events).toEqual([
      { type: "PRICE_DROP", priceMinor: 7500, availability: "IN_STOCK" },
    ]);
    expect(result.priceState).toEqual({
      priceDropArmed: false,
      lastNotifiedPriceMinor: 7500,
    });
  });

  it("does not repeat while the price stays below the target", () => {
    const after = state({ priceDropArmed: false, lastNotifiedPriceMinor: 7500 });
    const result = evaluateNotificationRules(input({ ...base, state: after }));
    expect(result.events).toEqual([]);
  });

  it("re-arms when the price rises above the target", () => {
    const after = state({ priceDropArmed: false, lastNotifiedPriceMinor: 7500 });
    const result = evaluateNotificationRules(
      input({
        ...base,
        state: after,
        current: { availability: "IN_STOCK", priceMinor: 9000 },
      }),
    );
    expect(result.events).toEqual([]);
    expect(result.priceState).toEqual({ priceDropArmed: true });
  });

  it("fires again after re-arming and dropping", () => {
    const armed = state({ priceDropArmed: true, lastNotifiedPriceMinor: 7500 });
    const result = evaluateNotificationRules(input({ ...base, state: armed }));
    expect(result.events.map((e) => e.type)).toEqual(["PRICE_DROP"]);
  });

  it("does not fire when out of stock even at the target price", () => {
    const result = evaluateNotificationRules(
      input({
        ...base,
        current: { availability: "OUT_OF_STOCK", priceMinor: 7500 },
      }),
    );
    expect(result.events).toEqual([]);
  });

  it("does not fire for a null price", () => {
    const result = evaluateNotificationRules(
      input({
        ...base,
        current: { availability: "IN_STOCK", priceMinor: null },
      }),
    );
    expect(result.events).toEqual([]);
  });

  it("fires subsequent-drop notifications past the threshold", () => {
    const notified = state({ priceDropArmed: false, lastNotifiedPriceMinor: 7500 });
    const below = evaluateNotificationRules(
      input({
        ...base,
        state: notified,
        current: { availability: "IN_STOCK", priceMinor: 7000 },
        subsequentDropPct: 5,
      }),
    );
    expect(below.events.map((e) => e.type)).toEqual(["PRICE_DROP_SUBSEQUENT"]);
    expect(below.priceState?.lastNotifiedPriceMinor).toBe(7000);

    const above = evaluateNotificationRules(
      input({
        ...base,
        state: notified,
        current: { availability: "IN_STOCK", priceMinor: 7300 },
        subsequentDropPct: 5,
      }),
    );
    expect(above.events).toEqual([]);
  });
});

describe("combined (BOTH) rule", () => {
  const base = {
    condition: "BOTH" as const,
    targetPriceMinor: 8000,
  };

  it("fires on a back-in-stock transition meeting the target price", () => {
    const result = evaluateNotificationRules(
      input({
        ...base,
        state: state({ lastNotifiedAvailability: "OUT_OF_STOCK" }),
        current: { availability: "IN_STOCK", priceMinor: 7500 },
      }),
    );
    expect(result.events.map((e) => e.type)).toEqual(["BACK_IN_STOCK"]);
    expect(result.backInStockState).toEqual({
      lastNotifiedAvailability: "IN_STOCK",
      priceDropArmed: false,
      lastNotifiedPriceMinor: 7500,
    });
  });

  it("does not fire when back in stock above the target price", () => {
    const result = evaluateNotificationRules(
      input({
        ...base,
        state: state({ lastNotifiedAvailability: "OUT_OF_STOCK" }),
        current: { availability: "IN_STOCK", priceMinor: 12000 },
      }),
    );
    expect(result.events).toEqual([]);
    // Reality is still recorded: it is in stock now.
    expect(result.backInStockState?.lastNotifiedAvailability).toBe("IN_STOCK");
  });

  it("does not fire on a later price drop without a stock transition", () => {
    const result = evaluateNotificationRules(
      input({
        ...base,
        state: state({ lastNotifiedAvailability: "IN_STOCK" }),
        current: { availability: "IN_STOCK", priceMinor: 7500 },
      }),
    );
    expect(result.events).toEqual([]);
  });
});
