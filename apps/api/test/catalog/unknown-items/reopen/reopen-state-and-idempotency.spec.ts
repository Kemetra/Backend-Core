/**
 * T052 — 007-US7-REOPEN — Reopen state guards + idempotency.
 *
 * Spec anchors: FR-043 (reopen-on-resolved → 409 already_reconciled +
 * details.prior_state; reopen when a pending sibling already exists →
 * already-pending, NO duplicate), FR-063 / SC-005 (Idempotency-Key:
 * same key + body replay → one fresh row + same response; changed body →
 * idempotency_key_conflict / 409).
 *
 * Route under test: POST /api/v1/catalog/unknown-items/:id/reopen
 * operationId: tenantAdminReopenUnknownItem
 *
 * Wiring: full integration module with the REAL IdempotencyInterceptor
 * (FakeRedis + FakeMarker + a stubbed IdempotencyKeyStore, no real Redis —
 * mirrors retry-identical.spec exactly) so the idempotency-key replay path is
 * exercised end-to-end. Tenant-wide actor (ctx.storeId === null) so the
 * authority gate passes and we test the state machine, not the 403 split
 * (covered by reopen-authority.spec).
 *
 * Docker: Testcontainers Postgres 16. Honors MIGRATION_TEST_ALLOW_SKIP=1.
 *
 * Pending-sibling design note (verified against 0007_catalog.sql):
 *   idx_unknown_items_lookup_value is a NON-UNIQUE partial index
 *   (WHERE resolution_status='pending'), so a duplicate pending INSERT does
 *   NOT raise 23505 — the at-most-one-pending-per-tuple invariant is an
 *   APPLICATION contract (005 FR-032 natural dedup). Reopen MUST therefore
 *   check for an existing pending sibling BEFORE inserting; otherwise it
 *   silently creates a SECOND pending row. (b) asserts exactly one.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { AuditEmitterInterceptor } from "../../../../src/audit/audit-emitter.interceptor";
import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../../../src/idempotency/idempotency.interceptor";
import {
  INFLIGHT_REDIS,
  InProgressMarker,
} from "../../../../src/idempotency/in-progress-marker";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import { PG_POOL } from "../../../../src/auth/auth.module";
import type { ResolvedContext } from "../../../../src/context/types";
import { ReconciliationController } from "../../../../src/catalog/reconciliation/reconciliation.controller";
import { ReconciliationService } from "../../../../src/catalog/reconciliation/reconciliation.service";

import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";

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
  ACTOR_A,
} from "../../__support__/isolation-harness";
import {
  seedUnknownItemsFixture,
  UNK_007_A_X_DISMISSED,
  UNK_007_A_X_RESOLVED,
  UNK_007_VAL_A_X_DISMISSED,
} from "../../__support__/seed-unknown-items";

const REOPEN_URL = (id: string) =>
  `/api/v1/catalog/unknown-items/${id}/reopen`;

// ---------------------------------------------------------------------------
// Fakes (mirror retry-identical.spec)
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
  async set(key: string, value: string, options: { px: number }): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + options.px });
    return "OK";
  }
  clear(): void {
    this.store.clear();
  }
}

class FakeMarker {
  async trySet(_tuple: string, _ttl?: number): Promise<boolean> {
    return true;
  }
  async del(_tuple: string): Promise<void> {
    /* no-op */
  }
}

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.calls.push(payload);
  }
  reset(): void {
    this.calls = [];
  }
}

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string | null = null; // tenant-wide actor — passes authority gate
  public userId: string = ACTOR_A;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: this.storeId,
      isPlatformAdmin: false,
      source: "session",
      storeAccess: { kind: "all" },
    };
    req.principal = { userId: this.userId };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let fakeRedis: FakeRedis;
let contextGuard: ConfigurableContextGuard;
let auditSpy: SpyAuditEnqueuer;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T052 reopen-state-and-idempotency.spec] Docker NOT AVAILABLE: ${msg}\n` +
          `MIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);
  await seedUnknownItemsFixture(env);

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();
  auditSpy = new SpyAuditEnqueuer();
  fakeRedis = new FakeRedis();
  const fakeMarker = new FakeMarker();

  // In-memory IdempotencyKeyStore — replay short-circuit is served from
  // fakeRedis; pgReader/pgWriter are no-op stubs (mirrors retry-identical.spec).
  const idempStore = new IdempotencyKeyStore({
    redis: fakeRedis,
    pgWriter: { async insert() {} },
    pgReader: {
      async find() {
        return null;
      },
    },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });

  const reflector = new Reflector();
  const auditInterceptor = new AuditEmitterInterceptor(reflector, auditSpy);
  const idempInterceptor = new IdempotencyInterceptor(
    reflector,
    idempStore,
    fakeMarker as unknown as InProgressMarker,
  );

  const moduleRef = await Test.createTestingModule({
    controllers: [ReconciliationController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ReconciliationService,
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
      { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      // Idempotency interceptor runs FIRST (registered before audit) so the
      // replay short-circuit precedes the audit emission, matching production
      // APP_INTERCEPTOR ordering.
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
      { provide: APP_INTERCEPTOR, useValue: auditInterceptor },
    ],
  })
    .overrideGuard(DashboardAuthGuard).useValue({ canActivate: () => true })
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

beforeEach(async () => {
  if (dockerSkipped || !env) return;
  auditSpy.reset();
  fakeRedis.clear();
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = null;
  contextGuard.userId = ACTOR_A;

  // Restore the dismissed fixture row and remove any fresh pending sibling.
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status   = 'dismissed',
            resolution_action   = 'dismissed',
            resolved_at         = now(),
            resolved_by         = $2,
            resolved_product_id = NULL
      WHERE id = $1`,
    [UNK_007_A_X_DISMISSED, ACTOR_A],
  );
  await env.admin.query(
    `DELETE FROM unknown_items
      WHERE tenant_id = $1
        AND value     = $2
        AND resolution_status = 'pending'`,
    [TENANT_A, UNK_007_VAL_A_X_DISMISSED],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

describe("T052 / 007-US7-REOPEN — state guards + idempotency [FR-043, FR-063, SC-005]", () => {
  it("(a) reopen on a RESOLVED item → 409 already_reconciled + details.prior_state", async () => {
    if (dockerSkipped) return;

    const res = await http()
      .post(REOPEN_URL(UNK_007_A_X_RESOLVED))
      .set("Idempotency-Key", "reopen-t052-resolved-key-00001")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body?.error?.code).toBe("already_reconciled");
    expect(res.body?.error?.details?.prior_state).toBe("resolved");
  });

  it("(b) reopen when a PENDING sibling already exists → no duplicate (already-pending)", async () => {
    if (dockerSkipped) return;

    // Pre-seed a pending sibling for the dismissed row's tuple (simulating a
    // re-capture between the dismiss and the reopen). Reopen must NOT create a
    // second pending row.
    await env!.admin.query(
      `INSERT INTO unknown_items
         (id, tenant_id, store_id, identifier_type, value,
          source_system, resolution_status, correlation_id)
       VALUES ($1, $2, $3, 'barcode', $4, NULL, 'pending', $5)`,
      [
        "0a000000-0000-7000-8000-00000005d6f1",
        TENANT_A,
        STORE_A_X,
        UNK_007_VAL_A_X_DISMISSED,
        "0a000000-0000-7000-8000-00000005c6f1",
      ],
    );

    auditSpy.reset();
    const res = await http()
      .post(REOPEN_URL(UNK_007_A_X_DISMISSED))
      .set("Idempotency-Key", "reopen-t052-sibling-key-000001")
      .send({});

    // Reuse path: an existing pending sibling is returned, NO new row. Per the
    // 200-vs-201 contract (CodeRabbit #408 F3), a reuse no-op is 200 OK
    // (createdFresh=false), distinct from the 201 fresh-insert path.
    expect(res.status).toBe(200);

    const pending = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM unknown_items
        WHERE tenant_id = $1 AND value = $2 AND resolution_status = 'pending'`,
      [TENANT_A, UNK_007_VAL_A_X_DISMISSED],
    );
    expect(pending.rows[0]?.count).toBe("1");

    // CodeRabbit #408 F2: a reuse changes no state → emit NO audit events
    // (neither a phantom fresh-capture nor a reopened action). This assertion
    // LOCKS that decision so the T070 audit-sweep can't silently disagree.
    await new Promise((resolve) => setImmediate(resolve));
    expect(auditSpy.calls).toHaveLength(0);
  });

  it("(c) same Idempotency-Key + body replay → one fresh row, same response", async () => {
    if (dockerSkipped) return;

    const key = "reopen-t052-replay-key-0000001";
    const first = await http()
      .post(REOPEN_URL(UNK_007_A_X_DISMISSED))
      .set("Idempotency-Key", key)
      .send({});
    expect(first.status).toBe(201);

    const replay = await http()
      .post(REOPEN_URL(UNK_007_A_X_DISMISSED))
      .set("Idempotency-Key", key)
      .send({});
    // Replay returns the prior response (interceptor short-circuit).
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);

    // Exactly one fresh pending row — replay did NOT create a second.
    const pending = await env!.admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM unknown_items
        WHERE tenant_id = $1 AND value = $2 AND resolution_status = 'pending'`,
      [TENANT_A, UNK_007_VAL_A_X_DISMISSED],
    );
    expect(pending.rows[0]?.count).toBe("1");
  });

  it("(d) same Idempotency-Key + CHANGED body → idempotency_key_conflict (409)", async () => {
    if (dockerSkipped) return;

    const key = "reopen-t052-conflict-key-000001";
    const first = await http()
      .post(REOPEN_URL(UNK_007_A_X_DISMISSED))
      .set("Idempotency-Key", key)
      .send({});
    expect(first.status).toBe(201);

    // Same key, different body → mismatch → idempotency_key_conflict.
    const conflict = await http()
      .post(REOPEN_URL(UNK_007_A_X_DISMISSED))
      .set("Idempotency-Key", key)
      .send({ unexpected: "changed-body" });

    expect(conflict.status).toBe(409);
    expect(conflict.body?.error?.code).toBe("idempotency_key_conflict");
  });
});
