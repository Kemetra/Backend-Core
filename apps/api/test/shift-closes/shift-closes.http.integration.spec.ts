/**
 * RT-383 — the admin shift-close reads over HTTP against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool) and the
 * real module graph (`TenantContextGuard`, `RolesGuard`,
 * `MembershipRepository`). Only cookie authentication is faked: a header
 * names the session (the RT-192 / RT-193 pattern).
 *
 *   GET /api/v1/shift-closes            consoleListShiftCloses
 *   GET /api/v1/shift-closes/{shiftId}  consoleGetShiftClose
 *
 * What this proves (RT-383 acceptance):
 *   - tenant isolation (RLS) and the operator store scope: owner / tenant_admin
 *     get their membership's scope (not narrowed by the active store),
 *     store_manager the standard scope (narrowed by the active store); an empty
 *     scope fails closed;
 *   - the non-disclosing 404: a role outside the list, another tenant's shift,
 *     an out-of-scope store, an open shift, a legacy shift and an absent id are
 *     the same 404, and so is a `store_id` filter outside the scope;
 *   - ordering and pagination stability: newest first by (closedAt, shiftId),
 *     microsecond ties kept apart; every page size walks the same rows once;
 *     the walk is not a snapshot exactly as the contract states;
 *   - each filter, and the 400 `validation_error` refusals;
 *   - every 200 and error body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import request from "supertest";

import { loadOpenApiContracts } from "../../src/openapi/loader";
import { encodeShiftCloseCursor } from "../../src/shift-closes/shift-closes.projections";
import { ShiftClosesModule } from "../../src/shift-closes/shift-closes.module";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import {
  bootScopedApp,
  NON_EXISTENT,
  SES_ADMIN_SPEC,
  SES_OWNER_ALL,
  SES_OWNER_ALL_ACTIVE,
  SES_OWNER_SPEC,
} from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  APPROVER_A,
  CASHIER_A,
  CLOSE_B,
  CLOSE_DEL,
  CLOSE_X1,
  CLOSE_X3,
  CLOSE_X4,
  CLOSE_Y2,
  CLOSE_Y5,
  CLOSE_Y6,
  LEGACY_X,
  MANAGER_DASHBOARD_TOKEN,
  MOVEMENT_X3_PAY_IN,
  MOVEMENT_X3_PAY_OUT,
  NO_SHIFT,
  OPEN_X,
  RETURN_X3,
  SCOPE_AX,
  SCOPE_AY,
  SES_ADMIN_EMPTY,
  SES_MANAGER,
  SES_MANAGER_ACTIVE,
  SES_STAFF,
  seedClose,
  seedShiftCloseFixture,
  TENANT_A_ORDER,
} from "./__support__/shift-close-fixture";

const LIST = "/api/v1/shift-closes";
const detail = (shiftId: string): string => `${LIST}/${shiftId}`;
/** The RolesGuard role refusal body; every 404 of this surface must equal it. */
const NOT_FOUND = { code: "not_found", message: "Not Found" };
const CONTRACT_ID = "shift-closes.openapi";

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let app: INestApplication | null = null;

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
let pageSchema: ValidateFunction;
let detailSchema: ValidateFunction;
let errorSchema: ValidateFunction;

beforeAll(async () => {
  const found = loadOpenApiContracts().find((c) => c.id === CONTRACT_ID);
  if (!found) throw new Error(`${CONTRACT_ID} not found in packages/contracts/openapi/`);
  ajv.addSchema(found.document as object, CONTRACT_ID);
  const compiled = (name: string): ValidateFunction => {
    const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
    if (!v) throw new Error(`ajv cannot resolve ${name}`);
    return v;
  };
  pageSchema = compiled("ShiftClosePage");
  detailSchema = compiled("ShiftCloseDetail");
  errorSchema = compiled("Error");

  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedShiftCloseFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-383 shift-closes] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  // Bearer tokens resolve on the RLS-exempt pool, as the production auth-lookup role does.
  app = await bootScopedApp(env, ShiftClosesModule, undefined, { authLookupPool: env.admin });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-383 shift-closes] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function get(path: string, session: string | null, query: Record<string, string | number> = {}) {
  const req = request(app!.getHttpServer()).get(path).query(query);
  return session === null ? req : req.set("x-test-session", session);
}

function expectValid(validate: ValidateFunction, body: unknown): void {
  const ok = validate(body);
  if (!ok) throw new Error(`contract violation: ${JSON.stringify(validate.errors)}`);
}

/** One page; asserts 200 and the `ShiftClosePage` contract shape. */
async function page(session: string, query: Record<string, string | number> = {}) {
  const res = await get(LIST, session, query).expect(200);
  expectValid(pageSchema, res.body);
  return res.body as { items: Array<Record<string, unknown> & { shiftId: string }>; nextCursor: string | null };
}

/** The shift ids of the first page (page_size 200: every fixture row fits). */
async function ids(session: string, query: Record<string, string | number> = {}): Promise<string[]> {
  const body = await page(session, { page_size: 200, ...query });
  expect(body.nextCursor).toBeNull();
  return body.items.map((i) => i.shiftId);
}

/** Walk every page at `pageSize`; the ids in order and the number of pages. */
async function walk(session: string, pageSize: number, query: Record<string, string> = {}) {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let pages = 1; pages <= 50; pages += 1) {
    const body = await page(session, { ...query, page_size: pageSize, ...(cursor ? { cursor } : {}) });
    expect(body.items.length).toBeLessThanOrEqual(pageSize);
    seen.push(...body.items.map((i) => i.shiftId));
    cursor = body.nextCursor;
    if (cursor === null) return { ids: seen, pages };
  }
  throw new Error("shift-close paging did not terminate");
}

/** A 404 whose body is exactly the role refusal's, apart from its request_id. */
async function expectNotFound(res: request.Response): Promise<void> {
  expect(res.status).toBe(404);
  expectValid(errorSchema, res.body);
  expect(Object.keys(res.body)).toEqual(["error"]);
  expect({ ...res.body.error, request_id: undefined }).toEqual({ ...NOT_FOUND, request_id: undefined });
}

async function expectValidationError(res: request.Response): Promise<void> {
  expect(res.status).toBe(400);
  expectValid(errorSchema, res.body);
  expect(res.body.error.code).toBe("validation_error");
}

const X_ONLY = [CLOSE_X4, CLOSE_X3, CLOSE_X1];
const Y_ONLY = [CLOSE_Y6, CLOSE_Y5, CLOSE_Y2];

// ===========================================================================
// Auth, role and store scope
// ===========================================================================

describe("RT-383 shift-closes — role and store scope", () => {
  it.each([
    ["owner, specific (X + deleted store)", SES_OWNER_SPEC, X_ONLY],
    ["tenant_admin, specific (X)", SES_ADMIN_SPEC, X_ONLY],
    ["owner, all, no active store", SES_OWNER_ALL, TENANT_A_ORDER],
    ["owner, all, X active (not narrowed)", SES_OWNER_ALL_ACTIVE, TENANT_A_ORDER],
    ["store_manager, specific (X + Y)", SES_MANAGER, [CLOSE_Y6, CLOSE_Y5, CLOSE_X4, CLOSE_X3, CLOSE_Y2, CLOSE_X1]],
    ["store_manager, Y active (narrowed)", SES_MANAGER_ACTIVE, Y_ONLY],
    ["tenant_admin with an empty scope (fails closed)", SES_ADMIN_EMPTY, []],
  ])("%s lists exactly its stores' closes, newest first", async (_label, session, expected) => {
    if (skip()) return;
    expect(await ids(session)).toEqual(expected);
  });

  it("never lists another tenant's close", async () => {
    if (skip()) return;
    for (const session of [SES_OWNER_ALL, SES_MANAGER, SES_OWNER_SPEC]) {
      expect(await ids(session)).not.toContain(CLOSE_B);
    }
  });

  it("store_staff is the non-disclosing 404 on both reads", async () => {
    if (skip()) return;
    await expectNotFound(await get(LIST, SES_STAFF));
    await expectNotFound(await get(detail(CLOSE_X1), SES_STAFF));
  });

  it("no session is 401", async () => {
    if (skip()) return;
    expect((await get(LIST, null)).status).toBe(401);
    expect((await get(detail(CLOSE_X1), null)).status).toBe(401);
  });

  it("a dashboard_api bearer of an allowed, in-scope member is 401 (cookie session only)", async () => {
    if (skip()) return;
    for (const path of [LIST, detail(CLOSE_X1)]) {
      const res = await get(path, null).set("Authorization", `Bearer ${MANAGER_DASHBOARD_TOKEN}`);
      expect(res.status).toBe(401);
      expectValid(errorSchema, res.body);
    }
  });
});

describe("RT-383 shift-closes — the non-disclosing detail 404", () => {
  it.each([
    ["another tenant's close", SES_OWNER_ALL, CLOSE_B],
    ["a store outside a specific owner's scope", SES_OWNER_SPEC, CLOSE_Y2],
    ["a soft-deleted store's close for a specific owner", SES_OWNER_SPEC, CLOSE_DEL],
    ["a store outside a narrowed manager's scope", SES_MANAGER_ACTIVE, CLOSE_X3],
    ["an empty scope", SES_ADMIN_EMPTY, CLOSE_X1],
    ["an open cash-up shift", SES_OWNER_ALL, OPEN_X],
    ["a legacy shift", SES_OWNER_ALL, LEGACY_X],
    ["an absent id", SES_OWNER_ALL, NO_SHIFT],
  ])("%s is the same 404", async (_label, session, shiftId) => {
    if (skip()) return;
    await expectNotFound(await get(detail(shiftId), session));
  });

  it("the same close is readable where it is in scope", async () => {
    if (skip()) return;
    for (const [session, shiftId] of [
      [SES_OWNER_ALL, CLOSE_Y2],
      [SES_OWNER_ALL, CLOSE_DEL],
      [SES_MANAGER, CLOSE_X3],
      [SES_MANAGER_ACTIVE, CLOSE_Y2],
    ] as const) {
      const res = await get(detail(shiftId), session).expect(200);
      expectValid(detailSchema, res.body);
      expect(res.body.shiftId).toBe(shiftId);
    }
  });

  it.each([
    ["a store outside a specific owner's scope", SES_OWNER_SPEC, STORE_A_Y],
    ["another tenant's store", SES_OWNER_ALL, STORE_B_X],
    ["an absent store", SES_OWNER_ALL, NON_EXISTENT],
    ["a store outside a narrowed manager's scope", SES_MANAGER_ACTIVE, STORE_A_X],
  ])("a store_id filter naming %s is the same 404", async (_label, session, storeId) => {
    if (skip()) return;
    await expectNotFound(await get(LIST, session, { store_id: storeId }));
  });
});

// ===========================================================================
// Detail projection
// ===========================================================================

describe("RT-383 shift-closes — detail", () => {
  it("returns the close, its opening, its movements and its claimed returns", async () => {
    if (skip()) return;
    const res = await get(detail(CLOSE_X3), SES_OWNER_SPEC).expect(200);
    expectValid(detailSchema, res.body);
    expect(res.body).toEqual({
      shiftId: CLOSE_X3,
      storeId: STORE_A_X,
      currencyCode: "EGP",
      openedAt: "2026-10-03T02:00:00.000Z",
      openingUserId: CASHIER_A,
      closedAt: "2026-10-03T10:00:00.000Z",
      closeKind: "forced",
      forcedReason: "Cashier left without closing",
      closingUserId: CASHIER_A,
      recordedByUserId: CASHIER_A,
      varianceApprovedByUserId: null,
      openingFloat: "500.00",
      cashSalesTotal: "1000.00",
      cashRefundsTotal: "25.00",
      payInTotal: "50.00",
      payOutTotal: "20.00",
      expectedCash: "1505.00",
      countedCash: "1517.50",
      variance: "12.50",
      saleCount: 7,
      receivedAt: expect.any(String),
      cashRefundReturnRefs: [RETURN_X3],
      // Same occurredAt: ties broken by movementId (PAY_OUT's id sorts first).
      cashMovements: [
        {
          movementId: MOVEMENT_X3_PAY_OUT,
          kind: "pay_out",
          amount: "20.00",
          reasonCode: "petty_expense",
          note: "Cleaning supplies",
          occurredAt: "2026-10-03T06:00:00.000Z",
          recordedByUserId: CASHIER_A,
          receivedAt: expect.any(String),
        },
        {
          movementId: MOVEMENT_X3_PAY_IN,
          kind: "pay_in",
          amount: "50.00",
          reasonCode: "float_top_up",
          note: null,
          occurredAt: "2026-10-03T06:00:00.000Z",
          recordedByUserId: CASHIER_A,
          receivedAt: expect.any(String),
        },
      ],
    });
  });

  it("a close with no movements or refunds returns empty arrays and a recorded approver", async () => {
    if (skip()) return;
    const res = await get(detail(CLOSE_X4), SES_OWNER_SPEC).expect(200);
    expectValid(detailSchema, res.body);
    expect(res.body).toMatchObject({
      closeKind: "normal",
      forcedReason: null,
      varianceApprovedByUserId: APPROVER_A,
      variance: "-100.00",
      cashRefundReturnRefs: [],
      cashMovements: [],
    });
  });

  it("accepts an upper-case shiftId", async () => {
    if (skip()) return;
    const res = await get(detail(CLOSE_X3.toUpperCase()), SES_OWNER_SPEC).expect(200);
    expect(res.body.shiftId).toBe(CLOSE_X3);
  });

  it("a malformed shiftId is 400 validation_error", async () => {
    if (skip()) return;
    await expectValidationError(await get(detail("not-a-uuid"), SES_OWNER_ALL));
  });
});

// ===========================================================================
// List projection, ordering and paging
// ===========================================================================

describe("RT-383 shift-closes — list projection and ordering", () => {
  it("projects every key, with exact-decimal money in the close's currency", async () => {
    if (skip()) return;
    const body = await page(SES_OWNER_ALL, { currency_code: "USD" });
    expect(body).toEqual({
      items: [
        {
          shiftId: CLOSE_Y5,
          storeId: STORE_A_Y,
          currencyCode: "USD",
          closedAt: "2026-10-04T10:00:00.000Z",
          closeKind: "normal",
          forcedReason: null,
          closingUserId: CASHIER_A,
          varianceApprovedByUserId: null,
          openingFloat: "500.00",
          cashSalesTotal: "1000.00",
          cashRefundsTotal: "0.00",
          payInTotal: "0.00",
          payOutTotal: "0.00",
          expectedCash: "1500.00",
          countedCash: "1480.00",
          variance: "-20.00",
          saleCount: 7,
          receivedAt: expect.any(String),
        },
      ],
      nextCursor: null,
    });
  });

  it("orders closes in the same millisecond by their microseconds", async () => {
    if (skip()) return;
    // Y6 is one microsecond after Y5; both render as ...10:00:00.000Z.
    expect(await ids(SES_OWNER_ALL, { store_id: STORE_A_Y })).toEqual(Y_ONLY);
  });

  it.each([1, 2, 3, 4, 6, 7])("walks every close exactly once at page_size %i", async (size) => {
    if (skip()) return;
    const walked = await walk(SES_OWNER_ALL, size);
    expect(walked.ids).toEqual(TENANT_A_ORDER);
    expect(walked.pages).toBe(Math.ceil(TENANT_A_ORDER.length / size));
  });

  it("the walk is gap-free across the closedAt tie and the microsecond tie", async () => {
    if (skip()) return;
    // page_size 1 puts a page boundary between X4 / X3 and between Y6 / Y5.
    expect((await walk(SES_MANAGER, 1)).ids).toEqual([CLOSE_Y6, CLOSE_Y5, CLOSE_X4, CLOSE_X3, CLOSE_Y2, CLOSE_X1]);
  });

  it("the walk keeps the filters", async () => {
    if (skip()) return;
    expect((await walk(SES_OWNER_ALL, 1, { approval: "not_approved" })).ids).toEqual([
      CLOSE_DEL,
      CLOSE_Y6,
      CLOSE_Y5,
      CLOSE_X3,
      CLOSE_X1,
    ]);
  });

  it("defaults to 50 per page", async () => {
    if (skip()) return;
    expect((await page(SES_OWNER_ALL)).items.map((i) => i.shiftId)).toEqual(TENANT_A_ORDER);
  });

  it("a cursor from another tenant, of another shape or not base64url JSON is 400", async () => {
    if (skip()) return;
    const foreign = encodeShiftCloseCursor({
      tenantId: TENANT_B,
      closedAtKey: "2026-10-03T10:00:00.000000Z",
      shiftId: CLOSE_X3,
    });
    const otherShape = Buffer.from(JSON.stringify({ k: "i", t: TENANT_A }), "utf8").toString("base64url");
    // Well-formed and same-tenant, but no such day: refused before the timestamptz cast.
    const impossibleDay = encodeShiftCloseCursor({
      tenantId: TENANT_A,
      closedAtKey: "2026-02-31T00:00:00.000000Z",
      shiftId: CLOSE_X3,
    });
    for (const cursor of [foreign, otherShape, impossibleDay, "bm90LWpzb24"]) {
      await expectValidationError(await get(LIST, SES_OWNER_ALL, { cursor }));
    }
  });

  it("a cursor issued for this tenant resumes the walk", async () => {
    if (skip()) return;
    const cursor = encodeShiftCloseCursor({
      tenantId: TENANT_A,
      closedAtKey: "2026-10-03T10:00:00.000000Z",
      shiftId: CLOSE_X4,
    });
    expect(await ids(SES_OWNER_ALL, { cursor })).toEqual([CLOSE_X3, CLOSE_Y2, CLOSE_X1]);
  });
});

// ===========================================================================
// Filters
// ===========================================================================

describe("RT-383 shift-closes — filters", () => {
  it.each<[string, Record<string, string>, string[]]>([
    ["store_id", { store_id: STORE_A_Y }, Y_ONLY],
    ["store_id (upper case)", { store_id: STORE_A_X.toUpperCase() }, X_ONLY],
    [
      "closed_from is inclusive",
      { closed_from: "2026-10-03T10:00:00Z" },
      [CLOSE_DEL, CLOSE_Y6, CLOSE_Y5, CLOSE_X4, CLOSE_X3],
    ],
    ["closed_to is exclusive", { closed_to: "2026-10-03T10:00:00Z" }, [CLOSE_Y2, CLOSE_X1]],
    [
      "closed_from honours its offset",
      { closed_from: "2026-10-03T12:00:00+02:00" },
      [CLOSE_DEL, CLOSE_Y6, CLOSE_Y5, CLOSE_X4, CLOSE_X3],
    ],
    ["closed_from at microsecond precision", { closed_from: "2026-10-04T10:00:00.000002Z" }, [CLOSE_DEL, CLOSE_Y6]],
    [
      "a microsecond-wide range",
      { closed_from: "2026-10-04T10:00:00.000001Z", closed_to: "2026-10-04T10:00:00.000002Z" },
      [CLOSE_Y5],
    ],
    ["close_kind=forced", { close_kind: "forced" }, [CLOSE_X3]],
    [
      "close_kind=normal",
      { close_kind: "normal" },
      [CLOSE_DEL, CLOSE_Y6, CLOSE_Y5, CLOSE_X4, CLOSE_Y2, CLOSE_X1],
    ],
    ["min_abs_variance is inclusive and absolute", { min_abs_variance: "12.5" }, [CLOSE_Y5, CLOSE_X4, CLOSE_X3]],
    ["min_abs_variance compares exactly", { min_abs_variance: "12.5001" }, [CLOSE_Y5, CLOSE_X4]],
    ["min_abs_variance=0 keeps every close", { min_abs_variance: "0" }, TENANT_A_ORDER],
    ["currency_code", { currency_code: "USD" }, [CLOSE_Y5]],
    ["min_abs_variance with currency_code", { min_abs_variance: "12.50", currency_code: "EGP" }, [CLOSE_X4, CLOSE_X3]],
    ["approval=approved", { approval: "approved" }, [CLOSE_X4, CLOSE_Y2]],
    [
      "approval=not_approved includes zero-variance closes",
      { approval: "not_approved" },
      [CLOSE_DEL, CLOSE_Y6, CLOSE_Y5, CLOSE_X3, CLOSE_X1],
    ],
    [
      "unapproved variances",
      { approval: "not_approved", min_abs_variance: "0.01" },
      [CLOSE_Y6, CLOSE_Y5, CLOSE_X3],
    ],
    ["no match is an empty 200", { currency_code: "JPY" }, []],
  ])("%s", async (_label, query, expected) => {
    if (skip()) return;
    expect(await ids(SES_OWNER_ALL, query)).toEqual(expected);
  });

  it("filters stay inside the caller's scope", async () => {
    if (skip()) return;
    expect(await ids(SES_OWNER_SPEC, { approval: "approved" })).toEqual([CLOSE_X4]);
    expect(await ids(SES_MANAGER_ACTIVE, { min_abs_variance: "1" })).toEqual([CLOSE_Y6, CLOSE_Y5, CLOSE_Y2]);
  });

  it.each<[string, Record<string, string | number>]>([
    ["an unknown query key", { tenant_id: TENANT_B }],
    ["page_size 0", { page_size: 0 }],
    ["page_size 201", { page_size: 201 }],
    ["a non-integer page_size", { page_size: "1.5" }],
    ["an unknown close_kind", { close_kind: "voided" }],
    ["an unknown approval", { approval: "verified" }],
    ["a negative min_abs_variance", { min_abs_variance: "-1" }],
    ["a min_abs_variance with five fractional digits", { min_abs_variance: "1.12345" }],
    ["a lower-case currency_code", { currency_code: "egp" }],
    ["a date without a time", { closed_from: "2026-10-01" }],
    ["a date-time without an offset", { closed_from: "2026-10-01T10:00:00" }],
    ["closed_to equal to closed_from", { closed_from: "2026-10-03T10:00:00Z", closed_to: "2026-10-03T12:00:00+02:00" }],
    ["closed_to before closed_from", { closed_from: "2026-10-04T00:00:00Z", closed_to: "2026-10-03T00:00:00Z" }],
    [
      "closed_to a microsecond before closed_from",
      { closed_from: "2026-10-04T10:00:00.000002Z", closed_to: "2026-10-04T10:00:00.000001Z" },
    ],
    ["a malformed store_id", { store_id: "not-a-uuid" }],
    ["a cursor outside the token alphabet", { cursor: "a+b/c=" }],
  ])("%s is 400 validation_error", async (_label, query) => {
    if (skip()) return;
    await expectValidationError(await get(LIST, SES_OWNER_ALL, query));
  });
});

// ===========================================================================
// The walk is not a snapshot (contract "Ordering and paging"). Runs last: it
// records new closes. They are GBP, so the walk is isolated by currency_code.
// ===========================================================================

describe("RT-383 shift-closes — closes recorded during a walk", () => {
  const G1 = "0a000000-0000-7000-8000-0000038309a1";
  const G2 = "0a000000-0000-7000-8000-0000038309a2";
  const G_OLDER = "0a000000-0000-7000-8000-0000038309a3";
  const G_NEWER = "0a000000-0000-7000-8000-0000038309a4";
  const gbp = { opening: 10_000, sales: 0, refunds: 0, payIn: 0, payOut: 0, counted: 10_000 };

  it("returns an existing close once, a later-recorded older close, and not a later-recorded newer one", async () => {
    if (skip()) return;
    await seedClose(env!.app, { shiftId: G1, scope: SCOPE_AX, closedAt: "2026-09-01T10:00:00Z", currencyCode: "GBP", amounts: gbp });
    await seedClose(env!.app, { shiftId: G2, scope: SCOPE_AY, closedAt: "2026-09-02T10:00:00Z", currencyCode: "GBP", amounts: gbp });

    const first = await page(SES_OWNER_ALL, { currency_code: "GBP", page_size: 1 });
    expect(first.items.map((i) => i.shiftId)).toEqual([G2]);

    // Recorded mid-walk: one sorts after the position (older), one before it (newer).
    await seedClose(env!.app, { shiftId: G_OLDER, scope: SCOPE_AX, closedAt: "2026-08-01T10:00:00Z", currencyCode: "GBP", amounts: gbp });
    await seedClose(env!.app, { shiftId: G_NEWER, scope: SCOPE_AY, closedAt: "2026-09-30T10:00:00Z", currencyCode: "GBP", amounts: gbp });

    const rest: string[] = [];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const next = await page(SES_OWNER_ALL, { currency_code: "GBP", page_size: 1, cursor });
      rest.push(...next.items.map((i) => i.shiftId));
      cursor = next.nextCursor;
    }
    expect(rest).toEqual([G1, G_OLDER]);
    expect(await ids(SES_OWNER_ALL, { currency_code: "GBP" })).toEqual([G_NEWER, G2, G1, G_OLDER]);
  });
});
