/**
 * RT-664 — `ReservationSweepProcessor`: the TTL sweeper of AI usage
 * reservations (AD-AI-ENT-001 D-3, RT-644 §4.6 / T17).
 *
 * The api reserves a request unit before every AI provider call and commits
 * or releases it after. A process crash between the two leaves the
 * reservation open, holding quota. This processor runs on a BullMQ
 * repeatable job (`ReservationSweepScheduler`, default every 5 minutes) and
 * releases every tenant's reservations whose TTL passed, with outcome
 * `reservation_expired`: never charged to the customer (D-8).
 *
 * Shape (the RT-209 replay purge):
 *   - list every tenant id (the repository explains the RLS reason);
 *   - per tenant, release in bounded batches until a batch comes back short;
 *   - a failing tenant is logged and the rest still run; the job then fails
 *     with `ReservationSweepIncompleteError` so BullMQ retries it. A retry is
 *     safe: a release is idempotent.
 *
 * Logging: counts only. A failure line carries the error class and a
 * SQLSTATE-like code, never the message, a tenant id or a row value.
 */
import { z } from "zod";

import { errorFields } from "../erpnext-reconciliation/stock-run-sweep.processor";
import { DEFAULT_RESERVATION_SWEEP_BATCH_SIZE, DEFAULT_RESERVATION_SWEEP_LOOKBACK_SECONDS } from "./reservation-sweep.config";
import type { ReservationSweepRepository } from "./reservation-sweep.repository";

/** BullMQ job (and job-scheduler) name. Pinned by the specs. */
export const RESERVATION_SWEEP_JOB_NAME = "ai-usage-reservation-sweep";

const ReservationSweepJobSchema = z.object({}).passthrough();

export type ReservationSweepLogLine = Readonly<Record<string, string | number>>;
export type ReservationSweepLog = (line: ReservationSweepLogLine) => void;

const COMPONENT = "ai-usage.reservation-sweep";

function writeStderr(line: ReservationSweepLogLine): void {
  process.stderr.write(JSON.stringify(line) + "\n");
}

export interface ReservationSweepResult {
  readonly tenants: number;
  readonly released: number;
  readonly batches: number;
  readonly failedTenants: number;
  readonly durationMs: number;
}

export class UnknownReservationSweepJobError extends Error {
  constructor(name: string) {
    super(`Unknown AI usage reservation sweep job name: '${name}'`);
    this.name = "UnknownReservationSweepJobError";
  }
}

export class MalformedReservationSweepJobError extends Error {
  constructor(name: string) {
    super(`Malformed AI usage reservation sweep job '${name}': payload must be an object`);
    this.name = "MalformedReservationSweepJobError";
  }
}

export class ReservationSweepIncompleteError extends Error {
  constructor(readonly result: ReservationSweepResult) {
    super(`AI usage reservation sweep incomplete: ${result.failedTenants} tenant(s) failed`);
    this.name = "ReservationSweepIncompleteError";
  }
}

interface Tally {
  tenants: number;
  released: number;
  batches: number;
  failedTenants: number;
}

export interface ReservationSweepOptions {
  readonly batchSize?: number;
  readonly lookbackSeconds?: number;
  readonly log?: ReservationSweepLog;
}

export class ReservationSweepProcessor {
  private readonly batchSize: number;
  private readonly lookbackSeconds: number;
  private readonly log: ReservationSweepLog;

  constructor(
    private readonly repo: ReservationSweepRepository,
    options: ReservationSweepOptions = {},
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_RESERVATION_SWEEP_BATCH_SIZE;
    this.lookbackSeconds = options.lookbackSeconds ?? DEFAULT_RESERVATION_SWEEP_LOOKBACK_SECONDS;
    this.log = options.log ?? writeStderr;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1) {
      throw new Error("ReservationSweepProcessor: batch size must be a positive whole number");
    }
  }

  async process(jobName: string, data: unknown): Promise<ReservationSweepResult> {
    if (jobName !== RESERVATION_SWEEP_JOB_NAME) throw new UnknownReservationSweepJobError(jobName);
    if (!ReservationSweepJobSchema.safeParse(data).success) throw new MalformedReservationSweepJobError(jobName);

    const startedAt = Date.now();
    const tally: Tally = { tenants: 0, released: 0, batches: 0, failedTenants: 0 };
    if (!(await this.repo.isProvisioned())) {
      // The owner-gated grants (or 0055 itself) are not applied yet: nothing can be reserved, so nothing to sweep.
      this.log({ level: "info", component: COMPONENT, message: "sweep_skipped_not_provisioned" });
      return { ...tally, durationMs: Date.now() - startedAt };
    }
    await this.sweepTenants(tally);
    const result: ReservationSweepResult = { ...tally, durationMs: Date.now() - startedAt };
    this.logSummary(result);
    if (result.failedTenants > 0) throw new ReservationSweepIncompleteError(result);
    return result;
  }

  private async sweepTenants(tally: Tally): Promise<void> {
    for (const tenantId of await this.repo.listTenantIds()) {
      tally.tenants += 1;
      await this.sweepTenantSafely(tenantId, tally);
    }
  }

  private logSummary(result: ReservationSweepResult): void {
    this.log({
      level: result.failedTenants > 0 ? "warn" : "info",
      component: COMPONENT,
      message: "sweep_complete",
      tenants: result.tenants,
      released: result.released,
      batches: result.batches,
      failed_tenants: result.failedTenants,
      duration_ms: result.durationMs,
    });
  }

  private async sweepTenantSafely(tenantId: string, tally: Tally): Promise<void> {
    try {
      let listed: number;
      do {
        const batch = await this.repo.releaseExpiredBatch(tenantId, { lookbackSeconds: this.lookbackSeconds, limit: this.batchSize });
        listed = batch.listed;
        tally.released += batch.released;
        tally.batches += 1;
      } while (listed >= this.batchSize);
    } catch (err) {
      tally.failedTenants += 1;
      this.log({ level: "error", component: COMPONENT, message: "tenant_sweep_failed", ...errorFields(err) });
    }
  }
}
