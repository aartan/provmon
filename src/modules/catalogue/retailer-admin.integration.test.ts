import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  listRetailerAdminViews,
  updateRetailerDiscoverySettings,
} from "@/modules/catalogue/retailer-admin.service";
import { registerBuiltInAdapters } from "@/modules/retailers/adapters";
import {
  createTestListing,
  resetTestState,
} from "@test/helpers/integration";

describe("retailer discovery management (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
    registerBuiltInAdapters();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("lists adapters with catalogue counts and persists settings", async () => {
    await createTestListing({
      retailerId: "mock",
      retailerProductId: "admin-listing",
      currentAvailability: "IN_STOCK",
    });

    const views = await listRetailerAdminViews();
    const mock = views.find((view) => view.id === "mock");
    expect(mock?.supportsCatalogue).toBe(true);
    expect(mock?.productCount).toBe(1);
    expect(mock?.inStockCount).toBe(1);

    const updated = await updateRetailerDiscoverySettings("mock", {
      discoveryEnabled: true,
      refreshIntervalHours: 6,
    });
    expect(updated.discoveryEnabled).toBe(true);
    expect(updated.refreshIntervalHours).toBe(6);
    expect(updated.nextRefreshAt).not.toBeNull();

    const stored = await db.retailerCatalogue.findUniqueOrThrow({
      where: { retailerId: "mock" },
    });
    expect(stored.discoveryEnabled).toBe(true);
    expect(stored.refreshIntervalHours).toBe(6);

    const disabled = await updateRetailerDiscoverySettings("mock", {
      discoveryEnabled: false,
    });
    expect(disabled.discoveryEnabled).toBe(false);
    expect(disabled.nextRefreshAt).toBeNull();
  });

  it("rejects unknown retailers and invalid intervals", async () => {
    await expect(
      updateRetailerDiscoverySettings("not-a-retailer", {
        discoveryEnabled: true,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      updateRetailerDiscoverySettings("mock", { refreshIntervalHours: 0 }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      updateRetailerDiscoverySettings("mock", { refreshIntervalHours: 25 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
