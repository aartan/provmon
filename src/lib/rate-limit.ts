import "server-only";

import { env } from "@/lib/env";
import { redis } from "@/lib/redis";

/**
 * Fixed-window rate limiter backed by Redis.
 *
 * Used for sensitive endpoints (login, register, test email). Since the
 * worker and web processes share Redis, limits apply across processes.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
  const bucket = `ratelimit:${env.NODE_ENV}:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
  const count = await redis.incr(bucket);
  if (count === 1) {
    await redis.expire(bucket, windowSeconds + 1);
  }
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: count > limit ? windowSeconds : 0,
  };
}
