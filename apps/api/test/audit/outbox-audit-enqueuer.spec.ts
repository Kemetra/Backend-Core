/**
 * T583 — OutboxAuditEnqueuer adoption test.
 *
 * Two layers:
 *
 *   Layer A — Unit (no Postgres)
 *     Verifies the AuditEnqueuerModule factory's environment-flag branch:
 *       - OUTBOX_AUDIT_ENABLED unset → returns the legacy enqueuer
 *       - OUTBOX_AUDIT_ENABLED=1 + pool present → returns OutboxAuditEnqueuer
 *       - OUTBOX_AUDIT_ENABLED=1 + pool null → falls back to legacy factory
 *     This is the dial that activates the outbox-backed audit path per
 *     environment without changing the source for either side of the
 *     cutover.
 *
 *   Layer B — Integration (Testcontainers Postgres)
 *     Drives a real OutboxAuditEnqueuer against a real outbox_events table
 *     and confirms an insert lands with the expected fields. Soft-skips
 *     when Docker is unavailable (MIGRATION_TEST_ALLOW_SKIP=1).
 */
import {
  isOutboxAuditEnabled,
  auditJobEnqueuerFactory,
  outboxOrLegacyAuditJobEnqueuerFactory,
} from "../../src/audit/audit-enqueuer.module";
import { OutboxAuditEnqueuer } from "../../src/audit/outbox-audit-enqueuer";
import { NoOpAuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
import {
  AuditQueueProducer,
  type AuditQueueLike,
} from "../../src/audit/audit-queue.producer";
import { Pool } from "pg";
import {
  APP_ROLE_NAME,
  APP_ROLE_PASSWORD,
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import type { AuditJobPayload } from "../../src/audit/audit-job.types";

// ---------------------------------------------------------------------------
// Layer A — Unit: feature-flag + factory selection
// ---------------------------------------------------------------------------

describe("isOutboxAuditEnabled — feature-flag parsing", () => {
  const original = process.env["OUTBOX_AUDIT_ENABLED"];

  afterEach(() => {
    if (original === undefined) {
      delete process.env["OUTBOX_AUDIT_ENABLED"];
    } else {
      process.env["OUTBOX_AUDIT_ENABLED"] = original;
    }
  });

  it("returns false when the env var is unset", () => {
    delete process.env["OUTBOX_AUDIT_ENABLED"];
    expect(isOutboxAuditEnabled()).toBe(false);
  });

  it("returns false for the empty string", () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "";
    expect(isOutboxAuditEnabled()).toBe(false);
  });

  it("returns true for the string '1'", () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "1";
    expect(isOutboxAuditEnabled()).toBe(true);
  });

  it("returns true for 'true', 'TRUE', 'yes' (case-insensitive)", () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "true";
    expect(isOutboxAuditEnabled()).toBe(true);
    process.env["OUTBOX_AUDIT_ENABLED"] = "TRUE";
    expect(isOutboxAuditEnabled()).toBe(true);
    process.env["OUTBOX_AUDIT_ENABLED"] = "yes";
    expect(isOutboxAuditEnabled()).toBe(true);
  });

  it("tolerates leading/trailing whitespace (' true ', 'yes\\n', '\\t1') -- trim before parse", () => {
    // .env files and shell here-docs frequently introduce surrounding
    // whitespace; the parser strips it before lowercasing so misconfigured
    // values still resolve to the operator's intent.
    process.env["OUTBOX_AUDIT_ENABLED"] = " true ";
    expect(isOutboxAuditEnabled()).toBe(true);
    process.env["OUTBOX_AUDIT_ENABLED"] = "yes\n";
    expect(isOutboxAuditEnabled()).toBe(true);
    process.env["OUTBOX_AUDIT_ENABLED"] = "\t1";
    expect(isOutboxAuditEnabled()).toBe(true);
    process.env["OUTBOX_AUDIT_ENABLED"] = " YES\r\n";
    expect(isOutboxAuditEnabled()).toBe(true);
  });

  it("returns false for other truthy-looking values", () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "on";
    expect(isOutboxAuditEnabled()).toBe(false);
    process.env["OUTBOX_AUDIT_ENABLED"] = "enabled";
    expect(isOutboxAuditEnabled()).toBe(false);
  });
});

describe("auditJobEnqueuerFactory — REDIS_URL × NODE_ENV branch matrix", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Fresh copy each test so mutations are scoped per-spec.
    process.env = { ...originalEnv };
    delete process.env["OUTBOX_AUDIT_ENABLED"]; // factory is the legacy path
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  /**
   * Trivial fake matching `AuditQueueLike`. The .add() spy lets the producer's
   * lazy-init path materialise the queue when we call enqueuer.enqueue() in
   * the URL-capture assertions below -- factory-time side effects no longer
   * fire (see lazy-init contract on AuditQueueProducer + auditJobEnqueuerFactory).
   */
  function fakeQueueFactory(): { queueFactory: (url: string) => AuditQueueLike; urls: string[] } {
    const urls: string[] = [];
    const queueFactory = (url: string): AuditQueueLike => {
      urls.push(url);
      return { add: async () => null };
    };
    return { queueFactory, urls };
  }

  /**
   * Probe payload reused across URL-capture assertions. Carries no PII --
   * the fake queue's .add() never inspects it; the only reason to call
   * enqueuer.enqueue() is to materialise the lazy producer's underlying
   * queue so the queueFactory thunk fires and captures the URL.
   *
   * Lazy-init context: auditJobEnqueuerFactory now returns a producer
   * WITHOUT having invoked the queueFactory thunk -- the call is deferred
   * to first enqueue(). This shifts construction from Nest module-init
   * time to first use, so Nest's `overrideProvider(... ).useValue(spy)`
   * cannot orphan a live BullMQ Queue. See repository.ts / auth.module.ts
   * + the lifecycle specs for the full rationale.
   */
  const probePayload: AuditJobPayload = {
    actor_user_id: null,
    actor_label: null,
    tenant_id: "00000000-0000-7000-8000-000000000001",
    store_id: null,
    action: "test.lazy.materialise",
    target_type: null,
    target_id: null,
    request_id: null,
    metadata: null,
  };

  it("NODE_ENV=production + REDIS_URL unset → throws with stable operator-runbook message", () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["REDIS_URL"];
    expect(() => auditJobEnqueuerFactory()).toThrow(
      /AuditModule: REDIS_URL is required in production/,
    );
  });

  it("NODE_ENV=production + REDIS_URL set → AuditQueueProducer wired with the configured URL (on first enqueue, lazy)", async () => {
    process.env["NODE_ENV"] = "production";
    process.env["REDIS_URL"] = "redis://prod-host:6379";
    const { queueFactory, urls } = fakeQueueFactory();

    const enqueuer = auditJobEnqueuerFactory(queueFactory);

    expect(enqueuer).toBeInstanceOf(AuditQueueProducer);
    // Lazy-init: the thunk has NOT fired yet -- materialisation is
    // deferred to first enqueue() so an `overrideProvider().useValue()`
    // cannot orphan a real Queue. Pre-refactor this was 1 already.
    expect(urls).toEqual([]);
    await (enqueuer as AuditQueueProducer).enqueue(probePayload);
    expect(urls).toEqual(["redis://prod-host:6379"]);
  });

  it("NODE_ENV=test + REDIS_URL set → AuditQueueProducer (non-prod path with Redis configured, lazy)", async () => {
    process.env["NODE_ENV"] = "test";
    process.env["REDIS_URL"] = "redis://test-host:6379";
    const { queueFactory, urls } = fakeQueueFactory();

    const enqueuer = auditJobEnqueuerFactory(queueFactory);

    expect(enqueuer).toBeInstanceOf(AuditQueueProducer);
    // Same lazy-init contract as above.
    expect(urls).toEqual([]);
    await (enqueuer as AuditQueueProducer).enqueue(probePayload);
    expect(urls).toEqual(["redis://test-host:6379"]);
  });

  it("NODE_ENV=test + REDIS_URL unset → NoOpAuditJobEnqueuer (dev/test fallback)", () => {
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "test";
    const enqueuer = auditJobEnqueuerFactory();
    expect(enqueuer).toBeInstanceOf(NoOpAuditJobEnqueuer);
  });

  it("NODE_ENV unset (≠ 'production') + REDIS_URL unset → NoOpAuditJobEnqueuer", () => {
    // The production guard is a literal `=== 'production'` check, so any
    // missing / arbitrary NODE_ENV value must fall into the dev branch.
    delete process.env["REDIS_URL"];
    delete process.env["NODE_ENV"];
    const enqueuer = auditJobEnqueuerFactory();
    expect(enqueuer).toBeInstanceOf(NoOpAuditJobEnqueuer);
  });

  it("queueFactory parameter is the test seam — invoked exactly once per producer's first enqueue (lazy)", async () => {
    process.env["NODE_ENV"] = "test";
    process.env["REDIS_URL"] = "redis://localhost:6379";
    const { queueFactory, urls } = fakeQueueFactory();

    const enqueuer1 = auditJobEnqueuerFactory(queueFactory);
    const enqueuer2 = auditJobEnqueuerFactory(queueFactory);

    // Pre-refactor, the two factory calls already populated urls. After
    // the lazy-init refactor, both producers are returned WITHOUT
    // invoking the thunk; materialisation is deferred to first enqueue.
    expect(urls).toEqual([]);

    // Materialise each producer separately -- the seam must fire once
    // per producer, not once per factory call.
    await (enqueuer1 as AuditQueueProducer).enqueue(probePayload);
    await (enqueuer2 as AuditQueueProducer).enqueue(probePayload);

    expect(urls).toHaveLength(2);
    expect(urls.every((u) => u === "redis://localhost:6379")).toBe(true);

    // Sanity: re-enqueueing the same producer does NOT re-invoke the
    // thunk (lazy producer caches the materialised queue).
    await (enqueuer1 as AuditQueueProducer).enqueue(probePayload);
    expect(urls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Layer A — Unit: pool-aware factory DI matrix (T583 live DI swap)
// ---------------------------------------------------------------------------
//
// Pins the four-way decision matrix of outboxOrLegacyAuditJobEnqueuerFactory:
//
//   OUTBOX_AUDIT_ENABLED unset/off            → legacy enqueuer
//   OUTBOX_AUDIT_ENABLED = "1" + pool present → OutboxAuditEnqueuer
//   OUTBOX_AUDIT_ENABLED = "1" + pool null    → fall back to legacy (NEVER drop)
//   invalid flag value ("on", "enabled")      → legacy enqueuer
//
// No Postgres connection is opened: the pool reference passed in is
// either an unused `Pool` instance or null. The factory only consults
// `pool === null` and threads the reference into `new OutboxAuditEnqueuer(pool)`
// — it never queries.

describe("outboxOrLegacyAuditJobEnqueuerFactory — pool-aware DI matrix (T583)", () => {
  const originalEnv = process.env;

  /**
   * Pools created via makeFakePool are tracked here so afterEach can
   * await `pool.end()` on each one. Even though the Pool constructor is
   * lazy and we never query, leaving instances unended leaks an event
   * loop reference and Jest reports "worker process has failed to exit
   * gracefully" -- the same warning we already see (pre-existing) in the
   * Layer B Testcontainers block. Cleaning these up keeps the Layer A
   * suite cleanup-clean.
   */
  let createdPools: Pool[] = [];

  /** Structured-logger spy bindings captured per test. */
  let loggerWarns: Array<{ obj: Record<string, unknown>; msg: string }> = [];

  /**
   * Minimal Logger-shaped fake. We only need `warn` for the assertions
   * below; the unused methods are stubs so the factory can call any of
   * them without crashing if behaviour ever changes. Matches the
   * `@data-pulse-2/shared` Logger surface (pino-compatible).
   */
  function makeFakeLogger(): {
    warn: jest.Mock;
    info: jest.Mock;
    error: jest.Mock;
    debug: jest.Mock;
    trace: jest.Mock;
    fatal: jest.Mock;
    child: jest.Mock;
  } {
    const warn = jest.fn((obj: Record<string, unknown>, msg: string) => {
      loggerWarns.push({ obj, msg });
    });
    const stub = jest.fn();
    const child = jest.fn(() => makeFakeLogger());
    return {
      warn,
      info: stub,
      error: stub,
      debug: stub,
      trace: stub,
      fatal: stub,
      child,
    };
  }

  beforeEach(() => {
    // Fresh process.env per test so flag mutations don't leak.
    process.env = { ...originalEnv };
    createdPools = [];
    loggerWarns = [];
  });

  afterEach(async () => {
    process.env = originalEnv;
    // End every Pool we created so Jest does not flag leaked event-loop
    // references. `pool.end()` is idempotent and resolves quickly for
    // never-connected pools.
    for (const pool of createdPools) {
      await pool.end().catch(() => undefined);
    }
    createdPools.length = 0;
  });

  /** Construct a never-used Pool. The factory only inspects `=== null`. */
  function makeFakePool(): Pool {
    // The Pool constructor is lazy — no connection is opened until a query
    // is issued. We never query, so this is a safe placeholder for "pool
    // is present" without booting Postgres. Tracked in `createdPools` so
    // afterEach can release the resource.
    const pool = new Pool({
      connectionString: "postgres://fake:fake@127.0.0.1:1/fake",
    });
    createdPools.push(pool);
    return pool;
  }

  function fakeQueueFactory(): (url: string) => AuditQueueLike {
    return () => ({ add: async () => null });
  }

  it("OUTBOX_AUDIT_ENABLED unset → legacy enqueuer (NODE_ENV=test, no REDIS_URL)", () => {
    delete process.env["OUTBOX_AUDIT_ENABLED"];
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "test";

    const pool = makeFakePool();
    const logger = makeFakeLogger();
    const enqueuer = outboxOrLegacyAuditJobEnqueuerFactory(
      pool,
      undefined,
      logger as unknown as import("@data-pulse-2/shared").Logger,
    );

    // Legacy factory's test-fallback is NoOp when REDIS_URL is unset.
    expect(enqueuer).toBeInstanceOf(NoOpAuditJobEnqueuer);
    expect(enqueuer).not.toBeInstanceOf(OutboxAuditEnqueuer);
    expect(loggerWarns).toHaveLength(0);
  });

  it("OUTBOX_AUDIT_ENABLED unset → legacy enqueuer (NODE_ENV=test + REDIS_URL → AuditQueueProducer)", () => {
    delete process.env["OUTBOX_AUDIT_ENABLED"];
    process.env["NODE_ENV"] = "test";
    process.env["REDIS_URL"] = "redis://localhost:6379";

    const pool = makeFakePool();
    const logger = makeFakeLogger();
    const enqueuer = outboxOrLegacyAuditJobEnqueuerFactory(
      pool,
      fakeQueueFactory(),
      logger as unknown as import("@data-pulse-2/shared").Logger,
    );

    expect(enqueuer).toBeInstanceOf(AuditQueueProducer);
    expect(enqueuer).not.toBeInstanceOf(OutboxAuditEnqueuer);
    expect(loggerWarns).toHaveLength(0);
  });

  it("OUTBOX_AUDIT_ENABLED='1' + pool present → OutboxAuditEnqueuer", () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "1";

    const pool = makeFakePool();
    const logger = makeFakeLogger();
    const enqueuer = outboxOrLegacyAuditJobEnqueuerFactory(
      pool,
      undefined,
      logger as unknown as import("@data-pulse-2/shared").Logger,
    );

    expect(enqueuer).toBeInstanceOf(OutboxAuditEnqueuer);
    expect(loggerWarns).toHaveLength(0);
  });

  it("OUTBOX_AUDIT_ENABLED='true' + pool present → OutboxAuditEnqueuer (case-insensitive)", () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "TRUE";

    const pool = makeFakePool();
    const enqueuer = outboxOrLegacyAuditJobEnqueuerFactory(pool);

    expect(enqueuer).toBeInstanceOf(OutboxAuditEnqueuer);
  });

  it("OUTBOX_AUDIT_ENABLED='yes' + pool present → OutboxAuditEnqueuer", () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "yes";

    const pool = makeFakePool();
    const enqueuer = outboxOrLegacyAuditJobEnqueuerFactory(pool);

    expect(enqueuer).toBeInstanceOf(OutboxAuditEnqueuer);
  });

  it("OUTBOX_AUDIT_ENABLED=' true ' (whitespace) + pool present → OutboxAuditEnqueuer", () => {
    // Pairs with the trim-before-parse fix in isOutboxAuditEnabled().
    process.env["OUTBOX_AUDIT_ENABLED"] = " true ";

    const pool = makeFakePool();
    const enqueuer = outboxOrLegacyAuditJobEnqueuerFactory(pool);

    expect(enqueuer).toBeInstanceOf(OutboxAuditEnqueuer);
  });

  it("OUTBOX_AUDIT_ENABLED='on' (invalid token) → legacy enqueuer", () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "on";
    process.env["NODE_ENV"] = "test";

    const pool = makeFakePool();
    const enqueuer = outboxOrLegacyAuditJobEnqueuerFactory(pool);

    expect(enqueuer).not.toBeInstanceOf(OutboxAuditEnqueuer);
  });

  it("OUTBOX_AUDIT_ENABLED='1' + pool null → safe fallback to legacy + warn through structured logger (NEVER drop events)", () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "1";
    process.env["NODE_ENV"] = "test";
    process.env["REDIS_URL"] = "redis://localhost:6379";

    const logger = makeFakeLogger();
    const enqueuer = outboxOrLegacyAuditJobEnqueuerFactory(
      null,
      fakeQueueFactory(),
      logger as unknown as import("@data-pulse-2/shared").Logger,
    );

    // 1. Never silently drops — falls back to the legacy BullMQ producer.
    expect(enqueuer).toBeInstanceOf(AuditQueueProducer);
    expect(enqueuer).not.toBeInstanceOf(OutboxAuditEnqueuer);

    // 2. Misconfiguration is observable through the structured logger.
    //    The shared @data-pulse-2/shared logger applies the redaction
    //    matrix at emit time; the binding we pass MUST already be
    //    PII-safe (no payload, no secret values).
    expect(loggerWarns).toHaveLength(1);
    const { obj, msg } = loggerWarns[0]!;
    expect(obj["component"]).toBe("audit.enqueuer");
    expect(obj["request_id"]).toBeNull();
    expect(obj["tenant_id"]).toBeNull();
    expect(msg).toContain("OUTBOX_AUDIT_ENABLED=1");
    expect(msg).toContain("PG_POOL is null");
    // 3. Neither the binding nor the message echoes secret-shaped values
    //    (DATABASE_URL connection strings, etc.).
    const serialised = JSON.stringify(obj) + " " + msg;
    expect(serialised).not.toContain("postgres://");
    expect(serialised).not.toMatch(/password/i);
  });

  it("OUTBOX_AUDIT_ENABLED='1' + pool null + NODE_ENV=production + no REDIS_URL → legacy factory fails loud", () => {
    // The flag is on, the pool is unavailable, AND the legacy fallback
    // itself cannot construct a real producer (production + no Redis).
    // The legacy factory throws the operator-runbook error in that case.
    // This pins the worst-case branch: we never silently drop, and the
    // operator sees BOTH the fallback warn line and the production
    // bootstrapping error.
    process.env["OUTBOX_AUDIT_ENABLED"] = "1";
    process.env["NODE_ENV"] = "production";
    delete process.env["REDIS_URL"];

    const logger = makeFakeLogger();
    expect(() =>
      outboxOrLegacyAuditJobEnqueuerFactory(
        null,
        undefined,
        logger as unknown as import("@data-pulse-2/shared").Logger,
      ),
    ).toThrow(/AuditModule: REDIS_URL is required in production/);
    // Fallback warn line still fires before the legacy factory throws.
    expect(loggerWarns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Layer B — Integration: real Postgres + outbox INSERT
// ---------------------------------------------------------------------------
//
// Testcontainers lifecycle is SCOPED to this describe block so the Layer A
// unit tests above never trigger a Docker container start. Running
// `jest --testPathPattern=...` against only Layer A (or running this file
// on a Docker-less machine when MIGRATION_TEST_ALLOW_SKIP=1) avoids ~3-5s
// of pointless container boot/teardown.

describe("OutboxAuditEnqueuer — writes a pending outbox_events row", () => {
  const TENANT_A = "0aa00000-0000-7000-8000-000000000001";

  let env: PgTestEnv | null = null;
  let dockerSkipped = false;

  function maybeSkip(): boolean {
    if (dockerSkipped) {
      console.warn("[outbox-audit-enqueuer.spec] skipping (Docker unavailable)");
      return true;
    }
    return false;
  }

  beforeAll(async () => {
    try {
      env = await startPgEnv();
      await applyAllUpAndCreateAppRole(env);
      await env.admin.query(
        `INSERT INTO tenants (id, slug, name) VALUES ($1, 'outbox-enqueuer-test', 'Outbox Enqueuer Test')`,
        [TENANT_A],
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
        console.warn(`\n[outbox-audit-enqueuer.spec] Docker NOT AVAILABLE: ${msg}\n`);
        dockerSkipped = true;
        return;
      }
      throw new Error(`Container start failed: ${msg}`);
    }
  }, 180_000);

  afterAll(async () => {
    if (env) await stopPgEnv(env);
  }, 60_000);

  it("inserts an audit.event.created row with the payload preserved (tenant-scoped)", async () => {
    if (maybeSkip()) return;

    // The SUT runs against `env.app` (the non-superuser `app_test` role).
    // Using `env.admin` (superuser) would silently bypass RLS even when
    // FORCE ROW LEVEL SECURITY is set, which would defeat the point of
    // exercising the enqueuer against a real schema — the INSERT could
    // succeed for the wrong reason. `env.admin` is still used below for
    // SETUP (seeding the tenants row) and ASSERTIONS (reading rows back
    // unconstrained by RLS), but never to drive the SUT.
    const enqueuer = new OutboxAuditEnqueuer(env!.app);
    // `request_id` must be a valid UUID — the OutboxAuditEnqueuer threads
    // it through as `correlationId`, and `outbox_events.correlation_id` is
    // a `uuid` column. A non-UUID value (e.g. "req-corr-0001") would fail
    // the INSERT with `invalid input syntax for type uuid` regardless of
    // RLS / pool choice.
    const REQUEST_UUID = "00000000-0000-7000-8000-00000000c001";
    const payload: AuditJobPayload = {
      actor_user_id: "00000000-0000-7000-8000-000000000010",
      actor_label:   null,
      tenant_id:     TENANT_A,
      store_id:      null,
      action:        "context.switch.tenant",
      target_type:   "tenant",
      target_id:     "00000000-0000-7000-8000-000000000020",
      request_id:    REQUEST_UUID,
      metadata:      null,
    };

    await enqueuer.enqueue(payload);

    // Filter on BOTH tenant_id and correlation_id (== REQUEST_UUID): the
    // tenant_id alone is not deterministic — earlier tests in this file
    // (or future ones) can insert rows for the same tenant, and
    // `ORDER BY created_at DESC LIMIT 1` would silently surface the wrong
    // one if another row landed first. Targeting the unique
    // (tenant, correlation_id) pair pins the assertion to THIS test's
    // insertion.
    const rows = await env!.admin.query<{
      event_id: string;
      tenant_id: string;
      store_id: string | null;
      event_type: string;
      payload: Record<string, unknown>;
      delivery_state: string;
      attempts: number;
      correlation_id: string | null;
    }>(
      `SELECT event_id, tenant_id, store_id, event_type, payload,
              delivery_state, attempts, correlation_id
         FROM outbox_events
        WHERE tenant_id = $1
          AND correlation_id = $2`,
      [TENANT_A, REQUEST_UUID],
    );

    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row.tenant_id).toBe(TENANT_A);
    expect(row.event_type).toBe("audit.event.created");
    expect(row.delivery_state).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.correlation_id).toBe(REQUEST_UUID);
    expect(row.payload).toMatchObject({
      actor_user_id: payload.actor_user_id,
      tenant_id: payload.tenant_id,
      action: "context.switch.tenant",
      target_type: "tenant",
    });
  });

  it("stores NULL tenant_id for platform-scoped audit events (nil UUID is not a tenant)", async () => {
    if (maybeSkip()) return;

    // Same RLS-realism contract as the tenant-scoped test above: SUT runs
    // under the app role. The platform-admin GUC the enqueuer sets is what
    // makes the INSERT pass RLS WITH CHECK on the platform-scoped row.
    const enqueuer = new OutboxAuditEnqueuer(env!.app);
    // Same UUID-column constraint: request_id flows into correlation_id and
    // must be a real UUID.
    const PLATFORM_REQUEST_UUID = "00000000-0000-7000-8000-00000000c002";
    const payload: AuditJobPayload = {
      actor_user_id: null,
      actor_label:   "platform-admin",
      tenant_id:     null, // platform-scoped — no tenant
      store_id:      null,
      action:        "platform.tenant.created",
      target_type:   null,
      target_id:     null,
      request_id:    PLATFORM_REQUEST_UUID,
      metadata:      null,
    };

    await enqueuer.enqueue(payload);

    const rows = await env!.admin.query<{ tenant_id: string | null; event_type: string }>(
      `SELECT tenant_id, event_type
         FROM outbox_events
        WHERE correlation_id = $1`,
      [PLATFORM_REQUEST_UUID],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.tenant_id).toBeNull();
    expect(rows.rows[0]!.event_type).toBe("audit.event.created");
  });

  // ---------------------------------------------------------------------------
  // Fail-closed integration coverage for the enqueuer's security boundary
  // ---------------------------------------------------------------------------
  //
  // OutboxAuditEnqueuer derives its tenant context from `payload.tenant_id`
  // and INSERTs an outbox row with the same `tenant_id`. The security
  // boundary it RELIES ON — but does not itself enforce — is the RLS
  // policy on `outbox_events`: tenant context and row.tenant_id must match
  // (or the platform-admin GUC must be 'true'). These tests prove that
  // boundary fails closed under the app role; without them the enqueuer's
  // happy-path success could be masking a permissive RLS policy.

  it("FC-1: app-role INSERT with mismatched tenant context vs row.tenant_id is rejected by RLS", async () => {
    if (maybeSkip()) return;

    const OTHER_TENANT = "00000000-0000-7000-8000-00000000beef";
    const FC1_REQUEST_UUID = "00000000-0000-7000-8000-00000000c011";

    // Open an app-role connection, set tenant context to TENANT_A via
    // `set_config(..., true)` (the transaction-local form of SET LOCAL —
    // `SET LOCAL <name> = $1` is a parse error because Postgres's SET
    // does not accept parameter placeholders, and the function form is
    // the standard workaround), then attempt to INSERT a row claiming
    // tenant_id = OTHER_TENANT. The outbox_events_tenant_isolation
    // WITH CHECK predicate evaluates
    //   tenant_id = current_setting('app.current_tenant')::uuid (FALSE here)
    //   OR current_setting('app.is_platform_admin') = 'true'  (FALSE here)
    // → Postgres raises SQLSTATE 42501 (insufficient_privilege / RLS).
    const pgErr = await runRlsRejectAttempt(env!.app, async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_A],
      );
      await client.query(
        `SELECT set_config('app.is_platform_admin', 'false', true)`,
      );
      await client.query(
        `INSERT INTO outbox_events
           (event_id, tenant_id, event_type, payload, delivery_state,
            attempts, correlation_id)
         VALUES ($1, $2, 'audit.event.created', '{"fc":1}'::jsonb,
                 'pending', 0, $3)`,
        [
          "00000000-0000-4000-8000-00000000fc01",
          OTHER_TENANT,
          FC1_REQUEST_UUID,
        ],
      );
    });

    expect(pgErr).not.toBeNull();
    // 42501 covers both "permission denied for table" and the
    // "new row violates row-level security policy" message Postgres
    // emits for WITH CHECK violations — the only outcomes this scenario
    // can legitimately produce.
    expect(pgErr!.code).toBe("42501");
    expect(pgErr!.message).toMatch(/row.level security|policy|permission denied/i);

    // Confirm the rollback was real: no row landed under the malicious
    // correlation_id even though we wrote it inside the failed transaction.
    const checkRows = await env!.admin.query(
      `SELECT 1 FROM outbox_events WHERE correlation_id = $1`,
      [FC1_REQUEST_UUID],
    );
    expect(checkRows.rows).toHaveLength(0);
  });

  it("FC-2: app-role INSERT with NO tenant context (virgin connection, not platform admin) is rejected by RLS", async () => {
    if (maybeSkip()) return;

    const FC2_REQUEST_UUID = "00000000-0000-7000-8000-00000000c012";

    // No `app.current_tenant` set in this connection's session.
    // `current_setting('app.current_tenant', true)` returns NULL when the
    // parameter has NEVER been touched in the session (the `true` flag
    // suppresses the missing-GUC error). With NULL, `NULL::uuid` is NULL,
    // `tenant_id = NULL` is NULL, the platform-admin branch is FALSE,
    // and the WITH CHECK predicate fails closed → SQLSTATE 42501.
    //
    // Why a fresh single-use Pool (not env.app):
    //   The shared `env.app` pool's clients are reused across tests. FC-1
    //   touches `app.current_tenant` via `set_config(..., true)`. Even
    //   after ROLLBACK, Postgres leaves user-defined GUCs in a "touched
    //   but empty" state on that client — `current_setting('app.current_tenant', true)`
    //   then returns `''` (empty string), not NULL, and the RLS predicate
    //   raises SQLSTATE 22P02 (invalid_text_representation for
    //   `''::uuid`) BEFORE the RLS WITH CHECK rejection can fire. That
    //   would be testing the wrong failure mode.
    //
    //   A brand-new Pool yields a brand-new connection that has never seen
    //   `app.current_tenant`, so `current_setting` legitimately returns
    //   NULL and the test exercises the intended fail-closed path. The
    //   pool is ended at the end of the test so no connection leaks.
    const freshPool = new Pool({
      connectionString:
        `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}` +
        `@${env!.host}:${env!.port}/test`,
    });

    try {
      const pgErr = await runRlsRejectAttempt(freshPool, async (client) => {
        // Do NOT touch `app.current_tenant` — leaving the GUC truly unset
        // is the whole point of FC-2. We explicitly set the platform-admin
        // GUC to 'false' so the second branch of the RLS predicate is
        // unambiguously FALSE rather than NULL (defence in depth — the
        // assertion below relies on a deterministic 42501).
        await client.query(
          `SELECT set_config('app.is_platform_admin', 'false', true)`,
        );
        await client.query(
          `INSERT INTO outbox_events
             (event_id, tenant_id, event_type, payload, delivery_state,
              attempts, correlation_id)
           VALUES ($1, $2, 'audit.event.created', '{"fc":2}'::jsonb,
                   'pending', 0, $3)`,
          [
            "00000000-0000-4000-8000-00000000fc02",
            TENANT_A,
            FC2_REQUEST_UUID,
          ],
        );
      });

      expect(pgErr).not.toBeNull();
      expect(pgErr!.code).toBe("42501");
      expect(pgErr!.message).toMatch(/row.level security|policy|permission denied/i);
    } finally {
      await freshPool.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Shared helper: run a transaction expected to fail RLS, leave the pooled
// client in a clean state.
// ---------------------------------------------------------------------------

/**
 * Run `work` inside a fresh transaction on a pooled `Pool` connection,
 * capture and return any Error that the work throws, and ALWAYS roll back
 * before releasing the client.
 *
 * The fail-closed tests deliberately provoke a Postgres error inside the
 * transaction (an RLS WITH CHECK violation). Two transaction-cleanup
 * pitfalls this helper avoids:
 *
 *   1. SET LOCAL parse error or set_config() failure short-circuits the
 *      "happy path" cleanup → ROLLBACK would never run inline.
 *   2. A Postgres error inside a transaction puts it in the "aborted"
 *      state; releasing such a client back to the pool poisons the
 *      next borrower (every subsequent query returns
 *      `current transaction is aborted, commands ignored`).
 *
 * By placing ROLLBACK in `finally` (with its own swallowed-error guard
 * so an already-aborted txn doesn't mask the original failure), the
 * pooled client is guaranteed to come back idle.
 */
async function runRlsRejectAttempt(
  pool: import("pg").Pool,
  work: (client: import("pg").PoolClient) => Promise<void>,
): Promise<(Error & { code?: string }) | null> {
  const client = await pool.connect();
  let captured: (Error & { code?: string }) | null = null;
  try {
    await client.query("BEGIN");
    try {
      await work(client);
    } catch (err) {
      captured = err as Error & { code?: string };
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The transaction is already aborted from the captured failure,
        // and Postgres tolerates ROLLBACK in that state — but if the
        // connection itself died, swallow it. The captured `pgErr` is
        // the original cause we want to surface.
      }
    }
  } finally {
    client.release();
  }
  return captured;
}
