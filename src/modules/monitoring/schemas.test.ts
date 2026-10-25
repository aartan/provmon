import { describe, expect, it } from "vitest";

import {
  intervalMinutesSchema,
  requiresTargetPrice,
  snapshotIntervalMinutesSchema,
  subscriptionNotificationStateSchema,
} from "@/modules/monitoring/schemas";

describe("requiresTargetPrice", () => {
  it("requires a target for PRICE_DROP and BOTH", () => {
    expect(requiresTargetPrice("PRICE_DROP")).toBe(true);
    expect(requiresTargetPrice("BOTH")).toBe(true);
    expect(requiresTargetPrice("BACK_IN_STOCK")).toBe(false);
  });
});

describe("intervalMinutesSchema", () => {
  it("accepts the supported intervals", () => {
    for (const minutes of [15, 30, 60, 360, 720, 1440]) {
      expect(intervalMinutesSchema.safeParse(minutes).success).toBe(true);
      expect(intervalMinutesSchema.safeParse(String(minutes)).success).toBe(true);
    }
  });

  it("rejects unsupported intervals", () => {
    for (const minutes of [5, 10, 45, 90, 0, -15, 1.5]) {
      expect(intervalMinutesSchema.safeParse(minutes).success, `minutes=${minutes}`).toBe(
        false,
      );
    }
  });
});

describe("snapshotIntervalMinutesSchema", () => {
  it("accepts disabled, daily and arbitrary positive cadences", () => {
    for (const minutes of [0, 360, 720, 1440, 10080, 525_600]) {
      expect(snapshotIntervalMinutesSchema.safeParse(minutes).success).toBe(true);
      expect(snapshotIntervalMinutesSchema.safeParse(String(minutes)).success).toBe(
        true,
      );
    }
  });

  it("rejects negative, fractional and excessive cadences", () => {
    for (const minutes of [-1, 1.5, 525_601]) {
      expect(
        snapshotIntervalMinutesSchema.safeParse(minutes).success,
        `minutes=${minutes}`,
      ).toBe(false);
    }
  });
});

describe("subscriptionNotificationStateSchema", () => {
  it("accepts a valid state", () => {
    expect(
      subscriptionNotificationStateSchema.safeParse({
        lastNotifiedAvailability: null,
        lastNotifiedPriceMinor: null,
        priceDropArmed: true,
      }).success,
    ).toBe(true);
    expect(
      subscriptionNotificationStateSchema.safeParse({
        lastNotifiedAvailability: "IN_STOCK",
        lastNotifiedPriceMinor: 19999,
        priceDropArmed: false,
      }).success,
    ).toBe(true);
  });

  it("rejects invalid availability and price shapes", () => {
    expect(
      subscriptionNotificationStateSchema.safeParse({
        lastNotifiedAvailability: "SOLD_OUT",
        lastNotifiedPriceMinor: null,
        priceDropArmed: true,
      }).success,
    ).toBe(false);
    expect(
      subscriptionNotificationStateSchema.safeParse({
        lastNotifiedAvailability: null,
        lastNotifiedPriceMinor: -5,
        priceDropArmed: true,
      }).success,
    ).toBe(false);
  });
});
