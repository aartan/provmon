/**
 * Cadence for checks that exist only to feed inventory historical alerts.
 * Subscription-driven checks keep their own faster cadence; this is the
 * fallback for alert-only inventory items.
 */
export const DEFAULT_ALERT_CHECK_INTERVAL_MINUTES = 1440;

export function alertCheckIntervalMinutes(): number {
  const raw = process.env.ALERT_CHECK_INTERVAL_MINUTES;
  if (!raw) {
    return DEFAULT_ALERT_CHECK_INTERVAL_MINUTES;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ALERT_CHECK_INTERVAL_MINUTES;
}
