/**
 * Parse an HTTP Retry-After header into milliseconds.
 *
 * The header can be either a number of seconds or an HTTP date. Invalid or
 * absent values return undefined so callers can apply their own default.
 */
export function parseRetryAfterHeader(
  value: string | null | undefined,
): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }
  return Math.max(0, timestamp - Date.now());
}
