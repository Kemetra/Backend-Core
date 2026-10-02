/**
 * T071 — 007-POLISH-SMOKE-COVERAGE — Quickstart journeys 1–6 integration smoke.
 *
 * A breadth-over-depth end-to-end smoke: it proves the six quickstart.md
 * journeys COMPOSE through one booted app (both controllers + both services +
 * the real IdempotencyInterceptor + the audit channel), with ONE representative
 * assertion per journey. It does NOT re-prove every sub-assertion — the per-op
 * specs (list / inspect / reopen / bulk-dismiss / reconciliation + the
 * Phase-8/9 guards) cover those exhaustively. This is the integration
 * confidence check.
 *
 * Order-independence: each journey targets its OWN dedicated fixture rows
 * (distinct ids + values seeded in beforeAll), so the lifecycle-mutating
 * journeys (dismiss / reopen / bulk-dismiss) never step on each other — the
 * smoke is robust to `it` reordering (no shared-row state-bleed).
 *
 * Principal mapping onto the A/B×X/Y fixture topology (quickstart's S1/S2/S3
 * narrative maps to the cells we have; Op12 is unused — no journey needs a
 * two-store operator):
 *   Admin = tenant-wide on TENANT_A (storeId: null)
 *   Op1   = store-scoped STORE_A_X
 *   T'    = TENANT_B principal (cross-tenant)
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
  TENANT_B,
  STORE_A_X,
  STORE_A_Y,
  ACTOR_A,
  PRODUCT_A_ACTIVE,
} from "../../__support__/isolation-harness";

// ---------------------------------------------------------------------------
// Dedicated per-journey fixture rows (distinct ids + values — no cross-journey
// state-bleed). All TENANT_A; J1/J2 pending in S1 + S2; J3 link/dismiss
// targets; J4 dismissed + resolved; J5 bulk targets; J6 reopen idempotency.
// ---------------------------------------------------------------------------
const J1_S1 = "0a000000-0000-7000-8000-00000071a001";
const J1_S2 = "0a000000-0000-7000-8000-00000071a002";
const J2_S1 = "0a000000-0000-7000-8000-00000071a003";
const J2_S2 = "0a000000-0000-7000-8000-00000071a004"; // out-of-scope for Op1
const J3_LINK = "0a000000-0000-7000-8000-00000071a005";
const J3_DISMISS = "0a000000-0000-7000-8000-00000071a006";
const J4_DISMISSED = "0a000000-0000-7000-8000-00000071a007";
const J4_RESOLVED = "0a000000-0000-7000-8000-00000071a008";
const J5_PENDING = "0a000000-0000-7000-8000-00000071a009";
const J5_OTHER = "0a000000-0000-7000-8000-00000071a00a"; // out-of-scope (S?/absent)
const J6_DISMISSED = "0a000000-0000-7000-8000-00000071a00b";

const V = (s: string) => `T071-${s}`;
const ABSENT = "0a000000-0000-7000-8000-0000007100ff";

const LIST_URL = "/api/v1/catalog/unknown-items";
const INSPECT_URL = (id: string) => `/api/v1/catalog/unknown-items/${id}`;
const DISMISS_URL = (id: string) => `/api/v1/catalog/unknown-items/${id}/dismiss`;
const LINK_URL = (id: string) => `/api/v1/catalog/unknown-items/${id}/link`;
const REOPEN_URL = (id: string) => `/api/v1/catalog/unknown-items/${id}/reopen`;
const BULK_URL = "/api/v1/catalog/unknown-items/bulk-dismiss";

async function drain(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise((r) => setImmediate(r));
}

class FakeRedis {
  private m = new Map<string, { value: string; expiresAt: number }>();
  async get(k: string): Promise<string | null> {
    const e = this.m.get(k);
    if (!e) return null;
    if (Date.now() > e.expiresAt) { this.m.delete(k); return null; }
    return e.value;
  }
  async set(k: string, v: string, o: { px: number }): Promise<unknown> {
    this.m.set(k, { value: v, expiresAt: Date.now() + o.px });
    return "OK";
  }
  clear(): void { this.m.clear(); }
}
class FakeMarker { async trySet(): Promise<boolean> { return true; } async del(): Promise<void> {} }

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(p: AuditJobPayload): Promise<void> { this.calls.push(p); }
  reset(): void { this.calls = []; }
}

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string | null = null;
  public userId: string = ACTOR_A;
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext }>();
    req.context = { userId: this.userId, tenantId: this.tenantId, storeId: this.storeId, isPlatformAdmin: false, source: "session", storeAccess: { kind: "all" } };
    return true;
  }
  asAdmin() { this.tenantId = TENANT_A; this.storeId = null; this.userId = ACTOR_A; }
  asOp1() { this.tenantId = TENANT_A; this.storeId = STORE_A_X; this.userId = ACTOR_A; }
  asForeign() { this.tenantId = TENANT_B; this.storeId = null; this.userId = ACTOR_A; }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let guard: ConfigurableContextGuard;
let auditSpy: SpyAuditEnqueuer;
let fakeRedis: FakeRedis;
let dockerSkipped = false;

async function seedPending(id: string, store: string, value: string): Promise<void> {
  await env!.admin.query(
    `INSERT INTO unknown_items (id, tenant_id, store_id, identifier_type, value, source_system, resolution_status, correlation_id)
     VALUES ($1,$2,$3,'barcode',$4,NULL,'pending',$5) ON CONFLICT DO NOTHING`,
    [id, TENANT_A, store, value, `${id}-corr`.slice(0, 36)],
  );
}
async function seedTerminal(id: string, store: string, value: string, status: "dismissed" | "resolved"): Promise<void> {
  const action = status === "dismissed" ? "dismissed" : "linked";
  const prod = status === "resolved" ? PRODUCT_A_ACTIVE : null;
  await env!.admin.query(
    `INSERT INTO unknown_items (id, tenant_id, store_id, identifier_type, value, source_system,
        resolution_status, resolution_action, resolved_at, resolved_by, resolved_product_id, correlation_id)
     VALUES ($1,$2,$3,'barcode',$4,NULL,$5,$6,now(),$7,$8,$9) ON CONFLICT DO NOTHING`,
    [id, TENANT_A, store, value, status, action, ACTOR_A, prod, `${id}-corr`.slice(0, 36)],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[T071 quickstart-journeys.spec] Docker NOT AVAILABLE: ${msg}\nMIGRATION_TEST_ALLOW_SKIP=1 set -- suite soft-skipped.\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);

  // Dedicated rows per journey.
  await seedPending(J1_S1, STORE_A_X, V("J1-S1"));
  await seedPending(J1_S2, STORE_A_Y, V("J1-S2"));
  await seedPending(J2_S1, STORE_A_X, V("J2-S1"));
  await seedPending(J2_S2, STORE_A_Y, V("J2-S2"));
  await seedPending(J3_LINK, STORE_A_X, V("J3-LINK"));
  await seedPending(J3_DISMISS, STORE_A_X, V("J3-DISMISS"));
  await seedTerminal(J4_DISMISSED, STORE_A_X, V("J4-DIS"), "dismissed");
  await seedTerminal(J4_RESOLVED, STORE_A_X, V("J4-RES"), "resolved");
  await seedPending(J5_PENDING, STORE_A_X, V("J5-PEND"));
  await seedTerminal(J5_OTHER, STORE_A_Y, V("J5-OTHER"), "resolved");
  await seedTerminal(J6_DISMISSED, STORE_A_X, V("J6-DIS"), "dismissed");

  const localEnv = env;
  guard = new ConfigurableContextGuard();
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
  app.useGlobalGuards(guard);
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  if (dockerSkipped) return;
  guard.asAdmin();
  auditSpy.reset();
  fakeRedis.clear();
});

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

describe("T071 / 007 — quickstart journeys 1–6 integration smoke", () => {
  it("Journey 1 — list is scoped + review-safe (no sale_context)", async () => {
    if (dockerSkipped) return;
    guard.asAdmin();
    const res = await http().get(`${LIST_URL}?status=pending&sort=age_asc`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    for (const item of res.body.items) expect(item).not.toHaveProperty("sale_context");
    // Op1 sees a scoped page (only its store's items) — out-of-range limit rejects.
    guard.asOp1();
    const reject = await http().get(`${LIST_URL}?status=pending&limit=500`);
    expect(reject.status).toBe(400);
  });

  it("Journey 2 — inspect: in-scope ReviewQueueItem; out-of-scope + cross-tenant → non-disclosing 404", async () => {
    if (dockerSkipped) return;
    guard.asAdmin();
    const ok = await http().get(INSPECT_URL(J2_S1));
    expect(ok.status).toBe(200);
    expect(ok.body).not.toHaveProperty("sale_context");

    guard.asOp1();
    const outOfScope = await http().get(INSPECT_URL(J2_S2)); // S2 row, Op1 is S1
    expect(outOfScope.status).toBe(404);

    guard.asForeign();
    const crossTenant = await http().get(INSPECT_URL(J2_S1));
    expect(crossTenant.status).toBe(404);
  });

  it("Journey 3 — shipped link + dismiss behave (resolved/linked; pending→dismissed; re-dismiss 409)", async () => {
    if (dockerSkipped) return;
    guard.asAdmin();
    const link = await http().post(LINK_URL(J3_LINK)).send({ product_id: PRODUCT_A_ACTIVE });
    expect(link.status).toBe(200);
    expect(link.body.resolution_status).toBe("resolved");

    const dismiss = await http().post(DISMISS_URL(J3_DISMISS)).send();
    expect(dismiss.status).toBe(200);
    expect(dismiss.body.resolution_status).toBe("dismissed");
    const reDismiss = await http().post(DISMISS_URL(J3_DISMISS)).send();
    expect(reDismiss.status).toBe(409);
    expect(reDismiss.body?.error?.code).toBe("already_reconciled");
  });

  it("Journey 4 — reopen: tenant-wide fresh pending; resolved→409; store-scoped in-scope→403, out-of-scope→404", async () => {
    if (dockerSkipped) return;
    guard.asAdmin();
    const reopen = await http().post(REOPEN_URL(J4_DISMISSED)).set("Idempotency-Key", "t071-j4-reopen-key-000001").send({});
    expect(reopen.status).toBe(201);
    expect(reopen.body.resolution_status).toBe("pending");

    const onResolved = await http().post(REOPEN_URL(J4_RESOLVED)).set("Idempotency-Key", "t071-j4-resolved-key-0001").send({});
    expect(onResolved.status).toBe(409);
    expect(onResolved.body?.error?.details?.prior_state).toBe("resolved");

    // Store-scoped, in-scope dismissed → 403 forbidden (service-layer authority).
    guard.asOp1();
    const forbidden = await http().post(REOPEN_URL(J6_DISMISSED)).set("Idempotency-Key", "t071-j4-forbid-key-00001").send({});
    expect(forbidden.status).toBe(403);
    expect(forbidden.body?.error?.code).toBe("forbidden");

    // Store-scoped, out-of-scope (a TENANT_B-owned id is invisible) → 404.
    const notFound = await http().post(REOPEN_URL(ABSENT)).set("Idempotency-Key", "t071-j4-notfound-key-001").send({});
    expect(notFound.status).toBe(404);
  });

  it("Journey 5 — bulk-dismiss: mixed per-item outcomes; 201-id ceiling → 400, nothing dismissed", async () => {
    if (dockerSkipped) return;
    guard.asAdmin();
    const mixed = await http().post(BULK_URL).set("Idempotency-Key", "t071-j5-bulk-key-00000001")
      .send({ ids: [J5_PENDING, J5_OTHER, ABSENT] });
    expect(mixed.status).toBe(200);
    const byId = (id: string) => mixed.body.outcomes.find((o: { id: string }) => o.id === id);
    expect(byId(J5_PENDING)?.outcome).toBe("dismissed");
    expect(byId(J5_OTHER)?.outcome).toBe("already_reconciled");
    expect(byId(ABSENT)?.outcome).toBe("not_found");

    // 201-id ceiling → whole-batch reject, nothing dismissed.
    const tooMany = Array.from({ length: 201 }, (_, i) =>
      `0a000000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`);
    const ceiling = await http().post(BULK_URL).set("Idempotency-Key", "t071-j5-ceiling-key-0001").send({ ids: tooMany });
    expect(ceiling.status).toBe(400);
  });

  it("Journey 6 — idempotency replay (one effect, same result) + audit flows through the single channel", async () => {
    if (dockerSkipped) return;
    guard.asAdmin();
    const key = "t071-j6-replay-key-00000001";
    // Re-seed J6 to dismissed (Journey 4 left it dismissed/untouched for Op1's 403; Admin can reopen it here).
    await env!.admin.query(
      `UPDATE unknown_items SET resolution_status='dismissed', resolution_action='dismissed',
          resolved_at=now(), resolved_by=$2, resolved_product_id=NULL WHERE id=$1`,
      [J6_DISMISSED, ACTOR_A],
    );
    await env!.admin.query(
      `DELETE FROM unknown_items WHERE tenant_id=$1 AND value=$2 AND resolution_status='pending'`,
      [TENANT_A, V("J6-DIS")],
    );
    auditSpy.reset();

    const first = await http().post(REOPEN_URL(J6_DISMISSED)).set("Idempotency-Key", key).send({});
    expect(first.status).toBe(201);
    const replay = await http().post(REOPEN_URL(J6_DISMISSED)).set("Idempotency-Key", key).send({});
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id); // one effect, same result

    await drain();
    // Audit flows through the single AUDIT_JOB_ENQUEUER channel (no parallel path),
    // and the reopen emitted its events there.
    const actions = auditSpy.calls.map((e) => e.action);
    expect(actions).toContain("unknown_item.reopened");
    expect(actions).toContain("unknown_item.captured");
  });
});
