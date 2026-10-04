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
