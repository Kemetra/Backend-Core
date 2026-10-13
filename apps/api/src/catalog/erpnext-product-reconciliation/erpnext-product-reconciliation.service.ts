/**
 * ErpnextProductReconciliationService — 021.
 *
 * The DP2-side product-master reconciliation/repair engine (run → report →
 * repair), the inverse of 017's stock reconciliation. It READS (never mirrors) the
 * 013 `erpnext_item_map` mapping, the 003 `tenant_products` catalog, and the 008
 * sale facts; it OWNS the `erpnext_product_reconciliation_*` run/result/repair
 * state.
 *
 *   - `listBacklog()` — US1: a LIVE read-projection of active products lacking a
 *     confirmed-and-active 013 mapping (003 ⟕ 013 confirmed-only-and-active).
 *     READ-NOT-MIRROR-013 — no 021 table write (FR-002).
 *   - `repairBacklogItem()` / `repairResult()` — US2: an idempotent repair that
 *     DRIVES 013's EXISTING suggest/confirm/re-point lifecycle under 013's
 *     `version` guard, composing the 013 transition with 021's `repair_attempt` +
 *     an in-transaction `audit_events` write ATOMICALLY (FR-010/015). 021 issues
 *     NO direct write to `erpnext_item_map`.
 *   - `triggerRun()` / `getRun()` / `listResults()` — US3: the persisted two-sided
 *     compare (stub-tolerant; the run processor runs in the worker over the
 *     connector item-view seam).
 *
 * Every query runs under the caller's tenant GUC via `runWithTenantContext`
 * (tenant from the dashboard session principal, never the body — §XII).
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { emit, OUTBOX_EVENT_TYPES, runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";

import { PG_POOL } from "../../auth/auth.module";
import { recordErpnextProductReconciliation } from "../../observability/metrics/api.metrics";
import { ErpnextItemMapService } from "../erpnext-item-map/erpnext-item-map.service";
import {
  RUN_COLS,
  RESULT_COLS,
  toBacklogItem,
  toResultBody,
  toRunBody,
  type BacklogDbRow,
  type BacklogItem,
  type ProductReconciliationResultBody,
  type ProductReconciliationRunBody,
  type RecordedProductRepair,
  type RepairKind,
  type RepairOutcome,
  type ResultDbRow,
  type RunDbRow,
} from "./product-reconciliation.projection";

/** Hard ceiling on a single page — the 012/009/017 500/req convention. */
export const PAGE_MAX = 500;

/** The addressed product / mapping does not resolve in the tenant scope. 404. */
export class ProductNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "ProductNotFoundError";
  }
}

/** The addressed run / result does not resolve in the tenant scope. 404. */
export class RunNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "RunNotFoundError";
  }
}

/** 013's optimistic-concurrency guard fired (stale version) OR a 013 1:1. 409. */
export class RepairConflictError extends Error {
  constructor(readonly repair: RecordedProductRepair) {
    super("conflict");
    this.name = "RepairConflictError";
  }
}

/** A repairKind whose required fields are missing. 400 (validation). */
export class RepairValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairValidationError";
  }
}

export interface ListBacklogInput {
  readonly tenantId: string;
  readonly cursor: string | null;
  readonly limit: number;
  readonly mismatchClass?: "unmapped_dp2_product" | "suggestion_unconfirmed";
}

export interface RepairInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly repairKind: RepairKind;
  readonly tenantProductId: string;
  readonly mappingId?: string;
  readonly erpnextItemRef?: string;
  readonly version?: number;
}

export interface RepairResult {
  readonly repair: RecordedProductRepair;
  /** True when the repair hit a no-op echo (already-confirmed) → controller 200. */
  readonly replayed: boolean;
}

@Injectable()
export class ErpnextProductReconciliationService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly itemMap: ErpnextItemMapService,
  ) {}

  // ===== US1: unmapped-product backlog (live read-projection) ================

  /**
   * List the tenant's unmapped-product backlog — active 003 products lacking a
   * confirmed-and-active 013 mapping (FR-001/002). For each product, the most
   * recent INERT (suggested-only OR retired-confirmed) 013 row is surfaced as the
   * suggestion provenance → `suggestion_unconfirmed`; a product with NO row at all
   * → `unmapped_dp2_product`. Re-resolves the 013 truth on every read.
   */
  async listBacklog(input: ListBacklogInput): Promise<{
    items: readonly BacklogItem[];
    nextCursor: string | null;
  }> {
    const limit = Math.min(Math.max(1, input.limit), PAGE_MAX);
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        const observedAt = new Date();
        // confirmed-and-active mapping → product is MAPPED (excluded). Otherwise
        // a LATERAL pick of the newest inert mapping row supplies the suggestion
        // provenance (suggestion_unconfirmed) or NULL (unmapped_dp2_product).
        const rows = await client.query<BacklogDbRow>(
          `SELECT tp.id AS tenant_product_id,
                  s.id  AS suggestion_mapping_id,
                  s.suggestion_source,
                  s.suggested_by,
                  s.suggested_at,
                  s.erpnext_item_ref
             FROM tenant_products tp
             LEFT JOIN erpnext_item_map cm
               ON cm.tenant_product_id = tp.id
              AND cm.state = 'confirmed'
              AND cm.retired_at IS NULL
             LEFT JOIN LATERAL (
               SELECT m.id, m.suggestion_source, m.suggested_by,
                      m.suggested_at, m.erpnext_item_ref
                 FROM erpnext_item_map m
                WHERE m.tenant_product_id = tp.id
                ORDER BY m.suggested_at DESC, m.id
                LIMIT 1
             ) s ON true
            WHERE tp.retired_at IS NULL
              AND cm.id IS NULL
              AND ($1::uuid IS NULL OR tp.id > $1::uuid)
              AND ($2::text IS NULL OR
                   ($2 = 'suggestion_unconfirmed' AND s.id IS NOT NULL) OR
                   ($2 = 'unmapped_dp2_product'   AND s.id IS NULL))
            ORDER BY tp.id
            LIMIT $3`,
          [input.cursor ?? null, input.mismatchClass ?? null, limit],
        );
        const items = rows.rows.map((r) => toBacklogItem(r, observedAt));
        const nextCursor =
          rows.rows.length === limit
            ? rows.rows[rows.rows.length - 1]!.tenant_product_id
            : null;
        return { items, nextCursor };
      },
    );
  }

  // ===== US2: repair via the 013 lifecycle ===================================

  /**
   * Repair a backlog item (US2). Drives 013's lifecycle via the client-accepting
   * 013 variant on 021's OWN transaction, so the 013 transition + the
   * `repair_attempt` + the in-transaction `audit_events` write are ATOMIC
   * (FR-015). 021 issues NO direct write to `erpnext_item_map`.
   */
  async repairBacklogItem(input: RepairInput): Promise<RepairResult> {
    this.validateRepair(input);
    const result = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      (client): Promise<RepairResult> =>
        this.runRepair(client, input, "backlog_item", input.tenantProductId),
    );
    // A conflict MUST commit its repair_attempt + audit (the conflict IS the
    // recorded outcome, FR-012) — so we throw AFTER the transaction returns, never
    // inside it (an in-tx throw would roll back the very attempt that records the
    // conflict). The audit-failure case still aborts the tx and propagates here.
    if (result.repair.outcome === "conflict") {
      throw new RepairConflictError(result.repair);
    }
    return result;
  }

  /**
   * Repair from a persisted US3 result (US2 over the run report). Resolves the
   * result row (404 on cross-tenant/absent), then runs the SAME 013-driven repair
   * and transitions the result `open → repaired` on a `mapped` outcome — all in
   * one transaction.
   */
  async repairResult(
    input: RepairInput & { readonly runId: string; readonly resultId: string },
  ): Promise<RepairResult> {
    this.validateRepair(input);
    const result = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<RepairResult> => {
        const cur = await client.query<{ result_state: string }>(
          `SELECT res.result_state
             FROM erpnext_product_reconciliation_result res
             JOIN erpnext_product_reconciliation_run run ON run.id = res.run_id
            WHERE res.id = $1 AND res.run_id = $2
            FOR UPDATE OF res`,
          [input.resultId, input.runId],
        );
        if (!cur.rows[0]) throw new RunNotFoundError();

        const r = await this.runRepair(client, input, "result", input.resultId);
        if (r.repair.outcome === "mapped" && cur.rows[0].result_state === "open") {
          await client.query(
            `UPDATE erpnext_product_reconciliation_result
                SET result_state = 'repaired', updated_at = now()
              WHERE id = $1`,
            [input.resultId],
          );
        }
        return r;
      },
    );
    if (result.repair.outcome === "conflict") {
      throw new RepairConflictError(result.repair);
    }
    return result;
  }

  /**
   * The shared 021 repair core — runs ON the caller's tenant-scoped tx client.
   * Drives 013's EXISTING lifecycle (confirm / suggest_confirm / re_point), maps
   * the 013 discriminated-union result to a 021 outcome, then writes the
   * `repair_attempt` + the in-transaction `audit_events` row ATOMICALLY.
   */
  private async runRepair(
    client: PoolClient,
    input: RepairInput,
    targetKind: "backlog_item" | "result",
    targetRefId: string,
  ): Promise<RepairResult> {
    let outcome: RepairOutcome;
    let resolvedItemMapId: string | null = null;

    if (input.repairKind === "confirm" || input.repairKind === "re_point") {
      // Confirm an existing 013 suggestion under 013's version guard. For an
      // already-confirmed-active mapping the confirm is a 0-row no-op echo
      // (FR-011); a stale version is a conflict (FR-012).
      const r = await this.itemMap.confirmOnClient(client, {
        tenantId: input.tenantId,
        id: input.mappingId!,
        version: input.version!,
        actorUserId: input.actorUserId,
      });
      if (r.kind === "ok") {
        outcome = "mapped";
        resolvedItemMapId = r.row.id;
      } else if (r.kind === "conflict") {
        // Distinguish "already confirmed-and-active" (no_op_echo) from a true
        // stale-version conflict by inspecting the row's current state.
        const existing = await client.query<{ id: string; state: string; retired_at: Date | null }>(
          `SELECT id, state, retired_at FROM erpnext_item_map WHERE id = $1 LIMIT 1`,
          [input.mappingId!],
        );
        const row = existing.rows[0];
        if (row?.state === "confirmed" && row.retired_at === null) {
          outcome = "no_op_echo";
          resolvedItemMapId = row.id;
        } else {
          outcome = "conflict";
        }
      } else {
        outcome = "still_unmapped";
      }
    } else {
      // suggest_confirm: record a 013 suggestion then confirm it — both on 021's
      // tx client (so the whole chain is atomic with the audit).
      const sug = await this.itemMap.suggestOnClient(client, {
        tenantId: input.tenantId,
        tenantProductId: input.tenantProductId,
        erpnextItemRef: input.erpnextItemRef!,
        actorUserId: input.actorUserId,
      });
      if (sug.kind === "not_found") {
        outcome = "still_unmapped";
      } else if (sug.kind === "conflict") {
        // An active mapping already exists for this product (013 1:1) → no_op_echo
        // if it's confirmed-active, else conflict.
        const active = await client.query<{ id: string; state: string }>(
          `SELECT id, state FROM erpnext_item_map
            WHERE tenant_product_id = $1 AND retired_at IS NULL LIMIT 1`,
          [input.tenantProductId],
        );
        const row = active.rows[0];
        if (row?.state === "confirmed") {
          outcome = "no_op_echo";
          resolvedItemMapId = row.id;
        } else {
          outcome = "conflict";
        }
      } else {
        const conf = await this.itemMap.confirmOnClient(client, {
          tenantId: input.tenantId,
          id: sug.row.id,
          version: sug.row.version,
          actorUserId: input.actorUserId,
        });
        if (conf.kind === "ok") {
          outcome = "mapped";
          resolvedItemMapId = conf.row.id;
        } else {
          outcome = "still_unmapped";
        }
      }
    }

    const recordedAt = await this.recordRepairAttempt(client, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      targetKind,
      targetRefId,
      repairKind: input.repairKind,
      outcome,
      resolvedItemMapId,
      expectedVersion: input.version ?? null,
    });

    const repair: RecordedProductRepair = {
      targetKind,
      targetRef: targetRefId,
      repairKind: input.repairKind,
      outcome,
      resolvedItemMapId,
      recordedAt,
    };
    // NOTE: a `conflict` is NOT thrown here — the caller throws RepairConflictError
    // AFTER the transaction commits, so the repair_attempt + audit row that record
    // the conflict persist (FR-012). Throwing in-tx would roll them back.
    return { repair, replayed: outcome === "no_op_echo" };
  }

  /**
   * Persist the repair: an append-only `repair_attempt` + a platform
   * `audit_events` row IN THE SAME TRANSACTION (FR-015) — a direct INSERT on the
   * caller's tenant-scoped client (NOT `@Auditable`, NOT `insertAuditEvent`), so a
   * repair that cannot audit rolls back. No PII in either row. Returns the
   * `created_at` ISO string of the attempt. Also emits the §VII signal.
   */
  private async recordRepairAttempt(
    client: PoolClient,
    a: {
      tenantId: string;
      actorUserId: string;
      targetKind: "backlog_item" | "result";
      targetRefId: string;
      repairKind: RepairKind;
      outcome: RepairOutcome;
      resolvedItemMapId: string | null;
      expectedVersion: number | null;
    },
  ): Promise<string> {
    const r = await client.query<{ created_at: Date }>(
      `INSERT INTO erpnext_product_reconciliation_repair_attempt
         (id, tenant_id, target_kind, target_ref_id, repair_kind, actor_user_id,
          outcome, resolved_item_map_id, expected_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING created_at`,
      [
        newId(),
        a.tenantId,
        a.targetKind,
        a.targetRefId,
        a.repairKind,
        a.actorUserId,
        a.outcome,
        a.resolvedItemMapId,
        a.expectedVersion,
      ],
    );
    await this.insertAudit(client, a.tenantId, a.actorUserId, {
      action: "erpnext_product_reconciliation.repaired",
      targetType: a.targetKind === "result"
        ? "erpnext_product_reconciliation_result"
        : "tenant_products",
      targetId: a.targetRefId,
      metadata: { outcome: a.outcome, repair_kind: a.repairKind },
    });
    recordErpnextProductReconciliation();
    return r.rows[0]!.created_at.toISOString();
  }

  private validateRepair(input: RepairInput): void {
    if (input.repairKind === "confirm" || input.repairKind === "re_point") {
      if (!input.mappingId || input.version === undefined) {
        throw new RepairValidationError(
          `${input.repairKind} requires mappingId + version`,
        );
      }
    } else if (input.repairKind === "suggest_confirm") {
      if (!input.erpnextItemRef) {
        throw new RepairValidationError("suggest_confirm requires erpnextItemRef");
      }
    }
  }

  // ===== US3: two-sided run + report =========================================

  /**
   * Trigger an on-demand product-master reconciliation run (US3). Creates the run
   * row (`status='running'`, `erpnext_view_status='unavailable'`), a platform
   * `audit_events` row, AND emits an `erpnext.product_reconciliation.requested`
   * outbox event — all in ONE transaction. The worker consumer drains the event
   * and invokes the run processor over the connector item-view seam, advancing the
   * run `running → completed`. Stub-tolerant (FR-007): an absent view is reported,
   * never a failure. DP2 makes NO outbound ERPNext HTTP.
   */
  triggerRun(input: {
    tenantId: string;
    actorUserId: string;
  }): Promise<ProductReconciliationRunBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ProductReconciliationRunBody> => {
        const runId = newId();
        const row = await client.query<RunDbRow>(
          `INSERT INTO erpnext_product_reconciliation_run
             (id, tenant_id, trigger, status, erpnext_view_status, actor_user_id)
           VALUES ($1, $2, 'on_demand', 'running', 'unavailable', $3)
           RETURNING ${RUN_COLS}`,
          [runId, input.tenantId, input.actorUserId],
        );
        await this.insertAudit(client, input.tenantId, input.actorUserId, {
          action: "erpnext_product_reconciliation.run.triggered",
          targetType: "erpnext_product_reconciliation_run",
          targetId: runId,
          metadata: {},
        });
        await emit(client, {
          eventType: OUTBOX_EVENT_TYPES.ERPNEXT_PRODUCT_RECONCILIATION_REQUESTED,
          tenantId: input.tenantId,
          payload: { run_id: runId },
        });
        return toRunBody(row.rows[0]!);
      },
    );
  }

  /** List the tenant's runs (US3), newest first, cursor-paginated. */
  async listRuns(input: {
    tenantId: string;
    cursor: string | null;
    limit: number;
  }): Promise<{ items: ProductReconciliationRunBody[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(1, input.limit), PAGE_MAX);
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        const rows = await client.query<RunDbRow>(
          `SELECT ${RUN_COLS} FROM erpnext_product_reconciliation_run
            WHERE ($1::uuid IS NULL OR id > $1::uuid)
            ORDER BY id
            LIMIT $2`,
          [input.cursor ?? null, limit],
        );
        const items = rows.rows.map(toRunBody);
        const nextCursor =
          rows.rows.length === limit ? rows.rows[rows.rows.length - 1]!.id : null;
        return { items, nextCursor };
      },
    );
  }

  /** List a run's classified results (US3), cursor-paginated. Foreign run → 404. */
  async listResults(input: {
    tenantId: string;
    runId: string;
    cursor: string | null;
    limit: number;
    mismatchClass?: string;
  }): Promise<{ items: ProductReconciliationResultBody[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(1, input.limit), PAGE_MAX);
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        const run = await client.query<{ id: string }>(
          `SELECT id FROM erpnext_product_reconciliation_run WHERE id = $1`,
          [input.runId],
        );
        if (!run.rows[0]) throw new RunNotFoundError();

        const rows = await client.query<ResultDbRow>(
          `SELECT ${RESULT_COLS}
             FROM erpnext_product_reconciliation_result
            WHERE run_id = $1
              AND ($2::uuid IS NULL OR id > $2::uuid)
              AND ($3::text IS NULL OR mismatch_class = $3::text)
            ORDER BY id
            LIMIT $4`,
          [input.runId, input.cursor ?? null, input.mismatchClass ?? null, limit],
        );
        const items = rows.rows.map(toResultBody);
        const nextCursor =
          rows.rows.length === limit ? rows.rows[rows.rows.length - 1]!.id : null;
        return { items, nextCursor };
      },
    );
  }

  /** Shared in-transaction platform audit insert (FR-015; same tx client, no PII). */
  private async insertAudit(
    client: PoolClient,
    tenantId: string,
    actorUserId: string,
    opts: {
      action: string;
      targetType: string;
      targetId: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        newId(),
        actorUserId,
        tenantId,
        opts.action,
        opts.targetType,
        opts.targetId,
        JSON.stringify(opts.metadata),
      ],
    );
  }
}
