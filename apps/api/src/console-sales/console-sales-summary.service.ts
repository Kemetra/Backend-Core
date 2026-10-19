/**
 * ConsoleSalesSummaryService — RT-649 (BC-009-1): the deterministic sales
 * summary (`console-sales-summary.openapi.yaml` 1.0.0-draft) for
 * Admin-Console spec 009 P-6 and a future Daily Briefing. Read only.
 *
 * DATA ACCESS — raw parameterized SQL under `runWithTenantContext` (tenant
 * RLS). Every figure is counted and summed in Postgres; the projection only
 * adds the per-group sums together (exact BigInt decimals).
 *
 * Invariants:
 *   - Tenant: RLS plus an explicit `tenant_id` predicate on every table; the
 *     tenant is the session's, never the request's (§II, §XII).
 *   - Store: the sales / voids / returns / refunds / shift-closes RLS policies
 *     are tenant-only, so the operator-surface store scope
 *     (`operator-store-scope.ts`, the `console-sales` rule) is applied here:
 *     the scoped store set is the `st` CTE, and every fact joins it. A
 *     `store_id` outside the scope, or not a store of the tenant, is
 *     `StoreNotInScopeError` (→ 404). An empty scope matches nothing.
 *   - One snapshot: every fact and every store of the scope is read by ONE
 *     statement, so the store figures and the scope totals always agree.
 *     `asOf` is `clock_timestamp()` read after it (the `console-sales` rule).
 *   - Business date: sales, voids and returns carry a stored business date;
 *     legacy refunds and shift closes are bucketed by the local date of their
 *     instant in the store's current IANA timezone (`AT TIME ZONE`, the tz
 *     database: DST days are 23 or 25 hours). A ±1 day UTC window keeps that
 *     predicate on a bounded slice; the local date decides membership.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { MembershipRepository } from "../context/membership.repository";
import { callerStoreScope, inStoreScope, scopeStoreIds } from "../context/operator-store-scope";
import {
  assembleSummary,
  type ConsoleSalesSummary,
  type SummaryFactRow,
  type SummaryStoreRow,
} from "./console-sales-summary.projections";
import {
  businessDatesOf,
  decodeSalesSummaryCursor,
  encodeSalesSummaryCursor,
  type SummaryCursorBinding,
} from "./console-sales-summary.query";
import { StoreNotInScopeError, type ScopedReadInput } from "./console-sales.service";

export interface SalesSummaryInput extends ScopedReadInput {
  /** Lower case; null for every store in the caller's scope. */
  readonly storeId: string | null;
  readonly from: string;
  readonly to: string;
  readonly cursor: string | null;
  readonly pageSize: number;
}

/**
 * $1 tenant, $2 scoped store ids (null = every store of the tenant), $3 from,
 * $4 to. One row per scoped store (`kind = 'store'`), then one row per fact
 * group. The UTC window `[from - 1 day, to + 2 days)` contains every instant
 * whose local date in any zone (offsets are within ±14 h) lies in the range.
 */
const SUMMARY_SQL = `
  WITH st AS MATERIALIZED (
    SELECT id, timezone FROM stores
     WHERE tenant_id = $1::uuid AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
  ),
  win AS (
    SELECT ($3::date - 1)::timestamp AT TIME ZONE 'UTC' AS lo,
           ($4::date + 2)::timestamp AT TIME ZONE 'UTC' AS hi
  )
  SELECT 'store' AS kind, st.id::text AS store_id, st.timezone AS timezone, NULL::text AS business_date,
         NULL::text AS currency_code, NULL::text AS k1, NULL::text AS k2, NULL::text AS k3,
         0 AS n, NULL::text AS amount
    FROM st
  UNION ALL
  SELECT 'sale', s.store_id::text, NULL, s.business_date::text, s.currency_code::text, s.sync_status, p.status, NULL,
         count(*)::int, sum(s.pos_total)::text
    FROM sales s
    JOIN st ON st.id = s.store_id
    LEFT JOIN erpnext_posting_status p
           ON p.tenant_id = s.tenant_id AND p.kind = 'sale_post' AND p.source_ref_id = s.id
   WHERE s.tenant_id = $1::uuid AND s.business_date BETWEEN $3::date AND $4::date
   GROUP BY s.store_id, s.business_date, s.currency_code, s.sync_status, p.status
  UNION ALL
  SELECT 'void', v.store_id::text, NULL, v.business_date::text, s.currency_code::text, NULL, NULL, NULL,
         count(*)::int, sum(s.pos_total)::text
    FROM sale_voids v
    JOIN st ON st.id = v.store_id
    JOIN sales s ON s.id = v.sale_id AND s.tenant_id = v.tenant_id AND s.store_id = v.store_id
   WHERE v.tenant_id = $1::uuid AND v.business_date BETWEEN $3::date AND $4::date
   GROUP BY v.store_id, v.business_date, s.currency_code
  UNION ALL
  SELECT 'return', r.store_id::text, NULL, r.business_date::text, r.currency_code::text, NULL, NULL, NULL,
         count(*)::int, sum(r.return_total)::text
    FROM sale_returns r
    JOIN st ON st.id = r.store_id
   WHERE r.tenant_id = $1::uuid AND r.business_date BETWEEN $3::date AND $4::date
   GROUP BY r.store_id, r.business_date, r.currency_code
  UNION ALL
  SELECT 'refund', g.store_id::text, NULL, g.local_date::text, g.currency_code::text, NULL, NULL, NULL,
         count(*)::int, sum(g.amount)::text
    FROM (SELECT f.store_id, f.currency_code, f.pos_refund_amount AS amount,
                 (f.refunded_at AT TIME ZONE st.timezone)::date AS local_date
            FROM sale_refunds f
            JOIN st ON st.id = f.store_id
            CROSS JOIN win
           WHERE f.tenant_id = $1::uuid AND f.refunded_at >= win.lo AND f.refunded_at < win.hi) g
   WHERE g.local_date BETWEEN $3::date AND $4::date
   GROUP BY g.store_id, g.local_date, g.currency_code
  UNION ALL
  SELECT 'close', g.store_id::text, NULL, g.local_date::text, NULL, g.close_kind, g.approval_missing,
         g.with_variance::text, count(*)::int, NULL
    FROM (SELECT c.store_id, c.close_kind, c.approval_missing, c.variance <> 0 AS with_variance,
                 (c.closed_at AT TIME ZONE st.timezone)::date AS local_date
            FROM shift_closes c
            JOIN st ON st.id = c.store_id
            CROSS JOIN win
           WHERE c.tenant_id = $1::uuid AND c.closed_at >= win.lo AND c.closed_at < win.hi) g
   WHERE g.local_date BETWEEN $3::date AND $4::date
   GROUP BY g.store_id, g.local_date, g.close_kind, g.approval_missing, g.with_variance`;

/** Each zone's local date at `asOf` ($1), for `currentBusinessDate`. */
const CURRENT_DATES_SQL = `
  SELECT tz, (($1::timestamptz) AT TIME ZONE tz)::date::text AS local_date
    FROM unnest($2::text[]) AS tz`;

/** A scoped store (`kind = 'store'`, `timezone` set) or a fact group (`timezone` null). */
interface RawRow extends Omit<SummaryFactRow, "kind"> {
  readonly kind: SummaryFactRow["kind"] | "store";
  readonly timezone: string | null;
}

@Injectable()
export class ConsoleSalesSummaryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /**
   * The summary page. The cursor is decoded (400 on a foreign token) before
   * any read; the caller's store scope is resolved on every request.
   */
  async summary(input: SalesSummaryInput): Promise<ConsoleSalesSummary> {
    const binding: SummaryCursorBinding = {
      tenantId: input.tenantId,
      storeId: input.storeId,
      from: input.from,
      to: input.to,
      pageSize: input.pageSize,
    };
    const after = input.cursor === null ? null : decodeSalesSummaryCursor(binding, input.cursor);
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) => {
      const storeIds = await this.scopedStoreIds(client, input);
      const raw = await client.query<RawRow>(SUMMARY_SQL, [input.tenantId, storeIds, input.from, input.to]);
      const storeRows = raw.rows.filter((r) => r.kind === "store");
      // A store_id that is not a store of this tenant reads no store row.
      if (input.storeId !== null && storeRows.length === 0) throw new StoreNotInScopeError();
      const facts = raw.rows.filter((r) => r.kind !== "store") as SummaryFactRow[];

      const asOf = await this.readClock(client);
      const stores = await this.withLocalDates(client, asOf, storeRows);

      const assembled = assembleSummary({
        scope: input.storeId === null ? "all_in_scope" : "store",
        storeRef: input.storeId,
        from: input.from,
        to: input.to,
        dates: businessDatesOf(input.from, input.to),
        asOf: asOf.toISOString(),
        stores,
        facts,
        after,
        pageSize: input.pageSize,
      });
      return {
        ...assembled.body,
        nextCursor: assembled.resumeAfter === null ? null : encodeSalesSummaryCursor(binding, assembled.resumeAfter),
      };
    });
  }

  /** The one in-scope `store_id`, else the caller's scoped stores (null = tenant-wide). */
  private async scopedStoreIds(client: PoolClient, input: SalesSummaryInput): Promise<readonly string[] | null> {
    const scope = await callerStoreScope(client, this.memberships, input);
    if (input.storeId === null) return scopeStoreIds(scope);
    if (!inStoreScope(scope, input.storeId)) throw new StoreNotInScopeError();
    return [input.storeId];
  }

  /** `asOf`: the server clock after the snapshot was read. */
  private async readClock(client: PoolClient): Promise<Date> {
    const r = await client.query<{ as_of: Date }>(`SELECT clock_timestamp() AS as_of`);
    return r.rows[0]!.as_of;
  }

  /** Each scoped store with its local date at `asOf` (`currentBusinessDate`). */
  private async withLocalDates(client: PoolClient, asOf: Date, storeRows: readonly RawRow[]): Promise<SummaryStoreRow[]> {
    const zones = [...new Set(storeRows.map((r) => r.timezone!))];
    if (zones.length === 0) return [];
    const r = await client.query<{ tz: string; local_date: string }>(CURRENT_DATES_SQL, [asOf, zones]);
    const today = new Map(r.rows.map((row) => [row.tz, row.local_date]));
    return storeRows.map((row) => ({
      store_id: row.store_id,
      timezone: row.timezone!,
      current_business_date: today.get(row.timezone!)!,
    }));
  }
}
