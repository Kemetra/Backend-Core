/**
 * store-scope-authz.spec.ts — RT-131 (RT-120 B-1 regression).
 *
 * A store-scoped member (`memberships.store_access_kind = 'specific'`) must
 * not list / inspect / dismiss / link / create-from / reopen another store's
 * unknown items. The default session state — no active store — must NOT
 * become tenant-wide authority.
 *
 * Unlike the rest of this folder, nothing on the authorization path is faked
 * except the cookie authentication itself (`DashboardAuthGuard`, which only
 * attaches `request.principal`). `TenantContextGuard`, `RolesGuard`,
 * `SessionRepository` and `MembershipRepository` are the real classes, and
 * every query runs on the `app_test` pool — a NOBYPASSRLS role (asserted
 * below) against the full migration set, so the 0011 store RLS policies are
 * genuinely in force.
 *
 * Matrix (tenant A: stores X, Y, Z; tenant B for the cross-tenant control):
 *   - store_manager, specific {X}, no active store — the RT-120 repro actor
 *   - owner,         specific {X}, no active store — role does not widen scope
 *   - store_manager, specific {X, Y}, no active store — multi-store, still not tenant-wide
 *   - store_manager, specific {X}, active store X — pre-existing path, unchanged
 *   - owner,         all,          no active store — intentionally tenant-wide
 */
import "reflect-metadata";

import type { CanActivate, ExecutionContext, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
  seedCatalogIsolationFixture,
} from "../../__support__/isolation-harness";
import { AUDIT_JOB_ENQUEUER } from "../../../../src/audit/audit-job.enqueuer";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PosOperatorAuthGuard } from "../../../../src/auth/pos-operator-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { SessionRepository } from "../../../../src/auth/session.repository";
import { ReconciliationController } from "../../../../src/catalog/reconciliation/reconciliation.controller";
import { ReconciliationService } from "../../../../src/catalog/reconciliation/reconciliation.service";
import { UnknownItemsController } from "../../../../src/catalog/unknown-items/unknown-items.controller";
import { UnknownItemsService } from "../../../../src/catalog/unknown-items/unknown-items.service";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { MembershipRepository } from "../../../../src/context/membership.repository";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";

// ---------------------------------------------------------------------------
// Fixture IDs (hex-only, `0131` mnemonic)
// ---------------------------------------------------------------------------

const STORE_A_Z = "0a000000-0000-7000-8000-0000013100a3";

const ROLE_OWNER = "0a000000-0000-7000-8000-0000013101a1";
const ROLE_STORE_MANAGER = "0a000000-0000-7000-8000-0000013101a2";

const USER_MGR_X = "0a000000-0000-7000-8000-0000013102a1";
const USER_OWNER_X = "0a000000-0000-7000-8000-0000013102a2";
const USER_MGR_XY = "0a000000-0000-7000-8000-0000013102a3";
const USER_OWNER_ALL = "0a000000-0000-7000-8000-0000013102a4";

const MEM_MGR_X = "0a000000-0000-7000-8000-0000013103a1";
const MEM_OWNER_X = "0a000000-0000-7000-8000-0000013103a2";
const MEM_MGR_XY = "0a000000-0000-7000-8000-0000013103a3";
const MEM_OWNER_ALL = "0a000000-0000-7000-8000-0000013103a4";

const SES_MGR_X = "0a000000-0000-7000-8000-0000013104a1";
const SES_OWNER_X = "0a000000-0000-7000-8000-0000013104a2";
const SES_MGR_XY = "0a000000-0000-7000-8000-0000013104a3";
const SES_OWNER_ALL = "0a000000-0000-7000-8000-0000013104a4";
const SES_MGR_X_ACTIVE_X = "0a000000-0000-7000-8000-0000013104a5";

const SESSION_USER: Readonly<Record<string, string>> = {
  [SES_MGR_X]: USER_MGR_X,
  [SES_OWNER_X]: USER_OWNER_X,
  [SES_MGR_XY]: USER_MGR_XY,
  [SES_OWNER_ALL]: USER_OWNER_ALL,
  [SES_MGR_X_ACTIVE_X]: USER_MGR_X,
};

// Unknown items. Each mutation test owns its own row so ordering is irrelevant.
const ITEM = {
  // list/inspect probes (never mutated)
  readX: "0a000000-0000-7000-8000-0000013105a1",
  readY: "0a000000-0000-7000-8000-0000013105a2",
  readZ: "0a000000-0000-7000-8000-0000013105a3",
  readB: "0b000000-0000-7000-8000-0000013105b1",
  // dismiss
  dismissX: "0a000000-0000-7000-8000-0000013106a1",
  dismissY: "0a000000-0000-7000-8000-0000013106a2",
  dismissYByOwnerAll: "0a000000-0000-7000-8000-0000013106a3",
  bulkX: "0a000000-0000-7000-8000-0000013106a4",
  bulkY: "0a000000-0000-7000-8000-0000013106a5",
  // link / create-product
  linkX: "0a000000-0000-7000-8000-0000013107a1",
  linkY: "0a000000-0000-7000-8000-0000013107a2",
  createX: "0a000000-0000-7000-8000-0000013107a3",
  createY: "0a000000-0000-7000-8000-0000013107a4",
  // reopen (seeded dismissed)
  reopenX: "0a000000-0000-7000-8000-0000013108a1",
  reopenY: "0a000000-0000-7000-8000-0000013108a2",
  reopenYByOwnerAll: "0a000000-0000-7000-8000-0000013108a3",
} as const;

const PENDING_ROWS: ReadonlyArray<readonly [id: string, tenant: string, store: string]> = [
  [ITEM.readX, TENANT_A, STORE_A_X],
  [ITEM.readY, TENANT_A, STORE_A_Y],
  [ITEM.readZ, TENANT_A, STORE_A_Z],
  [ITEM.readB, TENANT_B, STORE_B_X],
  [ITEM.dismissX, TENANT_A, STORE_A_X],
  [ITEM.dismissY, TENANT_A, STORE_A_Y],
  [ITEM.dismissYByOwnerAll, TENANT_A, STORE_A_Y],
  [ITEM.bulkX, TENANT_A, STORE_A_X],
  [ITEM.bulkY, TENANT_A, STORE_A_Y],
  [ITEM.linkX, TENANT_A, STORE_A_X],
  [ITEM.linkY, TENANT_A, STORE_A_Y],
  [ITEM.createX, TENANT_A, STORE_A_X],
  [ITEM.createY, TENANT_A, STORE_A_Y],
];

const DISMISSED_ROWS: ReadonlyArray<readonly [id: string, tenant: string, store: string]> = [
  [ITEM.reopenX, TENANT_A, STORE_A_X],
  [ITEM.reopenY, TENANT_A, STORE_A_Y],
  [ITEM.reopenYByOwnerAll, TENANT_A, STORE_A_Y],
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let app: INestApplication | null = null;

/**
 * Stands in for cookie authentication ONLY: attaches the session principal
 * named by a test header. Everything after it (tenant context, store access,
 * roles) is resolved by the real guards against the real database.
 */
class HeaderSessionAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      principal?: unknown;
    }>();
    const sessionId = req.headers["x-test-session"];
    const userId = sessionId ? SESSION_USER[sessionId] : undefined;
    if (!sessionId || !userId) return false;
    req.principal = { kind: "session", sessionId, userId };
    return true;
  }
}

async function seed(admin: Pool): Promise<void> {
  await seedCatalogIsolationFixture({ admin });

  await admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'rt131-z', 'RT-131 Z')`,
    [STORE_A_Z, TENANT_A],
  );
  await admin.query(
    `INSERT INTO users (id, email) VALUES
       ($1, 'rt131-mgr-x@example.test'),
       ($2, 'rt131-owner-x@example.test'),
       ($3, 'rt131-mgr-xy@example.test'),
       ($4, 'rt131-owner-all@example.test')`,
    [USER_MGR_X, USER_OWNER_X, USER_MGR_XY, USER_OWNER_ALL],
  );
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $3, 'owner', 'Owner'),
       ($2, $3, 'store_manager', 'Store Manager')`,
    [ROLE_OWNER, ROLE_STORE_MANAGER, TENANT_A],
  );
  await admin.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $9, $2, $10, 'specific'),
       ($3, $9, $4, $11, 'specific'),
       ($5, $9, $6, $10, 'specific'),
       ($7, $9, $8, $11, 'all')`,
    [
      MEM_MGR_X, USER_MGR_X,
      MEM_OWNER_X, USER_OWNER_X,
      MEM_MGR_XY, USER_MGR_XY,
      MEM_OWNER_ALL, USER_OWNER_ALL,
      TENANT_A, ROLE_STORE_MANAGER, ROLE_OWNER,
    ],
  );
  await admin.query(
    `INSERT INTO store_access (membership_id, store_id, tenant_id) VALUES
       ($1, $4, $6), ($2, $4, $6), ($3, $4, $6), ($3, $5, $6)`,
    [MEM_MGR_X, MEM_OWNER_X, MEM_MGR_XY, STORE_A_X, STORE_A_Y, TENANT_A],
  );
  // Sessions in the default state: active tenant A, NO active store — the
  // exact state RT-120 B-1 exploited. One extra session pins store X.
  await admin.query(
    `INSERT INTO sessions
       (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
     VALUES
       ($1, $2, $11, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($3, $4, $11, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($5, $6, $11, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($7, $8, $11, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex')),
       ($9, $10, $11, $12, now() + interval '1 hour', decode(md5(random()::text), 'hex'))`,
    [
      SES_MGR_X, USER_MGR_X,
      SES_OWNER_X, USER_OWNER_X,
      SES_MGR_XY, USER_MGR_XY,
      SES_OWNER_ALL, USER_OWNER_ALL,
      SES_MGR_X_ACTIVE_X, USER_MGR_X,
      TENANT_A, STORE_A_X,
    ],
  );

  for (const [id, tenant, store] of PENDING_ROWS) {
    await admin.query(
      `INSERT INTO unknown_items
         (id, tenant_id, store_id, identifier_type, value, resolution_status, correlation_id)
       VALUES ($1, $2, $3, 'barcode', $4, 'pending', gen_random_uuid())`,
      [id, tenant, store, `RT131-${id.slice(-6)}`],
    );
  }
  for (const [id, tenant, store] of DISMISSED_ROWS) {
    await admin.query(
      `INSERT INTO unknown_items
         (id, tenant_id, store_id, identifier_type, value, resolution_status,
          resolution_action, resolved_at, resolved_by, correlation_id)
       VALUES ($1, $2, $3, 'barcode', $4, 'dismissed', 'dismissed', now(), $5, gen_random_uuid())`,
      [id, tenant, store, `RT131-${id.slice(-6)}`, USER_OWNER_ALL],
    );
  }
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seed(env.admin);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-131 store-scope-authz] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  const appPool = env.app;
  const moduleRef = await Test.createTestingModule({
    controllers: [UnknownItemsController, ReconciliationController],
    providers: [
      { provide: PG_POOL, useValue: appPool },
      // Audit delivery is not under test here; accept and drop.
      { provide: AUDIT_JOB_ENQUEUER, useValue: { enqueue: async () => undefined } },
      { provide: SessionRepository, useFactory: () => new SessionRepository(appPool) },
      { provide: MembershipRepository, useFactory: () => new MembershipRepository(appPool) },
      UnknownItemsService,
      ReconciliationService,
      TenantContextGuard,
      RolesGuard,
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue(new HeaderSessionAuthGuard())
    // POS capture route only — not exercised by this spec.
    .overrideGuard(PosOperatorAuthGuard)
    .useValue({ canActivate: () => false })
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
    console.warn("[RT-131 store-scope-authz] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function as(sessionId: string) {
  if (!app) throw new Error("app not initialised");
  const server = app.getHttpServer();
  return {
    get: (path: string) => request(server).get(path).set("x-test-session", sessionId),
    post: (path: string, body: object = {}) =>
      request(server)
        .post(path)
        .set("x-test-session", sessionId)
        .set("Idempotency-Key", `rt131-${sessionId.slice(-4)}-${path}`)
        .send(body),
  };
}

async function itemState(id: string): Promise<{ status: string; product: string | null }> {
  if (!env) throw new Error("env not initialised");
  const res = await env.admin.query<{ resolution_status: string; resolved_product_id: string | null }>(
    "SELECT resolution_status, resolved_product_id FROM unknown_items WHERE id = $1",
    [id],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`fixture row ${id} missing`);
  return { status: row.resolution_status, product: row.resolved_product_id };
}

async function pendingCount(storeId: string, value: string): Promise<number> {
  if (!env) throw new Error("env not initialised");
  const res = await env.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM unknown_items
      WHERE store_id = $1 AND value = $2 AND resolution_status = 'pending'`,
    [storeId, value],
  );
  return Number(res.rows[0]?.n ?? "0");
}

function listedIds(body: unknown): string[] {
  return ((body as { items: Array<{ id: string }> }).items ?? []).map((i) => i.id);
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}

const UI = "/api/v1/catalog/unknown-items";

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

describe("RT-131 — harness preconditions", () => {
  it("the application pool is a NOBYPASSRLS, non-superuser role", async () => {
    if (skip() || !env) return;
    const res = await env.app.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    expect(res.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});

// ---------------------------------------------------------------------------
// Read paths: list + inspect
// ---------------------------------------------------------------------------

describe("RT-131 — list is scoped to the membership's stores, not to the active store", () => {
  it("specific {X} manager with no active store sees only store X (RT-120 B-1 P1)", async () => {
    if (skip()) return;
    const res = await as(SES_MGR_X).get(`${UI}?status=pending&limit=200`).expect(200);
    const ids = listedIds(res.body);
    expect(ids).toEqual(expect.arrayContaining([ITEM.readX]));
    expect(ids).not.toContain(ITEM.readY);
    expect(ids).not.toContain(ITEM.readZ);
    expect(ids).not.toContain(ITEM.readB);
    const stores = new Set(
      (res.body as { items: Array<{ store_id: string }> }).items.map((i) => i.store_id),
    );
    expect([...stores]).toEqual([STORE_A_X]);
  });

  it("a store_id filter naming an ungranted store returns an empty page", async () => {
    if (skip()) return;
    const res = await as(SES_MGR_X).get(`${UI}?status=pending&store_id=${STORE_A_Y}`).expect(200);
    expect(listedIds(res.body)).toEqual([]);
  });

  it("store-scoped list suppresses resolved_product_id (FR-001a)", async () => {
    if (skip()) return;
    const res = await as(SES_MGR_X).get(`${UI}?status=pending`).expect(200);
    for (const item of (res.body as { items: Array<Record<string, unknown>> }).items) {
      expect(item).not.toHaveProperty("resolved_product_id");
    }
  });

  it("specific {X} owner with no active store sees only store X — role does not widen store scope", async () => {
    if (skip()) return;
    const res = await as(SES_OWNER_X).get(`${UI}?status=pending&limit=200`).expect(200);
    const ids = listedIds(res.body);
    expect(ids).toContain(ITEM.readX);
    expect(ids).not.toContain(ITEM.readY);
    expect(ids).not.toContain(ITEM.readZ);
  });

  it("specific {X, Y} manager sees X and Y but not Z — multi-store is not tenant-wide", async () => {
    if (skip()) return;
    const res = await as(SES_MGR_XY).get(`${UI}?status=pending&limit=200`).expect(200);
    const ids = listedIds(res.body);
    expect(ids).toEqual(expect.arrayContaining([ITEM.readX, ITEM.readY]));
    expect(ids).not.toContain(ITEM.readZ);
    expect(ids).not.toContain(ITEM.readB);
  });

  it("specific {X} manager with active store X keeps the pre-existing store-X scope", async () => {
    if (skip()) return;
    const res = await as(SES_MGR_X_ACTIVE_X).get(`${UI}?status=pending&limit=200`).expect(200);
    const ids = listedIds(res.body);
    expect(ids).toContain(ITEM.readX);
    expect(ids).not.toContain(ITEM.readY);
  });

  it("tenant-wide owner (kind=all) with no active store still sees every tenant-A store, never tenant B", async () => {
    if (skip()) return;
    const res = await as(SES_OWNER_ALL).get(`${UI}?status=pending&limit=200`).expect(200);
    const ids = listedIds(res.body);
    expect(ids).toEqual(expect.arrayContaining([ITEM.readX, ITEM.readY, ITEM.readZ]));
    expect(ids).not.toContain(ITEM.readB);
    // Tenant-wide browse keeps product visibility (FR-001a).
    expect((res.body as { items: Array<Record<string, unknown>> }).items[0]).toHaveProperty(
      "resolved_product_id",
    );
  });
});

describe("RT-131 — inspect is evaluated against the item's store", () => {
  it("specific {X} manager: own-store item → 200", async () => {
    if (skip()) return;
    const res = await as(SES_MGR_X).get(`${UI}/${ITEM.readX}`).expect(200);
    expect((res.body as { store_id: string }).store_id).toBe(STORE_A_X);
  });

  it("specific {X} manager: other-store item → non-disclosing 404 (RT-120 B-1 P2)", async () => {
    if (skip()) return;
    const res = await as(SES_MGR_X).get(`${UI}/${ITEM.readY}`).expect(404);
    expect(errorCode(res.body)).toBe("not_found");
  });

  it("specific {X, Y} manager: Z item → 404, Y item → 200", async () => {
    if (skip()) return;
    await as(SES_MGR_XY).get(`${UI}/${ITEM.readZ}`).expect(404);
    await as(SES_MGR_XY).get(`${UI}/${ITEM.readY}`).expect(200);
  });

  it("tenant-wide owner: any tenant-A store → 200; tenant-B item → 404", async () => {
    if (skip()) return;
    await as(SES_OWNER_ALL).get(`${UI}/${ITEM.readZ}`).expect(200);
    await as(SES_OWNER_ALL).get(`${UI}/${ITEM.readB}`).expect(404);
  });
});

// ---------------------------------------------------------------------------
// Action paths: dismiss, bulk-dismiss, link, create-product, reopen
// ---------------------------------------------------------------------------

describe("RT-131 — dismiss / bulk-dismiss never mutate an out-of-scope item", () => {
  it("specific {X} manager: dismiss other-store item → 404 and the row stays pending (RT-120 B-1 P3)", async () => {
    if (skip()) return;
    const res = await as(SES_MGR_X).post(`${UI}/${ITEM.dismissY}/dismiss`).expect(404);
    expect(errorCode(res.body)).toBe("not_found");
    expect((await itemState(ITEM.dismissY)).status).toBe("pending");
  });

  it("specific {X} manager: dismiss own-store item → 200", async () => {
    if (skip()) return;
    await as(SES_MGR_X).post(`${UI}/${ITEM.dismissX}/dismiss`).expect(200);
    expect((await itemState(ITEM.dismissX)).status).toBe("dismissed");
  });

  it("specific {X} manager: bulk-dismiss reports the other-store id as not_found and leaves it pending", async () => {
    if (skip()) return;
    const res = await as(SES_MGR_X)
      .post(`${UI}/bulk-dismiss`, { ids: [ITEM.bulkY, ITEM.bulkX] })
      .expect(200);
    expect((res.body as { outcomes: unknown[] }).outcomes).toEqual([
      { id: ITEM.bulkY, outcome: "not_found" },
      { id: ITEM.bulkX, outcome: "dismissed" },
    ]);
    expect((await itemState(ITEM.bulkY)).status).toBe("pending");
  });

  it("tenant-wide owner: dismiss a store-Y item → 200 (unchanged)", async () => {
    if (skip()) return;
    await as(SES_OWNER_ALL).post(`${UI}/${ITEM.dismissYByOwnerAll}/dismiss`).expect(200);
    expect((await itemState(ITEM.dismissYByOwnerAll)).status).toBe("dismissed");
  });
});

describe("RT-131 — link / create-product are evaluated against the item's store", () => {
  it("specific {X} manager: link other-store item → 404, row untouched", async () => {
    if (skip()) return;
    await as(SES_MGR_X)
      .post(`${UI}/${ITEM.linkY}/link`, { product_id: PRODUCT_A_ACTIVE })
      .expect(404);
    expect(await itemState(ITEM.linkY)).toEqual({ status: "pending", product: null });
  });

  it("specific {X} manager: link own-store item → 200", async () => {
    if (skip()) return;
    await as(SES_MGR_X)
      .post(`${UI}/${ITEM.linkX}/link`, { product_id: PRODUCT_A_ACTIVE })
      .expect(200);
    expect(await itemState(ITEM.linkX)).toEqual({ status: "resolved", product: PRODUCT_A_ACTIVE });
  });

  it("specific {X} owner: create-product from other-store item → 404, row untouched", async () => {
    if (skip()) return;
    await as(SES_OWNER_X)
      .post(`${UI}/${ITEM.createY}/create-product`, { name: "RT-131 Y", tax_category: "standard" })
      .expect(404);
    expect(await itemState(ITEM.createY)).toEqual({ status: "pending", product: null });
  });

  it("specific {X} owner: create-product from own-store item → 201", async () => {
    if (skip()) return;
    await as(SES_OWNER_X)
      .post(`${UI}/${ITEM.createX}/create-product`, { name: "RT-131 X", tax_category: "standard" })
      .expect(201);
    expect((await itemState(ITEM.createX)).status).toBe("resolved");
  });
});

describe("RT-131 — reopen requires real tenant-wide authority; no active store is not it", () => {
  it("specific {X} manager: reopen other-store item → non-disclosing 404, no new row (RT-120 B-1 P3c)", async () => {
    if (skip()) return;
    const value = `RT131-${ITEM.reopenY.slice(-6)}`;
    const res = await as(SES_MGR_X).post(`${UI}/${ITEM.reopenY}/reopen`).expect(404);
    expect(errorCode(res.body)).toBe("not_found");
    expect(await pendingCount(STORE_A_Y, value)).toBe(0);
  });

  it("specific {X} manager: reopen own-store item → 403 forbidden (in scope, not tenant-wide), no new row", async () => {
    if (skip()) return;
    const value = `RT131-${ITEM.reopenX.slice(-6)}`;
    const res = await as(SES_MGR_X).post(`${UI}/${ITEM.reopenX}/reopen`).expect(403);
    expect(errorCode(res.body)).toBe("forbidden");
    expect(await pendingCount(STORE_A_X, value)).toBe(0);
  });

  it("specific {X, Y} manager: reopen a store-Y item → 403, never tenant-wide", async () => {
    if (skip()) return;
    await as(SES_MGR_XY).post(`${UI}/${ITEM.reopenY}/reopen`).expect(403);
    expect(await pendingCount(STORE_A_Y, `RT131-${ITEM.reopenY.slice(-6)}`)).toBe(0);
  });

  it("tenant-wide owner: reopen a store-Y item → 201 with a fresh pending row (unchanged)", async () => {
    if (skip()) return;
    const value = `RT131-${ITEM.reopenYByOwnerAll.slice(-6)}`;
    await as(SES_OWNER_ALL).post(`${UI}/${ITEM.reopenYByOwnerAll}/reopen`).expect(201);
    expect(await pendingCount(STORE_A_Y, value)).toBe(1);
  });
});
