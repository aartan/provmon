import "dotenv/config";

import { registerTestMockRetailer } from "@/modules/retailers/testing";
import { TEST_DATABASE_URL, TEST_REDIS_URL } from "@test/setup/global-setup";

/**
 * Runs in every test worker before any test file is imported. Point the
 * application singletons (db, redis, queues) at the dedicated test
 * database and Redis instance before their modules load.
 */
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL = TEST_REDIS_URL;

// Integration tests must not run against the production queue.
process.env.WORKER_ENABLED = "false";

// Tests use the in-process mock fixture, not deployment-installed plugins.
process.env.PROVMON_PLUGIN_DIR = "test/fixtures/no-plugins";
delete process.env.PROVMON_PLUGINS;

// Every test file gets the controllable mock retailer. External plugins are
// not loaded from the deployment directory during unit/integration tests.
registerTestMockRetailer();
