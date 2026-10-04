/**
 * RT-179 — `StockRunSweepProcessor`: the scheduled ERPNext stock reconciliation
 * run sweep.
 *
 * Before RT-179 a stock run only started when an operator called the api
 * `triggerRun`; the `scheduled` trigger existed in the schema but nothing
 * produced it. This processor runs on a BullMQ repeatable job
 * (`StockRunSweepScheduler`, default daily) and, for every active tenant, for
 * every store with an active `purpose='stock'` warehouse map, creates one
 * `scheduled` stock run through the same creation path as `triggerRun`. Mapped
 * stores defer the run to the connector Bin snapshot, so the live loop is the
 * on-demand one: bin-view feed → connector snapshot → `erpnext.reconciliation.
 * requested` → `ReconciliationRunProcessor`.
 *
 * Per store, in one tenant-scoped transaction (see the repository):
 *   - a `running` stock run exists (any trigger)   → `skipped_running`;
 *   - a `scheduled` run started in this period     → `skipped_period`;
 *   - otherwise                                    → `created`.
 * So a re-delivered or second tick within a period creates nothing, and a
 * store whose last run never completed is not stacked with more runs.
 *
 * Stores without a stock map (none, or a `returns`-only map) are never listed,
 * so the sweep creates no run for them — the unmapped case stays the operator's
 * on-demand trigger, which completes as `unmapped_store`.
 *
 * Tenants are swept independently: a failure in one is logged and the sweep
 * continues; the job then fails with `StockRunSweepIncompleteError` so BullMQ
 * retries it, and the idempotency rules make the retry a no-op for the stores
 * already handled.
 */
import { z } from "zod";

import {
  recordStockReconciliationSweep,
  type StockReconciliationSweepOutcome,
} from "../observability/metrics/worker.metrics";
import { sweepPeriodStart } from "./stock-run-sweep.config";
import type { StockRunSweepRepository } from "./stock-run-sweep.repository";

/** BullMQ job (and job-scheduler) name. Pinned by the scheduler spec. */
export const STOCK_RUN_SWEEP_JOB_NAME = "erpnext-stock-reconciliation-sweep";

/** Scheduled sweeps carry no payload; passthrough tolerates BullMQ metadata. */
const StockRunSweepJobSchema = z.object({}).passthrough();

export type StockRunSweepLogLine = Readonly<Record<string, string | number>>;
export type StockRunSweepLog = (line: StockRunSweepLogLine) => void;

const COMPONENT = "erpnext-reconciliation.stock-run-sweep";

function writeStderr(line: StockRunSweepLogLine): void {
  process.stderr.write(JSON.stringify(line) + "\n");
}

export interface StockRunSweepResult {
  readonly periodStart: string;
  readonly tenants: number;
  readonly created: number;
  readonly skippedRunning: number;
  readonly skippedPeriod: number;
  readonly failedTenants: number;
}

export class UnknownStockRunSweepJobError extends Error {
  constructor(jobName: string) {
    super(`Unknown stock-run-sweep job name: '${jobName}'`);
    this.name = "UnknownStockRunSweepJobError";
  }
}

export class MalformedStockRunSweepJobError extends Error {
  constructor(jobName: string) {
    super(`Malformed stock-run-sweep job '${jobName}': payload must be an object`);
    this.name = "MalformedStockRunSweepJobError";
  }
}

export class StockRunSweepIncompleteError extends Error {
  constructor(failedTenants: number) {
    super(`stock run sweep incomplete: ${failedTenants} tenant(s) failed`);
    this.name = "StockRunSweepIncompleteError";
  }
}

export class StockRunSweepProcessor {
  constructor(
    private readonly repo: StockRunSweepRepository,
    private readonly intervalMs: number,
    private readonly clock: () => Date = () => new Date(),
    private readonly log: StockRunSweepLog = writeStderr,
  ) {}

  async process(jobName: string, data: unknown): Promise<StockRunSweepResult> {
    if (jobName !== STOCK_RUN_SWEEP_JOB_NAME) {
      throw new UnknownStockRunSweepJobError(jobName);
    }
    if (!StockRunSweepJobSchema.safeParse(data).success) {
      throw new MalformedStockRunSweepJobError(jobName);
    }

    const now = this.clock();
    const periodStart = sweepPeriodStart(now, this.intervalMs);
    const counts: Record<StockReconciliationSweepOutcome, number> = {
      created: 0,
      skipped_running: 0,
      skipped_period: 0,
    };
    let failedTenants = 0;

    const tenantIds = await this.repo.listActiveTenantIds();
    for (const tenantId of tenantIds) {
      try {
        await this.sweepTenant(tenantId, periodStart, now, counts);
      } catch (err) {
        failedTenants += 1;
        // Error class only — a pg message can carry row values (§VII).
        this.log({
          level: "error",
          component: COMPONENT,
          message: "tenant_sweep_failed",
          tenant_id: tenantId,
          errorName: err instanceof Error ? err.name || "Error" : "UnknownError",
        });
      }
    }

    const result: StockRunSweepResult = {
      periodStart: periodStart.toISOString(),
      tenants: tenantIds.length,
      created: counts.created,
      skippedRunning: counts.skipped_running,
      skippedPeriod: counts.skipped_period,
      failedTenants,
    };
    this.log({
      level: failedTenants > 0 ? "warn" : "info",
      component: COMPONENT,
      message: "sweep_complete",
      period_start: result.periodStart,
      tenants: result.tenants,
      created: result.created,
      skipped_running: result.skippedRunning,
      skipped_period: result.skippedPeriod,
      failed_tenants: failedTenants,
    });
    if (failedTenants > 0) throw new StockRunSweepIncompleteError(failedTenants);
    return result;
  }

  private async sweepTenant(
    tenantId: string,
    periodStart: Date,
    now: Date,
    counts: Record<StockReconciliationSweepOutcome, number>,
  ): Promise<void> {
    const storeIds = await this.repo.listMappedStoreIds(tenantId);
    for (const storeId of storeIds) {
      const { outcome, runId } = await this.repo.sweepStore({
        tenantId,
        storeId,
        periodStart,
        now,
      });
      counts[outcome] += 1;
      recordStockReconciliationSweep(outcome);
      this.log({
        level: "info",
        component: COMPONENT,
        message: "store_swept",
        outcome,
        tenant_id: tenantId,
        store_id: storeId,
        run_id: runId,
      });
    }
  }
}
