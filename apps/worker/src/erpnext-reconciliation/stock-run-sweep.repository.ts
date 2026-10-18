/**
 * RT-179 — Postgres side of the scheduled stock reconciliation run sweep.
 *
 * RLS posture (the RT-123 lesson: a sweep without a GUC sees nothing under
 * FORCE RLS):
 *   - `listActiveTenantIds` is the ONLY platform-admin read. It reads tenant
 *     ids, nothing else, through the `tenants` policy's is_platform_admin
 *     branch (the same boundary the retention sweeps use).
 *   - Every other statement runs in its own transaction under ONE tenant's GUC
 *     (`isPlatformAdmin: false`). `erpnext_warehouse_map` and
 *     `erpnext_reconciliation_run` have no platform branch, so the store list,
 *     the idempotency checks and every write are confined to that tenant by
 *     RLS; the explicit `tenant_id = $1` predicates are belt-and-braces.
 *
 * Run creation goes through the shared `createStockReconciliationRun` — the
 * exact path the api `triggerRun` uses — with `trigger='scheduled'`.
 *
 * Eligibility is atomic with creation: inside the per-store transaction the
 * tenant, store and stock-map rows are re-read `FOR SHARE`. A concurrent
 * suspension / store deactivation / map retirement either committed first (the
 * locked re-read sees it, under READ COMMITTED's recheck of the newest row
 * version) or waits for this transaction to commit. An ineligible store is
 * `skipped_ineligible` and never reaches run creation, so the sweep never
 * creates a run for a suspended tenant or an unmapped store. Row locks need
 * UPDATE privilege; the domain runtime role (DATABASE_URL) already updates all
 * three tables (tenant status, store lifecycle, map retirement), and the
 * tables' UPDATE policies admit the tenant's own rows under its GUC.
 *
 * RT-688 (RT-187 D5) — run expiry. `expireStaleRuns` runs once per tenant per
 * tick, before the store sweep, in its own transaction under that tenant's
 * GUC. It moves every `kind='stock'` run still `running` `STOCK_RUN_TTL_MS`
 * after `started_at` whose Bin report is NOT complete to `failed` through the
 * shared `failStockReconciliationRun` (row lock + re-check, `summary.failure`,
 * audit row). It covers every store of the tenant, mapped or not, so a run
 * abandoned before a remap or a deactivation is expired too. A run whose
 * report IS complete is never expired: it waits for the reconciliation worker
 * and is only counted (`strandedComplete`). The TTL is measured from the
 * tick's time (the same instant a scheduled run's `started_at` is stamped
 * with), so a delayed or retried job only expires later, never earlier.
 */
import {
  createStockReconciliationRun,
  failStockReconciliationRun,
  runWithTenantContext,
  stockRunReportCompleteSql,
} from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import type { StockReconciliationSweepOutcome } from "../observability/metrics/worker.metrics";
import type { SweepPeriod } from "./stock-run-sweep.config";

/** `audit_events.actor_label` on a scheduled run's audit row (no human actor). */
export const STOCK_RUN_SWEEP_ACTOR_LABEL = "system:erpnext-stock-reconciliation-sweep";

/** `audit_events.actor_label` on an expired run's audit row (RT-688). */
export const STOCK_RUN_EXPIRY_ACTOR_LABEL = "system:erpnext-stock-run-expiry";

/**
 * RT-688 (RT-187 D5) — run TTL: a stock run still `running` this long after
 * `started_at` without a complete Bin report is expired. Four times the
 * connector's ~25 min retry horizon plus margin, far shorter than the sweep
 * period.
 */
export const STOCK_RUN_TTL_MS = 2 * 60 * 60 * 1000;

/** One tenant's expiry pass (RT-688). */
export interface ExpireStaleRunsResult {
  /** Runs moved `running → failed` by this pass. */
  readonly expired: readonly string[];
  /** Runs still `running` past the TTL with an incomplete report (a lost race). */
  readonly strandedIncomplete: number;
  /** Runs still `running` past the TTL with a complete report (never expired). */
  readonly strandedComplete: number;
}

/** One store of one tenant, as the sweep addresses it. */
export interface StoreSweepTarget {
  readonly tenantId: string;
  readonly storeId: string;
}

export interface SweepStoreInput {
  readonly target: StoreSweepTarget;
  /** The tick: `start` bounds the period check, `now` is the run's `started_at`. */
  readonly period: SweepPeriod;
}

export interface SweepStoreResult {
  readonly outcome: StockReconciliationSweepOutcome;
  /** The created run, or the run that caused the skip; null when ineligible. */
  readonly runId: string | null;
}

export interface StockRunSweepRepository {
  listActiveTenantIds(): Promise<string[]>;
  /** Active, non-deleted stores of `tenantId` with an active `stock` warehouse map. */
  listMappedStoreIds(tenantId: string): Promise<string[]>;
  sweepStore(input: SweepStoreInput): Promise<SweepStoreResult>;
  /**
   * RT-688: expire `tenantId`'s incomplete stock runs started more than
   * `STOCK_RUN_TTL_MS` before `now`, then count the stranded ones.
   */
  expireStaleRuns(tenantId: string, now: Date): Promise<ExpireStaleRunsResult>;
}

export class PgStockRunSweepRepository implements StockRunSweepRepository {
  constructor(private readonly pool: Pool) {}

  listActiveTenantIds(): Promise<string[]> {
    return runWithTenantContext(
      this.pool,
      { tenantId: null, isPlatformAdmin: true },
      async (client) => {
        const r = await client.query<{ id: string }>(
          `SELECT id FROM tenants
            WHERE deleted_at IS NULL AND status = 'active'
            ORDER BY id`,
        );
        return r.rows.map((row) => row.id);
      },
    );
  }

  listMappedStoreIds(tenantId: string): Promise<string[]> {
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{ store_id: string }>(
          `SELECT DISTINCT whm.store_id
             FROM erpnext_warehouse_map whm
             JOIN stores s ON s.id = whm.store_id
            WHERE whm.tenant_id = $1
              AND whm.purpose = 'stock'
              AND whm.retired_at IS NULL
              AND s.deleted_at IS NULL
              AND s.is_active
            ORDER BY whm.store_id`,
          [tenantId],
        );
        return r.rows.map((row) => row.store_id);
      },
    );
  }

  async sweepStore({ target, period }: SweepStoreInput): Promise<SweepStoreResult> {
    const { tenantId, storeId } = target;
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<SweepStoreResult> => {
        // Serialise concurrent sweeps of the same store (two worker replicas,
        // a retried job) so the checks below and the insert are atomic. The
        // lock is transaction-scoped and released on COMMIT/ROLLBACK.
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('erpnext-stock-run-sweep:' || $1::text, 0))`,
          [storeId],
        );

        // Eligibility, atomic with creation (see the module doc): the tenant is
        // active, the store is active and not deleted, and it has an active
        // `stock` map. FOR SHARE holds those rows until COMMIT, so a concurrent
        // suspension / deactivation / retirement cannot slip in before the
        // insert; one that committed first is seen by the locked re-read. A
        // foreign store id is invisible under this tenant's GUC (RLS), so it is
        // ineligible too and can never get a run stamped with this tenant.
        const eligible = await client.query<{ id: string }>(
          `SELECT s.id
             FROM stores s
             JOIN tenants t
               ON t.id = s.tenant_id
             JOIN erpnext_warehouse_map whm
               ON whm.store_id = s.id
              AND whm.tenant_id = s.tenant_id
            WHERE s.id = $1 AND s.tenant_id = $2
              AND t.status = 'active' AND t.deleted_at IS NULL
              AND s.deleted_at IS NULL AND s.is_active
              AND whm.purpose = 'stock' AND whm.retired_at IS NULL
              FOR SHARE OF t, s, whm`,
          [storeId, tenantId],
        );
        if (!eligible.rows[0]) return { outcome: "skipped_ineligible", runId: null };

        const running = await client.query<{ id: string }>(
          `SELECT id FROM erpnext_reconciliation_run
            WHERE tenant_id = $1 AND store_id = $2
              AND kind = 'stock' AND status = 'running'
            ORDER BY started_at
            LIMIT 1`,
          [tenantId, storeId],
        );
        if (running.rows[0]) {
          return { outcome: "skipped_running", runId: running.rows[0].id };
        }

        const inPeriod = await client.query<{ id: string }>(
          `SELECT id FROM erpnext_reconciliation_run
            WHERE tenant_id = $1 AND store_id = $2
              AND kind = 'stock' AND trigger = 'scheduled'
              AND started_at >= $3
            ORDER BY started_at
            LIMIT 1`,
          [tenantId, storeId, period.start],
        );
        if (inPeriod.rows[0]) {
          return { outcome: "skipped_period", runId: inPeriod.rows[0].id };
        }

        const { run } = await createStockReconciliationRun(client, {
          runId: newId(),
          auditEventId: newId(),
          tenantId,
          storeId,
          trigger: "scheduled",
          actorUserId: null,
          actorLabel: STOCK_RUN_SWEEP_ACTOR_LABEL,
          startedAt: period.now,
        });
        return { outcome: "created", runId: run.id };
      },
    );
  }

  expireStaleRuns(tenantId: string, now: Date): Promise<ExpireStaleRunsResult> {
    const cutoff = new Date(now.getTime() - STOCK_RUN_TTL_MS);
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<ExpireStaleRunsResult> => {
        const stale = await client.query<{ id: string }>(
          `SELECT run.id FROM erpnext_reconciliation_run run
            WHERE run.tenant_id = $1
              AND run.kind = 'stock' AND run.status = 'running'
              AND run.started_at < $2
              AND NOT ${stockRunReportCompleteSql("run")}
            ORDER BY run.started_at, run.id`,
          [tenantId, cutoff],
        );

        // Each failure re-checks under the row lock, so a report that completed
        // since the read above is left running (and counted below).
        const expired: string[] = [];
        for (const { id } of stale.rows) {
          const failed = await failStockReconciliationRun(client, {
            runId: id,
            auditEventId: newId(),
            tenantId,
            reason: "bin_view_not_completed",
            actorUserId: null,
            actorLabel: STOCK_RUN_EXPIRY_ACTOR_LABEL,
          });
          if (failed) expired.push(id);
        }

        const stranded = await client.query<{ complete: string; incomplete: string }>(
          `SELECT count(*) FILTER (WHERE ${stockRunReportCompleteSql("run")})::text AS complete,
                  count(*) FILTER (WHERE NOT ${stockRunReportCompleteSql("run")})::text AS incomplete
             FROM erpnext_reconciliation_run run
            WHERE run.tenant_id = $1
              AND run.kind = 'stock' AND run.status = 'running'
              AND run.started_at < $2`,
          [tenantId, cutoff],
        );
        // An aggregate without GROUP BY always returns one row.
        const counts = stranded.rows[0]!;
        return {
          expired,
          strandedIncomplete: Number(counts.incomplete),
          strandedComplete: Number(counts.complete),
        };
      },
    );
  }
}

/** No-DB path (dev / CI without DATABASE_URL): nothing to sweep. */
export class NoOpStockRunSweepRepository implements StockRunSweepRepository {
  async listActiveTenantIds(): Promise<string[]> {
    return [];
  }

  async listMappedStoreIds(_tenantId: string): Promise<string[]> {
    return [];
  }

  async sweepStore(_input: SweepStoreInput): Promise<SweepStoreResult> {
    throw new Error("NoOpStockRunSweepRepository.sweepStore: no database configured");
  }

  async expireStaleRuns(_tenantId: string, _now: Date): Promise<ExpireStaleRunsResult> {
    throw new Error("NoOpStockRunSweepRepository.expireStaleRuns: no database configured");
  }
}
