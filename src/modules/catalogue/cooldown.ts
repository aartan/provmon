import { redis } from "@/lib/redis";

/**
 * Retailer-scoped rate-limit cooldowns.
 *
 * A 429 means every future request to that retailer should pause, not just
 * the job that happened to receive it. Cooldowns are therefore stored in
 * Redis under a key that contains the retailer id, so one retailer can be
 * cooling down while another continues normally.
 */

export const DEFAULT_CATALOGUE_COOLDOWN_MS = 60_000;
export const MAX_CATALOGUE_COOLDOWN_MS = 30 * 60_000;

const KEY_PREFIX = "catalogue:cooldown:";
const EXTEND_ONLY_SCRIPT = `
  local current = redis.call("GET", KEYS[1])
  if current then
    local currentUntil = tonumber(current)
    if currentUntil and currentUntil >= tonumber(ARGV[1]) then
      return currentUntil
    end
  end
  redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
  return tonumber(ARGV[1])
`;

export function catalogueCooldownKey(retailerId: string): string {
  return `${KEY_PREFIX}${retailerId}`;
}

/** Epoch milliseconds until which the retailer must not be contacted. */
export async function getRetailerCooldownUntil(
  retailerId: string,
): Promise<number> {
  const raw = await redis.get(catalogueCooldownKey(retailerId));
  const until = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(until) && until > Date.now() ? until : 0;
}

/**
 * Set or extend a retailer cooldown. Returns the effective expiry timestamp.
 * Existing longer cooldowns are never shortened.
 */
export async function setRetailerCooldown(
  retailerId: string,
  durationMs: number,
): Promise<number> {
  const capped = Math.min(
    MAX_CATALOGUE_COOLDOWN_MS,
    Math.max(0, Math.round(durationMs)),
  );
  if (capped === 0) {
    return 0;
  }
  const until = Date.now() + capped;
  const result = await redis.eval(
    EXTEND_ONLY_SCRIPT,
    1,
    catalogueCooldownKey(retailerId),
    String(until),
    String(capped),
  );
  return typeof result === "number" ? result : until;
}

/**
 * Record a rate-limit response. Retry-After is honoured when supplied;
 * otherwise a conservative default is used. A small upward jitter avoids
 * every retry waking at exactly the same instant.
 */
export async function noteCatalogueRateLimit(
  retailerId: string,
  retryAfterMs?: number,
): Promise<number> {
  const base =
    retryAfterMs && retryAfterMs > 0
      ? retryAfterMs
      : DEFAULT_CATALOGUE_COOLDOWN_MS;
  const jitter = Math.floor(Math.random() * Math.min(10_000, base * 0.1));
  return setRetailerCooldown(retailerId, base + jitter);
}
