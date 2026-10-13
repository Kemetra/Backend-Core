/**
 * ErpnextWarehouseMapService — 014-CRUD (T031, T033).
 *
 * The tenant-admin store↔ERPNext-Warehouse mapping set/list/retire/re-point
 * engine. Links a DP2 `stores` row to an ERPNext **Warehouse** reference
 * (`erpnext_warehouse_map`, migration 0018) — a PURE MAPPING / RECONCILIATION
 * layer, NOT a stock-authority handover (OQ-1, §IX, the SIGNED stock-impact
 * decision): DP2's 009 ledger stays the OPERATIONAL on-hand authority; ERPNext
 * owns VALUATION.
 *
 * Every write runs inside a single `runWithTenantContext` transaction so
 * `app.current_tenant` is set (fail-closed RLS) and partial state can never be
 * persisted. Discriminated-union results (`{ kind: "ok" | "not_found" |
 * "conflict" }`) are mapped to HTTP by the controller — mirrors
 * ErpnextItemMapService.
 *
 * Invariants enforced here:
 *   - §XII: `tenant_id` + actor come from `input` (controller sets them from
 *     `ctx`, never the body). The strict Zod DTO rejects body-smuggled fields.
 *   - OQ-2 forward-compat 1:1: a 2nd ACTIVE set for the same
 *     (tenant, store, 'stock') trips the `UQ_idx_erpnext_warehouse_map_active`
 *     partial-unique (23505) → conflict. v1 only ever writes `purpose='stock'`.
 *   - §III optimistic concurrency: retire uses
 *     `... WHERE id = $1 AND version = $2 AND retired_at IS NULL`, incrementing
 *     version; a 0-row result (stale version, wrong-tenant RLS, or already
 *     retired) is a conflict / not_found.
 *   - NO ERPNext Bin/quantity is fetched or stored (OQ-1) — the reconciliation
 *     run is 017.
 *
 * 014 adds NO outbox event (the §8 carve, T002): the happy-path audit subjects
 * (`erpnext_warehouse_map.set` / `.retired`) are emitted by the `@Auditable`
 * decorator + AuditEmitterInterceptor on the controller routes (success-gated,
 * so effectively transaction-gated).
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Pool } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Logger } from "@data-pulse-2/shared";

import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../audit/audit-job.enqueuer";
import { PG_POOL } from "../../auth/auth.module";
import { ROOT_LOGGER } from "../../common/logging.interceptor";
import type { ErpnextWarehouseMapRow } from "./dto/erpnext-warehouse-mapping.dto";

// ---------------------------------------------------------------------------
// DB row shape (snake_case) → service row (camelCase)
// ---------------------------------------------------------------------------

interface DbRow {
  id: string;
  store_id: string;
  purpose: "stock" | "returns";
  erpnext_warehouse_ref: string;
  version: number;
  set_by: string | null;
  set_at: Date;
  retired_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLS = `id, store_id, purpose, erpnext_warehouse_ref, version,
  set_by, set_at, retired_at, created_at, updated_at`;

function toRow(r: DbRow): ErpnextWarehouseMapRow {
  return {
    id: r.id,
    storeId: r.store_id,
    purpose: r.purpose,
    erpnextWarehouseRef: r.erpnext_warehouse_ref,
    version: r.version,
    setBy: r.set_by,
    setAt: r.set_at,
    retiredAt: r.retired_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Result discriminated unions
// ---------------------------------------------------------------------------

export type SetResult =
  | { kind: "ok"; row: ErpnextWarehouseMapRow }
  | { kind: "not_found" }
  | { kind: "conflict" };

export type RetireResult =
  | { kind: "ok"; row: ErpnextWarehouseMapRow }
  | { kind: "not_found" }
  | { kind: "conflict" };

function isPgCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

@Injectable()
export class ErpnextWarehouseMapService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Optional()
    @Inject(AUDIT_JOB_ENQUEUER)
    private readonly auditEnqueuer?: AuditJobEnqueuer,
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Logger,
  ) {}

  /**
   * Set a MANUAL mapping (`purpose='stock'` in v1). Scope-checks the store
   * first (non-disclosing 404 if absent/cross-tenant). The 1:1 active
   * partial-unique (OQ-2, on (tenant, store, purpose)) surfaces a 2nd active
   * set as conflict.
   */
  set(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly erpnextWarehouseRef: string;
    readonly actorUserId: string;
  }): Promise<SetResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<SetResult> => {
        // Scope-check the store (RLS-filtered → cross-tenant returns 0 rows).
        const store = await client.query<{ id: string }>(
          `SELECT id FROM stores WHERE id = $1 LIMIT 1`,
          [input.storeId],
        );
        if (!store.rows[0]) {
          return { kind: "not_found" };
        }

        try {
          const inserted = await client.query<DbRow>(
            `INSERT INTO erpnext_warehouse_map
               (id, tenant_id, store_id, purpose, erpnext_warehouse_ref,
                set_by, version)
             VALUES ($1, $2, $3, 'stock', $4, $5, 1)
             RETURNING ${SELECT_COLS}`,
            [
              newId(),
              input.tenantId,
              input.storeId,
              input.erpnextWarehouseRef,
              input.actorUserId,
            ],
          );
          const row = toRow(inserted.rows[0]!);
          this.logger?.info(
            {
              tenant_id: input.tenantId,
              mapping_id: row.id,
              store_id: row.storeId,
              action: "erpnext_warehouse_map.set",
            },
            "erpnext-warehouse-map: set",
          );
          return { kind: "ok", row };
        } catch (err: unknown) {
          // 23505 = active partial-unique (a 2nd active mapping for the store/purpose).
          if (isPgCode(err, "23505")) {
            return { kind: "conflict" };
          }
          // 23503 = FK violation: the store was deleted between the scope-check
          // SELECT and this INSERT (a narrow TOCTOU window under READ
          // COMMITTED). A vanished parent is correctly a non-disclosing
          // not_found, not a 500 — mirrors the 23505 handling.
          if (isPgCode(err, "23503")) {
            return { kind: "not_found" };
          }
          throw err;
        }
      },
    );
  }

  /**
   * Retire an active mapping (soft-delete: set retired_at). Append-only —
   * a re-point is a retire here followed by a fresh `set` (never an in-place
   * identity rewrite; data-model §2). Optimistic concurrency:
   * `WHERE id = $1 AND version = $2 AND retired_at IS NULL`, version++. A
   * 0-row result is a conflict (stale version / already retired) or
   * not_found (RLS-filtered / fabricated id).
   */
  retire(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly version: number;
  }): Promise<RetireResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<RetireResult> => {
        const updated = await client.query<DbRow>(
          `UPDATE erpnext_warehouse_map
              SET retired_at = now(),
                  version    = version + 1,
                  updated_at = now()
            WHERE id          = $1
              AND version     = $2
              AND retired_at IS NULL
           RETURNING ${SELECT_COLS}`,
          [input.id, input.version],
        );
        if (updated.rows[0]) {
          const row = toRow(updated.rows[0]);
          this.logger?.info(
            {
              tenant_id: input.tenantId,
              mapping_id: row.id,
              action: "erpnext_warehouse_map.retired",
            },
            "erpnext-warehouse-map: retired",
          );
          return { kind: "ok", row };
        }
        // Disambiguate conflict (row exists but wrong version/state) from
        // not_found (no such row in this tenant — RLS-filtered / fabricated id).
        const exists = await client.query<{ id: string }>(
          `SELECT id FROM erpnext_warehouse_map WHERE id = $1 LIMIT 1`,
          [input.id],
        );
        return exists.rows[0] ? { kind: "conflict" } : { kind: "not_found" };
      },
    );
  }

  /** List the tenant's ACTIVE mappings. */
  list(input: {
    readonly tenantId: string;
  }): Promise<ErpnextWarehouseMapRow[]> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ErpnextWarehouseMapRow[]> => {
        const rows = await client.query<DbRow>(
          `SELECT ${SELECT_COLS} FROM erpnext_warehouse_map
            WHERE retired_at IS NULL
            ORDER BY set_at DESC, id`,
        );
        return rows.rows.map(toRow);
      },
    );
  }
}
