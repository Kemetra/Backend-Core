/**
 * WorkerModule — slice 6 (T091) + PR-D audit wiring.
 *
 * Wires the worker side of two pipelines:
 *
 *   EmailWorker
 *     ├─ EmailProcessor                           (PR #15)
 *     │    └─ EMAIL_ADAPTER                       (NoOpEmailAdapter — PR #15)
 *     └─ WORKER_FACTORY                           (shared with AuditWorker)
 *
 *   AuditWorker                                   (PR-D)
 *     ├─ AuditFanoutProcessor                     (T232)
 *     │    └─ AUDIT_DB                            (DrizzleAuditDbAdapter or NoOpAuditDbAdapter)
 *     │          └─ AuditDbPool                   (Nest-managed wrapper around pg.Pool|null)
 *     │                └─ pg.Pool                 (built from DATABASE_URL)
 *     └─ WORKER_FACTORY                           (shared with EmailWorker)
 *
 * Why a wrapper class instead of a raw `pg.Pool` provider?
 * --------------------------------------------------------
 * NestJS only fires `onModuleDestroy` on providers whose resolved value
 * is a class instance with that hook. A `useFactory` that returned a
 * raw `Pool` would be a value-typed provider — Nest has no contract to
 * call `pool.end()` on it during `app.close()`. Under SIGTERM the
 * worker process would hang on open Postgres connections until forced.
 *
 * `AuditDbPool` is a thin Nest-aware wrapper that owns the pool's
 * lifecycle: it implements `OnModuleDestroy` and calls `pool.end()`
 * exactly once on shutdown. The `AUDIT_DB` provider injects the
 * wrapper, reads `wrapper.pool`, and never sees the raw `Pool`
 * factory output.
 *
 * WORKER_FACTORY rule (existing, unchanged)
 * -----------------------------------------
 *   - `NODE_ENV=production` + `REDIS_URL` missing → throws at boot.
 *     Silently consuming nothing while the producer fills the queue
 *     is a safety hazard; we fail loud instead.
 *   - non-production + `REDIS_URL` missing → falls back to
 *     `NoOpWorkerFactory` so dev / CI machines without Redis still
 *     boot. Same fallback policy as `apps/api`'s `AuthModule`.
 *   - `REDIS_URL` set → builds a real `BullMqWorkerFactory` that
 *     constructs `new bullmq.Worker(name, handler, { connection })`.
 *
 * PG_POOL × AUDIT_DB rule (PR-D — consume-without-persist guard)
 * --------------------------------------------------------------
 *   - `NODE_ENV=production` + `DATABASE_URL` missing → throws at boot.
 *   - `REDIS_URL` set + `DATABASE_URL` missing → throws at boot
 *     **regardless of `NODE_ENV`**. A worker that consumes real BullMQ
 *     jobs but cannot persist them would ack-and-drop audit events,
 *     which is strictly worse than not consuming at all.
 *   - non-production + `REDIS_URL` unset + `DATABASE_URL` unset →
 *     `NoOpAuditDbAdapter`. Safe because the worker is also no-op
 *     (`NoOpWorkerFactory`); no jobs flow.
 *   - `DATABASE_URL` set → real `pg.Pool` and `DrizzleAuditDbAdapter`,
 *     regardless of `REDIS_URL` (a worker with DB but no Redis is fine
 *     — it just doesn't consume anything at runtime).
 *
 * The `NoOpAuditDbAdapter` is permitted ONLY when the
 * `WORKER_FACTORY` is also a `NoOpWorkerFactory`. The two factories
 * read `REDIS_URL` and `DATABASE_URL` independently, but the guard
 * above ensures a real Redis worker is never paired with a no-op DB.
 *
 * Tests substitute fakes via `Test.createTestingModule(...)
 * .overrideProvider(...)`. No Redis, no BullMQ runtime, no Postgres,
 * no provider SDK is loaded under test.
 *
 * What is NOT in this module
 * --------------------------
 *   - Retry / backoff / DLQ defaults — T092 (queue.config.ts).
 *   - Session-revoke worker — T302.
 *   - OTel propagation from API → worker — T303.
 *   - Real provider SDK — PQ-1.
 */
import {
  Injectable,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { Queue, Worker as BullMqWorker, type WorkerOptions } from "bullmq";
import { Pool } from "pg";

import {
  registerDbPoolGauges,
  registerOutboxPendingGauge,
  registerQueueLagGauge,
  WORKER_QUEUE_NAMES,
  type WorkerQueueName,
} from "./observability/metrics/worker.metrics";
import { InstrumentedRedis } from "./observability/instrumented-redis";
import { InstrumentedPool } from "./observability/instrumented-pool";

import {
  EMAIL_ADAPTER,
  type EmailAdapter,
  NoOpEmailAdapter,
} from "./email/email.adapter";
import { EmailProcessor } from "./email/email.processor";
import {
  type EmailJobHandler,
  EmailWorker,
  type WorkerFactory,
  type WorkerLike,
  type WorkerStartOptions,
  WORKER_FACTORY,
} from "./email/email.worker";
import { AuditFanoutProcessor, AUDIT_DB, type AuditDbLike } from "./audit/audit-fanout.processor";
import { AuditWorker } from "./audit/audit.worker";
import { SaleProcessingProcessor } from "./sales/sale-processing.processor";
import { SaleWorker } from "./sales/sale.worker";
import {
  DrizzleAuditDbAdapter,
  NoOpAuditDbAdapter,
} from "./audit/drizzle-audit-db.adapter";
import {
  AuditRetentionProcessor,
  AUDIT_RETENTION_REPO,
  type AuditRetentionRepository,
} from "./audit/audit-retention.processor";
import {
  DrizzleAuditRetentionRepository,
  NoOpAuditRetentionRepository,
} from "./audit/drizzle-audit-retention.repository";
import { AuditRetentionWorker } from "./audit/audit-retention.worker";
import { AuditRetentionScheduler } from "./audit/audit-retention.scheduler";
import { OutboxModule, OutboxDrainerRunner } from "./outbox/outbox.module";
import { OutboxConsumerRegistry } from "./outbox/registry";
import { DrainerProcessor } from "./outbox/drainer.processor";
import { PostingRequestedConsumer } from "./erpnext-posting/posting-requested.consumer";
import { ReconciliationRequestedConsumer } from "./erpnext-reconciliation/reconciliation-requested.consumer";
import { ProductReconciliationRequestedConsumer } from "./erpnext-product-reconciliation/product-reconciliation-requested.consumer";
import { ReportBackedBinView } from "./erpnext-reconciliation/report-backed-bin-view";
import {
  OutboxRetentionProcessor,
  OUTBOX_RETENTION_REPO,
  type OutboxRetentionRepository,
} from "./outbox/retention.processor";
import {
  DrizzleOutboxRetentionRepository,
  NoOpOutboxRetentionRepository,
} from "./outbox/drizzle-outbox-retention.repository";
import { OutboxRetentionWorker } from "./outbox/retention.worker";
import { OutboxRetentionScheduler } from "./outbox/retention.scheduler";

/**
 * Real BullMQ-backed factory. Constructs a `bullmq.Worker` that
 * subscribes to the named queue and delegates each job to `handler`.
 *
 * Connection: `{ url: REDIS_URL }`. We do NOT eagerly construct an
 * `ioredis` client here — BullMQ owns its own connection lifecycle and
 * the URL form is the simplest production-safe wiring.
 *
 * `options` are spread into the `new Worker(...)` call so the shared
 * `DEFAULT_WORKER_OPTIONS` (concurrency, lockDuration, stalled-job
 * tuning) flow through unchanged.
 */
export class BullMqWorkerFactory implements WorkerFactory {
  constructor(private readonly redisUrl: string) {}

  create(
    queueName: string,
    handler: EmailJobHandler,
    options: WorkerStartOptions,
  ): WorkerLike {
    const client = new InstrumentedRedis(this.redisUrl);
    const worker = new BullMqWorker(
      queueName,
      async (job) => handler({ name: job.name, data: job.data }),
      { connection: client, ...options },
    );
    return {
      on(event: "error", listener: (err: Error) => void): unknown {
        return worker.on(event, listener);
      },
      async close(): Promise<void> {
        try {
          await worker.close();
        } finally {
          client.disconnect();
        }
      },
    };
  }
}

/**
 * Dev / test fallback. `start()` and `close()` are no-ops; no jobs are
 * ever consumed. The class name is loud so a deployment that ships
 * with this active is obvious in the dependency graph.
 *
 * Accepts the same options arg as `BullMqWorkerFactory` for interface
 * parity, then ignores it.
 */
export class NoOpWorkerFactory implements WorkerFactory {
  create(
    _queueName: string,
    _handler: EmailJobHandler,
    _options: WorkerStartOptions,
  ): WorkerLike {
    return {
      on: () => undefined,
      close: async () => {
        // intentionally empty — no underlying worker exists
      },
    };
  }
}

/**
 * Factory for the `WORKER_FACTORY` provider. Exported so tests can
 * call it directly and assert the production-vs-dev branch behavior.
 */
export function workerFactoryProviderFactory(): WorkerFactory {
  const url = process.env["REDIS_URL"];
  if (!url) {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error(
        "WorkerModule: REDIS_URL is required in production " +
          "(BullMQ Worker cannot be created without it).",
      );
    }
    return new NoOpWorkerFactory();
  }
  return new BullMqWorkerFactory(url);
}

/**
 * Nest-managed wrapper that owns the worker's `pg.Pool` lifecycle.
 *
 * Why this exists
 * ---------------
 * Nest only invokes `onModuleDestroy` on providers whose resolved value
 * is a class instance implementing the hook. A `useFactory` returning a
 * raw `Pool` would be opaque to Nest — `app.close()` would not call
 * `pool.end()`, and the worker process would hang on open Postgres
 * connections under SIGTERM. This wrapper makes pool teardown
 * explicit and Nest-aware.
 *
 * Field semantics
 * ---------------
 * - `pool === null` is the safe non-prod / no-Redis / no-DB path
 *   (paired with `NoOpAuditDbAdapter` downstream). `onModuleDestroy`
 *   is then a no-op.
 * - `pool !== null` is the real DB path. `onModuleDestroy` ends the
 *   pool exactly once; double-destroy is tolerated because we null the
 *   reference before awaiting `pool.end()`.
 *
 * Constructed by `pgPoolProviderFactory()` — never `new`-instantiated
 * directly outside that factory and tests.
 */
@Injectable()
export class AuditDbPool implements OnModuleDestroy {
  private _pool: Pool | null;
  private _heartbeatPool: Pool | null;

  constructor(pool: Pool | null, heartbeatPool: Pool | null = null) {
    this._pool = pool;
    this._heartbeatPool = heartbeatPool;
  }

  /** The underlying pool, or `null` on the safe no-DB path. */
  get pool(): Pool | null {
    return this._pool;
  }

  get heartbeatPool(): Pool | null {
    return this._heartbeatPool;
  }

  /**
   * Nest lifecycle hook — fires on `app.close()` from `main.ts`.
   * Idempotent: a second invocation is a no-op because we null the
   * reference before awaiting.
   */
  async onModuleDestroy(): Promise<void> {
    const p = this._pool;
    const heartbeatPool = this._heartbeatPool;
    this._pool = null;
    this._heartbeatPool = null;
    try {
      if (heartbeatPool !== null) {
        await heartbeatPool.end();
      }
    } finally {
      if (p !== null) {
        await p.end();
      }
    }
  }
}

/**
 * Factory for the `AuditDbPool` provider (PR-D).
 *
 * Implements the DATABASE_URL × REDIS_URL truth table at the module
 * docstring. Returns an `AuditDbPool` whose internal pool is `null`
 * only on the safe path. All other "missing DATABASE_URL" cases throw.
 *
 * Exported so tests can call it directly without booting Nest DI.
 */
export function pgPoolProviderFactory(): AuditDbPool {
  const dbUrl = process.env["DATABASE_URL"];
  const redisUrl = process.env["REDIS_URL"];
  const isProd = process.env["NODE_ENV"] === "production";

  if (dbUrl) {
    return new AuditDbPool(
      new InstrumentedPool({ connectionString: dbUrl }),
      new InstrumentedPool({ connectionString: dbUrl, max: 2 }),
    );
  }

  // dbUrl is missing from here on.
  if (isProd) {
    throw new Error(
      "WorkerModule: DATABASE_URL is required in production " +
        "(audit worker cannot persist events without it).",
    );
  }
  if (redisUrl) {
    throw new Error(
      "WorkerModule: DATABASE_URL is required when REDIS_URL is set " +
        "(consume-without-persist guard: a worker that ingests BullMQ jobs " +
        "but cannot write to the DB would silently drop audit events).",
    );
  }
  // Safe path: no Redis (no consumption) AND no DB. NoOpAuditDbAdapter pairs
  // with NoOpWorkerFactory; no audit events flow.
  return new AuditDbPool(null);
}

/**
 * Factory for the `AUDIT_DB` provider (PR-D).
 *
 * Reads `wrapper.pool`:
 * - non-null → `DrizzleAuditDbAdapter` (real persistence).
 * - null     → `NoOpAuditDbAdapter` (only reachable on the safe
 *              non-prod / no-Redis / no-DB path; the guard in
 *              `pgPoolProviderFactory` rejects every other
 *              missing-DATABASE_URL case).
 *
 * The factory does NOT take ownership of the pool — `AuditDbPool` owns
 * lifecycle. The adapter holds a reference for query-time use; teardown
 * is on the wrapper, not the adapter.
 */
export function auditDbProviderFactory(wrapper: AuditDbPool): AuditDbLike {
  const pool = wrapper.pool;
  if (pool === null) {
    return new NoOpAuditDbAdapter();
  }
  return new DrizzleAuditDbAdapter(pool);
}

/**
 * Factory for the `SaleProcessingProcessor` provider (008 WIRING).
 *
 * The processor takes a RAW `pg.Pool` (not a seam like `AUDIT_DB`). We REUSE
 * the existing `AuditDbPool` wrapper rather than creating a second Postgres
 * pool — the module's design explicitly shares one pool across the audit /
 * outbox / sales pipelines (see `auditRetentionRepoProviderFactory` and
 * `drainerProcessorProviderFactory`, which do the same). Lifecycle stays on
 * `AuditDbPool.onModuleDestroy`; this factory never owns the pool.
 *
 * Null-pool path: `wrapper.pool === null` is the safe non-prod / no-Redis /
 * no-DB path, which by the module's truth table is ALWAYS paired with
 * `NoOpWorkerFactory`. The `SaleWorker` on that path never consumes a job, so
 * `process()` — the only method that touches the pool — never runs. We pass
 * `wrapper.pool as Pool` so the processor is still constructible (Nest needs a
 * value); any path that actually consumes (REDIS_URL set) forces
 * `pgPoolProviderFactory` to guarantee a non-null pool via the
 * consume-without-persist guard. We do NOT change the processor's constructor.
 *
 * Exported so tests can call it directly without booting Nest DI.
 */
export function saleProcessingProcessorProviderFactory(
  wrapper: AuditDbPool,
): SaleProcessingProcessor {
  return new SaleProcessingProcessor(wrapper.pool as Pool);
}

/**
 * Factory for the `SaleWorker` provider (008 WIRING).
 *
 * Mirrors how `AuditWorker` is wired, but `SaleWorker`'s constructor takes its
 * collaborators positionally (`processor, workerFactory`) with no `@Inject`
 * token decorator, so we construct it explicitly here injecting the processor
 * and the shared `WORKER_FACTORY`. The same `WorkerFactory` instance
 * (`BullMqWorkerFactory` in prod, `NoOpWorkerFactory` in dev) is shared with
 * `EmailWorker` / `AuditWorker`.
 *
 * Exported so tests can call it directly.
 */
export function saleWorkerProviderFactory(
  processor: SaleProcessingProcessor,
  workerFactory: WorkerFactory,
): SaleWorker {
  return new SaleWorker(processor, workerFactory);
}

/**
 * Factory for the `AUDIT_RETENTION_REPO` provider (T311 Layer B).
 *
 * Mirrors `auditDbProviderFactory`: delegates to the NoOp implementation
 * on the safe no-DB path, and to the Drizzle implementation when a real
 * pool is available. The pool lifecycle remains on `AuditDbPool`.
 */
export function auditRetentionRepoProviderFactory(
  wrapper: AuditDbPool,
): AuditRetentionRepository {
  if (wrapper.pool === null) {
    return new NoOpAuditRetentionRepository();
  }
  return new DrizzleAuditRetentionRepository(wrapper.pool);
}

/**
 * Factory for the `OUTBOX_RETENTION_REPO` provider (T590).
 *
 * Mirrors `auditRetentionRepoProviderFactory`. Reuses the existing
 * `AuditDbPool` wrapper so no second Postgres pool is created -- the
 * outbox retention sweep shares lifecycle with the audit pipeline. The
 * Drizzle implementation issues its DELETEs under
 * `runWithTenantContext({ tenantId: null, isPlatformAdmin: true })` so
 * the platform-admin OR-branch of the outbox_events RLS policy covers
 * every tenant in a single sweep.
 */
export function outboxRetentionRepoProviderFactory(
  wrapper: AuditDbPool,
): OutboxRetentionRepository {
  if (wrapper.pool === null) {
    return new NoOpOutboxRetentionRepository();
  }
  return new DrizzleOutboxRetentionRepository(wrapper.pool);
}

/** DI token for the `AuditDbPool` Nest-managed wrapper. */
export const PG_POOL = "PG_POOL";

/** DI token for the outbox `DrainerProcessor` (resolves to `null` on the no-DB path). */
export const OUTBOX_DRAINER = "OUTBOX_DRAINER";

/**
 * Factory for the OUTBOX_DRAINER provider.
 *
 * Lives in `WorkerModule` (not `OutboxModule`) because it injects
 * `AuditDbPool`, which is a `WorkerModule`-scoped provider. Nest provider
 * scope flows downstream only: an imported child module cannot inject
 * providers declared by the importer. Placing this factory here is the
 * minimal-blast-radius fix for the cross-module DI graph.
 *
 * On the safe no-DB path (`wrapper.pool === null`) the factory returns
 * `null`; `outboxDrainerRunnerProviderFactory` then constructs a no-op
 * runner so `WorkerModule` still boots without booting Postgres.
 */
export function drainerProcessorProviderFactory(
  wrapper: AuditDbPool,
  registry: OutboxConsumerRegistry,
): DrainerProcessor | null {
  const pool = wrapper.pool;
  if (pool === null) {
    return null;
  }
  // 015: register the DB-capable `erpnext.posting.requested` consumer here —
  // the one place that holds BOTH the pool and the (mutable, exported) registry,
  // and runs DURING provider construction, BEFORE OutboxDrainerRunner.onModuleInit
  // starts the poll loop (so there is no register-after-drain race). The pool-free
  // consumers (audit, sale-captured) register in OutboxModule's factory; this one
  // cannot (OutboxModule cannot inject the pool — that would be a circular dep).
  registry.register(new PostingRequestedConsumer(pool));
  // 017-RECON-WIRING + 019-T041: the DB-capable `erpnext.reconciliation.requested`
  // consumer registers in the SAME seam — it holds the pool (it invokes
  // ReconciliationRunProcessor) and must register BEFORE the drain loop starts.
  // 019-T041 wires the LIVE `ReportBackedBinView` (was EMPTY_BIN_VIEW): the event
  // is now emitted by `binViewReportSnapshot` AFTER the connector records its Bin
  // snapshot run-scoped, so the processor reads REAL Bin data from
  // `run.summary.bin_view_report` and completes the run over it. A run whose
  // connector never reports stays `running` (re-trigger / future scheduled sweep).
  registry.register(
    new ReconciliationRequestedConsumer(pool, new ReportBackedBinView(pool)),
  );
  // 021-US3: the DB-capable `erpnext.product_reconciliation.requested` consumer
  // registers in the SAME seam (it holds the pool; it invokes
  // ProductReconciliationRunProcessor) BEFORE the drain loop starts. v1 wires the
  // EMPTY_ERPNEXT_ITEM_VIEW stub (the connector item-view is NOT live — the future
  // [GATED] 021-ITEM-VIEW-CONTRACT, epic #524), so a triggered run completes
  // reporting DP2-side classes only with erpnext_view_status='unavailable' — a
  // REPORTED condition, never a failure, never a fabricated unmapped_erpnext_item
  // (FR-007). This makes the DP2-INTERNAL run live; it does NOT make the
  // cross-system connector leg live.
  registry.register(new ProductReconciliationRequestedConsumer(pool));
  return new DrainerProcessor({ pool, heartbeatPool: wrapper.heartbeatPool ?? pool, registry });
}

/**
 * Factory for the `OutboxDrainerRunner` provider.
 *
 * On the no-DB path the upstream factory returns `null` — we still need a
 * runner instance so Nest can fire lifecycle hooks (and so other modules
 * holding a reference don't blow up). The no-op shape mirrors the
 * `DrainerProcessor` surface the runner actually touches.
 */
export function outboxDrainerRunnerProviderFactory(
  drainer: DrainerProcessor | null,
): OutboxDrainerRunner {
  if (drainer === null) {
    return new OutboxDrainerRunner({
      start: () => { /* no-op: no pool available */ },
      stop: () => { /* no-op */ },
      tick: async () => { /* no-op */ },
    } as unknown as DrainerProcessor);
  }
  return new OutboxDrainerRunner(drainer);
}

/**
 * Nest-aware registrar for the `db_pool_in_use` and `db_pool_waiters`
 * ObservableGauge callbacks (P4 W1).
 *
 * On `onModuleInit` registers both pool-stats callbacks against
 * `AuditDbPool.pool`. On `onModuleDestroy` removes them so the callbacks
 * do not reference a closed pool. The no-DB path (`wrapper.pool === null`)
 * is handled inside `registerDbPoolGauges` — the registrar is always safe
 * to wire regardless of the runtime environment.
 */
@Injectable()
export class WorkerDbPoolGaugeRegistrar implements OnModuleInit, OnModuleDestroy {
  private handle: { stop: () => void } | null = null;

  constructor(private readonly wrapper: AuditDbPool) {}

  onModuleInit(): void {
    this.handle = registerDbPoolGauges({ pool: this.wrapper.pool });
  }

  onModuleDestroy(): void {
    const h = this.handle;
    this.handle = null;
    if (h !== null) {
      h.stop();
    }
  }
}

/**
 * Nest-aware registrar for the `queue_lag_seconds` ObservableGauge
 * callback (P4 W2).
 *
 * On `onModuleInit`:
 *   - If `REDIS_URL` is absent → no-op (matches `NoOpWorkerFactory` path).
 *   - Otherwise → creates one lightweight BullMQ `Queue` reader per entry in
 *     `WORKER_QUEUE_NAMES` and passes the map to `registerQueueLagGauge`.
 *     Queue readers share the same connection format as the BullMQ workers but
 *     are read-only (no processor attached). BullMQ owns each connection's
 *     lifecycle.
 *
 * On `onModuleDestroy`:
 *   - Removes the OTel callback.
 *   - Closes all Queue reader connections (fire-and-forget errors are
 *     swallowed since the process is already exiting).
 */
@Injectable()
export class QueueLagGaugeRegistrar implements OnModuleInit, OnModuleDestroy {
  private queues: Map<WorkerQueueName, Queue> | null = null;
  private clients: InstrumentedRedis[] | null = null;
  private handle: { stop: () => void } | null = null;

  onModuleInit(): void {
    const redisUrl = process.env["REDIS_URL"];
    if (!redisUrl) {
      return;
    }
    const pairs = WORKER_QUEUE_NAMES.map((name) => {
      const client = new InstrumentedRedis(redisUrl);
      const queue = new Queue(name, { connection: client });
      return { client, queue, name };
    });
    this.clients = pairs.map((p) => p.client);
    this.queues = new Map(pairs.map((p) => [p.name, p.queue]));
    this.handle = registerQueueLagGauge({ queues: this.queues });
  }

  async onModuleDestroy(): Promise<void> {
    const h = this.handle;
    this.handle = null;
    if (h !== null) {
      h.stop();
    }
    const qs = this.queues;
    this.queues = null;
    if (qs !== null) {
      await Promise.all([...qs.values()].map((q) => q.close().catch(() => undefined)));
    }
    const cs = this.clients;
    this.clients = null;
    if (cs !== null) {
      await Promise.all(cs.map((c) => c.quit().catch(() => undefined)));
    }
  }
}

/**
 * Nest-aware registrar for the `outbox_pending_total` ObservableGauge
 * callback (T595 PR-B-2).
 *
 * Mirrors `OutboxDrainerRunner`'s lifecycle pattern:
 *   - On `onModuleInit`, calls `registerOutboxPendingGauge` with the
 *     shared `AuditDbPool.pool` (real `pg.Pool` in production, `null`
 *     on the safe non-prod / no-DB path — registrar handles both).
 *   - On `onModuleDestroy`, calls the returned `stop` handle so the
 *     OTel callback is removed during graceful shutdown and does not
 *     try to query a closed pool.
 *
 * The registrar is its own provider class (not folded into
 * `OutboxDrainerRunner`) so its lifecycle is independent: the drainer's
 * poll loop and the gauge callback start / stop on their own. The
 * shared `AuditDbPool` wrapper owns pool teardown for both.
 */
@Injectable()
export class OutboxPendingGaugeRegistrar implements OnModuleInit, OnModuleDestroy {
  private handle: { stop: () => void } | null = null;

  constructor(private readonly wrapper: AuditDbPool) {}

  onModuleInit(): void {
    this.handle = registerOutboxPendingGauge({ pool: this.wrapper.pool });
  }

  onModuleDestroy(): void {
    const h = this.handle;
    this.handle = null;
    if (h !== null) {
      h.stop();
    }
  }
}

@Module({
  imports: [OutboxModule],
  providers: [
    // ── Email pipeline (existing) ─────────────────────────────────────
    {
      provide: EMAIL_ADAPTER,
      useFactory: (): EmailAdapter => new NoOpEmailAdapter(),
    },
    EmailProcessor,
    {
      provide: WORKER_FACTORY,
      useFactory: workerFactoryProviderFactory,
    },
    EmailWorker,

    // ── Audit pipeline (PR-D) ─────────────────────────────────────────
    //
    // AuditDbPool is registered as a CLASS-token provider so Nest tracks
    // it for lifecycle hooks. The string token PG_POOL aliases the same
    // instance via useExisting, preserving a stable injection identifier
    // for the AUDIT_DB factory. A useFactory keyed on a string token
    // alone does NOT reliably receive `onModuleDestroy` calls — class
    // tokens do.
    {
      provide: AuditDbPool,
      useFactory: pgPoolProviderFactory,
    },
    {
      provide: PG_POOL,
      useExisting: AuditDbPool,
    },
    {
      provide: AUDIT_DB,
      useFactory: auditDbProviderFactory,
      inject: [AuditDbPool],
    },
    AuditFanoutProcessor,
    AuditWorker,

    // ── Sale-processing pipeline (008 WIRING) ─────────────────────────
    //
    // Closes the merged-but-unwired gap: SaleProcessingProcessor had no
    // BullMQ Worker bootstrap. Mirrors the AuditWorker registration above.
    //
    // The processor takes a RAW pg.Pool — it REUSES the existing AuditDbPool
    // wrapper (no second Postgres pool; same precedent as the audit-retention
    // and outbox-drainer factories). SaleWorker shares the same WORKER_FACTORY
    // (NoOp in dev / BullMQ in prod) as Email/Audit. Both providers are
    // constructed via explicit factories because their constructors take
    // positional args without @Inject token decorators.
    //
    // SCOPE NOTE: the lag-gauge entry (worker.metrics.ts WORKER_QUEUE_NAMES,
    // forbidden) and the DLQ-monitoring entry (queue.config.ts, whose guard
    // spec pins exactly 3 entries and lives outside this slice's test globs)
    // are DEFERRED to a monitoring follow-up that owns those files. The
    // enqueue (outbox → queue) half is likewise deferred (it needs apps/api +
    // the gated packages/db OUTBOX_EVENT_TYPES registry).
    {
      provide: SaleProcessingProcessor,
      useFactory: saleProcessingProcessorProviderFactory,
      inject: [AuditDbPool],
    },
    {
      provide: SaleWorker,
      useFactory: saleWorkerProviderFactory,
      inject: [SaleProcessingProcessor, WORKER_FACTORY],
    },

    // ── Audit retention pipeline (T311 Layer B) ───────────────────────
    //
    // AuditRetentionProcessor has a second constructor param (clock: () => Date)
    // with a runtime default. NestJS reflects it as `Function` and tries to
    // inject it; we bypass that by constructing the processor explicitly so the
    // TypeScript default value is used in production.
    {
      provide: AUDIT_RETENTION_REPO,
      useFactory: auditRetentionRepoProviderFactory,
      inject: [AuditDbPool],
    },
    {
      provide: AuditRetentionProcessor,
      useFactory: (repo: AuditRetentionRepository) =>
        new AuditRetentionProcessor(repo),
      inject: [AUDIT_RETENTION_REPO],
    },
    AuditRetentionWorker,
    AuditRetentionScheduler,

    // ── Outbox retention pipeline (T590) ──────────────────────────────
    //
    // Mirrors the audit-retention quartet above. Shares the existing
    // AuditDbPool wrapper so no second Postgres pool is created. The
    // Drizzle repo issues platform-admin sweeps so a single daily run
    // covers every tenant -- positive counterpart to the tenant-scoped
    // RLS negative locked by retention.spec.ts suite RT-6.
    //
    // OutboxRetentionProcessor takes a `clock: () => Date` default param
    // that NestJS reflects as `Function`; same factory pattern as the
    // AuditRetentionProcessor binding above so the TypeScript default
    // is preserved in production.
    {
      provide: OUTBOX_RETENTION_REPO,
      useFactory: outboxRetentionRepoProviderFactory,
      inject: [AuditDbPool],
    },
    {
      provide: OutboxRetentionProcessor,
      useFactory: (repo: OutboxRetentionRepository) =>
        new OutboxRetentionProcessor(repo),
      inject: [OUTBOX_RETENTION_REPO],
    },
    OutboxRetentionWorker,
    OutboxRetentionScheduler,

    // ── Outbox drainer pipeline (T581) ────────────────────────────────
    //
    // The OUTBOX_DRAINER + OutboxDrainerRunner providers live here (not in
    // OutboxModule) because they inject AuditDbPool, which is declared by
    // this module. Nest provider scope flows downstream: a module imported
    // by WorkerModule cannot inject providers from WorkerModule itself.
    // OutboxModule still owns the pool-independent primitives
    // (OUTBOX_AUDIT_QUEUE, OutboxConsumerRegistry).
    {
      provide: OUTBOX_DRAINER,
      useFactory: drainerProcessorProviderFactory,
      inject: [AuditDbPool, OutboxConsumerRegistry],
    },
    {
      provide: OutboxDrainerRunner,
      useFactory: outboxDrainerRunnerProviderFactory,
      inject: [OUTBOX_DRAINER],
    },

    // ── DB pool gauge registrar (P4 W1) ──────────────────────────────
    //
    // Registers db_pool_in_use + db_pool_waiters ObservableGauge callbacks
    // against AuditDbPool on Nest init. Synchronous in-memory reads; no
    // async I/O. The no-DB path is handled inside registerDbPoolGauges.
    WorkerDbPoolGaugeRegistrar,

    // ── Queue lag gauge registrar (P4 W2) ────────────────────────────
    //
    // Creates BullMQ Queue reader instances for all 5 WORKER_QUEUE_NAMES
    // and registers the queue_lag_seconds ObservableGauge callback on init.
    // No-op when REDIS_URL is absent (dev / CI without Redis).
    QueueLagGaugeRegistrar,

    // ── Outbox pending-events gauge registrar (T595 PR-B-2) ───────────
    //
    // Registers the outbox_pending_total ObservableGauge callback against
    // AuditDbPool on Nest init. Lifecycle is independent of the drainer
    // (the gauge keeps emitting whether the drainer is in mid-tick or
    // not). The no-DB path is handled inside the registrar itself.
    OutboxPendingGaugeRegistrar,
  ],
  exports: [
    EmailWorker,
    EmailProcessor,
    AuditWorker,
    AuditFanoutProcessor,
    SaleWorker,
    SaleProcessingProcessor,
    AuditRetentionWorker,
    AuditRetentionProcessor,
    OutboxRetentionWorker,
    OutboxRetentionProcessor,
    OUTBOX_DRAINER,
    OutboxDrainerRunner,
    WorkerDbPoolGaugeRegistrar,
    QueueLagGaugeRegistrar,
    OutboxPendingGaugeRegistrar,
  ],
})
export class WorkerModule {}
