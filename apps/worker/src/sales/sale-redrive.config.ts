/**
 * RT-457 — cadence and age threshold of the sale re-drive sweep.
 *
 * `SALE_REDRIVE_INTERVAL_MS` (optional): how often the sweep runs.
 *   - unset or blank → 300_000 (5 minutes);
 *   - otherwise a whole number of milliseconds, at least 60_000.
 * `SALE_REDRIVE_MIN_AGE_MS` (optional): how old a stranded item must be before
 * the sweep touches it, so the live pipeline (outbox drain → BullMQ
 * sale-processing → posting consumer) always gets the first chance.
 *   - unset or blank → 900_000 (15 minutes);
 *   - otherwise a whole number of milliseconds, at least 60_000.
 * `SALE_REDRIVE_MAX_AGE_MS` (optional): items OLDER than this are never
 * re-driven automatically, so history from before the posting pipeline (or a
 * long-forgotten lab sale) is never posted to ERPNext by surprise.
 *   - unset or blank → 604_800_000 (7 days);
 *   - otherwise a whole number of milliseconds, greater than the minimum age.
 * Any other value refuses boot, so a typo never silently changes behaviour.
 */

export const SALE_REDRIVE_INTERVAL_ENV = "SALE_REDRIVE_INTERVAL_MS";
export const SALE_REDRIVE_MIN_AGE_ENV = "SALE_REDRIVE_MIN_AGE_MS";

export const DEFAULT_SALE_REDRIVE_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_SALE_REDRIVE_MIN_AGE_MS = 15 * 60 * 1000;
export const SALE_REDRIVE_MAX_AGE_ENV = "SALE_REDRIVE_MAX_AGE_MS";
export const DEFAULT_SALE_REDRIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_SALE_REDRIVE_MS = 60 * 1000;

/** Most items of each kind the sweep re-drives per tenant per tick. */
export const SALE_REDRIVE_BATCH_LIMIT = 100;

/**
 * A posting intent is re-emitted only after its event dead-lettered, and only
 * while fewer than this many of its events have dead-lettered: an intent the
 * consumer can never accept stops after this many attempts instead of looping.
 */
export const SALE_REDRIVE_MAX_DEAD_LETTERS = 3;

/** The age window an item must fall in to be re-driven. */
export interface SaleRedriveWindow {
  readonly minAgeMs: number;
  readonly maxAgeMs: number;
}

function resolveMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < MIN_SALE_REDRIVE_MS) {
    throw new Error(`${name} must be a whole number of milliseconds >= ${MIN_SALE_REDRIVE_MS}`);
  }
  return value;
}

/** The configured sweep interval in ms. Throws on an invalid value. */
export function resolveSaleRedriveIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveMs(env, SALE_REDRIVE_INTERVAL_ENV, DEFAULT_SALE_REDRIVE_INTERVAL_MS);
}

/** The configured minimum age in ms. Throws on an invalid value. */
export function resolveSaleRedriveMinAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  return resolveMs(env, SALE_REDRIVE_MIN_AGE_ENV, DEFAULT_SALE_REDRIVE_MIN_AGE_MS);
}

/** The configured age window. Throws on an invalid value or max <= min. */
export function resolveSaleRedriveWindow(env: NodeJS.ProcessEnv = process.env): SaleRedriveWindow {
  const minAgeMs = resolveSaleRedriveMinAgeMs(env);
  const maxAgeMs = resolveMs(env, SALE_REDRIVE_MAX_AGE_ENV, DEFAULT_SALE_REDRIVE_MAX_AGE_MS);
  if (maxAgeMs <= minAgeMs) {
    throw new Error(`${SALE_REDRIVE_MAX_AGE_ENV} must be greater than ${SALE_REDRIVE_MIN_AGE_ENV}`);
  }
  return { minAgeMs, maxAgeMs };
}
