/**
 * 021 HTTP/controller integration (T017/T027/T035) — boots Nest + supertest over
 * the real routes, mirroring the 013/017 harness (ConfigurableContextGuard +
 * overridden production guards + RLS-active PG_POOL). Docker-gated (WSL).
 *
 * Covers the controller behaviours the direct-service tests cannot:
 *   - GET  /backlog                       → 200 page
 *   - POST /runs (triggerRun)             → 201 ProductReconciliationRun (running,
 *                                            erpnext_view_status=unavailable) + the
 *                                            outbox event is emitted in-tx
 *   - GET  /runs (listRuns)               → 200 includes the triggered run
 *   - GET  /runs/:id/results              → 200; foreign run → 404
 *   - POST /repairs (confirm)             → 201 outcome=mapped
 *   - POST /repairs (re-confirm)          → 200 outcome=no_op_echo + Idempotent-Replayed
 *   - POST /repairs (stale version)       → 409 { error.code: conflict }
 *   - POST /repairs (runId XOR resultId)  → 400 validation_error
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  type Provider,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import { runWithTenantContext } from "@data-pulse-2/db";

import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../../src/context/types";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../../../src/idempotency/idempotency.interceptor";
import {
  INFLIGHT_REDIS,
  InProgressMarker,
} from "../../../../src/idempotency/in-progress-marker";
import { ErpnextItemMapService } from "../../../../src/catalog/erpnext-item-map/erpnext-item-map.service";
import { ErpnextProductReconciliationController } from "../../../../src/catalog/erpnext-product-reconciliation/erpnext-product-reconciliation.controller";
import { ErpnextProductReconciliationService } from "../../../../src/catalog/erpnext-product-reconciliation/erpnext-product-reconciliation.service";

class FakeRedis {
  private readonly s = new Map<string, { value: string; expiresAt: number }>();
  async get(k: string): Promise<string | null> {
    const e = this.s.get(k);
    if (!e) return null;
    if (Date.now() > e.expiresAt) { this.s.delete(k); return null; }
    return e.value;
  }
  async set(k: string, v: string, o: { px: number }): Promise<unknown> {
    this.s.set(k, { value: v, expiresAt: Date.now() + o.px }); return "OK";
  }
}
class FakeMarker {
  async trySet(): Promise<boolean> { return true; }
  async del(): Promise<void> {}
}

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  ITEM_MAP_FIXTURE_IDS,
  seedItemMapFixture,
} from "../../erpnext-item-map/__support__/seed-item-map";

const TENANT_A = ITEM_MAP_FIXTURE_IDS.tenantA;
const ACTOR_A = ITEM_MAP_FIXTURE_IDS.actorA;
const PRODUCT_A_SUGGESTED = "0a000000-0000-7000-8000-00000d021841";
const MAP_A_SUGGESTED = "0a000000-0000-7000-8000-00000d021842";
const BASE = "/api/v1/catalog/erpnext-product-reconciliation";

class ConfigurableContextGuard implements CanActivate {
  public tenantId = TENANT_A;
  public userId = ACTOR_A;
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: null,
      isPlatformAdmin: false,
      source: "session",
    };
    req.principal = { userId: this.userId };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let skip = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[021 http.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  await seedItemMapFixture(env);
  await env.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'recon021-http@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR_A],
  );
  await env.admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $2, '021 HTTP Suggested', 'standard', $3, $3) ON CONFLICT DO NOTHING`,
    [PRODUCT_A_SUGGESTED, TENANT_A, ACTOR_A],
  );
  await env.admin.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, suggested_by, version)
     VALUES ($1, $2, $3, 'ERP-021-HTTP', 'suggested', 'manual', $4, 1)
     ON CONFLICT DO NOTHING`,
    [MAP_A_SUGGESTED, TENANT_A, PRODUCT_A_SUGGESTED, ACTOR_A],
  );

  const localEnv = env;
  const fakeRedis = new FakeRedis();
  const fakeMarker = new FakeMarker();
  const idempStore = new IdempotencyKeyStore({
    redis: fakeRedis,
    pgWriter: { async insert(): Promise<void> {} },
    pgReader: { async find(): Promise<null> { return null; } },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
  const providers: Provider[] = [
    { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
    ErpnextProductReconciliationService,
    ErpnextItemMapService,
    { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
    { provide: INFLIGHT_REDIS, useValue: fakeRedis },
    { provide: InProgressMarker, useValue: fakeMarker },
    {
      provide: APP_INTERCEPTOR,
      useValue: new IdempotencyInterceptor(new Reflector(), idempStore, fakeMarker as unknown as InProgressMarker),
    },
  ];
  const moduleRef = await Test.createTestingModule({
    controllers: [ErpnextProductReconciliationController],
    providers,
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(new ConfigurableContextGuard());
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function http() {
  if (!app) throw new Error("Docker unavailable");
  return request(app.getHttpServer());
}

describe("021 HTTP — backlog + run lifecycle", () => {
  it("GET /backlog → 200 page", async () => {
    if (skip) return;
    const res = await http().get(`${BASE}/backlog`).expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  let runId = "";

  it("POST /runs (triggerRun) → 201 running run + emits the outbox event in-tx", async () => {
    if (skip) return;
    const res = await http()
      .post(`${BASE}/runs`)
      .set("Idempotency-Key", "k".repeat(20))
      .send({})
      .expect(201);
    expect(res.body.status).toBe("running");
    expect(res.body.erpnextViewStatus).toBe("unavailable");
    runId = res.body.id;

    const outbox = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events
        WHERE event_type='erpnext.product_reconciliation.requested'
          AND payload->>'run_id' = $1`,
      [runId],
    );
    expect(Number(outbox.rows[0]!.count)).toBe(1);
  });

  it("GET /runs (listRuns) → 200 includes the triggered run", async () => {
    if (skip) return;
    const res = await http().get(`${BASE}/runs`).expect(200);
    expect(res.body.items.some((r: { id: string }) => r.id === runId)).toBe(true);
  });

  it("GET /runs/:id/results → 200 (empty for a fresh running run)", async () => {
    if (skip) return;
    const res = await http().get(`${BASE}/runs/${runId}/results`).expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it("GET /runs/:foreign/results → 404 non-disclosing", async () => {
    if (skip) return;
    const res = await http()
      .get(`${BASE}/runs/0f000000-0000-7000-8000-0000000000ff/results`)
      .expect(404);
    expect(res.body.error?.code).toBe("not_found");
  });
});

describe("021 HTTP — repair envelopes", () => {
  async function version(): Promise<number> {
    return runWithTenantContext(
      env!.app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{ version: number }>(
          `SELECT version FROM erpnext_item_map WHERE id = $1`,
          [MAP_A_SUGGESTED],
        );
        return r.rows[0]!.version;
      },
    );
  }

  it("POST /repairs (confirm) → 201 outcome=mapped", async () => {
    if (skip) return;
    const v = await version();
    const res = await http()
      .post(`${BASE}/repairs`)
      .set("Idempotency-Key", "repair-confirm-key-001")
      .send({ repairKind: "confirm", tenantProductId: PRODUCT_A_SUGGESTED, mappingId: MAP_A_SUGGESTED, version: v })
      .expect(201);
    expect(res.body.outcome).toBe("mapped");
    expect(res.body.resolvedItemMapId).toBe(MAP_A_SUGGESTED);
  });

  it("POST /repairs (re-confirm now-confirmed) → 200 no_op_echo + Idempotent-Replayed", async () => {
    if (skip) return;
    const v = await version();
    const res = await http()
      .post(`${BASE}/repairs`)
      .set("Idempotency-Key", "repair-confirm-key-002")
      .send({ repairKind: "confirm", tenantProductId: PRODUCT_A_SUGGESTED, mappingId: MAP_A_SUGGESTED, version: v })
      .expect(200);
    expect(res.body.outcome).toBe("no_op_echo");
    expect(res.headers["idempotent-replayed"]).toBe("true");
  });

  it("POST /repairs (stale version on a still-suggested mapping) → 409 conflict envelope", async () => {
    if (skip) return;
    // A FRESH suggested product+mapping (the seeded one is now confirmed) so the
    // stale-version confirm hits the genuine version-guard conflict, not no_op_echo.
    const prod = "0a000000-0000-7000-8000-00000d021843";
    const map = "0a000000-0000-7000-8000-00000d021844";
    await env!.admin.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, '021 HTTP Conflict', 'standard', $3, $3) ON CONFLICT DO NOTHING`,
      [prod, TENANT_A, ACTOR_A],
    );
    await env!.admin.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, suggested_by, version)
       VALUES ($1, $2, $3, 'ERP-021-CONF', 'suggested', 'manual', $4, 1) ON CONFLICT DO NOTHING`,
      [map, TENANT_A, prod, ACTOR_A],
    );
    const res = await http()
      .post(`${BASE}/repairs`)
      .set("Idempotency-Key", "repair-confirm-key-003")
      .send({ repairKind: "confirm", tenantProductId: prod, mappingId: map, version: 999 })
      .expect(409);
    expect(res.body.error?.code).toBe("conflict");
  });

  it("POST /repairs (runId without resultId) → 400 validation_error", async () => {
    if (skip) return;
    const res = await http()
      .post(`${BASE}/repairs`)
      .set("Idempotency-Key", "repair-confirm-key-004")
      .send({
        repairKind: "confirm",
        tenantProductId: PRODUCT_A_SUGGESTED,
        mappingId: MAP_A_SUGGESTED,
        version: 1,
        runId: "0f000000-0000-7000-8000-0000000000aa",
      })
      .expect(400);
    expect(res.body.error?.code).toBe("validation_error");
  });
});
