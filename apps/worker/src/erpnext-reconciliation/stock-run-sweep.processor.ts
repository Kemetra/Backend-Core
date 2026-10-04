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
 *   - tenant suspended, store inactive/deleted or
 *     stock map retired since the listing          → `skipped_ineligible`;
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
 * Tenants AND stores are swept independently: a failure in one store (or in a
 * tenant's store listing) is logged and the sweep continues with the rest; the
 * job then fails with `StockRunSweepIncompleteError` so BullMQ retries it, and
 * the idempotency rules make the retry a no-op for the stores already handled.
 *
 * The period is taken from the tick's SCHEDULED time when the job carries it
 * (a job-scheduler job id is `repeat:<scheduler>:<scheduledMillis>`), not from
 * the wall clock at processing time, so queue delay or a worker clock running
 * slightly behind Redis cannot move a tick into the wrong period. The
 * scheduler anchors ticks on period boundaries (see the scheduler).
 */
import { z } from "zod";

import {
  recordStockReconciliationSweep,
  type StockReconciliationSweepOutcome,
} from "../observability/metrics/worker.metrics";
import { sweepPeriod, type SweepPeriod } from "./stock-run-sweep.config";
import type {
  StockRunSweepRepository,
  StoreSweepTarget,
  SweepStoreResult,
} from "./stock-run-sweep.repository";

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

/** A BullMQ job as the sweep receives it. */
export interface SweepJob {
  readonly name: string;
  readonly data: unknown;
  /** The tick's scheduled time, when known (see `scheduledAtFromJobId`). */
  readonly scheduledAt?: Date | undefined;
}

/** One tenant of one sweep pass. */
interface TenantSweepTarget {
  readonly tenantId: string;
}

export interface StockRunSweepResult {
  readonly periodStart: string;
  readonly tenants: number;
  readonly created: number;
  readonly skippedRunning: number;
  readonly skippedPeriod: number;
  readonly skippedIneligible: number;
  readonly failedTenants: number;
  readonly failedStores: number;
}

export class UnknownStockRunSweepJobError extends Error {
  constructor(job: SweepJob) {
    super(`Unknown stock-run-sweep job name: '${job.name}'`);
    this.name = "UnknownStockRunSweepJobError";
  }
}

export class MalformedStockRunSweepJobError extends Error {
  constructor(job: SweepJob) {
    super(`Malformed stock-run-sweep job '${job.name}': payload must be an object`);
    this.name = "MalformedStockRunSweepJobError";
  }
}

export class StockRunSweepIncompleteError extends Error {
  constructor(result: StockRunSweepResult) {
    super(
      `stock run sweep incomplete: ${result.failedTenants} tenant(s) and ` +
        `${result.failedStores} store(s) failed`,
    );
    this.name = "StockRunSweepIncompleteError";
  }
}

/** The running totals of one sweep pass. */
class SweepTally {
  private readonly counts: Record<StockReconciliationSweepOutcome, number> = {
    created: 0,
    skipped_running: 0,
    skipped_period: 0,
    skipped_ineligible: 0,
  };
  private tenants = 0;
  private failedTenants = 0;
  private failedStores = 0;

  constructor(private readonly period: SweepPeriod) {}

  tenantDone(succeeded: boolean): void {
    this.tenants += 1;
    if (!succeeded) this.failedTenants += 1;
  }

  storeDone(swept: SweepStoreResult): void {
    this.counts[swept.outcome] += 1;
  }

  storeFailed(): void {
    this.failedStores += 1;
  }

  result(): StockRunSweepResult {
    return {
      periodStart: this.period.start.toISOString(),
      tenants: this.tenants,
      created: this.counts.created,
      skippedRunning: this.counts.skipped_running,
      skippedPeriod: this.counts.skipped_period,
      skippedIneligible: this.counts.skipped_ineligible,
      failedTenants: this.failedTenants,
      failedStores: this.failedStores,
    };
  }
}

export class StockRunSweepProcessor {
  constructor(
    private readonly repo: StockRunSweepRepository,
    private readonly intervalMs: number,
    private readonly clock: () => Date = () => new Date(),
    private readonly log: StockRunSweepLog = writeStderr,
  ) {}

  /** Process a job without a known scheduled time (period from the clock). */
  async process(jobName: string, data: unknown): Promise<StockRunSweepResult> {
    return this.processJob({ name: jobName, data });
  }

  async processJob(job: SweepJob): Promise<StockRunSweepResult> {
    assertSweepJob(job);

    const period = sweepPeriod(job.scheduledAt ?? this.clock(), this.intervalMs);
    const tally = new SweepTally(period);
    for (const tenantId of await this.repo.listActiveTenantIds()) {
      tally.tenantDone(await this.sweepTenantSafely({ tenantId }, period, tally));
    }

    const result = tally.result();
    this.logSummary(result);
    if (isIncomplete(result)) throw new StockRunSweepIncompleteError(result);
    return result;
  }

  /** Sweep one tenant. A listing failure is logged and returns false. */
  private async sweepTenantSafely(
    tenant: TenantSweepTarget,
    period: SweepPeriod,
    tally: SweepTally,
  ): Promise<boolean> {
    try {
      await this.sweepTenant(tenant, period, tally);
      return true;
    } catch (err) {
      this.log({
        level: "error",
        component: COMPONENT,
        message: "tenant_sweep_failed",
        tenant_id: tenant.tenantId,
        ...errorFields(err),
      });
      return false;
    }
  }

  private async sweepTenant(
    tenant: TenantSweepTarget,
    period: SweepPeriod,
    tally: SweepTally,
  ): Promise<void> {
    for (const storeId of await this.repo.listMappedStoreIds(tenant.tenantId)) {
      await this.sweepStoreSafely({ tenantId: tenant.tenantId, storeId }, period, tally);
    }
  }

  /** Sweep one store. A failure is logged and counted; the next store still runs. */
  private async sweepStoreSafely(
    target: StoreSweepTarget,
    period: SweepPeriod,
    tally: SweepTally,
  ): Promise<void> {
    try {
      const swept = await this.repo.sweepStore({ target, period });
      tally.storeDone(swept);
      this.recordOutcome(target, swept);
    } catch (err) {
      tally.storeFailed();
      this.log({
        level: "error",
        component: COMPONENT,
        message: "store_sweep_failed",
        tenant_id: target.tenantId,
        store_id: target.storeId,
        ...errorFields(err),
      });
    }
  }

  private recordOutcome(target: StoreSweepTarget, swept: SweepStoreResult): void {
    recordStockReconciliationSweep(swept.outcome);
    this.log({
      level: "info",
      component: COMPONENT,
      message: "store_swept",
      outcome: swept.outcome,
      tenant_id: target.tenantId,
      store_id: target.storeId,
      ...(swept.runId === null ? {} : { run_id: swept.runId }),
    });
  }

  private logSummary(result: StockRunSweepResult): void {
    this.log({
      level: isIncomplete(result) ? "warn" : "info",
      component: COMPONENT,
      message: "sweep_complete",
      period_start: result.periodStart,
      tenants: result.tenants,
      created: result.created,
      skipped_running: result.skippedRunning,
      skipped_period: result.skippedPeriod,
      skipped_ineligible: result.skippedIneligible,
      failed_tenants: result.failedTenants,
      failed_stores: result.failedStores,
    });
  }
}

function isIncomplete(result: StockRunSweepResult): boolean {
  return result.failedTenants > 0 || result.failedStores > 0;
}

/** Rejects a job that is not the sweep, or whose payload is not an object. */
function assertSweepJob(job: SweepJob): void {
  if (job.name !== STOCK_RUN_SWEEP_JOB_NAME) {
    throw new UnknownStockRunSweepJobError(job);
  }
  if (!StockRunSweepJobSchema.safeParse(job.data).success) {
    throw new MalformedStockRunSweepJobError(job);
  }
}

const SCHEDULED_JOB_ID = new RegExp(`^repeat:${STOCK_RUN_SWEEP_JOB_NAME}:(\\d{1,15})$`);

/**
 * The scheduled time of a job-scheduler job, from its id
 * (`repeat:<schedulerId>:<scheduledMillis>`, BullMQ 5 job schedulers). Any
 * other id (a manually added job, none at all) → undefined.
 */
export function scheduledAtFromJobId(jobId: string | undefined): Date | undefined {
  const match = jobId === undefined ? null : SCHEDULED_JOB_ID.exec(jobId);
  return match ? new Date(Number(match[1])) : undefined;
}

/**
 * The error's class name for logs, never its message: a pg or Redis message
 * can carry row values or a connection string (§VII / §XIV).
 */
export function errorClassName(err: unknown): string {
  if (!(err instanceof Error)) return "UnknownError";
  return err.name || "Error";
}

/** Short identifier-like codes only: a SQLSTATE (`40P01`) or a Node code (`ECONNRESET`). */
const ERROR_CODE = /^[A-Z0-9_]{1,32}$/;

/**
 * Loggable error fields: the class name plus, when present, the error's code.
 * pg's `DatabaseError` names every failure "error", so the SQLSTATE in
 * `err.code` is what makes a failure diagnosable. A code carries no row values;
 * anything that is not a short identifier-like string is dropped.
 */
export function errorFields(err: unknown): { errorName: string; errorCode?: string } {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && ERROR_CODE.test(code)
    ? { errorName: errorClassName(err), errorCode: code }
    : { errorName: errorClassName(err) };
}
