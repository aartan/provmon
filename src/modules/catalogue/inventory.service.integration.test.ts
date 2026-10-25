import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  addInventoryItem,
  attachMonitoringToInventoryItem,
  InventoryServiceError,
} from "@/modules/catalogue/inventory.service";
import {
  findInventoryItemForUser,
  removeInventoryItemForUser,
} from "@/modules/catalogue/inventory.repository";
import { archiveSubscription } from "@/modules/monitoring/repository";
import { mockRetailerStore } from "@/modules/retailers/adapters/mock";
import { mockProductUrl } from "@/modules/retailers/adapters/mock/types";
import { createTestUser, resetTestState } from "@test/helpers/integration";

describe("inventory service (integration)", () => {
  beforeEach(async () => {
    await resetTestState();
    mockRetailerStore.reset();
  });

  afterAll(async () => {
    await resetTestState();
  });

  it("adds a product to inventory without creating monitoring", async () => {
    const userId = await createTestUser("inventory-add@example.com");

    const result = await addInventoryItem({
      userId,
      url: mockProductUrl("in-stock"),
    });

    expect(result.created).toBe(true);
    expect(await db.inventoryItem.count({ where: { userId } })).toBe(1);
    expect(await db.monitoringSubscription.count({ where: { userId } })).toBe(0);
    expect(await db.retailerListing.count()).toBe(1);
    expect(
      await db.listingObservation.count({
        where: { retailerListingId: result.listing.id, kind: "INITIAL" },
      }),
    ).toBe(1);
  });

  it("is idempotent when the same product is added twice", async () => {
    const userId = await createTestUser("inventory-again@example.com");

    const first = await addInventoryItem({
      userId,
      url: mockProductUrl("in-stock"),
    });
    const second = await addInventoryItem({
      userId,
      url: mockProductUrl("in-stock"),
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.inventoryItem.id).toBe(first.inventoryItem.id);
    expect(await db.inventoryItem.count({ where: { userId } })).toBe(1);
  });

  it("attaches monitoring to an owned listing and resumes an archived subscription", async () => {
    const userId = await createTestUser("inventory-attach@example.com");
    const added = await addInventoryItem({
      userId,
      url: mockProductUrl("in-stock"),
    });
    const item = await findInventoryItemForUser(
      added.inventoryItem.id,
      userId,
    );
    expect(item).not.toBeNull();
    const listing = item!.canonicalProduct.listings[0];

    const subscription = await attachMonitoringToInventoryItem({
      userId,
      inventoryItemId: added.inventoryItem.id,
      retailerListingId: listing.id,
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });
    expect(subscription.status).toBe("ACTIVE");
    expect(subscription.retailerListingId).toBe(listing.id);

    await expect(
      attachMonitoringToInventoryItem({
        userId,
        inventoryItemId: added.inventoryItem.id,
        retailerListingId: listing.id,
        condition: "BACK_IN_STOCK",
        intervalMinutes: 15,
      }),
    ).rejects.toBeInstanceOf(InventoryServiceError);

    const archived = await archiveSubscription(subscription.id, userId);
    expect(archived?.status).toBe("ARCHIVED");
    expect(archived?.archivedAt).not.toBeNull();
    expect(archived?.nextCheckAt).toBeNull();

    const resumed = await attachMonitoringToInventoryItem({
      userId,
      inventoryItemId: added.inventoryItem.id,
      retailerListingId: listing.id,
      condition: "BACK_IN_STOCK",
      intervalMinutes: 30,
    });
    expect(resumed.id).toBe(subscription.id);
    expect(resumed.status).toBe("ACTIVE");
    expect(resumed.intervalMinutes).toBe(30);
    expect(resumed.archivedAt).toBeNull();
  });

  it("enforces ownership when attaching monitoring or removing inventory", async () => {
    const owner = await createTestUser("inventory-owner@example.com");
    const stranger = await createTestUser("inventory-stranger@example.com");
    const added = await addInventoryItem({
      userId: owner,
      url: mockProductUrl("in-stock"),
    });
    const item = await findInventoryItemForUser(
      added.inventoryItem.id,
      owner,
    );
    const listing = item!.canonicalProduct.listings[0];

    expect(
      await findInventoryItemForUser(added.inventoryItem.id, stranger),
    ).toBeNull();
    await expect(
      attachMonitoringToInventoryItem({
        userId: stranger,
        inventoryItemId: added.inventoryItem.id,
        retailerListingId: listing.id,
        condition: "BACK_IN_STOCK",
        intervalMinutes: 15,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(
      await removeInventoryItemForUser(added.inventoryItem.id, stranger),
    ).toBe(false);
    expect(await db.inventoryItem.count({ where: { userId: owner } })).toBe(1);
  });

  it("archives monitoring and keeps shared history when removed from inventory", async () => {
    const userId = await createTestUser("inventory-remove@example.com");
    const added = await addInventoryItem({
      userId,
      url: mockProductUrl("in-stock"),
    });
    const item = await findInventoryItemForUser(
      added.inventoryItem.id,
      userId,
    );
    const listing = item!.canonicalProduct.listings[0];

    const subscription = await attachMonitoringToInventoryItem({
      userId,
      inventoryItemId: added.inventoryItem.id,
      retailerListingId: listing.id,
      condition: "BACK_IN_STOCK",
      intervalMinutes: 15,
    });

    const removed = await removeInventoryItemForUser(
      added.inventoryItem.id,
      userId,
    );
    expect(removed).toBe(true);
    expect(await db.inventoryItem.count({ where: { userId } })).toBe(0);

    const archived = await db.monitoringSubscription.findUnique({
      where: { id: subscription.id },
    });
    expect(archived?.status).toBe("ARCHIVED");
    expect(archived?.archivedAt).not.toBeNull();
    expect(archived?.nextCheckAt).toBeNull();

    // Shared catalogue rows and observations survive.
    expect(await db.retailerListing.count({ where: { id: listing.id } })).toBe(1);
    expect(
      await db.listingObservation.count({
        where: { retailerListingId: listing.id },
      }),
    ).toBeGreaterThan(0);

    expect(
      await removeInventoryItemForUser(added.inventoryItem.id, userId),
    ).toBe(false);
  });

  it("rejects unsupported URLs and invalid monitoring configuration", async () => {
    const userId = await createTestUser("inventory-errors@example.com");

    await expect(
      addInventoryItem({
        userId,
        url: "https://unsupported-retailer.example/product/1",
      }),
    ).rejects.toBeInstanceOf(InventoryServiceError);

    const added = await addInventoryItem({
      userId,
      url: mockProductUrl("in-stock"),
    });
    const item = await findInventoryItemForUser(
      added.inventoryItem.id,
      userId,
    );
    const listing = item!.canonicalProduct.listings[0];

    await expect(
      attachMonitoringToInventoryItem({
        userId,
        inventoryItemId: added.inventoryItem.id,
        retailerListingId: listing.id,
        condition: "PRICE_DROP",
        intervalMinutes: 15,
      }),
    ).rejects.toThrow(/target price/i);

    await expect(
      attachMonitoringToInventoryItem({
        userId,
        inventoryItemId: added.inventoryItem.id,
        retailerListingId: listing.id,
        condition: "BACK_IN_STOCK",
        intervalMinutes: 5,
      }),
    ).rejects.toBeInstanceOf(InventoryServiceError);
  });
});
