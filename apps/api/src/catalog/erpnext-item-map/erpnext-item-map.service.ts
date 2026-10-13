/**
 * ErpnextItemMapService — 013-CRUD (T031, T033) + 013-REPOINT (T041).
 *
 * The tenant-admin ERPNext Item-mapping suggest/confirm/retire/re-point engine.
 * Links a DP2 `tenant_products` row to an ERPNext **Item** reference
 * (`erpnext_item_map`, migration 0017) — a MAPPING/RECONCILIATION layer, NOT a
 * catalog-authority handover (OQ-1, §IX).
 *
 * Every write runs inside a single `runWithTenantContext` transaction so
 * `app.current_tenant` is set (fail-closed RLS) and partial state can never be
 * persisted. Discriminated-union results (`{ kind: "ok" | "not_found" |
 * "conflict" }`) are mapped to HTTP by the controller — mirrors
 * ReconciliationService.
 *
 * Invariants enforced here:
 *   - §XII: `tenant_id` + actor come from `input` (controller sets them from
 *     `ctx`, never the body). The strict Zod DTO rejects body-smuggled fields.
 *   - OQ-2 1:1: a 2nd ACTIVE suggest for the same (tenant, product) trips the
 *     `UQ_idx_erpnext_item_map_active` partial-unique (23505) → conflict.
 *   - §III optimistic concurrency: confirm/retire use
 *     `... WHERE id = $1 AND version = $2`, incrementing version; a 0-row
 *     result (stale version, wrong-tenant RLS, or wrong lifecycle state) is a
 *     conflict / not_found.
 *   - v1 suggest is MANUAL-ONLY (AUTO_MATCH_NO_SOURCE): suggestion_source is
 *     always recorded server-side as 'manual'.
 *
 * 013 adds NO outbox event (OQ-8, T002): the happy-path audit subjects
 * (`erpnext_item_map.suggested` / `.confirmed` / `.retired`) are emitted by the
 * `@Auditable` decorator + AuditEmitterInterceptor on the controller routes
 * (success-gated, so effectively transaction-gated).
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Logger } from "@data-pulse-2/shared";

import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../audit/audit-job.enqueuer";
import { PG_POOL } from "../../auth/auth.module";
import { ROOT_LOGGER } from "../../common/logging.interceptor";
import type { ErpnextItemMapRow } from "./dto/erpnext-item-mapping.dto";

// ---------------------------------------------------------------------------
// DB row shape (snake_case) → service row (camelCase)
// ---------------------------------------------------------------------------

interface DbRow {
  id: string;
  tenant_product_id: string;
  erpnext_item_ref: string;
  state: "suggested" | "confirmed";
  suggestion_source: "barcode" | "item_code" | "manual";
  version: number;
  suggested_by: string | null;
  suggested_at: Date;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  retired_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLS = `id, tenant_product_id, erpnext_item_ref, state,
  suggestion_source, version, suggested_by, suggested_at, confirmed_by,
  confirmed_at, retired_at, created_at, updated_at`;

function toRow(r: DbRow): ErpnextItemMapRow {
  return {
    id: r.id,
    tenantProductId: r.tenant_product_id,
    erpnextItemRef: r.erpnext_item_ref,
    state: r.state,
    suggestionSource: r.suggestion_source,
    version: r.version,
    suggestedBy: r.suggested_by,
    suggestedAt: r.suggested_at,
    confirmedBy: r.confirmed_by,
    confirmedAt: r.confirmed_at,
    retiredAt: r.retired_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Result discriminated unions
// ---------------------------------------------------------------------------

export type SuggestResult =
  | { kind: "ok"; row: ErpnextItemMapRow }
  | { kind: "not_found" }
  | { kind: "conflict" };

export type ConfirmResult =
  | { kind: "ok"; row: ErpnextItemMapRow }
  | { kind: "not_found" }
  | { kind: "conflict" };

export type RetireResult =
  | { kind: "ok"; row: ErpnextItemMapRow }
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
export class ErpnextItemMapService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Optional()
    @Inject(AUDIT_JOB_ENQUEUER)
    private readonly auditEnqueuer?: AuditJobEnqueuer,
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Logger,
  ) {}

  /**
   * Record a MANUAL suggested mapping (state='suggested'). Scope-checks the
   * tenant product first (non-disclosing 404 if absent/cross-tenant). The 1:1
   * active partial-unique (OQ-2) surfaces a 2nd active suggest as conflict.
   */
  suggest(input: {
    readonly tenantId: string;
    readonly tenantProductId: string;
    readonly erpnextItemRef: string;
    readonly actorUserId: string;
  }): Promise<SuggestResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      (client): Promise<SuggestResult> => this.suggestOnClient(client, input),
    );
  }

  /**
   * Client-accepting variant of {@link suggest}. Runs 013's suggest SQL on a
   * CALLER-SUPPLIED tenant-scoped client so an external owner (021 product-master
   * reconciliation repair) can compose this 013 transition with its own
   * `repair_attempt` + in-transaction `audit_events` writes ATOMICALLY (FR-015).
   * 013 still owns the SQL — 021 only supplies the connection; no new mapping
   * primitive. The caller MUST already have set `app.current_tenant` (e.g. inside
   * `runWithTenantContext`).
   */
  async suggestOnClient(
    client: PoolClient,
    input: {
      readonly tenantId: string;
      readonly tenantProductId: string;
      readonly erpnextItemRef: string;
      readonly actorUserId: string;
    },
  ): Promise<SuggestResult> {
    // Scope-check the product (RLS-filtered → cross-tenant returns 0 rows).
    const product = await client.query<{ id: string }>(
      `SELECT id FROM tenant_products WHERE id = $1 LIMIT 1`,
      [input.tenantProductId],
    );
    if (!product.rows[0]) {
      return { kind: "not_found" };
    }

    // SAVEPOINT scopes the INSERT so a constraint violation (23505/23503)
    // does NOT abort the caller's transaction. This method runs on a
    // caller-supplied client that may be mid-transaction (e.g. 021's
    // runRepair, which issues further SQL on the same client after a
    // `conflict` result). Without the savepoint a swallowed 23505 leaves
    // the PG transaction aborted → every subsequent query throws 25P02.
    await client.query("SAVEPOINT sp_suggest");
    try {
      const inserted = await client.query<DbRow>(
        `INSERT INTO erpnext_item_map
               (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
                suggestion_source, suggested_by, version)
             VALUES ($1, $2, $3, $4, 'suggested', 'manual', $5, 1)
             RETURNING ${SELECT_COLS}`,
        [
          newId(),
          input.tenantId,
          input.tenantProductId,
          input.erpnextItemRef,
          input.actorUserId,
        ],
      );
      await client.query("RELEASE SAVEPOINT sp_suggest");
      const row = toRow(inserted.rows[0]!);
      this.logger?.info(
        {
          tenant_id: input.tenantId,
          mapping_id: row.id,
          tenant_product_id: row.tenantProductId,
          action: "erpnext_item_map.suggested",
        },
        "erpnext-item-map: suggested",
      );
      return { kind: "ok", row };
    } catch (err: unknown) {
      // Roll the failed INSERT back to the savepoint so the caller's
      // transaction stays usable, THEN classify the error.
      await client.query("ROLLBACK TO SAVEPOINT sp_suggest");
      // 23505 = active partial-unique (a 2nd active mapping for the product).
      if (isPgCode(err, "23505")) {
        return { kind: "conflict" };
      }
      // 23503 = FK violation: the tenant product was deleted between the
      // scope-check SELECT and this INSERT (a narrow TOCTOU window under
      // READ COMMITTED). A vanished parent is correctly a non-disclosing
      // not_found, not a 500 — mirrors the 23505 handling.
      if (isPgCode(err, "23503")) {
        return { kind: "not_found" };
      }
      throw err;
    }
  }

  /**
   * Confirm a suggested mapping → state='confirmed' + provenance. Optimistic
   * concurrency: `WHERE id = $1 AND version = $2 AND state = 'suggested' AND
   * retired_at IS NULL`, version++. A 0-row result is a conflict (stale version
   * / already confirmed / retired); a row absent under RLS is not_found.
   */
  confirm(input: {
    readonly tenantId: string;
    readonly id: string;
    readonly version: number;
    readonly actorUserId: string;
  }): Promise<ConfirmResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      (client): Promise<ConfirmResult> => this.confirmOnClient(client, input),
    );
  }

  /**
   * Client-accepting variant of {@link confirm} — runs 013's confirm SQL on a
   * caller-supplied tenant-scoped client so 021's repair can compose the 013
   * transition with its own audit + repair_attempt atomically (FR-015). See
   * {@link suggestOnClient}.
   */
  async confirmOnClient(
    client: PoolClient,
    input: {
      readonly tenantId: string;
      readonly id: string;
      readonly version: number;
      readonly actorUserId: string;
    },
  ): Promise<ConfirmResult> {
    const updated = await client.query<DbRow>(
      `UPDATE erpnext_item_map
              SET state        = 'confirmed',
                  confirmed_by = $3,
                  confirmed_at = now(),
                  version      = version + 1,
                  updated_at   = now()
            WHERE id          = $1
              AND version     = $2
              AND state       = 'suggested'
              AND retired_at IS NULL
           RETURNING ${SELECT_COLS}`,
      [input.id, input.version, input.actorUserId],
    );
    if (updated.rows[0]) {
      const row = toRow(updated.rows[0]);
      this.logger?.info(
        {
          tenant_id: input.tenantId,
          mapping_id: row.id,
          action: "erpnext_item_map.confirmed",
        },
        "erpnext-item-map: confirmed",
      );
      return { kind: "ok", row };
    }
    // Disambiguate conflict (row exists but wrong version/state) from
    // not_found (no such row in this tenant — RLS-filtered / fabricated id).
    const exists = await client.query<{ id: string }>(
      `SELECT id FROM erpnext_item_map WHERE id = $1 LIMIT 1`,
      [input.id],
    );
    return exists.rows[0] ? { kind: "conflict" } : { kind: "not_found" };
  }

  /**
   * Retire an active mapping (soft-delete: set retired_at). Append-only —
   * a re-point is a retire here followed by a fresh `suggest` (never an
   * in-place identity rewrite; data-model §6). Optimistic concurrency:
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
      (client): Promise<RetireResult> => this.retireOnClient(client, input),
    );
  }

  /**
   * Client-accepting variant of {@link retire} — runs 013's retire SQL on a
   * caller-supplied tenant-scoped client (the {@link suggestOnClient} rationale).
   */
  async retireOnClient(
    client: PoolClient,
    input: {
      readonly tenantId: string;
      readonly id: string;
      readonly version: number;
    },
  ): Promise<RetireResult> {
    const updated = await client.query<DbRow>(
      `UPDATE erpnext_item_map
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
          action: "erpnext_item_map.retired",
        },
        "erpnext-item-map: retired",
      );
      return { kind: "ok", row };
    }
    const exists = await client.query<{ id: string }>(
      `SELECT id FROM erpnext_item_map WHERE id = $1 LIMIT 1`,
      [input.id],
    );
    return exists.rows[0] ? { kind: "conflict" } : { kind: "not_found" };
  }

  /** List the tenant's ACTIVE mappings, optionally filtered by lifecycle state. */
  list(input: {
    readonly tenantId: string;
    readonly state?: "suggested" | "confirmed";
  }): Promise<ErpnextItemMapRow[]> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ErpnextItemMapRow[]> => {
        const rows = input.state
          ? await client.query<DbRow>(
              `SELECT ${SELECT_COLS} FROM erpnext_item_map
                WHERE retired_at IS NULL AND state = $1
                ORDER BY suggested_at DESC, id`,
              [input.state],
            )
          : await client.query<DbRow>(
              `SELECT ${SELECT_COLS} FROM erpnext_item_map
                WHERE retired_at IS NULL
                ORDER BY suggested_at DESC, id`,
            );
        return rows.rows.map(toRow);
      },
    );
  }
}
