/**
 * AuditQueueProducer — Scope A audit wiring.
 *
 * Concrete `AuditJobEnqueuer` backed by a BullMQ `Queue` named "audit".
 * The matching fan-out processor (`AuditFanoutProcessor`) already lives in
 * `apps/worker/src/audit/audit-fanout.processor.ts` (T233); this file ships
 * the producer side so `AuditEmitterInterceptor` can enqueue real jobs.
 *
 * Per-emission identity (RT-124)
 * ------------------------------
 * Every `@Auditable` action must produce a distinct row in `audit_events`
 * (FR-AUDIT-1), so the jobId is NEVER derived from the request (unlike
 * `EmailQueueProducer`'s deterministic jobId) — a retried HTTP request is a
 * new emission and gets a new id. Each emission mints one `event_id`, used as
 * the jobId and as `audit_events.id`, so only a re-delivery of the SAME
 * emission is deduplicated.
 *
 * Cross-app constant mirror
 * -------------------------
 * `AUDIT_FANOUT_JOB_NAME_API` intentionally mirrors
 * `AUDIT_FANOUT_JOB_NAME` in `apps/worker/src/audit/audit-fanout.processor.ts`.
 * `apps/api` MUST NOT import that constant directly — cross-app imports
 * violate the monorepo app boundary. A future shared-package slice will
 * consolidate both into `@data-pulse-2/shared/queues/audit-config`.
 * Until then, keep the two in sync manually; the literal-equality tests
 * in `audit-queue.producer.spec.ts` pin both to `"audit-fanout"`.
 */
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Queue } from "bullmq";
import { newId } from "@data-pulse-2/shared";
import { injectTraceContext } from "@data-pulse-2/shared/observability/otel";
import type { AuditJobEnqueuer } from "./audit-job.enqueuer";
import type { AuditJobPayload } from "./audit-job.types";
import { QUEUE_NAMES } from "@data-pulse-2/shared";

/** BullMQ queue name for audit jobs. */
export const AUDIT_QUEUE_NAME = QUEUE_NAMES.audit;

/**
 * BullMQ job name used by both this producer and the audit fan-out worker.
 *
 * API-local mirror of `AUDIT_FANOUT_JOB_NAME` in
 * `apps/worker/src/audit/audit-fanout.processor.ts`.
 * See module docstring for the cross-app boundary rationale.
 */
export const AUDIT_FANOUT_JOB_NAME_API = "audit-fanout";

/**
 * Minimal `Queue` surface this producer relies on. Keeping it narrow lets
 * unit specs pass an in-memory fake without any BullMQ runtime.
 *
 * `close()` is OPTIONAL so existing in-memory test doubles continue to
 * work without a no-op stub; the producer's `onModuleDestroy` checks for
 * the method before invoking it (see class below). Real `bullmq.Queue`
 * always exposes `close()`.
 */
export interface AuditQueueLike {
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
  close?(): Promise<void>;
}

/**
 * Lazy-queue provider thunk. The factory returns one of these instead of
 * an eagerly-constructed Queue so Nest's `overrideProvider(...).useValue(...)`
 * can replace the binding BEFORE any real BullMQ Queue is constructed
 * (which would open a background ioredis socket and leak past
 * `app.close()` -- see class docstring below).
 */
export type AuditQueueProvider = () => Queue | AuditQueueLike;

/**
 * AuditQueueProducer accepts EITHER a ready `Queue | AuditQueueLike`
 * (eager: existing tests pass a FakeQueue directly) OR a
 * `AuditQueueProvider` thunk (lazy: production factory passes a thunk
 * that constructs the real BullMQ Queue on first `enqueue()`).
 *
 * Why lazy on the production path
 * -------------------------------
 * Nest's `Test.createTestingModule(...).overrideProvider(...).useValue(...)`
 * replaces the binding for a token AFTER the original `useFactory` has
 * already run. When the factory eagerly constructs a `new Queue(...)`,
 * the resulting orphaned producer holds a background ioredis client
 * that survives `app.close()` -- Jest then reports "worker process has
 * failed to exit gracefully" at suite teardown. Threshold-crossing
 * accumulation of these leaked handles flips CI's db-integration step
 * from exit-0-with-warning to exit-1 (observed on PR #240).
 *
 * The PR #241 `OnModuleDestroy` hook fixes the LEGITIMATE teardown
 * path (when the producer in the container is the one Nest actually
 * destroys), but does not cover the override-orphan case: an
 * overridden producer never has `onModuleDestroy` called on it because
 * Nest no longer knows it exists.
 *
 * Lazy construction shifts the side effect from MODULE INIT to FIRST
 * USE. In the override case, the original producer is orphaned with
 * its lazy Queue never constructed -- no socket, no timer, no leak.
 * In the production case, the first audit emission constructs the
 * Queue exactly once and the same `OnModuleDestroy` hook closes it
 * cleanly at shutdown.
 *
 * Concurrency: two concurrent `enqueue()` calls on a cold producer
 * could both try to initialise. BullMQ Queue construction is
 * synchronous, so the late caller would briefly observe a half-built
 * Queue. The double-check guard (`this.queue ?? (this.queue = ...)`)
 * is safe under Node's single-threaded event-loop semantics; the
 * worst case is one wasted Queue object that the GC reclaims.
 */
@Injectable()
export class AuditQueueProducer
  implements AuditJobEnqueuer, OnModuleDestroy
{
  private closed = false;
  /** Materialised Queue. `null` while still lazy. */
  private queue: Queue | AuditQueueLike | null;
  /** Thunk to build the Queue on first use; `null` once materialised. */
  private queueProvider: AuditQueueProvider | null;

  /**
   * Eager: pass a ready `Queue | AuditQueueLike`. Used by unit specs
   * that supply a FakeQueue and by call sites where the queue is
   * already constructed.
   *
   * Lazy: pass an `AuditQueueProvider` thunk. Used by the production
   * `auditJobEnqueuerFactory` so the BullMQ Queue is NOT constructed
   * at Nest module-init time (which would leak past an
   * overrideProvider that runs after init).
   */
  constructor(queueOrProvider: Queue | AuditQueueLike | AuditQueueProvider) {
    if (typeof queueOrProvider === "function") {
      this.queue = null;
      this.queueProvider = queueOrProvider;
    } else {
      this.queue = queueOrProvider;
      this.queueProvider = null;
    }
  }

  /**
   * Materialise the underlying Queue on first use. Called by `enqueue`
   * (and by `onModuleDestroy` only when we have already materialised
   * via an enqueue -- never to force materialisation just for cleanup).
   *
   * Post-destroy guard
   * ------------------
   * CodeRabbit review on PR #242: the previous implementation
   * (`this.queue ?? (this.queue = this.queueProvider!())`) would
   * happily invoke the provider thunk AFTER `onModuleDestroy()` set
   * `this.closed = true`. In production that creates a fresh BullMQ
   * Queue plus background ioredis client which `onModuleDestroy` has
   * already short-circuited past -- a brand-new resource leak that
   * is the exact opposite of what the lazy refactor was designed to
   * prevent.
   *
   * Order of checks (kept symmetric with EmailQueueProducer.ensureQueue):
   *   1. Queue already materialised → return it (fast path).
   *   2. Producer is closed → throw. Caller MUST NOT enqueue against
   *      a destroyed producer; surfacing this loudly is the only way
   *      to catch latent post-destroy emissions (e.g. an async audit
   *      interceptor that fires after `app.close()`).
   *   3. Provider thunk is null → throw a defensive Error. In normal
   *      flows this is unreachable -- the constructor sets one of
   *      `queue` / `queueProvider`, and the materialisation path
   *      below nulls `queueProvider` only AFTER setting `queue`.
   *   4. Materialise via the thunk and clear `queueProvider` so we
   *      cannot accidentally invoke it twice (and so the GC can free
   *      any closure state the thunk was holding).
   */
  private ensureQueue(): Queue | AuditQueueLike {
    if (this.queue !== null) return this.queue;
    if (this.closed) {
      throw new Error("AuditQueueProducer is closed");
    }
    if (this.queueProvider === null) {
      throw new Error(
        "AuditQueueProducer queue provider is unavailable (lazy invariant violated)",
      );
    }
    const q = this.queueProvider();
    this.queue = q;
    this.queueProvider = null;
    return q;
  }

  async enqueue(payload: AuditJobPayload): Promise<void> {
    const queue = this.ensureQueue();
    // RT-124: every emission still produces a distinct job — each enqueue
    // mints a fresh id unless the caller already holds one. That id is the
    // jobId (a repeated add of the SAME fact is a no-op) and becomes
    // audit_events.id in the worker, whose insert ignores a conflicting id,
    // so a retried job cannot duplicate the row.
    const eventId = payload.event_id ?? newId();
    await queue.add(
      AUDIT_FANOUT_JOB_NAME_API,
      { ...payload, event_id: eventId, traceContext: injectTraceContext() },
      { jobId: eventId },
    );
  }

  /**
   * Close the underlying BullMQ Queue on module shutdown.
   *
   * Idempotent: a second call is a no-op (Nest's lifecycle CAN fire
   * close cycles more than once in some `Test.createTestingModule`
   * teardown patterns; bullmq's own `Queue.close()` is itself
   * idempotent, but the guard avoids double-await and keeps the
   * intent obvious).
   *
   * Lazy-aware: if the producer was constructed in lazy mode and
   * `enqueue()` was never called, there is no Queue to close. The
   * hook does nothing -- the whole point of lazy mode.
   *
   * Defensive: optional-chain on `close` so in-memory test doubles
   * that omit the method continue to work. Errors from `close()` are
   * swallowed -- shutdown is best-effort and a failed close on an
   * already-disconnected client is exactly the noise we don't want
   * to log at process exit.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.queue === null) {
      // Lazy, never materialised. Drop the provider thunk too so a
      // subsequent `enqueue` cannot resurrect the queue via the
      // `ensureQueue` materialisation path (post-destroy guard --
      // CodeRabbit review on PR #242).
      this.queueProvider = null;
      return;
    }
    const closeFn = (this.queue as AuditQueueLike).close;
    if (typeof closeFn === "function") {
      try {
        await closeFn.call(this.queue);
      } catch {
        // Best-effort: a failing close on a queue we're tearing down
        // anyway shouldn't crash the shutdown path.
      }
    }
  }
}
