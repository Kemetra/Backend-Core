/**
 * RT-209 — cadence and batch size of the cashier-admission replay purge.
 *
 * `CASHIER_ADMISSION_REPLAY_PURGE_INTERVAL_MS` (optional)
 *   - unset or blank → 3_600_000 (hourly);
 *   - otherwise a whole number of milliseconds, at least 60_000 (1 minute).
 * Any other value refuses boot (the scheduler resolves it at module init), so
 * a typo never silently falls back to the default.
 *
 * A replay row is useless once it expires (the api replays only while
 * `expires_at` is in the future, and the window is at most one admission TTL),
 * so the interval bounds how long an expired copy of a cashier's display name
 * can outlive its replay window.
 */

export const REPLAY_PURGE_INTERVAL_ENV = "CASHIER_ADMISSION_REPLAY_PURGE_INTERVAL_MS";

export const DEFAULT_REPLAY_PURGE_INTERVAL_MS = 60 * 60 * 1000;

export const MIN_REPLAY_PURGE_INTERVAL_MS = 60 * 1000;

/** Rows deleted per statement, so each transaction stays short. */
export const DEFAULT_REPLAY_PURGE_BATCH_SIZE = 500;

/** The configured purge interval in ms. Throws on an invalid value. */
export function resolveReplayPurgeIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[REPLAY_PURGE_INTERVAL_ENV] ?? "").trim();
  if (raw === "") return DEFAULT_REPLAY_PURGE_INTERVAL_MS;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < MIN_REPLAY_PURGE_INTERVAL_MS) {
    throw new Error(
      `${REPLAY_PURGE_INTERVAL_ENV} must be a whole number of milliseconds ` +
        `>= ${MIN_REPLAY_PURGE_INTERVAL_MS}`,
    );
  }
  return value;
}
