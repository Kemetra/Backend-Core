/**
 * AuditEnqueuerModule — shared write-side audit-job provider.
 *
 * Why this module exists
 * ----------------------
 * `AuditModule` imports `AuthModule` (read-side audit query controller mounts
 * `AuthGuard` / `RolesGuard`). To allow `AuthModule` to enqueue audit jobs
 * (T238 — `auth.signin.{ok|failed}` emission) without creating a circular
 * import (`AuthModule → AuditModule → AuthModule`), the `AUDIT_JOB_ENQUEUER`
 * provider is hoisted into this leaf module that depends on neither.
 *
 * Both `AuthModule` and `AuditModule` import this module; both consume the
 * same DI token, so a single `AuditQueueProducer` (or `NoOpAuditJobEnqueuer`
 * in dev/test) is shared across the request graph and tests can still call
 * `overrideProvider(AUDIT_JOB_ENQUEUER)` once to spy on every emission site.
 *
 * Wiring policy mirrors `auditJobEnqueuerFactory` previously inlined in
 * `AuditModule` (now imported from here) — production with `REDIS_URL`
 * unset throws; non-production falls back to `NoOpAuditJobEnqueuer`. The
 * BullMQ `Queue` constructor is identical, so the on-the-wire job contract
 * (queue name, default job options, no jobId) is preserved.
 */
import { Module, type Provider } from "@nestjs/common";
import { Queue, type JobsOptions } from "bullmq";
import type { Pool } from "pg";

import { createLogger, type Logger } from "@data-pulse-2/shared";
import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
  NoOpAuditJobEnqueuer,
} from "./audit-job.enqueuer";
import {
  AUDIT_QUEUE_NAME,
  AuditQueueProducer,
  type AuditQueueLike,
} from "./audit-queue.producer";
import { OutboxAuditEnqueuer } from "./outbox-audit-enqueuer";

/**
 * Build the runtime `AuditJobEnqueuer`.
 *
 * Lazy-init contract
 * ------------------
 * The factory returns the producer WITHOUT constructing the underlying
 * BullMQ `Queue`. Construction happens on first `enqueue()` call (see
 * `AuditQueueProducer`'s lazy-mode constructor + `ensureQueue()`).
 * This shifts the Queue's side effects from Nest module-init time to
 * first use, which means:
 *
 *   * `overrideProvider(AUDIT_JOB_ENQUEUER).useValue(spy)` orphans the
 *     factory-returned producer cleanly -- with eager construction the
 *     orphaned producer kept its BullMQ Queue alive and Jest reported
 *     "worker process has failed to exit gracefully" at suite teardown
 *     (the PR #240 db-integration leak). Lazy producers never construct
 *     a Queue when overridden, so no resource survives the override.
 *   * Production behaviour is unchanged at steady state: the first
 *     audit emission constructs the Queue exactly once.
 *
 * The `queueFactory` parameter remains a unit-test seam: specs that
 * want to assert on the `url` value passed to the Queue constructor
 * can supply a custom factory and we close over it in the thunk.
 */
export function auditJobEnqueuerFactory(
  queueFactory?: (url: string) => AuditQueueLike,
): AuditJobEnqueuer {
  const url = process.env["REDIS_URL"];
  if (!url) {
    if (process.env["NODE_ENV"] === "production") {
      // Error message intentionally retains the historical "AuditModule:"
      // prefix so existing operator runbooks and the
      // `audit-queue.producer.spec.ts` literal-string assertion remain
      // valid even though the factory has moved into this leaf module.
      throw new Error(
        "AuditModule: REDIS_URL is required in production " +
          "(AuditQueueProducer cannot be wired without it).",
      );
    }
    return new NoOpAuditJobEnqueuer();
  }
  // Defer Queue construction to first use. The thunk captures `url`
  // and the optional `queueFactory` seam so both production and unit
  // tests follow the same lazy materialisation path.
  const provider = () =>
    queueFactory !== null && queueFactory !== undefined
      ? queueFactory(url)
      : new Queue(AUDIT_QUEUE_NAME, {
          connection: { url },
          defaultJobOptions: DEFAULT_JOB_OPTIONS as JobsOptions,
        });
  return new AuditQueueProducer(provider);
}

/**
 * Returns true when the outbox-backed audit path should be used in place of
 * direct BullMQ enqueueing. Defaults OFF — production cutover is operator-
 * driven, not code-driven.
 *
 * The DI swap landed with slice 1C-B2 (T583): `outboxOrLegacyAuditJobEnqueuerFactory`
 * below consults this flag and returns either an OutboxAuditEnqueuer (flag on +
 * pool present) or the legacy AuditQueueProducer / NoOpAuditJobEnqueuer (flag
 * off, or flag on but pool unavailable).
 *
 * The live binding lives in `OutboxAuditEnqueuerModule` (a sibling leaf module
 * that imports AuthModule to inject PG_POOL). This module — `AuditEnqueuerModule`
 * — keeps its legacy provider so `AuthModule` can still resolve
 * AUDIT_JOB_ENQUEUER for the auth-signin emission path without picking up the
 * outbox dependency on PG_POOL (which would re-introduce the
 * `AuthModule → AuditEnqueuerModule → AuthModule` cycle this leaf module
 * exists to avoid).
 *
 * The flag accepts the literal strings "1", "true", or "yes"
 * (case-insensitive). Leading and trailing whitespace is stripped before
 * parsing so " true " and "yes\n" (common when the value comes from a
 * .env file or shell here-doc) are correctly recognised as enabled.
 */
export function isOutboxAuditEnabled(): boolean {
  const raw = (process.env["OUTBOX_AUDIT_ENABLED"] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Pool-aware factory used by `OutboxAuditEnqueuerModule` (slice 1C-B2, T583).
 *
 * Decision matrix:
 *
 *   OUTBOX_AUDIT_ENABLED unset/off            → legacy `auditJobEnqueuerFactory`
 *                                               (direct BullMQ enqueueing).
 *   OUTBOX_AUDIT_ENABLED on  + pool present   → `OutboxAuditEnqueuer`
 *                                               (writes audit.event.created
 *                                               rows to outbox_events).
 *   OUTBOX_AUDIT_ENABLED on  + pool null      → fall back to legacy +
 *                                               emit a PII-safe structured
 *                                               warn line through the shared
 *                                               pino logger so an operator
 *                                               can see the configuration
 *                                               mismatch.
 *
 * Safe-fallback rationale (matches task instruction "fall back to legacy
 * only if the existing architecture clearly supports safe fallback"):
 *   - The legacy path is exactly what runs when the flag is off, so it is
 *     guaranteed-safe steady-state.
 *   - A flag-on + null-pool combination is a misconfiguration, not a
 *     failure mode; failing loud would crash request handling for a
 *     misconfiguration the operator can fix at runtime.
 *   - The structured warn line ensures the misconfiguration is
 *     observable through the same boundary the rest of the API uses
 *     (`@data-pulse-2/shared` createLogger, which honours
 *     DEFAULT_REDACT_PATHS and is what `apps/api/src/main.ts` and the
 *     pos-* modules use). PII-safe by construction.
 *
 * Module-init context vs request context
 * --------------------------------------
 * This factory fires at Nest module-init time, before any HTTP request
 * is being handled. There is no `request_id` / `tenant_id` to attach to
 * the log line. The warn binding therefore explicitly emits both as
 * `null` so the line's shape matches the FR-B-004 request-scoped log
 * schema -- downstream log-search tooling does not have to special-case
 * boot-time emissions.
 *
 * The `queueFactory` parameter passes through to the legacy fallback so
 * unit tests can swap the BullMQ Queue out without booting Redis. The
 * optional `logger` parameter is the structured-logger seam: tests pass
 * a spy logger to assert on the emitted bindings without parsing stderr
 * JSON; production callers (and call sites that simply do not supply a
 * logger) get a module-local logger via `createLogger`. No new
 * dependencies; createLogger is already used by `apps/api/src/main.ts`
 * and several pos-* modules.
 */
export function outboxOrLegacyAuditJobEnqueuerFactory(
  pool: Pool | null,
  queueFactory?: (url: string) => AuditQueueLike,
  logger?: Logger,
): AuditJobEnqueuer {
  if (!isOutboxAuditEnabled()) {
    return auditJobEnqueuerFactory(queueFactory);
  }
  if (pool === null) {
    // Misconfiguration: flag is on but no DB pool is available. The
    // legacy BullMQ path keeps audit emissions flowing while the
    // operator investigates. NEVER silently drop audit events.
    //
    // The structured boundary is `@data-pulse-2/shared` createLogger.
    // When the caller did not pass an explicit logger we build a
    // module-local one bound to `api.audit.enqueuer` -- mirrors the
    // pos-shifts/pos-operators per-module logger pattern.
    const log = logger ?? createLogger({ service: "api.audit.enqueuer" });
    log.warn(
      {
        component: "audit.enqueuer",
        request_id: null,
        tenant_id: null,
      },
      "OUTBOX_AUDIT_ENABLED=1 but PG_POOL is null; falling back to legacy " +
        "BullMQ audit enqueuer. Check DATABASE_URL configuration.",
    );
    return auditJobEnqueuerFactory(queueFactory);
  }
  return new OutboxAuditEnqueuer(pool);
}

const auditJobEnqueuerProvider: Provider = {
  provide: AUDIT_JOB_ENQUEUER,
  useFactory: auditJobEnqueuerFactory,
};

@Module({
  providers: [auditJobEnqueuerProvider],
  exports: [AUDIT_JOB_ENQUEUER],
})
export class AuditEnqueuerModule {}
