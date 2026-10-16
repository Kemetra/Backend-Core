/**
 * read-role-gate.spec.ts — RT-566.
 *
 * The dashboard READ operations (`tenantAdminListUnknownItems`,
 * `tenantAdminInspectUnknownItem`) are role-gated like dismiss:
 * owner / tenant_admin / store_manager read; store_staff is refused with
 * 403 `forbidden` (the contract's documented role refusal) on both.
 *
 * Same harness shape as `store-scope-authz.spec.ts`: only cookie authentication
 * is faked; `TenantContextGuard`, `RolesGuard` and the repositories are real,
 * on the NOBYPASSRLS `app_test` pool. Every member has `store_access_kind =
 * 'all'` so the ONLY thing that can refuse store_staff is the role gate, never
 * store scope.
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
  STORE_A_X,
  TENANT_A,
  seedCatalogIsolationFixture,
} from "../../__support__/isolation-harness";
import { AUDIT_JOB_ENQUEUER } from "../../../../src/audit/audit-job.enqueuer";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PosOperatorAuthGuard } from "../../../../src/auth/pos-operator-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { SessionRepository } from "../../../../src/auth/session.repository";
import { UnknownItemsController } from "../../../../src/catalog/unknown-items/unknown-items.controller";
import { UnknownItemsService } from "../../../../src/catalog/unknown-items/unknown-items.service";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { MembershipRepository } from "../../../../src/context/membership.repository";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";

// ---------------------------------------------------------------------------
// Fixture IDs (hex-only, `0566` mnemonic)
// ---------------------------------------------------------------------------

const ITEM_X = "0a000000-0000-7000-8000-0000056605a1";
const ITEM_MISSING = "0a000000-0000-7000-8000-0000056605ff";

interface Member {
  readonly role: "owner" | "tenant_admin" | "store_manager" | "store_staff";
  readonly roleId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly sessionId: string;
}

const MEMBERS: readonly Member[] = [
  { role: "owner", n: 1 },
  { role: "tenant_admin", n: 2 },
  { role: "store_manager", n: 3 },
  { role: "store_staff", n: 4 },
].map(({ role, n }) => ({
  role: role as Member["role"],
  roleId: `0a000000-0000-7000-8000-0000056601a${n}`,
  userId: `0a000000-0000-7000-8000-0000056602a${n}`,
  membershipId: `0a000000-0000-7000-8000-0000056603a${n}`,
  sessionId: `0a000000-0000-7000-8000-0000056604a${n}`,
}));

const byRole = (role: Member["role"]): Member => {
  const m = MEMBERS.find((x) => x.role === role);
  if (!m) throw new Error(`no fixture member for ${role}`);
  return m;
};

const SESSION_USER: Readonly<Record<string, string>> = Object.fromEntries(
  MEMBERS.map((m) => [m.sessionId, m.userId]),
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let app: INestApplication | null = null;

/** Stands in for cookie authentication ONLY (attaches the session principal). */
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
  for (const m of MEMBERS) {
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      m.userId,
      `rt566-${m.role}@example.test`,
    ]);
    await admin.query(
      `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $2, $3, $3)`,
      [m.roleId, TENANT_A, m.role],
    );
    await admin.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
       VALUES ($1, $2, $3, $4, 'all')`,
      [m.membershipId, TENANT_A, m.userId, m.roleId],
    );
    await admin.query(
      `INSERT INTO sessions
         (id, user_id, active_tenant_id, active_store_id, absolute_expires_at, credential_hash)
       VALUES ($1, $2, $3, NULL, now() + interval '1 hour', decode(md5(random()::text), 'hex'))`,
      [m.sessionId, m.userId, TENANT_A],
    );
  }
  await admin.query(
    `INSERT INTO unknown_items
       (id, tenant_id, store_id, identifier_type, value, resolution_status, correlation_id)
     VALUES ($1, $2, $3, 'barcode', 'RT566-X', 'pending', gen_random_uuid())`,
    [ITEM_X, TENANT_A, STORE_A_X],
  );
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
      console.warn(`\n[RT-566 read-role-gate] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  const appPool = env.app;
  const moduleRef = await Test.createTestingModule({
    controllers: [UnknownItemsController],
    providers: [
      { provide: PG_POOL, useValue: appPool },
      { provide: AUDIT_JOB_ENQUEUER, useValue: { enqueue: async () => undefined } },
      { provide: SessionRepository, useFactory: () => new SessionRepository(appPool) },
      { provide: MembershipRepository, useFactory: () => new MembershipRepository(appPool) },
      UnknownItemsService,
      TenantContextGuard,
      RolesGuard,
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue(new HeaderSessionAuthGuard())
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
    console.warn("[RT-566 read-role-gate] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function get(role: Member["role"], path: string) {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer())
    .get(path)
    .set("x-test-session", byRole(role).sessionId);
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } }).error?.code;
}

const UI = "/api/v1/catalog/unknown-items";
const PERMITTED = ["owner", "tenant_admin", "store_manager"] as const;

describe("RT-566 — list is role-gated", () => {
  it.each(PERMITTED)("%s → 200 and sees the item", async (role) => {
    if (skip()) return;
    const res = await get(role, `${UI}?status=pending&limit=200`).expect(200);
    const ids = (res.body as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(ids).toContain(ITEM_X);
  });

  it("store_staff (tenant-wide membership) → 403 forbidden, no items", async () => {
    if (skip()) return;
    const res = await get("store_staff", `${UI}?status=pending&limit=200`).expect(403);
    expect(errorCode(res.body)).toBe("forbidden");
    expect(res.body).not.toHaveProperty("items");
  });
});

describe("RT-566 — inspect is role-gated", () => {
  it.each(PERMITTED)("%s → 200 on an in-scope item", async (role) => {
    if (skip()) return;
    const res = await get(role, `${UI}/${ITEM_X}`).expect(200);
    expect((res.body as { id: string }).id).toBe(ITEM_X);
  });

  it("store_staff → 403 forbidden on an existing item", async () => {
    if (skip()) return;
    const res = await get("store_staff", `${UI}/${ITEM_X}`).expect(403);
    expect(errorCode(res.body)).toBe("forbidden");
  });

  it("store_staff → 403 on a non-existent id too (role refusal is no existence oracle)", async () => {
    if (skip()) return;
    const res = await get("store_staff", `${UI}/${ITEM_MISSING}`).expect(403);
    expect(errorCode(res.body)).toBe("forbidden");
  });

  it("a permitted role still gets non-disclosing 404 on a non-existent id", async () => {
    if (skip()) return;
    const res = await get("owner", `${UI}/${ITEM_MISSING}`).expect(404);
    expect(errorCode(res.body)).toBe("not_found");
  });
});
