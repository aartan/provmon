import Redis from "ioredis";

import { db } from "@/lib/db";
import { TEST_REDIS_URL } from "@test/setup/global-setup";

/**
 * Integration test helpers. Reset the test database and the dedicated test
 * Redis instance (database 1) between tests so each test starts clean.
 */

export const testRedis = new Redis(TEST_REDIS_URL, {
  maxRetriesPerRequest: null,
});

export async function flushRedis(): Promise<void> {
  await testRedis.flushdb();
}

/** Delete every row in FK-safe order. */
export async function resetDb(): Promise<void> {
  await db.$transaction([
    db.notification.deleteMany(),
    db.monitoringCheck.deleteMany(),
    db.priceObservation.deleteMany(),
    db.availabilityObservation.deleteMany(),
    db.monitoringSubscription.deleteMany(),
    db.product.deleteMany(),
    db.notificationPreference.deleteMany(),
    db.user.deleteMany(),
  ]);
}

export async function resetTestState(): Promise<void> {
  await resetDb();
  await flushRedis();
}

export async function createTestUser(email = "test@example.com"): Promise<string> {
  const user = await db.user.create({
    data: { email, passwordHash: "not-a-real-hash", name: "Test User" },
  });
  return user.id;
}
