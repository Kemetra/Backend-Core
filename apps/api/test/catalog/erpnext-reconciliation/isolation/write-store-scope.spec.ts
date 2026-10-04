/**
 * RT-191 — the ERPNext reconciliation WRITES are bound to the caller's
 * membership store scope and to live stores (HTTP + Testcontainers).
 *
 * Boots the REAL `ErpnextReconciliationModule` graph over real Postgres (the
 * NOBYPASSRLS `app_test` pool): `TenantContextGuard`, `RolesGuard`,
 * `SessionRepository` and `MembershipRepository` come from the production
 * wiring, so the store scope is resolved from seeded memberships, store grants
 * and sessions exactly as in production. Only cookie authentication is faked: a
 * header names the session (the RT-177 negative on-hand spec's pattern).
 *
 * Covered writes (the three in the module):
 *   POST /runs                                   triggerReconciliationRun
 *   POST /postings/:workItemRef/repair           repairPosting
 *   POST /runs/:runId/results/:resultId/repair   repairStockMismatch
 *
 * For each: a `specific`-membership owner and tenant_admin get the non-disclosing
 * 404 outside their grant and succeed inside it; an `all`-membership owner
 * reaches every live store (an active store does not narrow it); a soft-deleted
 * store and a foreign-tenant store are 404; a 404 writes nothing.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { AUDIT_JOB_ENQUEUER } from "../../../../src/audit/audit-job.enqueuer";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { AUTH_LOOKUP_POOL } from "../../../../src/auth/database-pools";
import { AuthTokenRepository } from "../../../../src/auth/auth-token.repository";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { SessionRepository } from "../../../../src/auth/session.repository";
import { ErpnextReconciliationModule } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.module";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { SALE_A_Y, SALES_SOURCE_SYSTEM } from "../../sales/__support__/seed-sales";
import {
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
} from "../../__support__/isolation-harness";
import {
  POSTING_DEADLETTER_A,
  RESULT_A,
  RUN_A,
  seedReconciliationFixture,
} from "../__support__/seed-reconciliation";

// ---------------------------------------------------------------------------
// Fixture IDs (`0191` mnemonic, hex only)
// ---------------------------------------------------------------------------

/** A soft-deleted tenant-A store, with a dead-letter and a run/result of its own. */
const S_DELETED = "0a000000-0000-7000-8000-0000019100a1";
const NON_EXISTENT = "0a000000-0000-7000-8000-0000019100ff";

const ROLE_OWNER = "0a000000-0000-7000-8000-0000019101a1";
const ROLE_ADMIN = "0a000000-0000-7000-8000-0000019101a2";

const USER_OWNER_SPEC = "0a000000-0000-7000-8000-0000019102a1";
const USER_ADMIN_SPEC = "0a000000-0000-7000-8000-0000019102a2";
const USER_OWNER_ALL = "0a000000-0000-7000-8000-0000019102a3";

const MEM_OWNER_SPEC = "0a000000-0000-7000-8000-0000019103a1";
const MEM_ADMIN_SPEC = "0a000000-0000-7000-8000-0000019103a2";
const MEM_OWNER_ALL = "0a000000-0000-7000-8000-0000019103a3";

/** owner, `specific` membership granted STORE_A_X only. */
const SES_OWNER_SPEC = "0a000000-0000-7000-8000-0000019104a1";
/** tenant_admin, `specific` membership granted STORE_A_X only. */
const SES_ADMIN_SPEC = "0a000000-0000-7000-8000-0000019104a2";
/** owner, `all` membership, no active store. */
const SES_OWNER_ALL = "0a000000-0000-7000-8000-0000019104a3";
/** owner, `all` membership, STORE_A_X selected as the active store. */
const SES_OWNER_ALL_ACTIVE = "0a000000-0000-7000-8000-0000019104a4";

const SESSION_USER: Readonly<Record<string, string>> = {
  [SES_OWNER_SPEC]: USER_OWNER_SPEC,
  [SES_ADMIN_SPEC]: USER_ADMIN_SPEC,
  [SES_OWNER_ALL]: USER_OWNER_ALL,
  [SES_OWNER_ALL_ACTIVE]: USER_OWNER_ALL,
};

/** STORE_A_Y (never granted to the `specific` members): a dead-letter + a run/result. */
const POSTING_DL_Y = "0a000000-0000-7000-8000-0000019105a1";
const RUN_Y = "0a000000-0000-7000-8000-0000019106a1";
const RESULT_Y = "0a000000-0000-7000-8000-0000019107a1";
/** S_DELETED: a sale + dead-letter + run/result, seeded while the store was live. */
const SALE_DEL = "0a000000-0000-7000-8000-0000019108a1";
const POSTING_DL_DEL = "0a000000-0000-7000-8000-0000019105a2";
const RUN_DEL = "0a000000-0000-7000-8000-0000019106a2";
const RESULT_DEL = "0a000000-0000-7000-8000-0000019107a2";

const BASE = "/api/v1/catalog/erpnext-reconciliation";
const RUNS = `${BASE}/runs`;
const postingRepair = (ref: string): string => `${BASE}/postings/${ref}/repair`;
const stockRepair = (run: string, result: string): string => `${RUNS}/${run}/results/${result}/repair`;

const NOT_FOUND = { code: "not_found" };

// ---------------------------------------------------------------------------
// Cookie-auth stand-in
// ---------------------------------------------------------------------------

/** A test header names the session; without it the real `DashboardAuthGuard` decides. */
class HeaderSessionAuthGuard implements CanActivate {
  constructor(private readonly real: DashboardAuthGuard) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      principal?: unknown;
    }>();
    const sessionId = req.headers["x-test-session"];
    const userId = sessionId ? SESSION_USER[sessionId] : undefined;
    if (!sessionId || !userId) return this.real.canActivate(ctx);
    req.principal = { kind: "session", sessionId, userId };
    return true;
  }
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function seedMembers(admin: Pool): Promise<void> {
  await admin.query(
    `INSERT INTO users (id, email) VALUES
       ($1, 'rt191-owner-spec@example.test'),
       ($2, 'rt191-admin-spec@example.test'),
       ($3, 'rt191-owner-all@example.test')`,
    [USER_OWNER_SPEC, USER_ADMIN_SPEC, USER_OWNER_ALL],
  );
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $3, 'owner', 'Owner'), ($2, $3, 'tenant_admin', 'Tenant Admin')`,
    [ROLE_OWNER, ROLE_ADMIN, TENANT_A],
  );
  await admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $7, $2, $8, 'specific'),
       ($3, $7, $4, $9, 'specific'),
       ($5, $7, $6, $8, 'all')`,
    [
      MEM_OWNER_SPEC, USER_OWNER_SPEC, MEM_ADMIN_SPEC, USER_ADMIN_SPEC, MEM_OWNER_ALL, USER_OWNER_ALL,
      TENANT_A, ROLE_OWNER, ROLE_ADMIN,
    ],
  );
  await admin.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES ($1, $3, $4), ($2, $3, $4)`,
    [MEM_OWNER_SPEC, MEM_ADMIN_SPEC, STORE_A_X, TENANT_A],
  );
  await admin.query(
    `INSERT INTO sessions
       (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
     VALUES
       ($1, $2, $8, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($3, $4, $8, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($5, $6, $8, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($7, $6, $8, $9,   now() + interval '1 hour', decode(md5(random()::text), 'hex'))`,
    [
      SES_OWNER_SPEC, USER_OWNER_SPEC, SES_ADMIN_SPEC, USER_ADMIN_SPEC, SES_OWNER_ALL, USER_OWNER_ALL,
      SES_OWNER_ALL_ACTIVE, TENANT_A, STORE_A_X,
    ],
  );
}

async function insertDeadletter(
  admin: Pool,
  row: { id: string; storeId: string; saleId: string },
): Promise<void> {
  await admin.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id,
        source_system, external_id, payload_hash, status, rejection_category)
     VALUES ($1, $2, $3, $4, 'sale_post', $1, $5, $6, $7, 'permanently_rejected', 'unmapped_item')`,
    [row.id, TENANT_A, row.storeId, row.saleId, SALES_SOURCE_SYSTEM, `rt191-${row.id}`, "a".repeat(64)],
  );
}

async function insertRunWithOpenResult(
  admin: Pool,
  row: { runId: string; resultId: string; storeId: string },
): Promise<void> {
  await admin.query(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, finished_at)
     VALUES ($1, $2, $3, 'stock', 'on_demand', 'completed', now())`,
    [row.runId, TENANT_A, row.storeId],
  );
  await admin.query(
    `INSERT INTO erpnext_reconciliation_result
       (id, run_id, tenant_id, mismatch_class, source_ref_id, result_state)
     VALUES ($1, $2, $3, 'quantity_divergence', $4, 'open')`,
    [row.resultId, row.runId, TENANT_A, PRODUCT_A_ACTIVE],
  );
}

/** Rows on STORE_A_Y, and on S_DELETED (seeded live, then soft-deleted). */
async function seedTargets(admin: Pool): Promise<void> {
  await insertDeadletter(admin, { id: POSTING_DL_Y, storeId: STORE_A_Y, saleId: SALE_A_Y });
  await insertRunWithOpenResult(admin, { runId: RUN_Y, resultId: RESULT_Y, storeId: STORE_A_Y });

  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'rt191-deleted', 'RT-191 Deleted')`,
    [S_DELETED, TENANT_A],
  );
  await admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'USD', 1.0000, now(), '2026-05-01', $4, 'rt191-sale-del', $5, $6)`,
    [SALE_DEL, TENANT_A, S_DELETED, SALES_SOURCE_SYSTEM, "a".repeat(64), USER_OWNER_ALL],
  );
  await insertDeadletter(admin, { id: POSTING_DL_DEL, storeId: S_DELETED, saleId: SALE_DEL });
  await insertRunWithOpenResult(admin, { runId: RUN_DEL, resultId: RESULT_DEL, storeId: S_DELETED });
  await admin.query(`UPDATE stores SET deleted_at = now() WHERE id = $1`, [S_DELETED]);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let app: INestApplication | null = null;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReconciliationFixture(env);
    await seedMembers(env.admin);
    await seedTargets(env.admin);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-191 write-store-scope] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  const appPool = env.app;
  const realDashboardGuard = new DashboardAuthGuard(
    new SessionRepository(appPool),
    new AuthTokenRepository(appPool),
  );
  // The production module graph — no hand-registered guards or repositories.
  const moduleRef = await Test.createTestingModule({ imports: [ErpnextReconciliationModule] })
    .overrideProvider(PG_POOL)
    .useValue(appPool)
    .overrideProvider(AUTH_LOOKUP_POOL)
    .useValue(appPool)
    .overrideProvider(AUDIT_JOB_ENQUEUER)
    .useValue({ enqueue: async () => undefined })
    .overrideGuard(DashboardAuthGuard)
    .useValue(new HeaderSessionAuthGuard(realDashboardGuard))
    .compile();
  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-191 write-store-scope] skipping — Docker unavailable");
    return true;
  }
  return false;
}

let keySeq = 0;
function post(path: string, session: string, body: Record<string, unknown>) {
  keySeq += 1;
  return request(app!.getHttpServer())
    .post(path)
    .set("x-test-session", session)
    .set("idempotency-key", `rt191k${String(keySeq).padStart(4, "0")}`.padEnd(32, "0"))
    .send(body);
}

const trigger = (session: string, storeId: string) => post(RUNS, session, { storeId });

async function count(sql: string, params: unknown[]): Promise<number> {
  const r = await env!.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${sql}`, params);
  return Number(r.rows[0]!.n);
}
const runsOf = (storeId: string): Promise<number> =>
  count(`erpnext_reconciliation_run WHERE store_id = $1`, [storeId]);
const repairAttemptsOf = (targetRef: string): Promise<number> =>
  count(`erpnext_reconciliation_repair_attempt WHERE target_ref_id = $1`, [targetRef]);

async function postingStatus(id: string): Promise<string> {
  const r = await env!.admin.query<{ status: string }>(
    `SELECT status FROM erpnext_posting_status WHERE id = $1`,
    [id],
  );
  return r.rows[0]!.status;
}
async function resultState(id: string): Promise<string> {
  const r = await env!.admin.query<{ result_state: string }>(
    `SELECT result_state FROM erpnext_reconciliation_result WHERE id = $1`,
    [id],
  );
  return r.rows[0]!.result_state;
}

// ---------------------------------------------------------------------------
// triggerReconciliationRun
// ---------------------------------------------------------------------------

describe("RT-191 triggerReconciliationRun — membership store scope", () => {
  it.each([
    ["owner", SES_OWNER_SPEC],
    ["tenant_admin", SES_ADMIN_SPEC],
  ])("a specific-membership %s: non-granted store → 404 and no run; granted store → 201", async (_role, session) => {
    if (skip()) return;
    const before = await runsOf(STORE_A_Y);
    const denied = await trigger(session, STORE_A_Y).expect(404);
    expect(denied.body.error).toMatchObject(NOT_FOUND);
    expect(await runsOf(STORE_A_Y)).toBe(before);

    const ok = await trigger(session, STORE_A_X).expect(201);
    expect(ok.body).toMatchObject({ storeId: STORE_A_X, kind: "stock", trigger: "on_demand", status: "running" });
  });

  it("a granted store id in upper case is still in scope", async () => {
    if (skip()) return;
    await trigger(SES_OWNER_SPEC, STORE_A_X.toUpperCase()).expect(201);
  });

  it("an all-membership owner triggers on any live store", async () => {
    if (skip()) return;
    for (const storeId of [STORE_A_X, STORE_A_Y]) {
      const res = await trigger(SES_OWNER_ALL, storeId).expect(201);
      expect(res.body.storeId).toBe(storeId);
    }
  });

  it("an all-membership owner's active store does not narrow the trigger", async () => {
    if (skip()) return;
    const res = await trigger(SES_OWNER_ALL_ACTIVE, STORE_A_Y).expect(201);
    expect(res.body.storeId).toBe(STORE_A_Y);
  });

  it("a soft-deleted store → 404 and no run, even for an all-membership owner", async () => {
    if (skip()) return;
    const before = await runsOf(S_DELETED);
    const res = await trigger(SES_OWNER_ALL, S_DELETED).expect(404);
    expect(res.body.error).toMatchObject(NOT_FOUND);
    expect(await runsOf(S_DELETED)).toBe(before);
  });

  it("a foreign-tenant store stays 404", async () => {
    if (skip()) return;
    const before = await runsOf(STORE_B_X);
    await trigger(SES_OWNER_ALL, STORE_B_X).expect(404);
    expect(await runsOf(STORE_B_X)).toBe(before);
  });

  it("out-of-scope, deleted, foreign and missing stores answer the identical 404 body", async () => {
    if (skip()) return;
    const bodies = await Promise.all([
      trigger(SES_OWNER_SPEC, STORE_A_Y).expect(404),
      trigger(SES_OWNER_SPEC, S_DELETED).expect(404),
      trigger(SES_OWNER_SPEC, STORE_B_X).expect(404),
      trigger(SES_OWNER_SPEC, NON_EXISTENT).expect(404),
    ]);
    const shapes = bodies.map((r) => ({ code: r.body.error.code, message: r.body.error.message }));
    for (const s of shapes) expect(s).toEqual(shapes[0]);
    expect(shapes[0]).toEqual({ code: "not_found", message: "Store not found." });
  });
});

// ---------------------------------------------------------------------------
// repairPosting
// ---------------------------------------------------------------------------

describe("RT-191 repairPosting — membership store scope", () => {
  it.each([
    ["owner", SES_OWNER_SPEC],
    ["tenant_admin", SES_ADMIN_SPEC],
  ])("a specific-membership %s: a non-granted store's dead-letter → 404, untouched", async (_role, session) => {
    if (skip()) return;
    const res = await post(postingRepair(POSTING_DL_Y), session, {}).expect(404);
    expect(res.body.error).toMatchObject({ code: "not_found", message: "Work item not found." });
    expect(await postingStatus(POSTING_DL_Y)).toBe("permanently_rejected");
    expect(await repairAttemptsOf(POSTING_DL_Y)).toBe(0);
  });

  it("a specific-membership owner repairs a granted store's dead-letter", async () => {
    if (skip()) return;
    const res = await post(postingRepair(POSTING_DEADLETTER_A), SES_OWNER_SPEC, {}).expect(201);
    expect(res.body).toMatchObject({ targetKind: "posting", targetRef: POSTING_DEADLETTER_A });
  });

  it("a soft-deleted store's dead-letter → 404, untouched (all-membership owner)", async () => {
    if (skip()) return;
    await post(postingRepair(POSTING_DL_DEL), SES_OWNER_ALL, {}).expect(404);
    expect(await postingStatus(POSTING_DL_DEL)).toBe("permanently_rejected");
    expect(await repairAttemptsOf(POSTING_DL_DEL)).toBe(0);
  });

  it("an all-membership owner repairs the non-granted store's dead-letter", async () => {
    if (skip()) return;
    const res = await post(postingRepair(POSTING_DL_Y), SES_OWNER_ALL, {}).expect(201);
    expect(res.body).toMatchObject({ targetKind: "posting", targetRef: POSTING_DL_Y });
    expect(await repairAttemptsOf(POSTING_DL_Y)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// repairStockMismatch
// ---------------------------------------------------------------------------

describe("RT-191 repairStockMismatch — membership store scope", () => {
  it.each([
    ["owner", SES_OWNER_SPEC],
    ["tenant_admin", SES_ADMIN_SPEC],
  ])("a specific-membership %s: a non-granted store's result → 404, still open", async (_role, session) => {
    if (skip()) return;
    const res = await post(stockRepair(RUN_Y, RESULT_Y), session, { repairKind: "re_sync" }).expect(404);
    expect(res.body.error).toMatchObject({ code: "not_found", message: "Result not found." });
    expect(await resultState(RESULT_Y)).toBe("open");
    expect(await repairAttemptsOf(RESULT_Y)).toBe(0);
  });

  it("a specific-membership tenant_admin repairs a granted store's result", async () => {
    if (skip()) return;
    const res = await post(stockRepair(RUN_A, RESULT_A), SES_ADMIN_SPEC, { repairKind: "re_sync" }).expect(201);
    expect(res.body).toMatchObject({ targetKind: "stock", targetRef: RESULT_A, outcome: "eligible_again" });
    expect(await resultState(RESULT_A)).toBe("repaired");
  });

  it("a soft-deleted store's result → 404, still open (all-membership owner)", async () => {
    if (skip()) return;
    await post(stockRepair(RUN_DEL, RESULT_DEL), SES_OWNER_ALL, { repairKind: "re_map" }).expect(404);
    expect(await resultState(RESULT_DEL)).toBe("open");
    expect(await repairAttemptsOf(RESULT_DEL)).toBe(0);
  });

  it("an all-membership owner repairs the non-granted store's result", async () => {
    if (skip()) return;
    const res = await post(stockRepair(RUN_Y, RESULT_Y), SES_OWNER_ALL, { repairKind: "re_sync" }).expect(201);
    expect(res.body).toMatchObject({ targetKind: "stock", targetRef: RESULT_Y, outcome: "eligible_again" });
    expect(await resultState(RESULT_Y)).toBe("repaired");
  });
});
