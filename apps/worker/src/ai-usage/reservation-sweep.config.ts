/**
 * RT-664 — cadence, lookback and batch size of the AI usage reservation
 * sweep (T17).
 *
 * `AI_RESERVATION_SWEEP_INTERVAL_MS` (optional)
 *   - unset or blank → 300_000 (every 5 minutes);
 *   - otherwise a whole number of milliseconds, at least 60_000.
 * `AI_RESERVATION_SWEEP_LOOKBACK_SECONDS` (optional)
 *   - unset or blank → 2_764_800 (32 days: longer than any UTC month window,
 *     so a reservation stuck while the sweeper was down for a whole window is
 *     still found);
 *   - otherwise a whole number of seconds, at least 3_600.
 * Any other value refuses boot (resolved at module init), so a typo never
 * silently falls back to the default.
 *
 * The ledger is append-only, so `idx_ai_usage_ledger_reserved_expiry` keeps
 * every reservation ever taken. The lookback bounds each tenant's scan to the
 * reservations that expired recently; a reservation older than the lookback
 * that is still open (the sweeper was down for longer) needs a manual release.
 */

export const RESERVATION_SWEEP_INTERVAL_ENV = "AI_RESERVATION_SWEEP_INTERVAL_MS";
export const RESERVATION_SWEEP_LOOKBACK_ENV = "AI_RESERVATION_SWEEP_LOOKBACK_SECONDS";

export const DEFAULT_RESERVATION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const MIN_RESERVATION_SWEEP_INTERVAL_MS = 60 * 1000;
export const DEFAULT_RESERVATION_SWEEP_LOOKBACK_SECONDS = 32 * 24 * 3600;
export const MIN_RESERVATION_SWEEP_LOOKBACK_SECONDS = 3600;

/** Reservations released per transaction, so each one stays short. */
export const DEFAULT_RESERVATION_SWEEP_BATCH_SIZE = 200;

function resolveWhole(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, unit: string): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be a whole number of ${unit} >= ${min}`);
  }
  return value;
}

export function resolveReservationSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveWhole(env, RESERVATION_SWEEP_INTERVAL_ENV, DEFAULT_RESERVATION_SWEEP_INTERVAL_MS, MIN_RESERVATION_SWEEP_INTERVAL_MS, "milliseconds");
}

export function resolveReservationSweepLookbackSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return resolveWhole(env, RESERVATION_SWEEP_LOOKBACK_ENV, DEFAULT_RESERVATION_SWEEP_LOOKBACK_SECONDS, MIN_RESERVATION_SWEEP_LOOKBACK_SECONDS, "seconds");
}
