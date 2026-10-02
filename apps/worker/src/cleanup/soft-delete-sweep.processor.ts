/**
 * SoftDeleteSweepProcessor — T312.
 *
 * Scheduled BullMQ processor that hard-deletes store rows that have been
 * soft-deleted for more than 30 days. Fires on a timer (repeatable job),
 * NOT in response to API-produced messages.
 *
 * Layered architecture (mirrors SessionRevokeProcessor / AuditFanoutProcessor)
 * ---------------------------------------------------------------------------
 *   Layer A (this file): pure `(jobName, data) → db.purgeSoftDeletedStores(cutoff)`.
 *     Knows nothing about BullMQ runtime, Redis, retry, or DB connection.
 *   Layer B (deferred): BullMQ `Worker` bootstrap, repeatable-job schedule,
 *     Redis connection, `worker.module.ts` registration.
 *
 * Scope — stores only
 * -------------------
 * Tenant hard-delete is deliberately excluded. The FK chain from `stores`,
 * `auth_tokens`, `sessions`, `memberships`, `pos_sessions`, etc. all declare
 * `ON DELETE RESTRICT` back to `tenants(id)`. Purging tenants requires a
 * full dependency teardown strategy that is deferred to a future task.
 *
 * Retention policy
 * ----------------
 * 30 days from `deleted_at`. Rows with `deleted_at IS NULL` (active stores)
 * are never touched. Rows with `deleted_at IS NOT NULL AND deleted_at < cutoff`
 * are hard-deleted. `cutoff = now() - 30 days`.
 *
 * Idempotency
 * -----------
 * Purging 0 rows is a success — no throw, no error. The scheduled job may
 * fire when there is nothing to clean up and that is expected.
 *
 * Clock injection
 * ---------------
 * `now` is an optional constructor parameter (`() => new Date()` in production)
 * so tests can inject a fixed clock without `jest.useFakeTimers`.
 *
 * DB seam
 * -------
 * `SoftDeleteSweepDbLike` is a LOCAL interface — not a Drizzle type, not
 * imported from `@data-pulse-2/db`. The production implementation (deferred)
 * will satisfy this interface by running:
 *   DELETE FROM stores
 *   WHERE deleted_at IS NOT NULL AND deleted_at < $cutoff
 * under the platform-admin RLS path.
 *
 * Cross-app isolation
 * -------------------
 * This file MUST NOT import from `apps/api` or `@data-pulse-2/db`.
 *
 * KNOWN GAP: Not registered in `worker.module.ts` and has no BullMQ `Worker`
 * bootstrap in this slice. Layer B wiring is deferred.
 */
import { Injectable, Inject, Optional } from "@nestjs/common";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Job name
// ---------------------------------------------------------------------------

/**
 * BullMQ job name this processor handles. Must match the repeatable-job
 * definition in the Layer-B wiring (deferred). The value is pinned by a
 * unit test so any drift fails CI.
 */
export const SOFT_DELETE_SWEEP_JOB_NAME = "soft-delete-sweep";

// ---------------------------------------------------------------------------
// Retention constant
// ---------------------------------------------------------------------------

/** Stores soft-deleted this many days ago or earlier are hard-deleted. */
const RETENTION_DAYS = 30;

// ---------------------------------------------------------------------------
// Scheduled job payload schema
// ---------------------------------------------------------------------------

/**
 * This is a scheduled sweep with no required payload fields. We accept
 * any extra keys (passthrough) so BullMQ's internal metadata does not
 * cause validation failures.
 */
const SoftDeleteSweepJobSchema = z.object({}).passthrough();

export type SoftDeleteSweepJobData = z.infer<typeof SoftDeleteSweepJobSchema>;

// ---------------------------------------------------------------------------
// DB seam (local — no import from @data-pulse-2/db)
// ---------------------------------------------------------------------------

/**
 * Minimal seam for the store purge operation.
 *
 * Returns the count of rows deleted (0 = success, nothing to purge).
 * Any DB error propagates unwrapped so BullMQ can apply retry/backoff.
 *
 * The production implementation (deferred) will satisfy this interface with:
 *   DELETE FROM stores WHERE deleted_at IS NOT NULL AND deleted_at < cutoff
 * under the platform-admin RLS path.
 */
export interface SoftDeleteSweepDbLike {
  purgeSoftDeletedStores(cutoff: Date): Promise<number>;
}

/** DI token for the DB seam. */
export const SWEEP_DB = "SWEEP_DB";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class MalformedSoftDeleteSweepJobError extends Error {
  constructor(jobName: string, issue: string) {
    super(`Malformed soft-delete-sweep job '${jobName}': ${issue}`);
    this.name = "MalformedSoftDeleteSweepJobError";
  }
}

export class UnknownSoftDeleteSweepJobError extends Error {
  constructor(jobName: string) {
    super(`Unknown soft-delete-sweep job name: '${jobName}'`);
    this.name = "UnknownSoftDeleteSweepJobError";
  }
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

@Injectable()
export class SoftDeleteSweepProcessor {
  constructor(
    @Optional()
    @Inject(SWEEP_DB)
    private readonly db: SoftDeleteSweepDbLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async process(jobName: string, data: unknown): Promise<void> {
    if (jobName !== SOFT_DELETE_SWEEP_JOB_NAME) {
      throw new UnknownSoftDeleteSweepJobError(jobName);
    }

    parseJobData(jobName, data);

    const cutoff = computeCutoff(this.now());
    await this.db.purgeSoftDeletedStores(cutoff);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJobData(jobName: string, data: unknown): SoftDeleteSweepJobData {
  const result = SoftDeleteSweepJobSchema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const issue = first
      ? `${first.path.join(".") || "<root>"}: ${first.message}`
      : "validation failed";
    throw new MalformedSoftDeleteSweepJobError(jobName, issue);
  }
  return result.data;
}

/**
 * Returns a Date exactly RETENTION_DAYS before `referenceNow`.
 * Rows with `deleted_at < cutoff` are eligible for purge.
 */
function computeCutoff(referenceNow: Date): Date {
  const cutoff = new Date(referenceNow);
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  return cutoff;
}
