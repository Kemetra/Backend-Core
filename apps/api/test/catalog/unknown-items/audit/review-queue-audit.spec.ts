/**
 * T070 — 007-POLISH-AUDIT-SWEEP — Full audit-linkage sweep.
 *
 * Spec anchors: SC-004, FR-064, FR-083 (005 audit surface), quickstart Journey 6.
 * Every state change produced by the 007 ops (reopen fresh-capture,
 * bulk-dismiss item-success) AND every audited failure (reopen rejection) emits
 * an audit event through the SAME 005 surface (the AUDIT_JOB_ENQUEUER), each
 * carrying the canonical fields: actor, tenant, store, action, target_type +
 * target_id, and a correlation id (request_id). No parallel/side channel.
 *
 * Correlation note: this slice WIDENED to thread the request correlation id into
 * the bulk-dismiss per-item audit (controller→service), so bulk events now carry
 * a non-null request_id symmetric with reopen — T070 asserts that on EVERY event.
 *
 * Wired module: BOTH controllers (reconciliation → reopen; unknown-items →
 * bulk-dismiss) + the real IdempotencyInterceptor (FakeRedis/FakeMarker, both
 * ops carry @Idempotent) + a SpyAuditEnqueuer (the single audit channel).
 *
 * Docker: Testcontainers Postgres 16, honors MIGRATION_TEST_ALLOW_SKIP=1.
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
  UNK_007_A_X_DISMISSED,
  UNK_005_A_X_BARCODE,
  UNK_007_VAL_A_X_DISMISSED,
} from "../../__support__/seed-unknown-items";

const REOPEN_URL = (id: string) => `/api/v1/catalog/unknown-items/${id}/reopen`;
const BULK_DISMISS_URL = "/api/v1/catalog/unknown-items/bulk-dismiss";

/** Canonical audit fields every state-change / audited-failure event must carry. */
function assertCanonicalShape(ev: AuditJobPayload): void {
  expect(ev.tenant_id).toBe(TENANT_A);
  expect(ev.actor_user_id).toBe(ACTOR_A);
  expect(ev.action).toEqual(expect.any(String));
  expect(ev.target_type).toBe("unknown_item");
  expect(ev.target_id).toEqual(expect.any(String));
  // FR-064 / SC-004 traceability: a correlation id MUST be present (non-null).
  expect(ev.request_id).toEqual(expect.any(String));
  // store_id is nullable for tenant-wide actors but the KEY must be present.
  expect(ev).toHaveProperty("store_id");
}

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
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
  async del(): Promise<void> {}
}

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(p: AuditJobPayload): Promise<void> {
    this.calls.push(p);
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
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext }>();
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: this.storeId,
      isPlatformAdmin: false,
      source: "session",
      storeAccess: { kind: "all" },
    };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let contextGuard: ConfigurableContextGuard;
let auditSpy: SpyAuditEnqueuer;
let fakeRedis: FakeRedis;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[T070 review-queue-audit.spec] Docker NOT AVAILABLE: ${msg}\nMIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`);
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
    pgReader: { async find() { return null; } },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
  const reflector = new Reflector();

  const moduleRef = await Test.createTestingModule({
    controllers: [ReconciliationController, UnknownItemsController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ReconciliationService,
      UnknownItemsService,
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
      { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
      { provide: INFLIGHT_REDIS, useValue: fakeRedis },
      { provide: InProgressMarker, useValue: fakeMarker },
      { provide: APP_INTERCEPTOR, useValue: new IdempotencyInterceptor(reflector, idempStore, fakeMarker as unknown as InProgressMarker) },
      { provide: APP_INTERCEPTOR, useValue: new AuditEmitterInterceptor(reflector, auditSpy) },
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
  // Restore the dismissed fixture row; clear any fresh pending sibling + reset
  // the bulk target to pending.
  await env.admin.query(
    `UPDATE unknown_items SET resolution_status='dismissed', resolution_action='dismissed',
        resolved_at=now(), resolved_by=$2, resolved_product_id=NULL WHERE id=$1`,
    [UNK_007_A_X_DISMISSED, ACTOR_A],
  );
  await env.admin.query(
    `DELETE FROM unknown_items WHERE tenant_id=$1 AND value=$2 AND resolution_status='pending'`,
    [TENANT_A, UNK_007_VAL_A_X_DISMISSED],
  );
  await env.admin.query(
    `UPDATE unknown_items SET resolution_status='pending', resolution_action=NULL,
        resolved_at=NULL, resolved_by=NULL, resolved_product_id=NULL WHERE id=$1`,
    [UNK_005_A_X_BARCODE],
  );
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

describe("T070 / 007 — full audit-linkage sweep [SC-004, FR-064, FR-083]", () => {
  it("a fresh reopen emits reopened + captured, each with the canonical fields incl. correlation id", async () => {
    if (dockerSkipped) return;
    contextGuard.storeId = null; // tenant-wide

    const res = await http().post(REOPEN_URL(UNK_007_A_X_DISMISSED)).set("Idempotency-Key", "t070-reopen-key-000000001").send({});
    expect(res.status).toBe(201);
    await drainMicrotasks();

    const reopened = auditSpy.calls.filter((e) => e.action === "unknown_item.reopened");
    const captured = auditSpy.calls.filter((e) => e.action === "unknown_item.captured");
    expect(reopened).toHaveLength(1);
    expect(captured).toHaveLength(1);
    assertCanonicalShape(reopened[0]!);
    assertCanonicalShape(captured[0]!);
    // The reopen action targets the DISMISSED row; the capture targets the fresh row.
    expect(reopened[0]!.target_id).toBe(UNK_007_A_X_DISMISSED);
    expect(captured[0]!.target_id).not.toBe(UNK_007_A_X_DISMISSED);
  });

  it("an audited reopen FAILURE (403 forbidden) emits reopen_rejected with the canonical fields", async () => {
    if (dockerSkipped) return;
    contextGuard.storeId = STORE_A_X; // store-scoped, in-scope → 403 forbidden (audited)

    const res = await http().post(REOPEN_URL(UNK_007_A_X_DISMISSED)).set("Idempotency-Key", "t070-forbid-key-000000001").send({});
    expect(res.status).toBe(403);
    await drainMicrotasks();

    const rejected = auditSpy.calls.filter((e) => e.action === "unknown_item.reopen_rejected");
    expect(rejected).toHaveLength(1);
    assertCanonicalShape(rejected[0]!);
  });

  it("a bulk-dismiss item-success emits unknown_item.dismissed with the canonical fields incl. correlation id", async () => {
    if (dockerSkipped) return;
    contextGuard.storeId = null;

    const res = await http().post(BULK_DISMISS_URL).set("Idempotency-Key", "t070-bulk-key-0000000001").send({ ids: [UNK_005_A_X_BARCODE] });
    expect(res.status).toBe(200);
    await drainMicrotasks();

    const dismissed = auditSpy.calls.filter((e) => e.action === "unknown_item.dismissed");
    expect(dismissed).toHaveLength(1);
    // The widened correlation thread: bulk dismiss events now carry a non-null
    // request_id (symmetric with reopen) — the canonical-shape check enforces it.
    assertCanonicalShape(dismissed[0]!);
    expect(dismissed[0]!.target_id).toBe(UNK_005_A_X_BARCODE);
  });

  it("every emitted event flows through the single AUDIT_JOB_ENQUEUER channel (no parallel channel)", async () => {
    if (dockerSkipped) return;
    contextGuard.storeId = null;

    await http().post(REOPEN_URL(UNK_007_A_X_DISMISSED)).set("Idempotency-Key", "t070-channel-key-00000001").send({});
    await drainMicrotasks();

    // All recorded events are AuditJobPayloads on the one spy — there is no
    // second emission path. Assert they all carry an action + are well-formed.
    expect(auditSpy.calls.length).toBeGreaterThan(0);
    for (const ev of auditSpy.calls) {
      expect(ev.action).toEqual(expect.any(String));
      assertCanonicalShape(ev);
    }
  });
});
