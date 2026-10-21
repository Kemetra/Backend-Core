/**
 * RT-802 — `GET /api/pos/v1/payer-accounts` (`posListChargeablePayers`,
 * `pos-payers.openapi.yaml` 1.0.0-draft, RT-570) end to end against a real
 * RLS-forced Postgres: the real PosPayersController / PosPayersService on
 * `env.app`, the global exception filter, and the RT-530 approver population.
 *
 * The envelope guard is replaced by a configurable stand-in that publishes
 * what the real `PosOperatorEnvelopeSaleGuard` publishes (tenant, store and
 * operator from the verified envelope) or refuses with the generic 401; the
 * guard's own auth and live re-verification are covered by its specs. The
 * operator's ROLE is checked for real, on the domain pool, every request.
 *
 * Acceptance (RT-802 AC2, AC3):
 *   - role refusal: a cashier, a store manager without access to this store, a
 *     revoked membership and a user of another tenant are 403
 *     `sale_responsibility_role_refused` (one body), before any 400;
 *   - other-store, other-tenant and suspended payers are absent;
 *   - an unlinked or blank-linked payer is `erpCustomerLinked: false,
 *     chargeable: false`;
 *   - pagination is stable (payerRef DESC, no duplicate, no skip) and its
 *     cursor is bound to the tenant, the store and the category;
 *   - `chargeable` agrees with `captureSale`'s payer check on every payer;
 *   - every 200 validates against `PosPayerPage`, is `no-store`, and minimal.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { runWithTenantContext } from "@data-pulse-2/db";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { Pool } from "pg";
import request from "supertest";

import { PG_POOL } from "../../../../src/auth/auth.module";
import { PosOperatorEnvelopeSaleGuard } from "../../../../src/auth/pos-operator-envelope-sale.guard";
import { PosWriteRateLimitGuard } from "../../../../src/auth/pos-write-rate-limit.guard";
import { PosPayersController } from "../../../../src/catalog/sales/payers/pos-payers.controller";
import { PosPayersService } from "../../../../src/catalog/sales/payers/pos-payers.service";
import { assertResponsibilityPayersEligible } from "../../../../src/catalog/sales/sale-responsibilities";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import type { TenantContextRequest } from "../../../../src/context/types";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { allContracts, contractDocument } from "../../../_helpers/openapi-contract";
import { seedCatalogIsolationFixture, STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../../__support__/isolation-harness";
import {
  APPROVER_CASHIER,
  APPROVER_MANAGER,
  APPROVER_NO_STORE,
  APPROVER_OTHER_TENANT,
  APPROVER_OWNER,
  APPROVER_REVOKED,
  APPROVER_TENANT_ADMIN,
  seedVoidApprovers,
} from "../__support__/void-approval-fixture";

const PATH = "/api/pos/v1/payer-accounts";
const CONTRACT_ID = "pos-payers.openapi";

// payerRef DESC is the order; ids are chosen so the expected order is plain.
const P_STORE = "0a000000-0000-7000-8000-0000008027a9";
const P_TENANT = "0a000000-0000-7000-8000-0000008027a8";
const P_UNLINKED = "0a000000-0000-7000-8000-0000008027a7";
const P_BLANK = "0a000000-0000-7000-8000-0000008027a6";
const P_STORE_INSURER = "0a000000-0000-7000-8000-0000008027a5";
const P_OTHER_STORE = "0a000000-0000-7000-8000-0000008027a4";
const P_SUSPENDED = "0a000000-0000-7000-8000-0000008027a3";
const P_TENANT_B = "0b000000-0000-7000-8000-0000008027b1";

/** The payers the STORE_A_X envelope may see, in payerRef DESC order. */
const VISIBLE = [P_STORE, P_TENANT, P_UNLINKED, P_BLANK, P_STORE_INSURER];
const ALL = [...VISIBLE, P_OTHER_STORE, P_SUSPENDED, P_TENANT_B];

/** Publishes the envelope's verified scope, or refuses like the real guard (generic 401). */
class StandInEnvelopeGuard implements CanActivate {
  tenantId = TENANT_A;
  storeId = STORE_A_X;
  userId = APPROVER_MANAGER;
  anonymous = false;

  canActivate(ctx: ExecutionContext): boolean {
    if (this.anonymous) throw new UnauthorizedException("Unauthorized");
    const req = ctx.switchToHttp().getRequest<TenantContextRequest>();
    req.context = { userId: this.userId, tenantId: this.tenantId, storeId: this.storeId, isPlatformAdmin: false, source: "token" };
    req.principal = {
      kind: "token",
      tokenId: "0a000000-0000-7000-8000-0000008027f1",
      tenantId: this.tenantId,
      userId: this.userId,
      storeId: this.storeId,
      scope: "pos_operator",
    };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
const guard = new StandInEnvelopeGuard();
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

function validator(name: "PosPayerPage" | "Error"): ValidateFunction {
  const compiled = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (compiled === undefined) throw new Error(`ajv cannot resolve ${name}`);
  return compiled;
}

beforeAll(async () => {
  ajv.addSchema(contractDocument(allContracts(), CONTRACT_ID) as object, CONTRACT_ID);
  try {
    env = await startPgEnv();
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") return;
    throw err;
  }
  try {
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await seedVoidApprovers(env.admin);
    await env.admin.query(
      `INSERT INTO payer_account (id, tenant_id, store_id, category, display_name, external_ref, status) VALUES
         ($1, $9,  $11,  'corporate',       'Store X corp',    'CUST-X',  'active'),
         ($2, $9,  NULL, 'credit_customer', 'House account',   'CUST-T',  'active'),
         ($3, $9,  NULL, 'insurer',         'Unlinked',        NULL,      'active'),
         ($4, $9,  NULL, 'insurer',         'Blank link',      E' \\t ',  'active'),
         ($5, $9,  $11,  'insurer',         'Store X insurer', 'CUST-XI', 'active'),
         ($6, $9,  $12,  'corporate',       'Store Y corp',    'CUST-Y',  'active'),
         ($7, $9,  $11,  'insurer',         'Suspended',       'CUST-S',  'suspended'),
         ($8, $10, $13,  'insurer',         'Tenant B',        'CUST-B',  'active')`,
      [P_STORE, P_TENANT, P_UNLINKED, P_BLANK, P_STORE_INSURER, P_OTHER_STORE, P_SUSPENDED, P_TENANT_B, TENANT_A, TENANT_B, STORE_A_X, STORE_A_Y, STORE_B_X],
    );
    const pgEnv = env;
    const moduleRef = await Test.createTestingModule({
      controllers: [PosPayersController],
      providers: [{ provide: PG_POOL, useFactory: (): Pool => pgEnv.app }, PosPayersService],
    })
      .overrideGuard(PosOperatorEnvelopeSaleGuard)
      .useValue(guard)
      .overrideGuard(PosWriteRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  } catch (err) {
    if (app) await app.close().catch(() => undefined);
    await stopPgEnv(env).catch(() => undefined);
    env = null;
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  guard.tenantId = TENANT_A;
  guard.storeId = STORE_A_X;
  guard.userId = APPROVER_MANAGER;
  guard.anonymous = false;
});

const skip = (): boolean => app === null;
const get = (query: Record<string, string> = {}) => request(app!.getHttpServer()).get(PATH).query(query);

function expectPage(res: request.Response): void {
  expect(res.status).toBe(200);
  const validate = validator("PosPayerPage");
  const valid = validate(res.body);
  expect(validate.errors ?? []).toEqual([]);
  expect(valid).toBe(true);
  expect(res.headers["cache-control"]).toBe("no-store");
}

const refs = (res: request.Response): string[] => (res.body.items as Array<{ payerRef: string }>).map((i) => i.payerRef);

// ===========================================================================
describe("RT-802 — who may read", () => {
  it.each([
    ["store_manager of this store", APPROVER_MANAGER],
    ["tenant_admin", APPROVER_TENANT_ADMIN],
    ["owner", APPROVER_OWNER],
  ])("a %s envelope reads the page", async (_role, userId) => {
    if (skip()) return;
    guard.userId = userId;
    const res = await get();
    expectPage(res);
    expect(refs(res)).toEqual(VISIBLE);
  });

  it.each([
    ["a cashier", APPROVER_CASHIER],
    ["a store manager without access to this store", APPROVER_NO_STORE],
    ["a revoked membership", APPROVER_REVOKED],
    ["a user of another tenant", APPROVER_OTHER_TENANT],
  ])("%s is 403 sale_responsibility_role_refused, one body", async (_label, userId) => {
    if (skip()) return;
    guard.userId = userId;
    const res = await get();
    expect(res.status).toBe(403);
    expect(validator("Error")(res.body)).toBe(true);
    expect(res.body.error.code).toBe("sale_responsibility_role_refused");
    expect(res.body.error.message).toBe("credit sales need an owner, tenant admin or store manager");
  });

  it("decides the role before the query: a cashier with a malformed query is 403, not 400", async () => {
    if (skip()) return;
    guard.userId = APPROVER_CASHIER;
    const res = await get({ page_size: "0", store_id: STORE_A_Y });
    expect(res.status).toBe(403);
  });

  it("a missing or invalid envelope is the generic 401", async () => {
    if (skip()) return;
    guard.anonymous = true;
    const res = await get();
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
describe("RT-802 — what it returns", () => {
  it("omits other-store, other-tenant and suspended payers, with no marker", async () => {
    if (skip()) return;
    const res = await get({ page_size: "200" });
    expectPage(res);
    for (const absent of [P_OTHER_STORE, P_SUSPENDED, P_TENANT_B]) expect(refs(res)).not.toContain(absent);
    expect(res.body.nextCursor).toBeNull();
  });

  it("projects the minimum: five fields per payer, linked payers chargeable, unlinked and blank-linked not", async () => {
    if (skip()) return;
    const res = await get();
    expectPage(res);
    const byRef = new Map((res.body.items as Array<Record<string, unknown>>).map((i) => [i["payerRef"], i]));
    expect(byRef.get(P_STORE)).toEqual({
      payerRef: P_STORE,
      displayName: "Store X corp",
      category: "corporate",
      erpCustomerLinked: true,
      chargeable: true,
    });
    for (const unlinked of [P_UNLINKED, P_BLANK]) {
      expect(byRef.get(unlinked)).toMatchObject({ erpCustomerLinked: false, chargeable: false });
    }
    expect(JSON.stringify(res.body)).not.toMatch(/CUST-|storeId|status|version|tenant/);
  });

  it("a store's view is its own: the STORE_A_Y envelope sees its payer and not STORE_A_X's", async () => {
    if (skip()) return;
    guard.userId = APPROVER_TENANT_ADMIN;
    guard.storeId = STORE_A_Y;
    const res = await get();
    expectPage(res);
    expect(refs(res)).toEqual([P_TENANT, P_UNLINKED, P_BLANK, P_OTHER_STORE]);
  });

  it("filters by category", async () => {
    if (skip()) return;
    const res = await get({ category: "insurer" });
    expectPage(res);
    expect(refs(res)).toEqual([P_UNLINKED, P_BLANK, P_STORE_INSURER]);
  });

  it("an empty category page is a 200", async () => {
    if (skip()) return;
    guard.storeId = STORE_A_Y;
    guard.userId = APPROVER_OWNER;
    const res = await get({ category: "corporate", page_size: "1" });
    expectPage(res);
    expect(refs(res)).toEqual([P_OTHER_STORE]);
    expect(res.body.nextCursor).toBeNull();
  });

  it("asOf is the server's read time", async () => {
    if (skip()) return;
    const before = Date.now();
    const res = await get();
    expectPage(res);
    const asOf = Date.parse(res.body.asOf as string);
    expect(asOf).toBeGreaterThanOrEqual(before - 5_000);
    expect(asOf).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it("chargeable agrees with captureSale's payer check for every payer (AC3)", async () => {
    if (skip()) return;
    const res = await get({ page_size: "200" });
    const listed = new Map((res.body.items as Array<{ payerRef: string; chargeable: boolean }>).map((i) => [i.payerRef, i.chargeable]));
    for (const payerRef of ALL) {
      const captureAccepts = await runWithTenantContext(env!.app, { tenantId: TENANT_A, isPlatformAdmin: false }, (client) =>
        assertResponsibilityPayersEligible(client, { tenantId: TENANT_A, storeId: STORE_A_X }, [
          { payerRef, amount: "1", sequence: 1 },
        ]).then(
          () => true,
          () => false,
        ),
      );
      expect({ payerRef, chargeable: listed.get(payerRef) ?? false }).toEqual({ payerRef, chargeable: captureAccepts });
    }
  });
});

// ===========================================================================
describe("RT-802 — paging", () => {
  it("walks payerRef DESC in pages of 2 with no duplicate and no skip", async () => {
    if (skip()) return;
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const res = await get({ page_size: "2", ...(cursor !== null ? { cursor } : {}) });
      expectPage(res);
      seen.push(...refs(res));
      cursor = res.body.nextCursor as string | null;
      if (cursor === null) break;
    }
    expect(seen).toEqual(VISIBLE);
  });

  it("a category walk keeps its filter", async () => {
    if (skip()) return;
    const first = await get({ category: "insurer", page_size: "2" });
    expectPage(first);
    const second = await get({ category: "insurer", page_size: "2", cursor: first.body.nextCursor as string });
    expectPage(second);
    expect([...refs(first), ...refs(second)]).toEqual([P_UNLINKED, P_BLANK, P_STORE_INSURER]);
  });

  it.each([
    ["with another category", (cursor: string) => ({ cursor, category: "insurer" })],
    ["at another store", (cursor: string) => ({ cursor, __store: STORE_A_Y })],
  ])("refuses a cursor reused %s → 400 validation_error", async (_label, build) => {
    if (skip()) return;
    const first = await get({ page_size: "1" });
    const query = build(first.body.nextCursor as string) as Record<string, string>;
    if (query["__store"] !== undefined) {
      guard.storeId = query["__store"];
      guard.userId = APPROVER_OWNER;
      delete query["__store"];
    }
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(validator("Error")(res.body)).toBe(true);
    expect(res.body.error.code).toBe("validation_error");
  });

  it.each([
    ["a Console raw-uuid cursor", { cursor: P_STORE }],
    ["an unknown key", { store_id: STORE_A_Y }],
    ["a free-text search", { q: "House" }],
    ["a malformed category", { category: "bank" }],
    ["page_size 201", { page_size: "201" }],
  ])("%s → 400 validation_error", async (_label, query) => {
    if (skip()) return;
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(validator("Error")(res.body)).toBe(true);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("a repeated key → 400, never a 500", async () => {
    if (skip()) return;
    const res = await request(app!.getHttpServer()).get(`${PATH}?category=insurer&category=corporate`);
    expect(res.status).toBe(400);
  });
});
