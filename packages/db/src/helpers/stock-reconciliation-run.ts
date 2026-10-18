/**
 * `createStockReconciliationRun` — the ONE creation path for a 017 stock
 * reconciliation run (RT-179).
 *
 * Shared by the two callers that start a run:
 *   - the api `ErpnextReconciliationService.triggerRun` (operator, `on_demand`);
 *   - the worker stock-run sweep (`scheduled`, no human actor).
 *
 * Runs on the CALLER's transaction client, which must already carry the
 * tenant GUC (`runWithTenantContext({ tenantId, isPlatformAdmin: false })`):
 * every statement is RLS-checked against that tenant, so a caller can never
 * create a run, an audit row or an outbox event for another tenant.
 *
 * In one transaction it:
 *   1. inserts the run (`kind='stock'`, `status='running'`);
 *   2. writes the platform `audit_events` row
 *      (`erpnext_reconciliation.run.triggered`, metadata `{ store_id }`);
 *   3. applies the 019-T041 lifecycle (shape a) — a CONDITIONAL emit:
 *        - the store HAS an active `purpose='stock'` warehouse map → DEFER: the
 *          run waits in `running`, offered on the 019 bin-view feed; the
 *          connector reports its Bin snapshot and `binViewReportSnapshot` emits
 *          `erpnext.reconciliation.requested` then, so the processor compares
 *          against REAL Bin data;
 *        - the store has NO active stock map → EMIT NOW: the feed only offers
 *          mapped runs, so a deferred unmapped-store run would be stranded in
 *          `running` forever. Emitting lets the processor complete it at once as
 *          `unmapped_store` (CodeRabbit #528 P1).
 *
 * A `returns`-only map is NOT a stock map: the trigger, the bin-view feed and
 * the run processor all count `purpose='stock'` only (RT-179).
 *
 * The caller owns the store-existence check (the api maps a missing store to
 * 404; the sweep only selects stores it can see).
 *
 * RT-688: `failStockReconciliationRun` is likewise the ONE early-failure path,
 * shared by the worker run-expiry pass and the api warehouse-map retire.
 */
import type { PoolClient } from "pg";

import { emit, OUTBOX_EVENT_TYPES } from "../outbox/producer";

export type StockReconciliationRunTrigger = "on_demand" | "scheduled";

/** The run columns every run read/write projects (api wire mapping input). */
export const STOCK_RECONCILIATION_RUN_COLUMNS =
  "id, store_id, kind, trigger, status, started_at, finished_at, summary";

export interface StockReconciliationRunRow {
  id: string;
  store_id: string;
  kind: "stock";
  trigger: StockReconciliationRunTrigger;
  status: "running" | "completed" | "failed";
  started_at: Date;
  finished_at: Date | null;
  summary: Record<string, unknown> | null;
}

export interface CreateStockReconciliationRunInput {
  /**
   * Caller-minted ids (UUIDv7 via `@data-pulse-2/shared` `newId()`; this
   * package does not depend on `shared`).
   */
  readonly runId: string;
  readonly auditEventId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly trigger: StockReconciliationRunTrigger;
  /** The operator for an `on_demand` run; `null` for a `scheduled` run. */
  readonly actorUserId: string | null;
  /**
   * `audit_events.actor_label` for a run with no human actor (the scheduled
   * sweep names itself here). `null` for an operator-triggered run.
   */
  readonly actorLabel: string | null;
  /**
   * `started_at` for the run. Omitted → the DB `now()` (the api path). The
   * scheduled sweep passes its own tick time so the run lands in the period
   * its idempotency check evaluated.
   */
  readonly startedAt?: Date;
}

export interface CreateStockReconciliationRunResult {
  readonly run: StockReconciliationRunRow;
  /**
   * True when `erpnext.reconciliation.requested` was emitted at creation (the
   * store has no active stock map). False when the run waits for the connector
   * Bin snapshot.
   */
  readonly emitted: boolean;
}

export async function createStockReconciliationRun(
  client: PoolClient,
  input: CreateStockReconciliationRunInput,
): Promise<CreateStockReconciliationRunResult> {
  const { runId } = input;
  const inserted = await client.query<StockReconciliationRunRow>(
    `INSERT INTO erpnext_reconciliation_run
       (id, tenant_id, store_id, kind, trigger, status, actor_user_id, started_at)
     VALUES ($1, $2, $3, 'stock', $4, 'running', $5, COALESCE($6::timestamptz, now()))
     RETURNING ${STOCK_RECONCILIATION_RUN_COLUMNS}`,
    [
      runId,
      input.tenantId,
      input.storeId,
      input.trigger,
      input.actorUserId,
      input.startedAt ?? null,
    ],
  );

  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, 'erpnext_reconciliation.run.triggered',
             'erpnext_reconciliation_run', $5, $6::jsonb)`,
    [
      input.auditEventId,
      input.actorUserId,
      input.actorLabel,
      input.tenantId,
      runId,
      JSON.stringify({ store_id: input.storeId }),
    ],
  );

  const mapped = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM erpnext_warehouse_map
      WHERE store_id = $1 AND purpose = 'stock' AND retired_at IS NULL`,
    [input.storeId],
  );
  // A COUNT(*) always returns one row.
  const emitted = Number(mapped.rows[0]!.n) === 0;
  if (emitted) {
    await emit(client, {
      eventType: OUTBOX_EVENT_TYPES.ERPNEXT_RECONCILIATION_REQUESTED,
      tenantId: input.tenantId,
      storeId: input.storeId,
      payload: { run_id: runId, store_id: input.storeId },
    });
  }

  return { run: inserted.rows[0]!, emitted };
}

/**
 * RT-688 — SQL predicate: the run's connector Bin report is complete. `alias`
 * is the `erpnext_reconciliation_run` alias in the caller's query.
 *
 * Matches the bin-view service's reading of a stored report: a report without
 * `complete` (pre-RT-175, one final window) counts as complete, so only an
 * explicit `complete: false` (an attempt still in progress) or no report at
 * all is incomplete.
 */
export function stockRunReportCompleteSql(alias: string): string {
  // COALESCE: a NULL summary must read as incomplete, never as NULL (which
  // would make `NOT <predicate>` drop the row too).
  return `COALESCE(jsonb_typeof(${alias}.summary->'bin_view_report') = 'object'
       AND (${alias}.summary->'bin_view_report'->'complete') IS DISTINCT FROM 'false'::jsonb, false)`;
}

/** Why a stock run was failed before its report completed (RT-688). */
export type StockReconciliationRunFailureReason =
  /** Still `running` past the run TTL without a complete report (D5). */
  | "bin_view_not_completed"
  /** The store's stock warehouse map was retired mid-run (§5.1). */
  | "warehouse_remapped";

export interface FailStockReconciliationRunInput {
  readonly runId: string;
  /** Caller-minted id for the audit row (written only when the run fails). */
  readonly auditEventId: string;
  readonly tenantId: string;
  readonly reason: StockReconciliationRunFailureReason;
  /** The operator who caused it (a map retire); `null` for the expiry sweep. */
  readonly actorUserId: string | null;
  /** `audit_events.actor_label` when there is no human actor. */
  readonly actorLabel: string | null;
}

/**
 * RT-688 — move a `running` stock run whose Bin report is NOT complete to
 * `failed`. Runs on the caller's tenant-scoped transaction client.
 *
 * The UPDATE locks the run row and re-checks `status = 'running'` and the
 * incomplete report on the newest row version (READ COMMITTED re-check), so it
 * never races `binViewReportSnapshot`, which holds the same row lock while it
 * records a window: a report that completed first wins and the run is left
 * alone (its `erpnext.reconciliation.requested` is already emitted, and
 * failing it would strand the processor).
 *
 * `summary.failure` records the reason plus, when present, the attempt id and
 * windows recorded so far: ids and counts only, no quantities or PII. The
 * partial `bin_view_report` is left in place as evidence. One `audit_events`
 * row (`erpnext_reconciliation.run.failed`) is written in the same transaction.
 *
 * Returns the store id of the failed run, or null when the run was not failed
 * (not running, report complete, or invisible under the tenant GUC).
 */
export async function failStockReconciliationRun(
  client: PoolClient,
  input: FailStockReconciliationRunInput,
): Promise<{ storeId: string } | null> {
  const updated = await client.query<{ store_id: string }>(
    `UPDATE erpnext_reconciliation_run run
        SET status      = 'failed',
            finished_at = now(),
            updated_at  = now(),
            summary     = COALESCE(run.summary, '{}'::jsonb) || jsonb_build_object(
              'failure', jsonb_strip_nulls(jsonb_build_object(
                'reason', $2::text,
                'attemptRef', run.summary #> '{bin_view_report,attemptRef}',
                'windowsRecorded', run.summary #> '{bin_view_report,windowsRecorded}')))
      WHERE run.id = $1
        AND run.kind = 'stock'
        AND run.status = 'running'
        AND NOT ${stockRunReportCompleteSql("run")}
      RETURNING run.store_id`,
    [input.runId, input.reason],
  );
  const row = updated.rows[0];
  if (!row) return null;

  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, 'erpnext_reconciliation.run.failed',
             'erpnext_reconciliation_run', $5, $6::jsonb)`,
    [
      input.auditEventId,
      input.actorUserId,
      input.actorLabel,
      input.tenantId,
      input.runId,
      JSON.stringify({ store_id: row.store_id, reason: input.reason }),
    ],
  );
  return { storeId: row.store_id };
}
