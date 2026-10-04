/**
 * RT-209 — `ReplayPurgeProcessor`: periodic purge of expired
 * `cashier_admission_requests` rows.
 *
 * The cashier-admissions idempotency store (0035, RT-113 BC2) keeps the
 * replayable `admitted` body, which carries the cashier's `display_name`
 * (personal data, §XIV). The api deletes a device's expired rows only when
 * that same device next saves a request, so a device that never admits again
 * kept its expired rows, and their copies of the display name, forever. This
 * processor runs on a BullMQ repeatable job (`ReplayPurgeScheduler`, default
 * hourly) and deletes every tenant's expired rows.
 *
 * Shape (modelled on the outbox retention purge and the RT-179 stock sweep):
 *   - list every tenant id (see the repository for the RLS reason);
 *   - per tenant, delete in bounded batches until a batch comes back short;
 *   - a failing tenant is logged and the rest still run; the job then fails
 *     with `ReplayPurgeIncompleteError` so BullMQ retries it. A retry is safe:
 *     a purge is idempotent.
 *
 * Logging: counts only (tenants, rows purged, batches, failed tenants,
 * duration). A failure line carries the error class and a SQLSTATE-like code,
 * never the error message, a tenant id or any row value.
 */
import { z } from "zod";

import { errorFields } from "../erpnext-reconciliation/stock-run-sweep.processor";
import { DEFAULT_REPLAY_PURGE_BATCH_SIZE } from "./replay-purge.config";
import type { ReplayPurgeRepository } from "./replay-purge.repository";

/** BullMQ job (and job-scheduler) name. Pinned by the specs. */
export const REPLAY_PURGE_JOB_NAME = "cashier-admission-replay-purge";

/** Scheduled purges carry no payload; passthrough tolerates BullMQ metadata. */
const ReplayPurgeJobSchema = z.object({}).passthrough();

export type ReplayPurgeLogLine = Readonly<Record<string, string | number>>;
export type ReplayPurgeLog = (line: ReplayPurgeLogLine) => void;

const COMPONENT = "cashier-admissions.replay-purge";

function writeStderr(line: ReplayPurgeLogLine): void {
  process.stderr.write(JSON.stringify(line) + "\n");
}

export interface ReplayPurgeResult {
  readonly tenants: number;
  readonly purged: number;
  readonly batches: number;
  readonly failedTenants: number;
  readonly durationMs: number;
}

export class UnknownReplayPurgeJobError extends Error {
  constructor(jobName: string) {
    super(`Unknown cashier-admission replay purge job name: '${jobName}'`);
    this.name = "UnknownReplayPurgeJobError";
  }
}

export class MalformedReplayPurgeJobError extends Error {
  constructor(jobName: string) {
    super(`Malformed cashier-admission replay purge job '${jobName}': payload must be an object`);
    this.name = "MalformedReplayPurgeJobError";
  }
}

export class ReplayPurgeIncompleteError extends Error {
  constructor(readonly result: ReplayPurgeResult) {
    super(`cashier-admission replay purge incomplete: ${result.failedTenants} tenant(s) failed`);
    this.name = "ReplayPurgeIncompleteError";
  }
}

/** Running totals of one purge pass. */
interface Tally {
  tenants: number;
  purged: number;
  batches: number;
  failedTenants: number;
}

export class ReplayPurgeProcessor {
  constructor(
    private readonly repo: ReplayPurgeRepository,
    private readonly batchSize: number = DEFAULT_REPLAY_PURGE_BATCH_SIZE,
    private readonly log: ReplayPurgeLog = writeStderr,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new Error("ReplayPurgeProcessor: batch size must be a positive whole number");
    }
  }

  async process(jobName: string, data: unknown): Promise<ReplayPurgeResult> {
    assertPurgeJob(jobName, data);

    const startedAt = Date.now();
    const tally: Tally = { tenants: 0, purged: 0, batches: 0, failedTenants: 0 };
    for (const tenantId of await this.repo.listTenantIds()) {
      tally.tenants += 1;
      await this.purgeTenantSafely(tenantId, tally);
    }

    const result: ReplayPurgeResult = { ...tally, durationMs: Date.now() - startedAt };
    this.logSummary(result);
    if (result.failedTenants > 0) throw new ReplayPurgeIncompleteError(result);
    return result;
  }

  /** Purge one tenant. A failure is logged and counted; the next tenant still runs. */
  private async purgeTenantSafely(tenantId: string, tally: Tally): Promise<void> {
    try {
      await this.purgeTenant(tenantId, tally);
    } catch (err) {
      tally.failedTenants += 1;
      this.log({
        level: "error",
        component: COMPONENT,
        message: "tenant_purge_failed",
        ...errorFields(err),
      });
    }
  }

  /** Bounded batches until one comes back short (nothing more expired). */
  private async purgeTenant(tenantId: string, tally: Tally): Promise<void> {
    let purged: number;
    do {
      purged = await this.repo.purgeExpiredBatch(tenantId, this.batchSize);
      tally.purged += purged;
      tally.batches += 1;
    } while (purged >= this.batchSize);
  }

  private logSummary(result: ReplayPurgeResult): void {
    this.log({
      level: result.failedTenants > 0 ? "warn" : "info",
      component: COMPONENT,
      message: "purge_complete",
      tenants: result.tenants,
      purged: result.purged,
      batches: result.batches,
      failed_tenants: result.failedTenants,
      duration_ms: result.durationMs,
    });
  }
}

/** Rejects a job that is not the purge, or whose payload is not an object. */
function assertPurgeJob(jobName: string, data: unknown): void {
  if (jobName !== REPLAY_PURGE_JOB_NAME) throw new UnknownReplayPurgeJobError(jobName);
  if (!ReplayPurgeJobSchema.safeParse(data).success) {
    throw new MalformedReplayPurgeJobError(jobName);
  }
}
