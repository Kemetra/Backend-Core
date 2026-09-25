/**
 * InstrumentedPool — pg.Pool subclass that emits `db_slow_query_total`
 * for every query whose wall-clock duration exceeds `SLOW_QUERY_THRESHOLD_SECONDS`.
 *
 * Mirrors `apps/api/src/observability/instrumented-pool.ts` exactly except
 * for the `recordDbSlowQuery` import, which comes from the worker's own
 * metrics module so the metric is registered on the worker's OTel Meter
 * (port 9091) rather than the API's (port 9464).
 *
 * See the API counterpart for full design notes.
 *
 * Constitution §VII / FR-B-003 / FR-B-006 / P4 W5.
 */
import { createHash } from "node:crypto";
import type { QueryConfig, QueryResult, QueryResultRow } from "pg";
import { Pool } from "pg";

import { recordDbSlowQuery } from "./metrics/worker.metrics";

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
 * never over rendered values. An empty string produces a deterministic hash.
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
 */
export class InstrumentedPool extends Pool {
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
    if (typeof valuesOrCallback === "function" || typeof callback === "function") {
      return super.query(
        queryTextOrConfig as string,
        valuesOrCallback as unknown[],
        callback as (err: Error, result: QueryResult<R>) => void,
      );
    }

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
