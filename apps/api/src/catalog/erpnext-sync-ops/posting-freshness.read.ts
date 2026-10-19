/**
 * RT-565 — posting freshness for the console sync-ops summary
 * (`console-sync-ops.yaml` 1.2.0-draft, D1–D7 of
 * `docs/planning/rt-565-posting-freshness-read.md`).
 *
 * Facts only, no current/behind verdict (D5): the latest ERP posting
 * confirmation, the pending posting-intent count and the oldest pending
 * intent's creation instant and age.
 *
 * ONE statement (D6). `runWithTenantContext` runs at READ COMMITTED, so each
 * statement takes its own snapshot; every fact comes from the same statement so
 * they cannot contradict each other, and `as_of` is `clock_timestamp()` taken
 * inside it, after its snapshot. Every visible row was committed before that
 * snapshot and its `created_at` / `posted_at` is its writer's `now()`, so every
 * returned timestamp is at or before `as_of`. The volatile `clock_timestamp()`
 * sits in an `OFFSET 0` subquery (never flattened), so it is evaluated once and
 * the age is computed against that one value; `GREATEST(0, …)` guards a clock
 * step.
 *
 * Each probe is shaped for one 0057–0061 partial index (D7): tenant-wide reads
 * use the tenant-first indexes; a store filter or a membership scope runs one
 * `LATERAL … LIMIT 1` probe per store on the store-first indexes. Tenant RLS
 * (fail-closed) supplies `tenant_id` to every probe.
 */
import type { PoolClient } from "pg";

/** The latest ERP posting confirmation in scope (contract `LastPosted`). */
export interface LastPosted {
  readonly state: "known" | "unknown" | "none";
  readonly at: string | null;
}

/** Contract `PostingFreshness`. */
export interface PostingFreshness {
  readonly lastPosted: LastPosted;
  readonly pendingCount: number;
  readonly oldestPendingAt: string | null;
  readonly oldestPendingAgeSeconds: number | null;
}

export interface PostingFreshnessRead {
  readonly asOf: string;
  readonly postingFreshness: PostingFreshness;
}

interface FreshnessRow {
  as_of: Date;
  last_posted_at: Date | null;
  any_legacy_posted: boolean | null;
  oldest_pending_at: Date | null;
  oldest_pending_age_seconds: string | null;
  pending_count: string;
}

// The outer query reads the one `as_of` value; `OFFSET 0` keeps the inner
// query (and its volatile clock_timestamp()) from being pulled up and
// re-evaluated per reference.
const OUTER_SELECT = `
SELECT f.as_of, f.last_posted_at, f.any_legacy_posted, f.oldest_pending_at,
       CASE WHEN f.oldest_pending_at IS NULL THEN NULL
            ELSE GREATEST(0, floor(extract(epoch FROM f.as_of - f.oldest_pending_at)))::bigint::text
       END AS oldest_pending_age_seconds,
       f.pending_count::text AS pending_count
  FROM (%INNER% OFFSET 0) f`;

// Tenant-wide (no store filter, tenant-wide membership): one probe per fact on
// the tenant-first indexes 0057 / 0059 / 0061.
const TENANT_INNER = `
SELECT clock_timestamp() AS as_of,
       (SELECT e.posted_at FROM erpnext_posting_status e
         WHERE e.posted_at IS NOT NULL
         ORDER BY e.posted_at DESC LIMIT 1) AS last_posted_at,
       EXISTS (SELECT 1 FROM erpnext_posting_status e
                WHERE e.status = 'posted' AND e.posted_at IS NULL) AS any_legacy_posted,
       (SELECT e.created_at FROM erpnext_posting_status e
         WHERE e.status = 'pending'
         ORDER BY e.created_at LIMIT 1) AS oldest_pending_at,
       (SELECT count(*) FROM erpnext_posting_status e
         WHERE e.status = 'pending') AS pending_count`;

// Store-scoped ($1 = the stores in scope; empty reads nothing): one probe per
// store on the store-first indexes 0058 / 0060 / 0061, then the max / min.
const STORES_INNER = `
SELECT clock_timestamp() AS as_of,
       (SELECT max(p.posted_at)
          FROM unnest($1::uuid[]) AS s(store_id)
          CROSS JOIN LATERAL (
            SELECT e.posted_at FROM erpnext_posting_status e
             WHERE e.store_id = s.store_id AND e.posted_at IS NOT NULL
             ORDER BY e.posted_at DESC LIMIT 1) p) AS last_posted_at,
       EXISTS (SELECT 1 FROM erpnext_posting_status e
                WHERE e.status = 'posted' AND e.posted_at IS NULL
                  AND e.store_id = ANY($1::uuid[])) AS any_legacy_posted,
       (SELECT min(p.created_at)
          FROM unnest($1::uuid[]) AS s(store_id)
          CROSS JOIN LATERAL (
            SELECT e.created_at FROM erpnext_posting_status e
             WHERE e.store_id = s.store_id AND e.status = 'pending'
             ORDER BY e.created_at LIMIT 1) p) AS oldest_pending_at,
       (SELECT count(*) FROM erpnext_posting_status e
         WHERE e.status = 'pending' AND e.store_id = ANY($1::uuid[])) AS pending_count`;

export const TENANT_FRESHNESS_SQL = OUTER_SELECT.replace("%INNER%", TENANT_INNER);
export const STORES_FRESHNESS_SQL = OUTER_SELECT.replace("%INNER%", STORES_INNER);

/**
 * The stores a freshness read covers: null = tenant-wide; otherwise the one
 * filtered store (only if inside the membership scope) or the membership
 * scope's stores. The same filters as the summary's posting leg (D4).
 */
export function freshnessStores(
  storeId: string | null,
  scoped: readonly string[] | null,
): readonly string[] | null {
  if (storeId === null) return scoped;
  if (scoped === null) return [storeId];
  return scoped.includes(storeId.toLowerCase()) ? [storeId] : [];
}

/** Read the posting freshness facts. `client` must run under the tenant's context. */
export async function readPostingFreshness(
  client: PoolClient,
  stores: readonly string[] | null,
): Promise<PostingFreshnessRead> {
  const res =
    stores === null
      ? await client.query<FreshnessRow>(TENANT_FRESHNESS_SQL)
      : await client.query<FreshnessRow>(STORES_FRESHNESS_SQL, [stores]);
  const row = res.rows[0]!;
  const pendingCount = Number(row.pending_count);

  // D3: `unknown` only when posted rows exist in scope but none carries
  // posted_at (all predate 0042); updated_at is never substituted.
  const lastPosted: LastPosted =
    row.last_posted_at !== null
      ? { state: "known", at: row.last_posted_at.toISOString() }
      : { state: row.any_legacy_posted ? "unknown" : "none", at: null };

  return {
    asOf: row.as_of.toISOString(),
    postingFreshness: {
      lastPosted,
      pendingCount,
      oldestPendingAt: row.oldest_pending_at ? row.oldest_pending_at.toISOString() : null,
      oldestPendingAgeSeconds:
        row.oldest_pending_age_seconds !== null ? Number(row.oldest_pending_age_seconds) : null,
    },
  };
}
