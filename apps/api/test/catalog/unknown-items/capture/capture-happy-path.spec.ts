/**
 * T510 — 005-WAVE1-CAPTURE-HAPPY — POS capture happy-path spec.
 *
 * Acceptance (slice 005-WAVE1-CAPTURE-HAPPY validation contract):
 *   GREEN — T510 acceptance criteria met:
 *     - POS submits unknown identifier → 201-class response
 *     - exactly one `unknown_items` row exists with:
 *         resolution_status = 'pending'
 *         tenant_id          = the POS principal's tenant
 *         store_id           = the POS principal's resolved store
 *         identifier_type / identifier_value match the submission
 *         resolved_at / resolved_by / resolution_action all NULL
 *     - response references the captured row by stable id
 *     - identical retry under the same `Idempotency-Key` returns the
 *       same body + 201, with `Idempotent-Replayed: true` on the second
 *       call (proves the existing `IdempotencyInterceptor` covers the
 *       new route without modification — FR-021)
 *     - `unknown_item_captured_total` is incremented exactly once across
 *       the original + replay (replay short-circuits before the handler)
 *
 * Wiring strategy:
 *   Mirrors `apps/api/test/catalog/unknown-items/idempotency/existing-primitive-coverage.spec.ts`
 *   (T505 / PR #306) — hand-rolled `Test.createTestingModule` with:
 *     - the real `UnknownItemsController`
 *     - the real `UnknownItemsService` injected with a Testcontainers
 *       pg.Pool (admin role — same posture as the 003 isolation harness)
 *     - the real `IdempotencyInterceptor` registered via APP_INTERCEPTOR
 *       (the decorator on the route is what we're proving still works)
 *     - the real `AuditEmitterInterceptor` registered via APP_INTERCEPTOR
 *       (passive on this slice — no deep audit assertion until T546)
 *     - a configurable context guard that publishes
 *       `req.context = { tenantId, storeId, userId, ... }` per request
 *     - FakeRedis + FakeMarker for the idempotency stack (no real Redis
 *       container — same Docker-light pattern as T505)
 *
 *   Importing the full `UnknownItemsModule` would transitively pull
 *   `AuthModule` + `AuditModule` (BullMQ queues, Drizzle repositories,
 *   etc.), neither of which the capture path actually exercises. The
 *   hand-rolled wiring keeps the spec scope tight to T510's behavior.
 *
 * Database fixture:
 *   `seedCatalogIsolationFixture(env)` from T340 creates the parent
 *   tenants/stores (TENANT_A / STORE_A_X / etc.). We submit an identifier
 *   value that's NOT in `seedUnknownItemsFixture` — proving the capture
 *   path creates a brand-new row, not a dedup hit.
 *
 * Docker:
 *   Testcontainers Postgres 16 is required for the integration `describe`.
 *   When `MIGRATION_TEST_ALLOW_SKIP=1` is set and Docker is unavailable,
 *   the integration suite is soft-skipped (repo-wide convention; mirrors
 *   `apps/api/test/catalog/unknown-items/isolation/cross-tenant.spec.ts`).
 *   The unit-level controller-guard `describe` below does NOT use
 *   Testcontainers and always runs.
 */
import "reflect-metadata";

import {
  Controller as _Controller,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../../../src/idempotency/idempotency.interceptor";
import {
  INFLIGHT_REDIS,
  InProgressMarker,
} from "../../../../src/idempotency/in-progress-marker";
import { UnknownItemsController } from "../../../../src/catalog/unknown-items/unknown-items.controller";
import { UnknownItemsService } from "../../../../src/catalog/unknown-items/unknown-items.service";
import { PG_POOL } from "../../../../src/auth/auth.module";
import type { ResolvedContext } from "../../../../src/context/types";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  TENANT_A,
  STORE_A_X,
} from "../../__support__/isolation-harness";

// ---------------------------------------------------------------------------
// Constants — fake POS-principal context
// ---------------------------------------------------------------------------

/** Stand-in POS device principal id (`req.context.userId`). */
const DEVICE_USER_ID = "0d000000-0000-7000-8000-0000000005d1";

/** 32-char ASCII idempotency key (passes the interceptor's regex). */
const IDEMP_KEY = "abcdef1234567890abcdef1234567890";

/** Identifier value used by the happy-path submission. Distinct from any
 * value seeded by `seed-unknown-items.ts` (which uses `T506-A-X-...`). */
const HAPPY_IDENTIFIER_VALUE = "HAPPY-PATH-NEW-001";

// ---------------------------------------------------------------------------
// In-memory FakeRedis — matches the RedisLike surface used by
// IdempotencyKeyStore (px-based set + get; the marker uses NX/EX but we
// stub the marker entirely below).
// ---------------------------------------------------------------------------

class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(
    key: string,
    value: string,
    options: { px: number },
  ): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + options.px });
    return "OK";
  }

  clear(): void {
    this.store.clear();
  }
}

// ---------------------------------------------------------------------------
// FakeMarker — always returns true (no in-progress contention is tested).
// ---------------------------------------------------------------------------

class FakeMarker {
  async trySet(_tuple: string, _ttl?: number): Promise<boolean> {
    return true;
  }
  async del(_tuple: string): Promise<void> {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// ConfigurableContextGuard — sets `req.context` to the POS principal shape.
// ---------------------------------------------------------------------------

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string = STORE_A_X;
  public userId: string = DEVICE_USER_ID;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
      requestId?: string;
    }>();
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: this.storeId,
      isPlatformAdmin: false,
      source: "token",
    };
    req.principal = { userId: this.userId };
    return true;
  }
}

// ---------------------------------------------------------------------------
// Metric capture — wraps `recordUnknownItemCaptured` so we can assert
// emission count without scraping Prometheus internals.
// ---------------------------------------------------------------------------

import * as apiMetrics from "../../../../src/observability/metrics/api.metrics";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PosOperatorAuthGuard } from "../../../../src/auth/pos-operator-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";

let captureCounter = 0;
let recordSpy: jest.SpyInstance;

// ---------------------------------------------------------------------------
// Suite-level state
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let fakeRedis: FakeRedis;
let contextGuard: ConfigurableContextGuard;
let dockerSkipped = false;

beforeAll(async () => {
  // Bring up Postgres + apply all migrations + seed parent rows.
  // Soft-skip when Docker is unavailable AND `MIGRATION_TEST_ALLOW_SKIP=1`
  // is set (repo-wide convention — mirrors cross-tenant.spec.ts).
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T510 capture-happy-path.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set — integration suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  const localEnv = env;
  fakeRedis = new FakeRedis();
  const fakeMarker = new FakeMarker();
  contextGuard = new ConfigurableContextGuard();

  const idempStore = new IdempotencyKeyStore({
    redis: fakeRedis,
    pgWriter: { async insert() {} },
    pgReader: { async find() { return null; } },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });

  const reflector = new Reflector();
  const idempInterceptor = new IdempotencyInterceptor(
    reflector,
    idempStore,
    fakeMarker as unknown as InProgressMarker,
  );

  const moduleRef = await Test.createTestingModule({
    controllers: [UnknownItemsController],
    providers: [
      // PG_POOL bound to app (non-superuser app_test role, RLS-active) —
      // this spec exercises the capture data path, so RLS policies must run
      // for real. Pattern set by link-happy-path.spec.ts:181-184 after PR #357.
      {
        provide: PG_POOL,
        useFactory: (): Pool => localEnv.app,
      },
      UnknownItemsService,
      { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
    ],
  })
    // Real DashboardAuthGuard + TenantContextGuard + RolesGuard are wired
    // method-level on LIST + dismiss as of the auth-guard wiring slice.
    // Even tests that only hit the POS capture route must override these
    // because NestJS resolves all controller-declared guards at compile time.
    // Override with no-op pass-throughs so the test harness compiles and
    // the global ConfigurableContextGuard's context survives to the handler.
    .overrideGuard(DashboardAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(PosOperatorAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard).useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(contextGuard);
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  if (dockerSkipped) return;
  fakeRedis.clear();
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = STORE_A_X;
  contextGuard.userId = DEVICE_USER_ID;
  captureCounter = 0;
  // Re-attach the spy each test (Jest's `restoreMocks: true` resets it).
  recordSpy = jest
    .spyOn(apiMetrics, "recordUnknownItemCaptured")
    .mockImplementation(() => {
      captureCounter += 1;
    });
});

afterEach(async () => {
  if (dockerSkipped) return;
  // Clean up only the rows this suite created (don't disturb the 003
  // isolation fixture). Identifier values are unique to this suite.
  if (env) {
    await env.admin.query(
      "DELETE FROM unknown_items WHERE value LIKE 'HAPPY-PATH-%'",
    );
  }
  recordSpy.mockRestore();
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

// ---------------------------------------------------------------------------
// T510 — POS captures an unknown item (happy path)
// ---------------------------------------------------------------------------

describe("T510 / 005-WAVE1-CAPTURE-HAPPY — POS captures an unknown item", () => {
  it("returns 201 with the contract's unknown-response shape and creates one pending row", async () => {
    if (dockerSkipped) return;
    const res = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send({
        identifier_type: "barcode",
        identifier_value: HAPPY_IDENTIFIER_VALUE,
      });

    expect(res.status).toBe(201);

    // Response shape: PosCaptureUnknownResponse discriminated union variant.
    expect(res.body).toMatchObject({
      kind: "unknown",
      unknown_item: {
        id: expect.any(String),
        tenant_id: TENANT_A,
        store_id: STORE_A_X,
        identifier_type: "barcode",
        identifier_value: HAPPY_IDENTIFIER_VALUE,
        source_system: null,
        resolution_status: "pending",
        resolution_action: null,
        resolved_at: null,
        resolved_by: null,
        resolved_product_id: null,
        encountered_at: expect.any(String),
      },
    });

    // Exactly one row exists for this tuple.
    expect(env).not.toBeNull();
    const rowCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1
          AND store_id  = $2
          AND identifier_type = 'barcode'
          AND value = $3`,
      [TENANT_A, STORE_A_X, HAPPY_IDENTIFIER_VALUE],
    );
    expect(rowCount.rows[0]?.count).toBe("1");

    // The row's column shape matches the response (resolution fields NULL).
    const row = await env!.admin.query<{
      id: string;
      tenant_id: string;
      store_id: string;
      identifier_type: string;
      value: string;
      source_system: string | null;
      resolution_status: string;
      resolution_action: string | null;
      resolved_at: Date | null;
      resolved_by: string | null;
      resolved_product_id: string | null;
      correlation_id: string;
    }>(
      `SELECT id, tenant_id, store_id, identifier_type, value, source_system,
              resolution_status, resolution_action, resolved_at, resolved_by,
              resolved_product_id, correlation_id
         FROM unknown_items
        WHERE id = $1`,
      [res.body.unknown_item.id],
    );
    const r = row.rows[0];
    expect(r).toBeDefined();
    expect(r!.tenant_id).toBe(TENANT_A);
    expect(r!.store_id).toBe(STORE_A_X);
    expect(r!.identifier_type).toBe("barcode");
    expect(r!.value).toBe(HAPPY_IDENTIFIER_VALUE);
    expect(r!.source_system).toBeNull();
    expect(r!.resolution_status).toBe("pending");
    expect(r!.resolution_action).toBeNull();
    expect(r!.resolved_at).toBeNull();
    expect(r!.resolved_by).toBeNull();
    expect(r!.resolved_product_id).toBeNull();
    // 003 NOT NULL — must be populated by the service.
    expect(typeof r!.correlation_id).toBe("string");
    expect(r!.correlation_id.length).toBeGreaterThan(0);

    // Counter incremented exactly once on the first capture.
    expect(captureCounter).toBe(1);

    // No tenant_products row was created (FR-001 — capture must never
    // silently mint a trusted catalog record).
    const productCount = await env!.admin.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM tenant_products WHERE tenant_id = $1",
      [TENANT_A],
    );
    // The isolation fixture seeds 2 products in tenant A (active + retired).
    // The post-capture count must remain at that baseline.
    expect(productCount.rows[0]?.count).toBe("2");
  });

  it("replays the original response on an identical retry with the same Idempotency-Key (FR-021 — proves IdempotencyInterceptor covers the route)", async () => {
    if (dockerSkipped) return;
    const body = {
      identifier_type: "barcode" as const,
      identifier_value: HAPPY_IDENTIFIER_VALUE,
    };

    const first = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send(body);
    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();

    // Allow the interceptor's fire-and-forget `store.save` tap to drain.
    // Mirrors T505's microtask-drain idiom.
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const second = await http()
      .post("/api/pos/v1/catalog/unknown-items")
      .set("Idempotency-Key", IDEMP_KEY)
      .send(body);

    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);

    // Only one row in the DB — the second call short-circuited in the
    // interceptor before the handler ran.
    expect(env).not.toBeNull();
    const rowCount = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM unknown_items
        WHERE tenant_id = $1
          AND store_id  = $2
          AND identifier_type = 'barcode'
          AND value = $3`,
      [TENANT_A, STORE_A_X, HAPPY_IDENTIFIER_VALUE],
    );
    expect(rowCount.rows[0]?.count).toBe("1");

    // Capture metric only incremented once (replay path doesn't invoke
    // the service).
    expect(captureCounter).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T512 — Controller defensive guards (unit-level, no Docker)
// ---------------------------------------------------------------------------
//
// The `posCaptureItem` handler in `UnknownItemsController` carries four
// defensive guards on `req.context` that the integration `describe` above
// never exercises (the configurable context guard always populates the
// shape). These unit tests cover each branch explicitly so the controller's
// branch coverage matches its assertion surface. The describe uses a
// minimal `Test.createTestingModule` with a mocked service — no Postgres,
// no Testcontainers, runs unconditionally (also under MIGRATION_TEST_ALLOW_SKIP=1).
//
// Each test mounts a guard that publishes a deliberately-malformed
// `req.context` and asserts the controller short-circuits with 401.
//
describe("T512 / UnknownItemsController — defensive context guards (unit)", () => {
  type MalformedContext = Partial<ResolvedContext> | null;

  class StaticContextGuard implements CanActivate {
    constructor(private readonly ctx: MalformedContext) {}
    canActivate(c: ExecutionContext): boolean {
      const req = c.switchToHttp().getRequest<{
        context?: MalformedContext | undefined;
        principal?: { userId?: string };
      }>();
      // null ⇒ omit `context` so the `if (!ctx)` branch fires.
      if (this.ctx === null) {
        req.context = undefined;
      } else {
        req.context = this.ctx as ResolvedContext;
      }
      req.principal = { userId: "device" };
      return true;
    }
  }

  async function bootWithCtx(ctx: MalformedContext): Promise<INestApplication> {
    const captureItem = jest.fn();
    const moduleRef = await Test.createTestingModule({
      controllers: [UnknownItemsController],
      providers: [
        { provide: UnknownItemsService, useValue: { captureItem } },
      ],
    })
    // Real DashboardAuthGuard + TenantContextGuard + RolesGuard are wired
    // method-level on LIST + dismiss as of the auth-guard wiring slice.
    // Even tests that only hit the POS capture route must override these
    // because NestJS resolves all controller-declared guards at compile time.
    // Override with no-op pass-throughs so the test harness compiles and
    // the global ConfigurableContextGuard's context survives to the handler.
    .overrideGuard(DashboardAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(PosOperatorAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard).useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
    .compile();
    const application = moduleRef.createNestApplication({ bufferLogs: true });
    application.useGlobalFilters(new GlobalExceptionFilter());
    application.useGlobalGuards(new StaticContextGuard(ctx));
    await application.init();
    return application;
  }

  const VALID_BODY = {
    identifier_type: "barcode" as const,
    identifier_value: "GUARD-TEST-001",
  };

  it("returns 401 when req.context is absent (no resolved POS principal)", async () => {
    const application = await bootWithCtx(null);
    try {
      const res = await request(application.getHttpServer())
        .post("/api/pos/v1/catalog/unknown-items")
        .set("Idempotency-Key", IDEMP_KEY)
        .send(VALID_BODY);
      expect(res.status).toBe(401);
    } finally {
      await application.close();
    }
  });

  it("returns 401 when ctx.tenantId is null", async () => {
    const application = await bootWithCtx({
      userId: DEVICE_USER_ID,
      tenantId: null,
      storeId: STORE_A_X,
      isPlatformAdmin: false,
      source: "token",
    });
    try {
      const res = await request(application.getHttpServer())
        .post("/api/pos/v1/catalog/unknown-items")
        .set("Idempotency-Key", IDEMP_KEY)
        .send(VALID_BODY);
      expect(res.status).toBe(401);
    } finally {
      await application.close();
    }
  });

  it("returns 401 when ctx.storeId is null (FR-011 — POS principal MUST resolve a store)", async () => {
    const application = await bootWithCtx({
      userId: DEVICE_USER_ID,
      tenantId: TENANT_A,
      storeId: null,
      isPlatformAdmin: false,
      source: "token",
    });
    try {
      const res = await request(application.getHttpServer())
        .post("/api/pos/v1/catalog/unknown-items")
        .set("Idempotency-Key", IDEMP_KEY)
        .send(VALID_BODY);
      expect(res.status).toBe(401);
    } finally {
      await application.close();
    }
  });

  it("returns 401 when ctx.userId is null", async () => {
    const application = await bootWithCtx({
      userId: null,
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      isPlatformAdmin: false,
      source: "token",
    });
    try {
      const res = await request(application.getHttpServer())
        .post("/api/pos/v1/catalog/unknown-items")
        .set("Idempotency-Key", IDEMP_KEY)
        .send(VALID_BODY);
      expect(res.status).toBe(401);
    } finally {
      await application.close();
    }
  });
});
