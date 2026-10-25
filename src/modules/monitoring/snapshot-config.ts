/**
 * Snapshot cadence configuration shared by the API, UI, and check engine.
 *
 * Snapshots do not represent price changes: they extend the known duration
 * of an unchanged state. `0` disables unchanged snapshots.
 */
export const DEFAULT_SNAPSHOT_INTERVAL_MINUTES = 1440;

/** Suggested values for the add-product UI; the API accepts any minute value. */
export const SNAPSHOT_INTERVAL_OPTIONS_MINUTES = [
  0,
  360,
  720,
  1440,
  4320,
  10080,
] as const;

export function formatSnapshotInterval(minutes: number): string {
  if (minutes <= 0) {
    return "Off";
  }
  if (minutes < 60) {
    return `Every ${minutes} minutes`;
  }
  if (minutes === 60) {
    return "Hourly";
  }
  if (minutes < 1440) {
    return `Every ${Math.round(minutes / 60)} hours`;
  }
  if (minutes === 1440) {
    return "Daily";
  }
  if (minutes % 1440 === 0) {
    return `Every ${minutes / 1440} days`;
  }
  return `Every ${Math.round(minutes / 60)} hours`;
}
