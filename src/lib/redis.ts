
import Redis from "ioredis";

import { env } from "@/lib/env";

/**
 * Shared Redis connection. `maxRetriesPerRequest: null` is required by
 * BullMQ so blocking commands (BZPOPMIN etc.) do not fail on retries.
 */
const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis: Redis =
  globalForRedis.redis ??
  new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });

if (env.NODE_ENV !== "production") {
  globalForRedis.redis = redis;
}
