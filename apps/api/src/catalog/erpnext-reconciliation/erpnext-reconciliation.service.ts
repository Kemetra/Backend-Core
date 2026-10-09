/**
 * ErpnextReconciliationService — 017.
 *
 * The DP2-side reconciliation/repair engine. US1 (this slice) is a PURE READ:
 *   - `listPostingBacklog()` — a read-projection of the 015 `erpnext_posting_status`
 *     rows with `status='permanently_rejected'` for the session tenant, cursor-
 *     ordered by the row `sequence` (the 015 feed-cursor column, stable on a
 *     dead-lettered row). 017 READS the 015 dead-letters in place — it never
 *     mirrors them into a 017 table (READ-NOT-MIRROR / R2).
 *
 * Repair (US2) + the stock run/report (US3) extend this service. All queries run
 * under the caller's tenant GUC via `runWithTenantContext` (tenant from the
 * dashboard session principal, never the body — §XII); RLS scopes the rows.
 *
 * RT-191: every WRITE (run trigger, posting repair, stock repair) is also bound
 * to the caller's membership store scope (`context/operator-store-scope.ts`, the
 * RT-177 rule) and to a live (not soft-deleted) store. The tables carry
 * tenant-only RLS, so the store check is applied here; a store outside the scope
 * or deleted gets the same non-disclosing 404 as a missing one.
 *
 * RT-192: every READ (backlog, run, results) is bound to the same membership
 * store scope. The backlog is filtered to the scoped stores (an out-of-scope
 * `storeId` filter is an empty page); a run outside the scope is the same 404 as
 * a missing one. Soft-deletion does not hide history from a read: a `specific`
 * scope never holds a deleted store, the tenant-wide scope still reads it.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import {
  createStockReconciliationRun,
  runWithTenantContext,
  STOCK_RECONCILIATION_RUN_COLUMNS,
  type StockReconciliationRunRow,
} from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";

import { PG_POOL } from "../../auth/auth.module";
import { MembershipRepository } from "../../context/membership.repository";
import type { ResolvedContext } from "../../context/types";
import { recordErpnextReconciliationRepair } from "../../observability/metrics/api.metrics";
import {
  toBacklogItem,
  type PostingBacklogItem,
  type PostingDeadletterRow,
} from "./reconciliation-report.projection";
import { callerStoreScope, inStoreScope, scopeStoreIds } from "../../context/operator-store-scope";

/** Hard ceiling on a single backlog page — the 012/009 500/req convention. */
export const BACKLOG_MAX_PAGE = 500;

/**
 * The DP2-side retry budget a posting repair resets to (mirrors the 015
 * `POSTING_RETRY_BUDGET`). A row that dead-lettered via `retry_budget_exhausted`
 * carries retry_count at the ceiling; the repair MUST reset it to 0 on re-head,
 * else the connector's first `failed_transient` ack re-dead-letters instantly.
 */
const REPAIR_RESET_RETRY_COUNT = 0;

export type RepairOutcome = "eligible_again" | "still_failing" | "no_op_echo";

/** The session context of a call; its store scope bounds the addressed store (RT-191, RT-192). */
interface ScopedInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
}

export interface RepairPostingInput extends ScopedInput {
  readonly actorUserId: string;
  readonly workItemRef: string;
}

/** The 012 RecordedRepair wire projection (DP2 → operator). */
export interface RecordedRepair {
  readonly targetKind: "posting" | "stock";
  readonly targetRef: string;
  readonly repairKind: "re_post" | "re_map" | "re_sync" | "drain";
  readonly outcome: RepairOutcome;
  readonly resolvedDocumentRef: string | null;
  readonly recordedAt: string;
}

export interface RepairResult {
  readonly repair: RecordedRepair;
  /** True when the repair hit a no-op echo (already-terminal/in-flight) — controller surfaces 200. */
  readonly replayed: boolean;
}

/** The addressed work-item does not resolve in the tenant scope (RLS 0 rows). 404. */
export class RepairNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "RepairNotFoundError";
  }
}

/** The addressed run / result does not resolve in the tenant scope. 404. */
export class RunNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "RunNotFoundError";
  }
}

/** The addressed store is not found, out of scope or deleted (trigger). 404. */
export class StoreNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "StoreNotFoundError";
  }
}

export interface ReconciliationRunBody {
  readonly id: string;
  readonly storeId: string;
  readonly kind: "stock";
  readonly trigger: "on_demand" | "scheduled";
  readonly status: "running" | "completed" | "failed";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly summary: Record<string, unknown> | null;
}

export interface ReconciliationResultBody {
  readonly id: string;
  readonly runId: string;
  readonly mismatchClass: string;
  readonly sourceRef: string | null;
  readonly resultState: "open" | "repaired" | "accepted";
  readonly detail: Record<string, unknown> | null;
}

export interface TriggerRunInput extends ScopedInput {
  readonly actorUserId: string;
  readonly storeId: string;
}

export interface RepairStockInput extends ScopedInput {
  readonly actorUserId: string;
  readonly runId: string;
  readonly resultId: string;
  readonly repairKind: "re_map" | "re_sync";
}

export interface ListBacklogInput extends ScopedInput {
  /** Opaque cursor — the last `sequence` the operator saw. null = from start. */
  readonly cursor: bigint | null;
  readonly limit: number;
  readonly storeId?: string;
  readonly rejectionCategory?: string;
}

export interface RunReadInput extends ScopedInput {
  readonly runId: string;
}

export interface ListResultsInput extends RunReadInput {
  readonly cursor: string | null;
  readonly limit: number;
  readonly mismatchClass?: string;
}

export interface ListBacklogResult {
  readonly items: readonly PostingBacklogItem[];
  /** The advanced opaque cursor (the last item's sequence), or null on empty/last. */
  readonly nextCursor: string | null;
}

interface BacklogDbRow extends PostingDeadletterRow {
  readonly sequence: string;
}

@Injectable()
export class ErpnextReconciliationService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /**
   * List the tenant's posting dead-letter backlog (US1) — a read-projection over
   * the 015 erpnext_posting_status rows where status='permanently_rejected'.
   * Cursor-ordered by the row `sequence`; optional store + class filters.
   * RT-192: only the stores in the caller's scope, filtered in SQL so the
   * cursor pages stay full and gap-free; an out-of-scope `storeId` filter is an
   * empty page (the contract declares no 404 for this list).
   */
  async listPostingBacklog(input: ListBacklogInput): Promise<ListBacklogResult> {
    const limit = Math.min(Math.max(1, input.limit), BACKLOG_MAX_PAGE);

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ListBacklogResult> => {
        const scope = await callerStoreScope(client, this.memberships, input);
        if (input.storeId !== undefined && !inStoreScope(scope, input.storeId)) {
          return { items: [], nextCursor: null };
        }
        // RLS scopes to the session tenant. The pending-feed index does not back
        // this (status='permanently_rejected'), but the table is small relative
        // to total postings; the provenance index assists the common scans.
        const rows = await client.query<BacklogDbRow>(
          `SELECT id, kind, rejection_category, sale_id,
                  source_system, external_id, updated_at,
                  sequence::text AS sequence
             FROM erpnext_posting_status
            WHERE status = 'permanently_rejected'
              AND ($1::bigint IS NULL OR sequence > $1::bigint)
              AND ($2::uuid IS NULL OR store_id = $2::uuid)
              AND ($3::text IS NULL OR rejection_category = $3::text)
              AND ($5::uuid[] IS NULL OR store_id = ANY($5::uuid[]))
            ORDER BY erpnext_posting_status.sequence -- not the ::text alias (RT-325)
            LIMIT $4`,
          [
            input.cursor !== null ? input.cursor.toString() : null,
            input.storeId ?? null,
            input.rejectionCategory ?? null,
            limit,
            scopeStoreIds(scope),
          ],
        );

        const items = rows.rows.map(toBacklogItem);
        // limit >= 1 (clamped), so a full page (length === limit) is always
        // non-empty — no redundant `&& length > 0` (it would be a dead branch).
        const advanced =
          rows.rows.length === limit ? rows.rows[rows.rows.length - 1]!.sequence : null;
        return { items, nextCursor: advanced };
      },
    );
  }

  /**
   * Repair (re-offer) a posting dead-letter (US2). Re-uses the 015 O-3 state
   * machine — re-evaluate 015-RESOLVE, and if it now resolves, flip the 015 row
   * `permanently_rejected → pending` + re-head `sequence` + RESET `retry_count`
   * (so the connector's first `failed_transient` ack doesn't instantly
   * re-dead-letter a `retry_budget_exhausted` row). The connector re-posts via the
   * EXISTING 012 feed/ack — DP2 makes NO outbound ERPNext HTTP. Writes a
   * `repair_attempt` + a platform `audit_events` row IN THE SAME TRANSACTION
   * (FR-014) as the transition. `SELECT … FOR UPDATE` serializes concurrent
   * repairs of one row.
   *
   * Four input statuses (the FOR UPDATE may catch concurrent/stale cases):
   *   - permanently_rejected + resolve OK    → pending (re-head) → eligible_again
   *   - permanently_rejected + resolve fails → no transition     → still_failing
   *   - posted                                → no_op_echo (echo stored document_ref)
   *   - pending (a concurrent repair already re-offered) → no_op_echo, NO re-head
   */
  async repairPosting(input: RepairPostingInput): Promise<RepairResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<RepairResult> => {
        const cur = await client.query<{
          status: string;
          document_ref: string | null;
          sale_id: string;
          store_id: string;
          kind: "sale_post" | "reversal";
        }>(
          `SELECT status, document_ref, sale_id, store_id, kind
             FROM erpnext_posting_status
            WHERE id = $1
            FOR UPDATE`,
          [input.workItemRef],
        );
        const row = cur.rows[0];
        if (!row) throw new RepairNotFoundError();
        // RT-191: a work item of a store outside the caller's scope (or of a
        // deleted store) is indistinguishable from a missing one.
        if (!(await this.storeWritable(client, input, row.store_id))) {
          throw new RepairNotFoundError();
        }

        // --- Already-terminal (posted) or in-flight (pending): no-op echo -------
        if (row.status === "posted") {
          return this.recordRepair(client, input, "no_op_echo", row.document_ref, true);
        }
        if (row.status === "pending") {
          // A concurrent repair already re-offered it; do NOT re-head again.
          return this.recordRepair(client, input, "no_op_echo", null, true);
        }

        // --- permanently_rejected: re-evaluate 015-RESOLVE ----------------------
        const resolvable = await this.resolvePostingEligibility(client, {
          saleId: row.sale_id,
          storeId: row.store_id,
        });
        if (!resolvable) {
          // Cause still unfixed — stays dead-lettered, returns to the backlog.
          return this.recordRepair(client, input, "still_failing", null, false);
        }

        return this.reofferPosting(client, input, row);
      },
    );
  }

  /**
   * Re-offer a resolvable dead-letter. RT-330: freeze the re-offer's resolution
   * FIRST; if nothing could be frozen (a map changed since the eligibility
   * read), do not re-offer, since a pending row without a version would fall
   * back to the live join. Otherwise flip to pending, re-head the sequence,
   * RESET retry_count and point at the frozen version. Do NOT touch
   * document_ref (NULL on a non-posted row; the
   * (status='posted')=(document_ref IS NOT NULL) CHECK would otherwise bite).
   */
  private async reofferPosting(
    client: PoolClient,
    input: RepairPostingInput,
    row: { kind: "sale_post" | "reversal"; sale_id: string; store_id: string },
  ): Promise<RepairResult> {
    const version = await this.freezeRepairResolution(client, {
      tenantId: input.tenantId,
      intentId: input.workItemRef,
      kind: row.kind,
      saleId: row.sale_id,
      storeId: row.store_id,
    });
    if (version === null) {
      return this.recordRepair(client, input, "still_failing", null, false);
    }
    await client.query(
      `UPDATE erpnext_posting_status
          SET status = 'pending', sequence = DEFAULT,
              retry_count = $2, current_resolution_version = $3,
              updated_at = now()
        WHERE id = $1`,
      [input.workItemRef, REPAIR_RESET_RETRY_COUNT, version],
    );
    return this.recordRepair(client, input, "eligible_again", null, false);
  }

  /**
   * RT-330: a repair re-offer happens before any ERP side effect, so it is an
   * explicit, audited re-resolution (ERP Integration baseline): write version
   * n+1 (`resolved_by = 'operator'`) and point the row at it. A reversal copies
   * its sale's `sale_post` current resolution (original lineage); otherwise the
   * current maps are read. Each INSERT is all-or-nothing over the sale lines
   * (the worker's `freezeResolution` copy — SQL is duplicated per package).
   * Returns the frozen version, or null when nothing could be frozen.
   */
  private async freezeRepairResolution(
    client: PoolClient,
    input: {
      tenantId: string;
      intentId: string;
      kind: "sale_post" | "reversal";
      saleId: string;
      storeId: string;
    },
  ): Promise<number | null> {
    const next = await client.query<{ v: number }>(
      `SELECT COALESCE(MAX(resolution_version), 0) + 1 AS v
         FROM erpnext_posting_resolution WHERE intent_id = $1`,
      [input.intentId],
    );
    const version = next.rows[0]!.v;
    let written = 0;
    if (input.kind === "reversal") {
      const copied = await client.query(
        `INSERT INTO erpnext_posting_resolution
           (tenant_id, intent_id, resolution_version, sale_line_id,
            erpnext_item_ref, item_map_id, warehouse_ref, warehouse_map_id, resolved_by)
         SELECT $1, $2, $3, r.sale_line_id,
                r.erpnext_item_ref, r.item_map_id, r.warehouse_ref, r.warehouse_map_id, 'operator'
           FROM erpnext_posting_status sp
           JOIN erpnext_posting_resolution r
             ON r.intent_id = sp.id AND r.resolution_version = sp.current_resolution_version
          WHERE sp.tenant_id = $1 AND sp.kind = 'sale_post'
            AND sp.sale_id = $4 AND sp.source_ref_id = $4`,
        [input.tenantId, input.intentId, version, input.saleId],
      );
      written = copied.rowCount ?? 0;
    }
    if (written === 0) {
      const resolved = await client.query(
        `INSERT INTO erpnext_posting_resolution
           (tenant_id, intent_id, resolution_version, sale_line_id,
            erpnext_item_ref, item_map_id, warehouse_ref, warehouse_map_id, resolved_by)
         SELECT $1, $2, $3, sl.id, m.erpnext_item_ref, m.id,
                w.erpnext_warehouse_ref, w.id, 'operator'
           FROM sale_lines sl
           JOIN erpnext_warehouse_map w
             ON w.store_id = $5 AND w.purpose = 'stock' AND w.retired_at IS NULL
           JOIN erpnext_item_map m
             ON m.tenant_product_id = sl.tenant_product_ref
            AND m.state = 'confirmed' AND m.retired_at IS NULL
          WHERE sl.sale_id = $4
            AND NOT EXISTS (
              SELECT 1 FROM sale_lines ul
                LEFT JOIN erpnext_item_map um
                  ON um.tenant_product_id = ul.tenant_product_ref
                 AND um.state = 'confirmed' AND um.retired_at IS NULL
               WHERE ul.sale_id = $4
                 AND (ul.tenant_product_ref IS NULL OR um.id IS NULL))`,
        [input.tenantId, input.intentId, version, input.saleId, input.storeId],
      );
      written = resolved.rowCount ?? 0;
    }
    return written > 0 ? version : null;
  }

  /**
   * 015-RESOLVE re-evaluation (api-side copy; the SQL is duplicated per package,
   * NOT imported across the api/worker boundary — the 015 worker-consumer
   * precedent). Keys on the PARENT `sale_id` (present for both kinds; a reversal's
   * source_ref_id is a terminal-event id with no lines). Returns true iff the
   * store maps to an active warehouse AND every line resolves to a confirmed,
   * non-retired item map.
   */
  private async resolvePostingEligibility(
    client: PoolClient,
    input: { saleId: string; storeId: string },
  ): Promise<boolean> {
    const wh = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM erpnext_warehouse_map
        WHERE store_id = $1 AND retired_at IS NULL`,
      [input.storeId],
    );
    // A COUNT(*) query always returns exactly one row, so rows[0].count is never
    // absent — no defensive `?? "0"` needed (it would be a dead branch).
    if (Number(wh.rows[0]!.count) === 0) return false;

    const unmapped = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM sale_lines sl
         LEFT JOIN erpnext_item_map m
           ON m.tenant_product_id = sl.tenant_product_ref
          AND m.state = 'confirmed'
          AND m.retired_at IS NULL
        WHERE sl.sale_id = $1
          AND (sl.tenant_product_ref IS NULL OR m.id IS NULL)`,
      [input.saleId],
    );
    return Number(unmapped.rows[0]!.count) === 0;
  }

  /**
   * Persist the repair: an append-only `repair_attempt` + a platform
   * `audit_events` row IN THE SAME TRANSACTION (FR-014). The audit write is a
   * NEW in-transaction INSERT on the same tenant-scoped client (NOT the async
   * `@Auditable` interceptor, NOT `insertAuditEvent` which grabs its own
   * connection) — so a repair that cannot audit rolls back. No PII in either row.
   */
  private async recordRepair(
    client: PoolClient,
    input: RepairPostingInput,
    outcome: RepairOutcome,
    documentRef: string | null,
    replayed: boolean,
  ): Promise<RepairResult> {
    const r = await client.query<{ created_at: Date }>(
      `INSERT INTO erpnext_reconciliation_repair_attempt
         (id, tenant_id, target_kind, target_ref_id, repair_kind, actor_user_id,
          outcome, resolved_document_ref)
       VALUES ($1, $2, 'posting', $3, 're_post', $4, $5, $6)
       RETURNING created_at`,
      [newId(), input.tenantId, input.workItemRef, input.actorUserId, outcome, documentRef],
    );
    await this.insertAudit(client, input.tenantId, input.actorUserId, {
      action: "erpnext_reconciliation.posting.repaired",
      targetType: "erpnext_posting_status",
      targetId: input.workItemRef,
      metadata: { outcome, repair_kind: "re_post" },
    });
    // §VII repair signal — a SIGNAL, never alters the outcome (the row is written above).
    recordErpnextReconciliationRepair();
    return {
      replayed,
      repair: {
        targetKind: "posting",
        targetRef: input.workItemRef,
        repairKind: "re_post",
        outcome,
        resolvedDocumentRef: documentRef,
        recordedAt: r.rows[0]!.created_at.toISOString(),
      },
    };
  }

  // ===== US3: stock reconciliation run + report + repair ====================

  /**
   * Trigger an on-demand stock reconciliation run (US3). Creates the run row
   * (`status='running'`), a platform `audit_events` row, AND emits an
   * `erpnext.reconciliation.requested` outbox event — all in ONE transaction
   * (017-RECON-WIRING). The worker-side `ReconciliationRequestedConsumer` drains
   * the event and invokes `ReconciliationRunProcessor`, advancing the run
   * `running → completed`. The emit is ATOMIC with the run insert: if the
   * transaction rolls back, neither the run nor the event persists, so there is
   * never an orphaned `running` row with no event to drive it (nor an event for
   * a run that never committed).
   *
   * The emit makes the DP2-INTERNAL loop live; it does NOT make the cross-system
   * connector→ERPNext-Bin read live (the consumer wires `EMPTY_BIN_VIEW` — the
   * stub-tolerant seam; the live read is the future [GATED] 017-STOCK-VIEW-CONTRACT).
   * The target store must resolve in the tenant (RLS), be inside the caller's
   * membership store scope and not be soft-deleted (RT-191); else
   * StoreNotFoundError. The scheduled sweep (RT-179) is a system actor and
   * calls `createStockReconciliationRun` directly, without this check.
   */
  async triggerRun(input: TriggerRunInput): Promise<ReconciliationRunBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ReconciliationRunBody> => {
        if (!(await this.storeWritable(client, input, input.storeId))) {
          throw new StoreNotFoundError();
        }

        // RT-179: the run insert + audit + 019-T041 conditional emit live in the
        // shared `createStockReconciliationRun` (packages/db), the same path the
        // worker's scheduled sweep uses. A store with an active `stock` map
        // DEFERS the emit to the connector Bin snapshot; an unmapped store emits
        // now so the processor completes it as `unmapped_store` (CodeRabbit #528
        // P1: do not strand unmapped-store runs).
        const { run } = await createStockReconciliationRun(client, {
          runId: newId(),
          auditEventId: newId(),
          tenantId: input.tenantId,
          storeId: input.storeId,
          trigger: "on_demand",
          actorUserId: input.actorUserId,
          actorLabel: null,
        });
        return toRunBody(run);
      },
    );
  }

  /** Get a run by id (US3). Cross-tenant / out-of-scope / absent → RunNotFoundError (404). */
  async getRun(input: RunReadInput): Promise<ReconciliationRunBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ReconciliationRunBody> => toRunBody(await this.readableRun(client, input)),
    );
  }

  /** List a run's classified results (US3), cursor-paginated. Foreign / out-of-scope run → 404. */
  async listResults(
    input: ListResultsInput,
  ): Promise<{ items: ReconciliationResultBody[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(1, input.limit), BACKLOG_MAX_PAGE);
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        await this.readableRun(client, input);

        const rows = await client.query<ResultDbRow>(
          `SELECT id, run_id, mismatch_class, source_ref_id, result_state, detail
             FROM erpnext_reconciliation_result
            WHERE run_id = $1
              AND ($2::uuid IS NULL OR id > $2::uuid)
              AND ($3::text IS NULL OR mismatch_class = $3::text)
            ORDER BY id
            LIMIT $4`,
          [input.runId, input.cursor ?? null, input.mismatchClass ?? null, limit],
        );
        const items = rows.rows.map(toResultBody);
        // limit >= 1 (clamped), so a full page (length === limit) is always
        // non-empty — no redundant `&& length > 0` (it would be a dead branch).
        const nextCursor =
          rows.rows.length === limit ? rows.rows[rows.rows.length - 1]!.id : null;
        return { items, nextCursor };
      },
    );
  }

  /**
   * Repair an actionable stock-mismatch result (US3). A state-transition + audit
   * — NOT an ERPNext mutation: DP2 makes no outbound HTTP and the connector
   * isn't built, so `re_map`/`re_sync` records the repair_attempt, flips the
   * result `open → repaired`, and audits. `result_state='repaired'` means the
   * operator ACKNOWLEDGED + INITIATED the fix (through the owning flow — 014 admin
   * re-map; re_sync via the connector when it ships), NOT that ERPNext now agrees.
   * The 009 ledger is NEVER mutated (FR-013/016). Foreign run/result → 404.
   */
  async repairStock(input: RepairStockInput): Promise<RepairResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<RepairResult> => {
        const cur = await client.query<{ result_state: string; store_id: string }>(
          `SELECT res.result_state, run.store_id
             FROM erpnext_reconciliation_result res
             JOIN erpnext_reconciliation_run run ON run.id = res.run_id
            WHERE res.id = $1 AND res.run_id = $2
            FOR UPDATE OF res`,
          [input.resultId, input.runId],
        );
        const row = cur.rows[0];
        if (!row) throw new RunNotFoundError();
        // RT-191: a result of a store outside the caller's scope (or of a
        // deleted store) is indistinguishable from a missing one.
        if (!(await this.storeWritable(client, input, row.store_id))) {
          throw new RunNotFoundError();
        }

        // Already repaired → idempotent no-op echo (no re-transition).
        const replayed = row.result_state !== "open";
        if (!replayed) {
          await client.query(
            `UPDATE erpnext_reconciliation_result
                SET result_state = 'repaired', updated_at = now()
              WHERE id = $1`,
            [input.resultId],
          );
        }
        const r = await client.query<{ created_at: Date }>(
          `INSERT INTO erpnext_reconciliation_repair_attempt
             (id, tenant_id, target_kind, target_ref_id, repair_kind, actor_user_id, outcome)
           VALUES ($1, $2, 'stock', $3, $4, $5, $6)
           RETURNING created_at`,
          [
            newId(),
            input.tenantId,
            input.resultId,
            input.repairKind,
            input.actorUserId,
            replayed ? "no_op_echo" : "eligible_again",
          ],
        );
        await this.insertAudit(client, input.tenantId, input.actorUserId, {
          action: "erpnext_reconciliation.stock.repaired",
          targetType: "erpnext_reconciliation_result",
          targetId: input.resultId,
          metadata: { repair_kind: input.repairKind },
        });
        recordErpnextReconciliationRepair();
        return {
          replayed,
          repair: {
            targetKind: "stock",
            targetRef: input.resultId,
            repairKind: input.repairKind,
            outcome: replayed ? "no_op_echo" : "eligible_again",
            resolvedDocumentRef: null,
            recordedAt: r.rows[0]!.created_at.toISOString(),
          },
        };
      },
    );
  }

  /**
   * RT-192: the addressed run, if it resolves in the tenant (RLS) and its store
   * is inside the caller's membership store scope; else RunNotFoundError, the
   * same non-disclosing 404 as a missing run.
   */
  private async readableRun(client: PoolClient, input: RunReadInput): Promise<RunDbRow> {
    const r = await client.query<RunDbRow>(
      `SELECT ${RUN_COLS} FROM erpnext_reconciliation_run WHERE id = $1`,
      [input.runId],
    );
    const run = r.rows[0];
    if (!run) throw new RunNotFoundError();
    const scope = await callerStoreScope(client, this.memberships, input);
    if (!inStoreScope(scope, run.store_id)) throw new RunNotFoundError();
    return run;
  }

  /**
   * RT-191: may this caller write against `storeId`? The store must be inside
   * the caller's membership store scope (the RT-177 rule: `owner` /
   * `tenant_admin` get their membership scope, not narrowed by the active
   * store) and live (`deleted_at IS NULL`). Runs on the tenant-scoped client, so
   * a foreign-tenant store never resolves either (RLS).
   */
  private async storeWritable(
    client: PoolClient,
    input: ScopedInput,
    storeId: string,
  ): Promise<boolean> {
    const scope = await callerStoreScope(client, this.memberships, input);
    if (!inStoreScope(scope, storeId)) return false;
    const store = await client.query<{ id: string }>(
      `SELECT id FROM stores WHERE id = $1 AND deleted_at IS NULL`,
      [storeId],
    );
    return store.rows.length > 0;
  }

  /** Shared in-transaction platform audit insert (FR-014; same tx client, no PII). */
  private async insertAudit(
    client: PoolClient,
    tenantId: string,
    actorUserId: string,
    opts: { action: string; targetType: string; targetId: string; metadata: Record<string, unknown> },
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [newId(), actorUserId, tenantId, opts.action, opts.targetType, opts.targetId, JSON.stringify(opts.metadata)],
    );
  }
}

// ---------------------------------------------------------------------------
// US3 row → wire projection helpers
// ---------------------------------------------------------------------------

const RUN_COLS = STOCK_RECONCILIATION_RUN_COLUMNS;

type RunDbRow = StockReconciliationRunRow;

interface ResultDbRow {
  id: string;
  run_id: string;
  mismatch_class: string;
  source_ref_id: string | null;
  result_state: "open" | "repaired" | "accepted";
  detail: Record<string, unknown> | null;
}

function toRunBody(r: RunDbRow): ReconciliationRunBody {
  return {
    id: r.id,
    storeId: r.store_id,
    kind: r.kind,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
    summary: r.summary,
  };
}

function toResultBody(r: ResultDbRow): ReconciliationResultBody {
  return {
    id: r.id,
    runId: r.run_id,
    mismatchClass: r.mismatch_class,
    sourceRef: r.source_ref_id,
    resultState: r.result_state,
    detail: r.detail,
  };
}
