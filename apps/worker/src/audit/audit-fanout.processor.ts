/**
 * AuditFanoutProcessor — T233.
 *
 * Worker-side processor that consumes `audit-fanout` BullMQ jobs and persists
 * one `audit_events` row per job via the injected `AuditDbLike` seam.
 *
 * Layered architecture (mirrors EmailProcessor)
 * ----------------------------------------------
 *   Layer A (this file): pure `(jobName, data) → dbLike.insertAuditEvent(row)`.
 *     Knows nothing about BullMQ runtime, Redis, retry, or DB connection.
 *   Layer B (deferred — future worker wiring slice): BullMQ `Worker` bootstrap,
 *     Redis connection, retry/backoff/DLQ, `worker.module.ts` registration, and
 *     `AuditQueueProducer` wiring on the API side.
 *
 * Error contract
 * --------------
 *   - `MalformedAuditJobError` — payload doesn't match the schema. Thrown
 *     before `dbLike.insertAuditEvent`; BullMQ should route to DLQ (T301).
 *   - `UnknownAuditJobError` — unrecognised job name. Same DLQ fate.
 *   - Any other error from `dbLike.insertAuditEvent` propagates unwrapped
 *     so BullMQ can apply its retry/backoff policy.
 *
 * Cross-app isolation
 * -------------------
 * This file MUST NOT import from `apps/api` or `@data-pulse-2/db`.
 * The job payload shape is defined locally via `AuditFanoutJobSchema` (Zod)
 * and structurally mirrors `AuditJobPayload` from the API side without
 * coupling to it. A future refactor can lift the shared type to
 * `packages/shared` once there is a second consumer.
 *
 * DB seam
 * -------
 * `AuditDbLike` is a minimal local interface — it is NOT a Drizzle type and
 * NOT imported from `@data-pulse-2/db`. The production implementation (deferred)
 * will satisfy this interface by wrapping `withTenant(...).auditEvents.insert`.
 *
 * id generation
 * -------------
 * `audit_events.id` has no DB-side DEFAULT (the DDL declares `UUID PRIMARY KEY`
 * with no `DEFAULT gen_random_uuid()`). The processor stamps `id` using
 * `newId()` from `@data-pulse-2/shared` (UUIDv7).
 *
 * occurred_at
 * -----------
 * The schema column has `DEFAULT now()`. The processor does NOT pass
 * `occurred_at`; the DB stamps it at insert time.
 *
 * Metadata safety (minimum guard — FR-AUDIT-3)
 * ---------------------------------------------
 * Metadata is stored as-is only when it is a plain object (no class instances,
 * no Date, no arrays at the top level) containing no blocked keys at any
 * nesting level — including inside nested arrays (case-insensitive,
 * depth-capped at 10). If the check fails, `{}` is stored instead.
 * T236 must become an allowlist, not a longer denylist.
 *
 * request_id coercion
 * -------------------
 * The DB column is `UUID` typed. The interceptor may forward non-UUID strings
 * (e.g. `"req-test-001"`). The processor coerces non-UUID values to `null`
 * before insert to avoid a Postgres type error.
 *
 * tenant_id null
 * --------------
 * The schema allows `tenant_id IS NULL` for platform-scoped audit events;
 * the RLS policy permits inserts under `app.is_platform_admin = 'true'`.
 * The processor passes `null` through unchanged — RLS enforcement is the DB
 * wiring layer's responsibility.
 *
 * KNOWN GAP: This processor is not registered in `worker.module.ts` and has
 * no BullMQ `Worker` bootstrap in this slice. That wiring lands in a future
 * worker wiring slice.
 */
import { Injectable, Inject } from "@nestjs/common";
import { z } from "zod";
import { newId } from "@data-pulse-2/shared";
import {
  extractTraceContext,
  context,
  type TraceCarrier,
} from "@data-pulse-2/shared/observability/otel";
import {
  recordWorkerJobDuration,
  recordWorkerProcessingFailure,
  sanitizeErrorClass,
} from "../observability/metrics/worker.metrics";

// T596: queue-level job_name per signals.md §3. The fanout processor handles
// only "audit-fanout" jobs today; the label value mirrors that queue-level
// bounded set member (already in WORKER_JOB_NAMES) per the approved D1
// decision.
const JOB_NAME_AUDIT_FANOUT = "audit-fanout" as const;

// ---------------------------------------------------------------------------
// Job name
// ---------------------------------------------------------------------------

/**
 * BullMQ job name this processor handles. Mirrors `AUDIT_FANOUT_JOB_NAME` in
 * the future `AuditQueueProducer` (apps/api). The literal is pinned by a unit
 * test so any producer/consumer drift fails CI loudly.
 *
 * Convention: `<domain>-<verb>` hyphenated (matches `"auth.password-reset"`,
 * `"memberships.invitation"` patterns and the worker package.json description
 * which already uses the string "audit-fanout").
 */
export const AUDIT_FANOUT_JOB_NAME = "audit-fanout";

// ---------------------------------------------------------------------------
// Worker-local job schema (no import from apps/api)
// ---------------------------------------------------------------------------

/**
 * Zod schema for the audit fanout job data. Structurally mirrors
 * `AuditJobPayload` in `apps/api/src/audit/audit-job.types.ts` without
 * importing it — apps must not depend on each other. Divergence in shape
 * becomes a visible type error in the spec.
 *
 * `request_id` is accepted as any nullable string here; UUID validation and
 * coercion to null happen inside the processor, not at the Zod layer, so the
 * processor can tell the difference between "absent" and "non-UUID string".
 */
const AuditFanoutJobSchema = z.object({
  actor_user_id: z.string().uuid().nullable(),
  actor_label:   z.string().nullable(),
  tenant_id:     z.string().uuid().nullable(),
  store_id:      z.string().uuid().nullable(),
  action:        z.string().min(1),
  target_type:   z.string().nullable(),
  target_id:     z.string().uuid().nullable(),
  request_id:    z.string().nullable(),
  metadata:      z.unknown().nullable(),
});

export type AuditFanoutJobData = z.infer<typeof AuditFanoutJobSchema>;

// ---------------------------------------------------------------------------
// DB seam (local — no import from @data-pulse-2/db)
// ---------------------------------------------------------------------------

/**
 * Minimal insert-row shape accepted by `AuditDbLike.insertAuditEvent`.
 *
 * This is a LOCAL interface — it is NOT a Drizzle type, NOT imported from
 * `@data-pulse-2/db`. Field names use snake_case to match the `audit_events`
 * Postgres column names. The production implementation (deferred) will satisfy
 * this interface by wrapping `withTenant(...).auditEvents.insert(values)`.
 *
 * `id` and `metadata` are required; all other fields mirror the nullable
 * columns in the schema.
 */
export interface AuditEventInsertRow {
  readonly id:            string;
  readonly actor_user_id: string | null;
  readonly actor_label:   string | null;
  readonly tenant_id:     string | null;
  readonly store_id:      string | null;
  readonly action:        string;
  readonly target_type:   string | null;
  readonly target_id:     string | null;
  readonly request_id:    string | null;
  readonly metadata:      Record<string, unknown>;
}

/**
 * DB seam interface. Satisfied in tests by a Jest spy; in production by a
 * Drizzle-backed implementation (deferred). Single method to keep the surface
 * minimal — the processor needs nothing else.
 */
export interface AuditDbLike {
  insertAuditEvent(row: AuditEventInsertRow): Promise<void>;
}

/** DI token for the DB seam. */
export const AUDIT_DB = "AUDIT_DB";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class MalformedAuditJobError extends Error {
  constructor(jobName: string, issue: string) {
    super(`Malformed audit job '${jobName}': ${issue}`);
    this.name = "MalformedAuditJobError";
  }
}

export class UnknownAuditJobError extends Error {
  constructor(jobName: string) {
    super(`Unknown audit job name: '${jobName}'`);
    this.name = "UnknownAuditJobError";
  }
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

@Injectable()
export class AuditFanoutProcessor {
  constructor(
    @Inject(AUDIT_DB)
    private readonly db: AuditDbLike,
  ) {}

  async process(jobName: string, data: unknown): Promise<void> {
    // T596: instrument the processor boundary. Wall-clock duration on every
    // exit (success and failure) feeds worker_job_duration_seconds; the
    // catch branch additionally increments worker_processing_failure_total
    // with the sanitized error class. Behavior is unchanged: thrown errors
    // (MalformedAuditJobError, UnknownAuditJobError, transient DB errors)
    // are rethrown verbatim so BullMQ's existing retry / DLQ semantics
    // continue to apply.
    const startNs = process.hrtime.bigint();
    try {
      const carrier =
        typeof data === "object" && data !== null && "traceContext" in data
          ? ((data as { traceContext?: TraceCarrier }).traceContext ?? {})
          : {};
      const restoredCtx = extractTraceContext(carrier);

      return await context.with(restoredCtx, async () => {
        if (jobName !== AUDIT_FANOUT_JOB_NAME) {
          throw new UnknownAuditJobError(jobName);
        }

        const parsed = parseJobData(jobName, data);

        const row: AuditEventInsertRow = {
          id:            newId(),
          actor_user_id: parsed.actor_user_id,
          actor_label:   parsed.actor_label,
          tenant_id:     parsed.tenant_id,
          store_id:      parsed.store_id,
          action:        parsed.action,
          target_type:   parsed.target_type,
          target_id:     parsed.target_id,
          request_id:    coerceRequestId(parsed.request_id),
          metadata:      safeMetadata(parsed.metadata),
        };

        await this.db.insertAuditEvent(row);
      });
    } catch (err: unknown) {
      const errorClass = sanitizeErrorClass(
        err instanceof Error ? err.constructor.name : null,
      );
      recordWorkerProcessingFailure({
        job_name: JOB_NAME_AUDIT_FANOUT,
        error_class: errorClass,
      });
      throw err;
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1_000_000_000;
      recordWorkerJobDuration({ job_name: JOB_NAME_AUDIT_FANOUT }, durationSeconds);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJobData(jobName: string, data: unknown): AuditFanoutJobData {
  const result = AuditFanoutJobSchema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const issue = first
      ? `${first.path.join(".") || "<root>"}: ${first.message}`
      : "validation failed";
    throw new MalformedAuditJobError(jobName, issue);
  }
  return result.data;
}

/**
 * UUID regex (v1–v8 compatible, case-insensitive). Coerces non-UUID strings
 * to null so the `request_id UUID` column does not receive an invalid value.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function coerceRequestId(value: string | null): string | null {
  if (value === null) return null;
  return UUID_RE.test(value) ? value : null;
}

/**
 * Returns true only for plain objects (`{}`-style). Rejects arrays, null,
 * class instances (Date, Map, etc.), and primitives. Used to guard both the
 * top-level metadata value and child values during the recursive blocked-key
 * scan — class instances are not safe to walk.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Interim denylist, matched case-insensitively at any nesting depth,
 * including inside nested arrays. If any key matches, the entire metadata
 * object is replaced with `{}`.
 * T236 must become an allowlist, not a longer denylist.
 */
const BLOCKED_KEYS = new Set([
  "password",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "cookie",
  "secret",
  "email",
]);

function safeMetadata(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    return {};
  }
  if (hasBlockedKey(value, 0)) {
    return {};
  }
  return value;
}

function hasBlockedKey(obj: Record<string, unknown>, depth: number): boolean {
  // Fail closed: depth exceeded means we cannot safely inspect further.
  if (depth > 10) return true;
  for (const key of Object.keys(obj)) {
    if (BLOCKED_KEYS.has(key.toLowerCase())) return true;
    const child = obj[key];
    if (isPlainObject(child)) {
      if (hasBlockedKey(child, depth + 1)) return true;
    } else if (Array.isArray(child)) {
      if (hasBlockedKeyInArray(child, depth + 1)) return true;
    } else if (child !== null && typeof child === "object") {
      // Non-plain object (Date, Map, class instance, etc.) — unsafe.
      return true;
    }
  }
  return false;
}

function hasBlockedKeyInArray(arr: unknown[], depth: number): boolean {
  // Fail closed: depth exceeded means we cannot safely inspect further.
  if (depth > 10) return true;
  for (const item of arr) {
    if (isPlainObject(item)) {
      if (hasBlockedKey(item, depth + 1)) return true;
    } else if (Array.isArray(item)) {
      if (hasBlockedKeyInArray(item, depth + 1)) return true;
    } else if (item !== null && typeof item === "object") {
      // Non-plain object inside array — unsafe.
      return true;
    }
  }
  return false;
}
