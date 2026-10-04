/**
 * RT-179 — cadence of the scheduled ERPNext stock reconciliation run sweep.
 *
 * `ERPNEXT_STOCK_RECONCILIATION_SWEEP_INTERVAL_MS` (optional)
 *   - unset or blank → 86_400_000 (daily);
 *   - otherwise a whole number of milliseconds, at least 300_000 (5 minutes,
 *     the connector bin-view poll cadence — a shorter period would only
 *     produce `skipped_running` ticks).
 * Any other value refuses boot (the scheduler and the sweep processor both
 * resolve it at construction), so a typo never silently falls back to daily.
 *
 * The interval is also the idempotency PERIOD: periods are aligned to the Unix
 * epoch (`floor(now / interval) * interval`), and a store gets at most one
 * scheduled run per period.
 */

export const STOCK_RUN_SWEEP_INTERVAL_ENV = "ERPNEXT_STOCK_RECONCILIATION_SWEEP_INTERVAL_MS";

export const DEFAULT_STOCK_RUN_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const MIN_STOCK_RUN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** The configured sweep interval in ms. Throws on an invalid value. */
export function resolveStockRunSweepIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = (env[STOCK_RUN_SWEEP_INTERVAL_ENV] ?? "").trim();
  if (raw === "") return DEFAULT_STOCK_RUN_SWEEP_INTERVAL_MS;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < MIN_STOCK_RUN_SWEEP_INTERVAL_MS) {
    throw new Error(
      `${STOCK_RUN_SWEEP_INTERVAL_ENV} must be a whole number of milliseconds ` +
        `>= ${MIN_STOCK_RUN_SWEEP_INTERVAL_MS}`,
    );
  }
  return value;
}

/** Start of the sweep period containing `now` (epoch-aligned). */
export function sweepPeriodStart(now: Date, intervalMs: number): Date {
  return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
}

/**
 * One sweep tick: the period it belongs to and the tick time itself. `now`
 * becomes a created run's `started_at`; `start` bounds the period check.
 */
export interface SweepPeriod {
  readonly start: Date;
  readonly now: Date;
}

export function sweepPeriod(now: Date, intervalMs: number): SweepPeriod {
  return { start: sweepPeriodStart(now, intervalMs), now };
}
