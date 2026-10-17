/**
 * ShiftClosesReadService — RT-383 (AD-CASH-001 follow-up 4): the admin read
 * of recorded RT-17 shift closes (`shift-closes.openapi.yaml`) that
 * Admin-Console RT-18 consumes.
 *
 * Read only: nothing here writes a shift, a close or a movement, and the
 * POS-facing shift operations are untouched.
 *
 * DATA ACCESS — raw parameterized SQL under `runWithTenantContext`, as on the
 * sibling Console read models (`SaleSyncOpsReadModelService`,
 * `ErpnextSyncOpsReadModelService`).
 *
 * Invariants:
 *   - Tenant: RLS (FORCE, `0036_shift_cash_up`) plus an explicit
 *     `tenant_id` predicate on every read. The tenant is the session's, never
 *     the request's (§II, §XII).
 *   - Store: the operator-surface store scope (`operator-store-scope.ts`,
 *     RT-51 D6 / RT-131 / RT-193) is a `store_id` predicate on the list and the
 *     detail, so out-of-scope rows are skipped in SQL (pages stay full and the
 *     keyset stays gap-free) and an out-of-scope close reads as absent. An
 *     empty scope matches nothing (fail closed). A `store_id` filter outside
 *     the scope is `StoreNotInScopeError` (→ the same non-disclosing 404).
 *   - Only recorded closes exist here: an open, legacy or undrained shift has
 *     no `shift_closes` row, so it is never listed and its detail is a 404.
 *   - Order: `closed_at DESC, shift_id DESC`, a total order over immutable
 *     rows; the keyset compares the full-precision `closed_at`.
 *   - RT-387: every close carries the shift's frozen policy (the 1:1 shift
 *     join), the derived `approvalRequiredByPolicy` / `approvalMissing` and
 *     the persisted `approverCheck` (the verdict row, else the
 *     not_applicable / check_unavailable rule), and the list filters on them.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { MembershipRepository } from "../context/membership.repository";
import { callerStoreScope, inStoreScope, scopeStoreIds } from "../context/operator-store-scope";
import type { StoreScope } from "../context/store-scope";
import type { ResolvedContext } from "../context/types";
import { FROZEN_POLICY_COLUMNS } from "../pos-shifts/shift-frozen-policy";
import {
  CLOSED_AT_KEY_SQL,
  decodeShiftCloseCursor,
  encodeShiftCloseCursor,
  toShiftCloseDetail,
  toShiftCloseSummary,
  type ShiftCashMovementReadRow,
  type ShiftCloseDetail,
  type ShiftCloseDetailRow,
  type ShiftClosePage,
  type ShiftCloseReadRow,
} from "./shift-closes.projections";

/** A recorded close that is absent, foreign, out of scope or not closed → 404. */
export class ShiftCloseNotFoundError extends Error {
  constructor() {
    super("shift close not found");
    this.name = "ShiftCloseNotFoundError";
  }
}

/** A `store_id` filter outside the caller's scope, or of another tenant → 404. */
export class StoreNotInScopeError extends Error {
  constructor() {
    super("store not found");
    this.name = "StoreNotInScopeError";
  }
}

/** The session context of a read; its store scope bounds the closes. */
export interface ScopedReadInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
}

/** The list filters, already validated (`ShiftCloseListQuerySchema`). */
export interface ShiftCloseListFilters {
  readonly storeId?: string;
  /** RFC 3339, inclusive. */
  readonly closedFrom?: string;
  /** RFC 3339, exclusive. */
  readonly closedTo?: string;
  readonly closeKind?: "normal" | "forced";
  /** Exact-decimal string. */
  readonly minAbsVariance?: string;
  readonly currencyCode?: string;
  readonly approval?: "approved" | "not_approved";
  /** RT-387: the derived tri-states and the persisted approver check. */
  readonly approvalRequired?: "yes" | "no" | "unknown";
  readonly approvalMissing?: "yes" | "no" | "unknown";
  readonly approverCheck?: "not_applicable" | "verified" | "unverified";
}

export interface ListShiftClosesInput extends ScopedReadInput {
  readonly filters: ShiftCloseListFilters;
  /** Opaque cursor from a prior page, or null for the first page. */
  readonly cursor: string | null;
  readonly limit: number;
}

const CLOSE_COLUMNS = `
  c.shift_id, c.store_id, c.currency_code, c.closed_at,
  ${CLOSED_AT_KEY_SQL} AS closed_at_key,
  c.close_kind, c.forced_reason, c.closing_user_id, c.variance_approved_by_user_id,
  c.opening_float::text AS opening_float, c.cash_sales_total::text AS cash_sales_total,
  c.cash_refunds_total::text AS cash_refunds_total, c.pay_in_total::text AS pay_in_total,
  c.pay_out_total::text AS pay_out_total, c.expected_cash::text AS expected_cash,
  c.counted_cash::text AS counted_cash, c.variance::text AS variance,
  c.sale_count, c.received_at,
  c.approval_required_by_policy, c.approval_missing,
  v.status AS verdict_status, v.reason AS verdict_reason,
  ${FROZEN_POLICY_COLUMNS}`;

/**
 * The close, its shift (1:1, the frozen policy) and its approver verdict, if
 * any. Every join is on the close's own tenant (and store), never wider.
 */
const CLOSE_FROM = `
    FROM shift_closes c
    JOIN shifts s
      ON s.shift_id = c.shift_id AND s.tenant_id = c.tenant_id AND s.store_id = c.store_id
    LEFT JOIN shift_close_approver_checks v
      ON v.shift_id = c.shift_id AND v.tenant_id = c.tenant_id`;

/** The persisted `approverCheck.status` of a close (the contract's placeholder rule included). */
const APPROVER_CHECK_SQL = `CASE WHEN c.variance_approved_by_user_id IS NULL THEN 'not_applicable'
            ELSE COALESCE(v.status, 'unverified') END`;

/**
 * $1 tenant, $2 scoped store ids (null = tenant-wide), $3 store filter,
 * $4 closed_from, $5 closed_to, $6 close kind, $7 min |variance|, $8 currency,
 * $9 approval, $10 / $11 keyset (closed_at, shift_id), $12 limit,
 * $13 approval_required, $14 approval_missing, $15 approver_check (RT-387).
 */
const LIST_SQL = `
  SELECT ${CLOSE_COLUMNS}
  ${CLOSE_FROM}
   WHERE c.tenant_id = $1::uuid
     AND ($2::uuid[] IS NULL OR c.store_id = ANY($2::uuid[]))
     AND ($3::uuid IS NULL OR c.store_id = $3::uuid)
     AND ($4::timestamptz IS NULL OR c.closed_at >= $4::timestamptz)
     AND ($5::timestamptz IS NULL OR c.closed_at < $5::timestamptz)
     AND ($6::text IS NULL OR c.close_kind = $6::text)
     AND ($7::numeric IS NULL OR abs(c.variance) >= $7::numeric)
     AND ($8::text IS NULL OR c.currency_code = $8::text)
     AND ($9::text IS NULL
          OR ($9::text = 'approved') = (c.variance_approved_by_user_id IS NOT NULL))
     AND ($13::text IS NULL OR c.approval_required_by_policy = $13::text)
     AND ($14::text IS NULL OR c.approval_missing = $14::text)
     AND ($15::text IS NULL OR ${APPROVER_CHECK_SQL} = $15::text)
     AND ($10::timestamptz IS NULL OR (c.closed_at, c.shift_id) < ($10::timestamptz, $11::uuid))
   ORDER BY c.closed_at DESC, c.shift_id DESC
   LIMIT $12`;

/** $1 shift, $2 tenant, $3 scoped store ids (null = tenant-wide). */
const DETAIL_SQL = `
  SELECT ${CLOSE_COLUMNS},
         s.opened_at, s.opening_cashier_user_id AS opening_user_id,
         c.recorded_by_user_id
  ${CLOSE_FROM}
   WHERE c.shift_id = $1::uuid
     AND c.tenant_id = $2::uuid
     AND ($3::uuid[] IS NULL OR c.store_id = ANY($3::uuid[]))`;

@Injectable()
export class ShiftClosesReadService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /**
   * One page of recorded closes, newest first. The cursor is decoded (400 on a
   * foreign token, `InvalidShiftCloseCursorError`) before any read. One row
   * beyond `limit` is read to tell whether another page follows, so the last
   * page always has `nextCursor: null`.
   */
  async list(input: ListShiftClosesInput): Promise<ShiftClosePage> {
    const keyset =
      input.cursor === null ? null : decodeShiftCloseCursor({ tenantId: input.tenantId, cursor: input.cursor });
    const { filters } = input;
    return this.inTenant(input, async (client) => {
      const scope = await this.scopeOf(client, input);
      if (filters.storeId !== undefined) await this.assertStoreInScope(client, input.tenantId, scope, filters.storeId);
      const r = await client.query<ShiftCloseReadRow>(LIST_SQL, [
        input.tenantId,
        scopeStoreIds(scope),
        filters.storeId ?? null,
        filters.closedFrom ?? null,
        filters.closedTo ?? null,
        filters.closeKind ?? null,
        filters.minAbsVariance ?? null,
        filters.currencyCode ?? null,
        filters.approval ?? null,
        keyset?.closedAtKey ?? null,
        keyset?.shiftId ?? null,
        input.limit + 1,
        filters.approvalRequired ?? null,
        filters.approvalMissing ?? null,
        filters.approverCheck ?? null,
      ]);
      const rows = r.rows.slice(0, input.limit);
      const last = rows[rows.length - 1];
      const nextCursor =
        r.rows.length > input.limit && last !== undefined
          ? encodeShiftCloseCursor({ tenantId: input.tenantId, closedAtKey: last.closed_at_key, shiftId: last.shift_id })
          : null;
      return { items: rows.map(toShiftCloseSummary), nextCursor };
    });
  }

  /**
   * One recorded close with its opening, movements (oldest first by
   * `occurred_at`, then id) and claimed refund returns (claim order). Absent,
   * foreign, out of scope or not closed → `ShiftCloseNotFoundError`.
   */
  async get(input: ScopedReadInput, shiftId: string): Promise<ShiftCloseDetail> {
    return this.inTenant(input, async (client) => {
      const scoped = scopeStoreIds(await this.scopeOf(client, input));
      const r = await client.query<ShiftCloseDetailRow>(DETAIL_SQL, [shiftId, input.tenantId, scoped]);
      const row = r.rows[0];
      if (row === undefined) throw new ShiftCloseNotFoundError();
      const movements = await client.query<ShiftCashMovementReadRow>(
        `SELECT id, kind, amount::text AS amount, reason_code, note, occurred_at,
                recorded_by_user_id, received_at
           FROM shift_cash_movements
          WHERE shift_id = $1::uuid AND tenant_id = $2::uuid AND store_id = $3::uuid
          ORDER BY occurred_at ASC, id ASC`,
        [row.shift_id, input.tenantId, row.store_id],
      );
      const refs = await client.query<{ return_id: string }>(
        `SELECT return_id
           FROM shift_refund_claims
          WHERE shift_id = $1::uuid AND tenant_id = $2::uuid AND store_id = $3::uuid
          ORDER BY ordinal ASC`,
        [row.shift_id, input.tenantId, row.store_id],
      );
      return toShiftCloseDetail({
        row,
        movements: movements.rows,
        refundReturnRefs: refs.rows.map((ref) => ref.return_id),
      });
    });
  }

  private inTenant<T>(input: ScopedReadInput, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, work);
  }

  /** The caller's store scope from its role in the tenant (RLS-scoped read). */
  private scopeOf(client: PoolClient, input: ScopedReadInput): Promise<StoreScope> {
    return callerStoreScope(client, this.memberships, input);
  }

  /**
   * A `store_id` filter must name a store in the caller's scope and in the
   * session tenant (RLS: another tenant's store returns no row). Otherwise
   * `StoreNotInScopeError`. Mirrors the sale-sync-ops `assertStoreInScope`.
   */
  private async assertStoreInScope(
    client: PoolClient,
    tenantId: string,
    scope: StoreScope,
    storeId: string,
  ): Promise<void> {
    if (!inStoreScope(scope, storeId)) throw new StoreNotInScopeError();
    const r = await client.query<{ id: string }>(
      `SELECT id FROM stores WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [storeId, tenantId],
    );
    if (r.rows.length === 0) throw new StoreNotInScopeError();
  }
}
