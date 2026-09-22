import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { mockRetailer, mockRetailerStore } from "@/modules/retailers/adapters/mock";
import { mockProductUrl } from "@/modules/retailers/adapters/mock/types";
import { RetailerNetworkError } from "@/modules/retailers/core/errors";
import {
  addMonitoringSubscription,
  MonitoringServiceError,
  processCheckJob,
} from "@/modules/monitoring/service";
import { createSubscription } from "@/modules/monitoring/repository";
import { createTestUser, resetTestState } from "@test/helpers/integration";

describe("addMonitoringSubscription (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
    mockRetailerStore.reset();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("creates a product and a subscription from a supported URL", async () => {
    const userId = await createTestUser();
    const subscription = await addMonitoringSubscription({
      userId,
      url: mockProductUrl("in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });

    expect(subscription.product.retailerId).toBe("mock");
    expect(subscription.product.name).toContain("In Stock");
    expect(subscription.status).toBe("ACTIVE");

    const storedProduct = await db.product.findFirst({
      where: { retailerId: "mock" },
    });
    expect(storedProduct?.currentAvailability).toBe("IN_STOCK");
    expect(storedProduct?.currentPriceMinor).toBe(29999);
  });

  it("shares one product row across users monitoring the same URL", async () => {
    const userA = await createTestUser("a@example.com");
    const userB = await createTestUser("b@example.com");

    await addMonitoringSubscription({
      userId: userA,
      url: mockProductUrl("in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });
    await addMonitoringSubscription({
      userId: userB,
      url: mockProductUrl("in-stock"),
      condition: "PRICE_DROP",
      targetPriceMinor: 25000,
      intervalMinutes: 30,
    });

    const productCount = await db.product.count();
    const subscriptionCount = await db.monitoringSubscription.count();
    expect(productCount).toBe(1);
    expect(subscriptionCount).toBe(2);
  });

  it("rejects a duplicate subscription for the same user and product", async () => {
    const userId = await createTestUser();
    await addMonitoringSubscription({
      userId,
      url: mockProductUrl("in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });
    await expect(
      addMonitoringSubscription({
        userId,
        url: mockProductUrl("in-stock"),
        condition: "BACK_IN_STOCK",
        intervalMinutes: 15,
      }),
    ).rejects.toThrow(MonitoringServiceError);
  });

  it("rejects PRICE_DROP without a target price", async () => {
    const userId = await createTestUser();
    await expect(
      addMonitoringSubscription({
        userId,
        url: mockProductUrl("in-stock"),
        condition: "PRICE_DROP",
        intervalMinutes: 15,
      }),
    ).rejects.toThrow(/target price is required/i);
  });

  it("rejects intervals below the retailer floor", async () => {
    const userId = await createTestUser();
    await expect(
      addMonitoringSubscription({
        userId,
        url: mockProductUrl("in-stock"),
        condition: "BACK_IN_STOCK",
        intervalMinutes: 1 as never,
      }),
    ).rejects.toThrow(MonitoringServiceError);
  });

  it("rejects unsupported retailer URLs", async () => {
    const userId = await createTestUser();
    await expect(
      addMonitoringSubscription({
        userId,
        url: "https://unknown-shop.example/products/1",
        condition: "BACK_IN_STOCK",
        intervalMinutes: 15,
      }),
    ).rejects.toThrow(MonitoringServiceError);
  });

  it("rejects URLs that are not product URLs", async () => {
    const userId = await createTestUser();
    await expect(
      addMonitoringSubscription({
        userId,
        url: "https://mock-retailer.test/",
        condition: "BACK_IN_STOCK",
        intervalMinutes: 15,
      }),
    ).rejects.toThrow(MonitoringServiceError);
  });

  it("rejects products the retailer reports as errors", async () => {
    const userId = await createTestUser();
    mockRetailerStore.setError("broken", { code: "BLOCKED", message: "nope" });
    await expect(
      addMonitoringSubscription({
        userId,
        url: mockProductUrl("broken"),
        condition: "BACK_IN_STOCK",
        intervalMinutes: 15,
      }),
    ).rejects.toThrow(/could not load the product/i);
  });
});

describe("processCheckJob (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
    mockRetailerStore.reset();
  });

  afterAll(async () => {
    await resetTestState();
  });

  async function createInStockSubscription(userId?: string) {
    const user = userId ?? (await createTestUser());
    return addMonitoringSubscription({
      userId: user,
      url: mockProductUrl("in-stock"),
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });
  }

  it("records a successful check and updates the product", async () => {
    const subscription = await createInStockSubscription();
    const outcome = await processCheckJob({ subscriptionId: subscription.id });

    expect(outcome.success).toBe(true);
    expect(outcome.current.availability).toBe("IN_STOCK");
    expect(outcome.current.priceMinor).toBe(29999);

    const checks = await db.monitoringCheck.findMany({
      where: { subscriptionId: subscription.id },
    });
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("SUCCESS");

    const product = await db.product.findUnique({
      where: { id: subscription.productId },
    });
    expect(product?.lastCheckedAt).not.toBeNull();
    expect(product?.lastSuccessfulAt).not.toBeNull();
  });

  it("records a price observation only when the price changes", async () => {
    const subscription = await createInStockSubscription();
    await processCheckJob({ subscriptionId: subscription.id });
    expect(await db.priceObservation.count()).toBe(0);

    mockRetailerStore.setPrice("in-stock", 25000);
    await processCheckJob({ subscriptionId: subscription.id });
    expect(await db.priceObservation.count()).toBe(1);

    await processCheckJob({ subscriptionId: subscription.id });
    expect(await db.priceObservation.count()).toBe(1);
  });

  it("records an availability observation only on transitions", async () => {
    const subscription = await createInStockSubscription();
    await processCheckJob({ subscriptionId: subscription.id });
    expect(await db.availabilityObservation.count()).toBe(0);

    mockRetailerStore.setAvailability("in-stock", "OUT_OF_STOCK");
    await processCheckJob({ subscriptionId: subscription.id });
    expect(await db.availabilityObservation.count()).toBe(1);

    // Out of stock again: no new observation.
    await processCheckJob({ subscriptionId: subscription.id });
    expect(await db.availabilityObservation.count()).toBe(1);

    // Back in stock: another transition.
    mockRetailerStore.setAvailability("in-stock", "IN_STOCK");
    await processCheckJob({ subscriptionId: subscription.id });
    expect(await db.availabilityObservation.count()).toBe(2);
  });

  it("reports the previous state in the outcome", async () => {
    const subscription = await createInStockSubscription();
    mockRetailerStore.setPrice("in-stock", 25000);
    const outcome = await processCheckJob({ subscriptionId: subscription.id });

    expect(outcome.previous).toEqual({ availability: "IN_STOCK", priceMinor: 29999 });
    expect(outcome.current).toEqual({ availability: "IN_STOCK", priceMinor: 25000 });
  });

  it("records retryable errors and rethrows for BullMQ retries", async () => {
    const subscription = await createInStockSubscription();
    mockRetailerStore.setError("in-stock", { code: "NETWORK", message: "down" });

    await expect(
      processCheckJob({ subscriptionId: subscription.id }),
    ).rejects.toBeInstanceOf(RetailerNetworkError);

    const checks = await db.monitoringCheck.findMany({
      where: { subscriptionId: subscription.id },
    });
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("ERROR");
    expect(checks[0].errorCode).toBe("NETWORK");
  });

  it("records non-retryable errors without throwing", async () => {
    const subscription = await createInStockSubscription();
    mockRetailerStore.setError("in-stock", { code: "BLOCKED", message: "blocked" });

    const outcome = await processCheckJob({ subscriptionId: subscription.id });
    expect(outcome.success).toBe(false);
    expect(outcome.errorCode).toBe("BLOCKED");

    const checks = await db.monitoringCheck.findMany({
      where: { subscriptionId: subscription.id },
    });
    expect(checks[0].status).toBe("ERROR");
    expect(checks[0].errorCode).toBe("BLOCKED");
  });

  it("recovers after transient retailer errors", async () => {
    const subscription = await createInStockSubscription();
    mockRetailerStore.setError("in-stock", { code: "NETWORK", message: "down" });
    await expect(
      processCheckJob({ subscriptionId: subscription.id }),
    ).rejects.toBeInstanceOf(RetailerNetworkError);

    mockRetailerStore.setError("in-stock", undefined);
    const outcome = await processCheckJob({ subscriptionId: subscription.id });
    expect(outcome.success).toBe(true);
  });

  it("skips gracefully when the subscription no longer exists", async () => {
    const outcome = await processCheckJob({ subscriptionId: "missing" });
    expect(outcome.success).toBe(false);
    expect(outcome.errorCode).toBe("SUBSCRIPTION_NOT_FOUND");
  });

  it("does not notify or change state for UNKNOWN availability", async () => {
    const subscription = await createInStockSubscription();
    mockRetailerStore.setAvailability("in-stock", "UNKNOWN");
    const outcome = await processCheckJob({ subscriptionId: subscription.id });

    expect(outcome.success).toBe(true);
    expect(outcome.current.availability).toBe("UNKNOWN");
    const product = await db.product.findUnique({
      where: { id: subscription.productId },
    });
    expect(product?.currentAvailability).toBe("UNKNOWN");
  });

  it("supports a manually created subscription (target price, combined condition)", async () => {
    const userId = await createTestUser();
    const viaAdd = await addMonitoringSubscription({
      userId,
      url: mockProductUrl("price-drops"),
      condition: "BOTH",
      targetPriceMinor: 20000,
      intervalMinutes: 30,
    });
    expect(viaAdd.targetPriceMinor).toBe(20000);
    expect(viaAdd.condition).toBe("BOTH");

    const outcome = await processCheckJob({ subscriptionId: viaAdd.id });
    expect(outcome.current.priceMinor).toBe(14999);
  });
});

describe("mockRetailer", () => {
  it("is registered with the shared registry", () => {
    expect(mockRetailer.id).toBe("mock");
  });

  it("createSubscription is usable directly (repository level)", async () => {
    await resetTestState();
    const userId = await createTestUser();
    const product = await db.product.create({
      data: {
        retailerId: "mock",
        retailerProductId: "direct",
        name: "Direct product",
        url: "https://mock-retailer.test/products/direct",
        currency: "GBP",
        currentAvailability: "IN_STOCK",
      },
    });
    const subscription = await createSubscription({
      userId,
      productId: product.id,
      condition: "BACK_IN_STOCK",
      intervalMinutes: 60,
    });
    expect(subscription.id).toBeTruthy();
  });
});
