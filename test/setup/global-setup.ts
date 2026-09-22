import "dotenv/config";

import { execSync } from "node:child_process";

import pg from "pg";

/**
 * Vitest global setup (runs once, in its own process):
 *  - creates the test database if missing
 *  - applies the schema with `prisma db push`
 *  - flushes the dedicated test Redis database
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://provmon:provmon@localhost:5433/provmon_test";

export const TEST_REDIS_URL =
  process.env.TEST_REDIS_URL ?? "redis://localhost:6379/1";

async function ensureTestDatabase(): Promise<void> {
  const adminUrl =
    process.env.DATABASE_URL ??
    "postgresql://provmon:provmon@localhost:5433/provmon";

  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const target = new URL(TEST_DATABASE_URL);
  const dbName = target.pathname.replace(/^\//, "");

  const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
    dbName,
  ]);
  if (existing.rowCount === 0) {
    await client.query(`CREATE DATABASE "${dbName}"`);
    console.log(`[test-setup] created database ${dbName}`);
  }
  await client.end();
}

export default async function setup(): Promise<void> {
  await ensureTestDatabase();

  execSync("npx prisma db push", {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
  console.log("[test-setup] schema pushed to test database");

  // Redis cleanup happens per test file via the integration helper.
}
