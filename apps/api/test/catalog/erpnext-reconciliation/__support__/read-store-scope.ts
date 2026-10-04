/**
 * RT-192 — shared fixture for the reconciliation READ store-scope specs (the
 * 017 erpnext-reconciliation reads and the 025 erpnext-sync-ops read model).
 *
 * Builds the REAL module graph over real Postgres (the NOBYPASSRLS `app_test`
 * pool): `TenantContextGuard`, `RolesGuard`, `SessionRepository` and
 * `MembershipRepository` come from the production wiring, so the store scope
 * is resolved from seeded memberships, store grants and sessions exactly as in
 * production. Only cookie authentication is faked: a header names the session
 * (the RT-177 / RT-191 pattern).
 *
 * Tenant A layout (on top of `seedReconciliationFixture`):
 *   STORE_A_X  granted to the `specific` members; dead-letters X1 (fixture), X2, X3,
 *              RUN_A (fixture, results RESULT_A + RESULT_A2) and RUN_X2
 *   STORE_A_Y  never granted; dead-letters Y1, Y2 interleaved with X*, RUN_Y
 *   S_DELETED  granted to the `specific` owner, then soft-deleted; DL_DEL, RUN_DEL
 * Tenant B: STORE_B_X with the fixture's RUN_B and a dead-letter DL_B.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it. IDs use the `0192`
 * mnemonic (hex only).
 */
import type { CanActivate, DynamicModule, ExecutionContext, INestApplication, Type } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";

import { AUDIT_JOB_ENQUEUER } from "../../../../src/audit/audit-job.enqueuer";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { AUTH_LOOKUP_POOL } from "../../../../src/auth/database-pools";
import { AuthTokenRepository } from "../../../../src/auth/auth-token.repository";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { SessionRepository } from "../../../../src/auth/session.repository";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import type { PgTestEnv } from "../../../_helpers/postgres-container";
import { SALE_A_X, SALE_A_Y, SALE_B_X, SALES_SOURCE_SYSTEM } from "../../sales/__support__/seed-sales";
import { PRODUCT_A_ACTIVE, STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../../__support__/isolation-harness";
import { POSTING_DEADLETTER_A, RUN_A, seedReconciliationFixture } from "./seed-reconciliation";

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

export const S_DELETED = "0a000000-0000-7000-8000-0000019200a1";
export const NON_EXISTENT = "0a000000-0000-7000-8000-0000019200ff";

const ROLE_OWNER = "0a000000-0000-7000-8000-0000019201a1";
const ROLE_ADMIN = "0a000000-0000-7000-8000-0000019201a2";

const USER_OWNER_SPEC = "0a000000-0000-7000-8000-0000019202a1";
const USER_ADMIN_SPEC = "0a000000-0000-7000-8000-0000019202a2";
const USER_OWNER_ALL = "0a000000-0000-7000-8000-0000019202a3";

const MEM_OWNER_SPEC = "0a000000-0000-7000-8000-0000019203a1";
const MEM_ADMIN_SPEC = "0a000000-0000-7000-8000-0000019203a2";
const MEM_OWNER_ALL = "0a000000-0000-7000-8000-0000019203a3";

/** owner, `specific` membership granted STORE_A_X and (soft-deleted) S_DELETED. */
export const SES_OWNER_SPEC = "0a000000-0000-7000-8000-0000019204a1";
/** tenant_admin, `specific` membership granted STORE_A_X only. */
export const SES_ADMIN_SPEC = "0a000000-0000-7000-8000-0000019204a2";
/** owner, `all` membership, no active store. */
export const SES_OWNER_ALL = "0a000000-0000-7000-8000-0000019204a3";
/** owner, `all` membership, STORE_A_X selected as the active store. */
export const SES_OWNER_ALL_ACTIVE = "0a000000-0000-7000-8000-0000019204a4";

const SESSION_USER: Readonly<Record<string, string>> = {
  [SES_OWNER_SPEC]: USER_OWNER_SPEC,
  [SES_ADMIN_SPEC]: USER_ADMIN_SPEC,
  [SES_OWNER_ALL]: USER_OWNER_ALL,
  [SES_OWNER_ALL_ACTIVE]: USER_OWNER_ALL,
};

/** The two `specific` members (granted STORE_A_X), for `it.each`. */
export const SPECIFIC_SESSIONS: ReadonlyArray<readonly [string, string]> = [
  ["owner", SES_OWNER_SPEC],
  ["tenant_admin", SES_ADMIN_SPEC],
];

/** Dead-letters, in insertion (= `sequence`) order after the fixture's X1. */
export const DL_X1 = POSTING_DEADLETTER_A;
export const DL_Y1 = "0a000000-0000-7000-8000-0000019205a1";
export const DL_X2 = "0a000000-0000-7000-8000-0000019205a2";
export const DL_Y2 = "0a000000-0000-7000-8000-0000019205a3";
export const DL_X3 = "0a000000-0000-7000-8000-0000019205a4";
export const DL_DEL = "0a000000-0000-7000-8000-0000019205a5";
export const DL_B = "0b000000-0000-7000-8000-0000019205b1";

export const RUN_X = RUN_A;
export const RUN_X2 = "0a000000-0000-7000-8000-0000019206a1";
export const RUN_Y = "0a000000-0000-7000-8000-0000019206a2";
export const RUN_DEL = "0a000000-0000-7000-8000-0000019206a3";
export const RESULT_A2 = "0a000000-0000-7000-8000-0000019207a1";
const RESULT_Y = "0a000000-0000-7000-8000-0000019207a2";
const RESULT_DEL = "0a000000-0000-7000-8000-0000019207a3";
const SALE_DEL = "0a000000-0000-7000-8000-0000019208a1";

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
       ($1, 'rt192-owner-spec@example.test'),
       ($2, 'rt192-admin-spec@example.test'),
       ($3, 'rt192-owner-all@example.test')`,
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
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES
       ($1, $3, $5), ($2, $3, $5), ($1, $4, $5)`,
    [MEM_OWNER_SPEC, MEM_ADMIN_SPEC, STORE_A_X, S_DELETED, TENANT_A],
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
  row: { id: string; tenantId: string; storeId: string; saleId: string },
): Promise<void> {
  await admin.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id,
        source_system, external_id, payload_hash, status, rejection_category)
     VALUES ($1, $2, $3, $4, 'sale_post', $1, $5, $6, $7, 'permanently_rejected', 'unmapped_item')`,
    [row.id, row.tenantId, row.storeId, row.saleId, SALES_SOURCE_SYSTEM, `rt192-${row.id}`, "a".repeat(64)],
  );
}

async function insertRun(admin: Pool, row: { runId: string; storeId: string; resultId?: string }): Promise<void> {
  await admin.query(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, finished_at)
     VALUES ($1, $2, $3, 'stock', 'on_demand', 'completed', now())`,
    [row.runId, TENANT_A, row.storeId],
  );
  if (row.resultId) await insertOpenResult(admin, row.resultId, row.runId);
}

async function insertOpenResult(admin: Pool, resultId: string, runId: string): Promise<void> {
  await admin.query(
    `INSERT INTO erpnext_reconciliation_result
       (id, run_id, tenant_id, mismatch_class, source_ref_id, result_state)
     VALUES ($1, $2, $3, 'quantity_divergence', $4, 'open')`,
    [resultId, runId, TENANT_A, PRODUCT_A_ACTIVE],
  );
}

/** Rows on STORE_A_X / STORE_A_Y (interleaved), S_DELETED (seeded live, then deleted) and tenant B. */
async function seedTargets(admin: Pool): Promise<void> {
  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'rt192-deleted', 'RT-192 Deleted')`,
    [S_DELETED, TENANT_A],
  );
  await admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'USD', 1.0000, now(), '2026-05-01', $4, 'rt192-sale-del', $5, $6)`,
    [SALE_DEL, TENANT_A, S_DELETED, SALES_SOURCE_SYSTEM, "a".repeat(64), USER_OWNER_ALL],
  );
  const deadletters = [
    { id: DL_Y1, tenantId: TENANT_A, storeId: STORE_A_Y, saleId: SALE_A_Y },
    { id: DL_X2, tenantId: TENANT_A, storeId: STORE_A_X, saleId: SALE_A_X },
    { id: DL_Y2, tenantId: TENANT_A, storeId: STORE_A_Y, saleId: SALE_A_Y },
    { id: DL_X3, tenantId: TENANT_A, storeId: STORE_A_X, saleId: SALE_A_X },
    { id: DL_DEL, tenantId: TENANT_A, storeId: S_DELETED, saleId: SALE_DEL },
    { id: DL_B, tenantId: TENANT_B, storeId: STORE_B_X, saleId: SALE_B_X },
  ];
  for (const row of deadletters) await insertDeadletter(admin, row);

  await insertOpenResult(admin, RESULT_A2, RUN_X);
  await insertRun(admin, { runId: RUN_Y, storeId: STORE_A_Y, resultId: RESULT_Y });
  await insertRun(admin, { runId: RUN_X2, storeId: STORE_A_X });
  await insertRun(admin, { runId: RUN_DEL, storeId: S_DELETED, resultId: RESULT_DEL });
  await admin.query(`UPDATE stores SET deleted_at = now() WHERE id = $1`, [S_DELETED]);
}

/** Seed the fixture, the members and the read targets. */
export async function seedReadStoreScope(env: PgTestEnv): Promise<void> {
  await seedReconciliationFixture(env);
  await seedTargets(env.admin);
  await seedMembers(env.admin);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/** Boot `module` over the app pool with only cookie authentication faked. */
export async function bootScopedApp(
  env: PgTestEnv,
  module: Type<unknown> | DynamicModule,
): Promise<INestApplication> {
  const appPool = env.app;
  const realDashboardGuard = new DashboardAuthGuard(
    new SessionRepository(appPool),
    new AuthTokenRepository(appPool),
  );
  const moduleRef = await Test.createTestingModule({ imports: [module] })
    .overrideProvider(PG_POOL)
    .useValue(appPool)
    .overrideProvider(AUTH_LOOKUP_POOL)
    .useValue(appPool)
    .overrideProvider(AUDIT_JOB_ENQUEUER)
    .useValue({ enqueue: async () => undefined })
    .overrideGuard(DashboardAuthGuard)
    .useValue(new HeaderSessionAuthGuard(realDashboardGuard))
    .compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
  return app;
}

/** Admin-pool count of tenant-A dead-letters on `storeIds` (or on every store). */
export async function countDeadletters(admin: Pool, storeIds: readonly string[] | null): Promise<number> {
  const r = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM erpnext_posting_status
      WHERE tenant_id = $1 AND status = 'permanently_rejected'
        AND ($2::uuid[] IS NULL OR store_id = ANY($2::uuid[]))`,
    [TENANT_A, storeIds],
  );
  return Number(r.rows[0]!.n);
}
