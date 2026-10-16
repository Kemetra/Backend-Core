/**
 * RT-418 — the Console payer-account routes over HTTP against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool) and the
 * real module graph (`TenantContextGuard`, `RolesGuard`,
 * `MembershipRepository`, the real `IdempotencyInterceptor` over a fake
 * Redis). Only cookie authentication is faked: a header names the session.
 *
 *   POST /api/v1/settlement/payer-accounts  consoleCreatePayerAccount
 *   GET  /api/v1/settlement/payer-accounts  consoleListPayerAccounts
 *
 * (`settlement/settlement.yaml` 2.0.0, RT-417.) What this proves:
 *   - authz: owner / tenant_admin only (403 otherwise), 401 without a session;
 *   - create: server-resolved tenant, the store scope (a store outside it, of
 *     another tenant or absent is the same 404), strict body (a removed
 *     `creditTerms`, a blank `externalRef` or a smuggled `tenant_id` is 400),
 *     idempotent on `Idempotency-Key` (replay = same payer, a changed body =
 *     409), nothing written on a refusal;
 *   - list: tenant-scoped, newest-first, keyset walks, the category filter,
 *     store-scoped payers outside the caller's store access excluded;
 *   - every body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import request from "supertest";

import { IdempotencyKeyStore } from "@data-pulse-2/shared";

import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
} from "../../../src/idempotency/idempotency.interceptor";
import { InProgressMarker } from "../../../src/idempotency/in-progress-marker";
import { loadOpenApiContracts } from "../../../src/openapi/loader";
import { PayerAccountsModule } from "../../../src/settlement/payer-accounts.module";
import { seedConsoleMember } from "../../_helpers/console-members";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
} from "../../catalog/__support__/isolation-harness";
import { bootScopedApp } from "../../catalog/erpnext-reconciliation/__support__/read-store-scope";

const URL = "/api/v1/settlement/payer-accounts";

// Sessions (the `x-test-session` stand-in for the dp2_session cookie).
const SES_OWNER_ALL = "0a000000-0000-7000-8000-0000004181a1";
const SES_OWNER_ACTIVE_X = "0a000000-0000-7000-8000-0000004181a2";
const SES_ADMIN_X = "0a000000-0000-7000-8000-0000004181a3";
const SES_MANAGER = "0a000000-0000-7000-8000-0000004181a4";
const SES_STAFF = "0a000000-0000-7000-8000-0000004181a5";
const SES_OWNER_B = "0b000000-0000-7000-8000-0000004181b1";

// Seeded payers (gen_random_uuid in 0027; newest-first is id DESC, so ids are chosen in order).
const P_TENANT_OLD = "0a000000-0000-7000-8000-0000004182a1";
const P_X = "0a000000-0000-7000-8000-0000004182a2";
const P_Y = "0a000000-0000-7000-8000-0000004182a3";
const P_TENANT_INSURER = "0a000000-0000-7000-8000-0000004182a4";
const P_B = "0b000000-0000-7000-8000-0000004182b1";
const SEEDED_A_ALL = [P_TENANT_INSURER, P_Y, P_X, P_TENANT_OLD];

const ABSENT_STORE = "0a000000-0000-7000-8000-0000004183ff";

class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e || Date.now() > e.expiresAt) return null;
    return e.value;
  }
  async set(key: string, value: string, options: { px: number }): Promise<unknown> {
    this.store.set(key, { value, expiresAt: Date.now() + options.px });
    return "OK";
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

function idempotencyProviders() {
  const redis = new FakeRedis();
  const store = new IdempotencyKeyStore({
    redis,
    pgWriter: { async insert() {} },
    pgReader: {
      async find() {
        return null;
      },
    },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
  const interceptor = new IdempotencyInterceptor(new Reflector(), store, new FakeMarker() as unknown as InProgressMarker);
  return [
    { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
    { provide: APP_INTERCEPTOR, useValue: interceptor },
  ];
}

function contractChecker(): (name: string, body: unknown) => void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const dir = resolve(__dirname, "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "settlement");
  const contract = loadOpenApiContracts({ dir }).find((c) => c.id === "settlement");
  if (!contract) throw new Error("settlement/settlement.yaml not found");
  ajv.addSchema(contract.document as object, "settlement");
  return (name, body) => {
    const validate = ajv.getSchema(`settlement#/components/schemas/${name}`)!;
    if (!validate(body)) throw new Error(`contract violation (${name}): ${JSON.stringify(validate.errors)}`);
  };
}
const conforms = contractChecker();

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let skipped = false;

async function seed(e: PgTestEnv): Promise<void> {
  await seedCatalogIsolationFixture(e);
  const members = [
    { userId: "0a000000-0000-7000-8000-0000004184a1", role: "owner", stores: "all" as const, sessions: { [SES_OWNER_ALL]: null, [SES_OWNER_ACTIVE_X]: STORE_A_X } },
    { userId: "0a000000-0000-7000-8000-0000004184a2", role: "tenant_admin", stores: [STORE_A_X], sessions: { [SES_ADMIN_X]: null } },
    { userId: "0a000000-0000-7000-8000-0000004184a3", role: "store_manager", stores: "all" as const, sessions: { [SES_MANAGER]: null } },
    { userId: "0a000000-0000-7000-8000-0000004184a4", role: "store_staff", stores: "all" as const, sessions: { [SES_STAFF]: null } },
  ];
  for (const [i, m] of members.entries()) {
    await seedConsoleMember(e.admin, {
      tenantId: TENANT_A,
      userId: m.userId,
      email: `rt418-${m.role}@example.test`,
      membershipId: `0a000000-0000-7000-8000-0000004185a${i + 1}`,
      roleId: `0a000000-0000-7000-8000-0000004186a${i + 1}`,
      roleCode: m.role,
      stores: m.stores,
      sessions: m.sessions,
    });
  }
  await seedConsoleMember(e.admin, {
    tenantId: TENANT_B,
    userId: "0b000000-0000-7000-8000-0000004184b1",
    email: "rt418-owner-b@example.test",
    membershipId: "0b000000-0000-7000-8000-0000004185b1",
    roleId: "0b000000-0000-7000-8000-0000004186b1",
    roleCode: "owner",
    stores: "all",
    sessions: { [SES_OWNER_B]: null },
  });
  await e.admin.query(
    `INSERT INTO payer_account (id, tenant_id, store_id, category, display_name, external_ref, status) VALUES
       ($1, $6, NULL, 'credit_customer', 'House account', 'CUST-HOUSE', 'active'),
       ($2, $6, $7,   'corporate',       'Store X corp',  'CUST-X',     'active'),
       ($3, $6, $8,   'corporate',       'Store Y corp',  'CUST-Y',     'suspended'),
       ($4, $6, NULL, 'insurer',         'Tenant insurer', NULL,        'active'),
       ($5, $9, $10,  'insurer',         'Tenant B insurer', 'CUST-B',  'active')`,
    [P_TENANT_OLD, P_X, P_Y, P_TENANT_INSURER, P_B, TENANT_A, STORE_A_X, STORE_A_Y, TENANT_B, STORE_B_X],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seed(env);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw new Error(`Container start failed: ${reason}`);
    skipped = true;
    return;
  }
  app = await bootScopedApp(env, PayerAccountsModule, undefined, { providers: idempotencyProviders() });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

const server = () => app!.getHttpServer() as Parameters<typeof request>[0];
const asSession = (req: request.Test, session: string | null) => (session === null ? req : req.set("x-test-session", session));
let keySeq = 0;
const freshKey = (): string => `rt418-payer-key-${(keySeq += 1).toString().padStart(8, "0")}`;

function create(session: string | null, body: object, key: string | null = freshKey()): request.Test {
  const req = asSession(request(server()).post(URL).set("Origin", "http://127.0.0.1").send(body), session);
  return key === null ? req : req.set("Idempotency-Key", key);
}
function list(session: string | null, query: Record<string, string | number> = {}): request.Test {
  return asSession(request(server()).get(URL).query(query), session);
}

function expectError(res: request.Response, status: number, code: string): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
  conforms("Error", res.body);
}

async function payerCount(displayName: string): Promise<number> {
  const r = await env!.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM payer_account WHERE display_name = $1`,
    [displayName],
  );
  return Number(r.rows[0]!.n);
}

const skip = (): boolean => skipped;

// ===========================================================================
// consoleCreatePayerAccount
// ===========================================================================
describe("consoleCreatePayerAccount", () => {
  it("creates a tenant-wide payer for an owner (201, contract shape, tenant server-resolved)", async () => {
    if (skip()) return;
    const res = await create(SES_OWNER_ALL, {
      category: "credit_customer",
      displayName: "Created tenant payer",
      externalRef: "CUST-NEW-1",
    }).expect(201);
    conforms("PayerAccount", res.body);
    expect(res.body).toEqual({
      payerRef: expect.any(String),
      category: "credit_customer",
      displayName: "Created tenant payer",
      externalRef: "CUST-NEW-1",
      status: "active",
      storeId: null,
      version: 0,
    });
    const row = await env!.admin.query(`SELECT tenant_id, store_id FROM payer_account WHERE id = $1`, [res.body.payerRef]);
    expect(row.rows[0]).toEqual({ tenant_id: TENANT_A, store_id: null });
  });

  it("creates a store-scoped payer inside a tenant_admin's store grant, with no externalRef (null)", async () => {
    if (skip()) return;
    const res = await create(SES_ADMIN_X, { category: "insurer", displayName: "Created X insurer", storeId: STORE_A_X }).expect(201);
    conforms("PayerAccount", res.body);
    expect(res.body).toMatchObject({ storeId: STORE_A_X, externalRef: null });
  });

  it.each([
    ["a store outside the caller's grant", SES_ADMIN_X, STORE_A_Y],
    ["a store outside the active store", SES_OWNER_ACTIVE_X, STORE_A_Y],
    ["another tenant's store", SES_OWNER_ALL, STORE_B_X],
    ["an absent store", SES_OWNER_ALL, ABSENT_STORE],
  ])("refuses %s as the same 404, writing nothing", async (_name, session, storeId) => {
    if (skip()) return;
    const displayName = `Refused store ${storeId}-${session}`;
    expectError(await create(session, { category: "corporate", displayName, storeId }), 404, "not_found");
    expect(await payerCount(displayName)).toBe(0);
  });

  it("lets a tenant_admin with a specific store grant create a tenant-wide payer (storeId null)", async () => {
    if (skip()) return;
    const res = await create(SES_ADMIN_X, { category: "corporate", displayName: "Admin tenant-wide", storeId: null });
    expect(res.status).toBe(201);
    expect(res.body.storeId).toBeNull();
  });

  it.each([
    ["creditTerms (removed in 2.0.0)", { creditTerms: { days: 30 } }],
    ["a blank externalRef", { externalRef: "   " }],
    ["a tab-only externalRef", { externalRef: "\t" }],
    ["an empty externalRef", { externalRef: "" }],
    ["a smuggled tenant_id", { tenant_id: TENANT_B }],
    ["an unknown category", { category: "bank" }],
    ["an empty displayName", { displayName: "" }],
    ["a malformed storeId", { storeId: "store-x" }],
  ])("refuses %s with 400 validation_error, writing nothing", async (_name, patch) => {
    if (skip()) return;
    const body = { category: "corporate", displayName: "Invalid body payer", ...patch };
    expectError(await create(SES_OWNER_ALL, body), 400, "validation_error");
    expect(await payerCount("Invalid body payer")).toBe(0);
  });

  it("refuses a write without an Idempotency-Key (400)", async () => {
    if (skip()) return;
    const res = await create(SES_OWNER_ALL, { category: "corporate", displayName: "No key payer" }, null);
    expect(res.status).toBe(400);
    expect(await payerCount("No key payer")).toBe(0);
  });

  it("is idempotent: a replay returns the same payer, a changed body under the key is 409", async () => {
    if (skip()) return;
    const key = freshKey();
    const body = { category: "corporate", displayName: "Idempotent payer", externalRef: "CUST-IDEM" };
    const first = await create(SES_OWNER_ALL, body, key).expect(201);
    const replay = await create(SES_OWNER_ALL, body, key);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.payerRef).toBe(first.body.payerRef);
    expect(await payerCount("Idempotent payer")).toBe(1);
    const changed = await create(SES_OWNER_ALL, { ...body, externalRef: "CUST-OTHER" }, key);
    expectError(changed, 409, "idempotency_key_conflict");
    expect(await payerCount("Idempotent payer")).toBe(1);
  });

  it.each([
    ["store_manager", SES_MANAGER],
    ["store_staff", SES_STAFF],
  ])("refuses a %s with 403, writing nothing", async (_role, session) => {
    if (skip()) return;
    const displayName = `Refused role payer ${session}`;
    const res = await create(session, { category: "corporate", displayName });
    expect(res.status).toBe(403);
    conforms("Error", res.body);
    expect(await payerCount(displayName)).toBe(0);
  });

  it("refuses an unauthenticated request with 401", async () => {
    if (skip()) return;
    expect((await create(null, { category: "corporate", displayName: "Anon payer" })).status).toBe(401);
    expect(await payerCount("Anon payer")).toBe(0);
  });
});

// ===========================================================================
// consoleListPayerAccounts
// ===========================================================================
type Page = { items: Array<{ payerRef: string; storeId: string | null; category: string }>; nextCursor: string | null };

async function page(session: string, query: Record<string, string | number> = {}): Promise<Page> {
  const res = await list(session, query).expect(200);
  conforms("PayerAccountPage", res.body);
  return res.body as Page;
}

async function seededIds(session: string, query: Record<string, string | number> = {}): Promise<string[]> {
  const body = await page(session, { page_size: 200, ...query });
  expect(body.nextCursor).toBeNull();
  const seeded = new Set([...SEEDED_A_ALL, P_B]);
  return body.items.map((i) => i.payerRef).filter((id) => seeded.has(id));
}

describe("consoleListPayerAccounts", () => {
  it("lists the tenant's payers newest-first for an all-store owner, never another tenant's", async () => {
    if (skip()) return;
    expect(await seededIds(SES_OWNER_ALL)).toEqual(SEEDED_A_ALL);
    expect(await seededIds(SES_OWNER_B)).toEqual([P_B]);
  });

  it("excludes store-scoped payers outside the caller's store access", async () => {
    if (skip()) return;
    expect(await seededIds(SES_ADMIN_X)).toEqual([P_TENANT_INSURER, P_X, P_TENANT_OLD]);
    expect(await seededIds(SES_OWNER_ACTIVE_X)).toEqual([P_TENANT_INSURER, P_X, P_TENANT_OLD]);
  });

  it("filters by category", async () => {
    if (skip()) return;
    expect(await seededIds(SES_OWNER_ALL, { category: "corporate" })).toEqual([P_Y, P_X]);
  });

  it("walks every page once at every page size, in the same order", async () => {
    if (skip()) return;
    const full = (await page(SES_OWNER_ALL, { page_size: 200 })).items.map((i) => i.payerRef);
    for (const size of [1, 2, 3]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let n = 0; n < 100; n += 1) {
        const body = await page(SES_OWNER_ALL, { page_size: size, ...(cursor ? { cursor } : {}) });
        expect(body.items.length).toBeLessThanOrEqual(size);
        seen.push(...body.items.map((i) => i.payerRef));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }
      expect(seen).toEqual(full);
    }
  });

  it.each([
    [{ cursor: "not-a-cursor" }],
    [{ page_size: 0 }],
    [{ page_size: 201 }],
    [{ category: "bank" }],
    [{ tenant_id: TENANT_B }],
  ])("answers 400 validation_error for %p", async (query) => {
    if (skip()) return;
    expectError(await list(SES_OWNER_ALL, query), 400, "validation_error");
  });

  it.each([
    ["store_manager", SES_MANAGER],
    ["store_staff", SES_STAFF],
  ])("refuses a %s with 403", async (_role, session) => {
    if (skip()) return;
    const res = await list(session);
    expect(res.status).toBe(403);
    conforms("Error", res.body);
  });

  it("refuses an unauthenticated request with 401", async () => {
    if (skip()) return;
    expect((await list(null)).status).toBe(401);
  });
});
