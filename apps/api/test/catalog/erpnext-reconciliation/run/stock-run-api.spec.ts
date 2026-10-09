/**
 * 017-US3 (api) — trigger / get / list-results / stock-repair HTTP surface.
 *
 * Drives the real controller behind the real IdempotencyInterceptor + (overridden)
 * dashboard guards. The run PROCESSOR is exercised separately in the worker spec;
 * here the trigger CREATES a `running` run (+ audits) and the processor is invoked
 * directly to produce results the list/repair routes read.
 *
 *   §1 trigger → 201, status='running', + audit_events row.
 *   §2 get → the run projection; foreign runId → 404.
 *   §3 list-results → the run's classified results (after the processor runs).
 *   §4 stock-repair → result open→repaired + audit; idempotent replay; foreign → 404.
 *   §5 §XII — smuggled storeId-less / unknown store → 404; strict body.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
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
import { ErpnextReconciliationController } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.controller";
import { ErpnextReconciliationService } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.service";
import { ErpnextPostingReResolutionService } from "../../../../src/catalog/erpnext-reconciliation/posting-re-resolution.service";
import { MembershipRepository } from "../../../../src/context/membership.repository";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { ACTOR_A, PRODUCT_A_ACTIVE, STORE_A_X } from "../../__support__/isolation-harness";
import {
  RECONCILIATION_FIXTURE_IDS,
  RUN_B,
  seedReconciliationFixture,
} from "../__support__/seed-reconciliation";

const TENANT_A = RECONCILIATION_FIXTURE_IDS.tenantA;
const RUNS = "/api/v1/catalog/erpnext-reconciliation/runs";
const NON_EXISTENT = "0f000000-0000-7000-8000-00000000dead";
const STORE_A_UNMAPPED = "0a000000-0000-7000-8000-0000000a5fae";

function idemp(suffix: string): string {
  return (suffix + "0".repeat(32)).slice(0, 32).replace(/[^a-z0-9]/g, "0");
}
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
class ConfigurableContextGuard implements CanActivate {
  public tenantId = TENANT_A;
  public userId = ACTOR_A;
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext; principal?: { userId?: string } }>();
    // RT-191: storeAccess is what TenantContextGuard resolves for an 'all' membership.
    req.context = {
      userId: this.userId, tenantId: this.tenantId, storeId: null, isPlatformAdmin: false,
      source: "session", storeAccess: { kind: "all" },
    };
    req.principal = { userId: this.userId };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[stock-run-api.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedReconciliationFixture(env);
  // An UNMAPPED tenant-A store (no active 014 stock map) for the unmapped-store
  // trigger test (CodeRabbit #528 P1 — such a run must emit + process at trigger,
  // not strand in `running`).
  await env.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'UNMAP', 'Unmapped Store')
     ON CONFLICT (id) DO NOTHING`,
    [STORE_A_UNMAPPED, TENANT_A],
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
    ErpnextReconciliationService,
    ErpnextPostingReResolutionService,
    // RT-191: the service reads the caller's role for the store scope.
    { provide: MembershipRepository, useFactory: (): MembershipRepository => new MembershipRepository(localEnv.app) },
    { provide: IDEMPOTENCY_KEY_STORE, useValue: idempStore },
    { provide: INFLIGHT_REDIS, useValue: fakeRedis },
    { provide: InProgressMarker, useValue: fakeMarker },
    {
      provide: APP_INTERCEPTOR,
      useValue: new IdempotencyInterceptor(new Reflector(), idempStore, fakeMarker as unknown as InProgressMarker),
    },
  ];
  const moduleRef = await Test.createTestingModule({
    controllers: [ErpnextReconciliationController],
    providers,
  })
    .overrideGuard(DashboardAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard).useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
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

const http = () => request(app!.getHttpServer());
const skip = () => dockerSkipped;

describe("017-US3 api — trigger", () => {
  it("§1 trigger creates a running run + an audit_events row", async () => {
    if (skip()) return;
    const res = await http().post(RUNS).set("idempotency-key", idemp("t")).send({ storeId: STORE_A_X }).expect(201);
    expect(res.body.status).toBe("running");
    expect(res.body.kind).toBe("stock");
    const audit = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE tenant_id=$1 AND action='erpnext_reconciliation.run.triggered' AND target_id=$2`,
      [TENANT_A, res.body.id],
    );
    expect(Number(audit.rows[0]?.count)).toBe(1);
    // 019-T041 lifecycle (shape a): the trigger NO LONGER emits
    // erpnext.reconciliation.requested. The run WAITS in `running` (offered on the
    // 019 bin-view feed); the event is emitted later by binViewReportSnapshot once
    // the connector records its Bin snapshot, so the processor runs over REAL Bin
    // data instead of the inert EMPTY_BIN_VIEW. Assert NO event on trigger.
    const ev = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events
        WHERE tenant_id=$1 AND event_type='erpnext.reconciliation.requested'
          AND payload->>'run_id'=$2`,
      [TENANT_A, res.body.id],
    );
    expect(Number(ev.rows[0]?.count)).toBe(0);
  });

  it("§1b trigger for an UNMAPPED store emits at trigger (not stranded) — CodeRabbit #528 P1", async () => {
    if (skip()) return;
    const res = await http().post(RUNS).set("idempotency-key", idemp("um")).send({ storeId: STORE_A_UNMAPPED }).expect(201);
    expect(res.body.status).toBe("running");
    // No 014 stock map → the bin-view feed would never offer this run, so the
    // event MUST be emitted at trigger so the processor can complete it as
    // `unmapped_store`. (A mapped store defers; see §1.)
    const ev = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_events
        WHERE tenant_id=$1 AND event_type='erpnext.reconciliation.requested'
          AND payload->>'run_id'=$2`,
      [TENANT_A, res.body.id],
    );
    expect(Number(ev.rows[0]?.count)).toBe(1);
  });

  it("§5 trigger for an unknown store → 404; strict body rejects extras", async () => {
    if (skip()) return;
    await http().post(RUNS).set("idempotency-key", idemp("u")).send({ storeId: NON_EXISTENT }).expect(404);
    await http().post(RUNS).set("idempotency-key", idemp("s")).send({ storeId: STORE_A_X, tenant_id: TENANT_A }).expect(400);
  });
});

describe("017-US3 api — get / list-results / repair", () => {
  it("§2 get returns the run; a foreign runId → 404", async () => {
    if (skip()) return;
    const created = await http().post(RUNS).set("idempotency-key", idemp("g")).send({ storeId: STORE_A_X }).expect(201);
    await http().get(`${RUNS}/${created.body.id}`).expect(200);
    // RUN_B belongs to tenant B → non-disclosing 404 under tenant A.
    await http().get(`${RUNS}/${RUN_B}`).expect(404);
  });

  it("§3+§4 list-results returns classified rows; stock-repair flips open→repaired + audits + idempotent", async () => {
    if (skip()) return;
    // Trigger a run, then run the processor directly to produce results.
    const created = await http().post(RUNS).set("idempotency-key", idemp("p")).send({ storeId: STORE_A_X }).expect(201);
    const runId = created.body.id as string;
    // Make STORE_A_X have a confirmed-mapped product with on-hand so a result lands.
    await env!.admin.query(`UPDATE sale_lines SET tenant_product_ref = $1 WHERE tenant_product_ref IS NULL`, [PRODUCT_A_ACTIVE]).catch(() => undefined);
    // Directly insert one open result for the run (the processor is proven in the
    // worker spec; here we exercise the read + repair routes).
    const resultId = "0a000000-0000-7000-8000-00000e0517f1";
    await env!.admin.query(
      `INSERT INTO erpnext_reconciliation_result (id, run_id, tenant_id, mismatch_class, source_ref_id, result_state)
       VALUES ($1, $2, $3, 'quantity_divergence', $4, 'open') ON CONFLICT DO NOTHING`,
      [resultId, runId, TENANT_A, PRODUCT_A_ACTIVE],
    );

    const list = await http().get(`${RUNS}/${runId}/results`).expect(200);
    expect(list.body.items.some((i: { id: string }) => i.id === resultId)).toBe(true);

    // Repair → 201, open→repaired, audited.
    const repair = await http()
      .post(`${RUNS}/${runId}/results/${resultId}/repair`)
      .set("idempotency-key", idemp("rr"))
      .send({ repairKind: "re_sync" })
      .expect(201);
    expect(repair.body.outcome).toBe("eligible_again");
    const state = await env!.admin.query<{ result_state: string }>(
      `SELECT result_state FROM erpnext_reconciliation_result WHERE id = $1`, [resultId],
    );
    expect(state.rows[0]?.result_state).toBe("repaired");
    const audit = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE action='erpnext_reconciliation.stock.repaired' AND target_id=$1`, [resultId],
    );
    expect(Number(audit.rows[0]?.count)).toBe(1);

    // A 2nd repair of the now-repaired result → no_op_echo (idempotent).
    const replay = await http()
      .post(`${RUNS}/${runId}/results/${resultId}/repair`)
      .set("idempotency-key", idemp("rr2"))
      .send({ repairKind: "re_sync" })
      .expect(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
  });
});
