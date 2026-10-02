/**
 * T055 — 007-US8-BULK-DISMISS — Bulk-dismiss whole-batch ceiling (RED→GREEN).
 *
 * Spec anchors: FR-044 (≤200 ids; > 200 → whole-batch reject, NOTHING
 * dismissed), FR-070 (no force/override), SC-008 (the ceiling is a reject,
 * not a clamp/truncate).
 *
 * Route under test: POST /api/v1/catalog/unknown-items/bulk-dismiss
 * operationId: tenantAdminBulkDismissUnknownItems (007 contract, v1.2.0-draft)
 *
 * The decisive FR-044 invariant: a batch of 201 ids is rejected WHOLE with
 * 400 validation — the request never partially applies. A clamp/truncate (e.g.
 * dismiss the first 200) is a stop condition. The maxItems:200 bound is
 * enforced at the Zod boundary (BulkDismissUnknownItemsRequest), so the service
 * is never even reached.
 *
 * Sub-cases:
 *   (a) 201 ids → 400 validation, and NO unknown_items row transitions to
 *       dismissed (nothing applied).
 *   (b) exactly 200 ids is accepted at the boundary (boundary is inclusive) —
 *       proves the reject is strictly > 200, not >= 200.
 *
 * Harness: mirrors reopen specs; tenant-wide actor. Docker: Testcontainers
 * Postgres 16. Honors MIGRATION_TEST_ALLOW_SKIP=1.
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
import { UnknownItemsController } from "../../../../src/catalog/unknown-items/unknown-items.controller";
import { UnknownItemsService } from "../../../../src/catalog/unknown-items/unknown-items.service";

import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PosOperatorAuthGuard } from "../../../../src/auth/pos-operator-auth.guard";
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
  UNK_005_A_X_BARCODE,
} from "../../__support__/seed-unknown-items";

const BULK_DISMISS_URL = "/api/v1/catalog/unknown-items/bulk-dismiss";

// A deterministic batch of UUIDv7-shaped ids (all distinct). They need not
// exist — the ceiling reject happens at the Zod boundary before any DB read.
function fakeIds(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const hex = i.toString(16).padStart(11, "0");
    ids.push(`0a000000-0000-7000-8000-${hex.slice(0, 12).padStart(12, "0")}`);
  }
  return ids;
}

class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return e.value;
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
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {
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
  public storeId: string | null = null;
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
        `\n[T055 bulk-ceiling.spec] Docker NOT AVAILABLE: ${msg}\n` +
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
    controllers: [UnknownItemsController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      UnknownItemsService,
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
      { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: idempInterceptor },
      { provide: APP_INTERCEPTOR, useValue: auditInterceptor },
    ],
  })
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

beforeEach(async () => {
  if (dockerSkipped || !env) return;
  auditSpy.reset();
  fakeRedis.clear();
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = null;
  contextGuard.userId = ACTOR_A;

  // Ensure the in-scope pending fixture row is pending (a rejected batch must
  // not have dismissed it).
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status = 'pending', resolution_action = NULL,
            resolved_at = NULL, resolved_by = NULL, resolved_product_id = NULL
      WHERE id = $1`,
    [UNK_005_A_X_BARCODE],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

describe("T055 / 007-US8-BULK-DISMISS — whole-batch ceiling [FR-044, FR-070, SC-008]", () => {
  it("(a) 201 ids → 400 validation, NOTHING dismissed (reject-whole, not clamp)", async () => {
    if (dockerSkipped) return;

    // Include a real in-scope pending id in the batch so we can prove it was
    // NOT dismissed despite being a valid dismiss target — the batch is
    // rejected whole BEFORE any item is processed.
    const ids = fakeIds(200);
    ids.push(UNK_005_A_X_BARCODE); // 201 total

    const res = await http()
      .post(BULK_DISMISS_URL)
      .set("Idempotency-Key", "bulk-t055-ceiling-key-0000001")
      .send({ ids });

    expect(res.status).toBe(400);
    // Runtime wire code for a Zod validation failure is `validation_error`
    // (ErrorCodes.VALIDATION) — the OpenAPI prose says `validation`, a
    // documented contract/runtime drift (see reconciliation.controller.ts
    // header). The behavior (400 + nothing dismissed) is the FR-044 invariant.
    expect(res.body?.error?.code).toBe("validation_error");

    // Nothing applied — the real pending id is still pending.
    const row = await env!.admin.query<{ resolution_status: string }>(
      `SELECT resolution_status FROM unknown_items WHERE id = $1`,
      [UNK_005_A_X_BARCODE],
    );
    expect(row.rows[0]?.resolution_status).toBe("pending");
  });

  it("(b) exactly 200 ids is accepted at the boundary (reject is strictly > 200)", async () => {
    if (dockerSkipped) return;

    // 200 fake ids — all resolve to per-item not_found (none exist), but the
    // batch itself is ACCEPTED (200 OK with outcomes), proving the ceiling is
    // > 200 (exclusive), not >= 200.
    const ids = fakeIds(200);

    const res = await http()
      .post(BULK_DISMISS_URL)
      .set("Idempotency-Key", "bulk-t055-boundary-key-000001")
      .send({ ids });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body?.outcomes)).toBe(true);
    expect(res.body.outcomes).toHaveLength(200);
  });
});
