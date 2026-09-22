import "dotenv/config";

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
