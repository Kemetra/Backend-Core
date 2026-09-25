/**
 * InstrumentedPool — pg.Pool subclass that emits `db_slow_query_total`
 * for every query whose wall-clock duration exceeds `SLOW_QUERY_THRESHOLD_SECONDS`.
 *
 * Design notes
 * ============
 * - Override point: `Pool.query()` is the single entry-point through which
 *   both Drizzle ORM and any direct `pool.query()` call flow. The Promise
 *   form is instrumented with a try/finally duration check; the callback
 *   form is passed through unchanged (Drizzle never uses it, and
 *   callback-form timing cannot be cleanly captured at the subclass level
 *   without rewriting the argument list).
 *
 * - `query_class` label: the parameterized SQL template text is hashed with
 *   SHA-256 and the first 8 hex digits are used as the label value. This is
 *   stable across runs (same query always produces the same class), bounded
 *   (8 hex chars), and safe (the hash is computed over the template — never
 *   over bound parameter values, which are PII-suspect per redaction matrix §3.3).
 *
 * - Threshold: 500 ms (`SLOW_QUERY_THRESHOLD_SECONDS = 0.5`). Queries whose
 *   duration is strictly less than the threshold emit nothing; queries at or
 *   above it increment the counter by 1, regardless of outcome (success or
 *   error — both indicate slow DB I/O).
 *
 * - Callback-form passthrough: the pg overload set includes three callback
 *   signatures. These are forwarded to `super.query()` without instrumentation.
 *   Any call that Drizzle or the application makes through the Promise form
 *   is fully instrumented; callback-form callers are unaffected.
 *
 * Constitution §VII / FR-B-003 / FR-B-006 / P4 W5.
 */
import { createHash } from "node:crypto";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { Pool } from "pg";

import { recordDbSlowQuery } from "./metrics/db.metrics";

// ---------------------------------------------------------------------------
// Threshold constant
// ---------------------------------------------------------------------------

/** Queries at or above this duration (seconds) increment db_slow_query_total. */
export const SLOW_QUERY_THRESHOLD_SECONDS = 0.5;

// ---------------------------------------------------------------------------
// Template hash helper
// ---------------------------------------------------------------------------

/** Pattern that every valid query_class label value must satisfy. */
const QUERY_CLASS_PATTERN = /^[0-9a-f]{8}$/;

/**
 * Stable 8-hex-char fingerprint of a parameterized SQL template.
 *
 * The hash is over the raw template text (with `$1`, `$2` … placeholders),
 * never over rendered values. An empty string (e.g. from a QueryConfig with
 * no `.text`) produces a deterministic hash rather than crashing — the caller
 * never needs to guard for undefined.
 */
export function hashQueryTemplate(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 8);
}

/**
 * Returns true when `value` is a safe query_class label: exactly 8 lowercase
 * hex characters. Anything else is rejected to prevent raw SQL fragments,
 * error text, or PII from reaching the metric label (FR-B-006 / §XIV).
 */
export function isValidQueryClass(value: string): boolean {
  return QUERY_CLASS_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Instrumented subclass
// ---------------------------------------------------------------------------

/**
 * pg.Pool subclass that hooks the Promise form of `query()` to emit
 * `db_slow_query_total` when a query exceeds the 500 ms threshold.
 *
 * Pass an instance of this class wherever a `pg.Pool` is accepted.
 * The subclass is transparent to Drizzle and to any caller that uses
 * the Promise API; callback-form callers receive the unmodified base
 * behaviour.
 */
export class InstrumentedPool extends Pool {
  /**
   * Instruments the Promise form of `pool.query()`.
   * Callback forms are forwarded to `super.query()` without instrumentation.
   */
  override query<R extends QueryResultRow = QueryResultRow>(
    queryTextOrConfig: string | QueryConfig,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
  override query<R extends QueryResultRow = QueryResultRow>(
    queryTextOrConfig: string | QueryConfig,
    callback: (err: Error, result: QueryResult<R>) => void,
  ): void;
  override query<R extends QueryResultRow = QueryResultRow>(
    queryTextOrConfig: string,
    values: unknown[],
    callback: (err: Error, result: QueryResult<R>) => void,
  ): void;
  override query<R extends QueryResultRow = QueryResultRow>(
    queryTextOrConfig: string | QueryConfig,
    valuesOrCallback?: unknown[] | ((err: Error, result: QueryResult<R>) => void),
    callback?: (err: Error, result: QueryResult<R>) => void,
  ): Promise<QueryResult<R>> | void {
    // Callback form — pass through without instrumentation.
    if (typeof valuesOrCallback === "function" || typeof callback === "function") {
      return super.query(
        queryTextOrConfig as string,
        valuesOrCallback as unknown[],
        callback as (err: Error, result: QueryResult<R>) => void,
      );
    }

    // Promise form — instrument with duration check.
    const text =
      typeof queryTextOrConfig === "string"
        ? queryTextOrConfig
        : (queryTextOrConfig.text ?? "");
    const start = performance.now();

    return (super.query(queryTextOrConfig as string, valuesOrCallback) as Promise<QueryResult<R>>).then(
      (result) => {
        const durationSeconds = (performance.now() - start) / 1000;
        if (durationSeconds >= SLOW_QUERY_THRESHOLD_SECONDS) {
          const queryClass = hashQueryTemplate(text);
          if (isValidQueryClass(queryClass)) {
            recordDbSlowQuery({ query_class: queryClass });
          }
        }
        return result;
      },
      (err: unknown) => {
        const durationSeconds = (performance.now() - start) / 1000;
        if (durationSeconds >= SLOW_QUERY_THRESHOLD_SECONDS) {
          const queryClass = hashQueryTemplate(text);
          if (isValidQueryClass(queryClass)) {
            recordDbSlowQuery({ query_class: queryClass });
          }
        }
        throw err;
      },
    );
  }
}
