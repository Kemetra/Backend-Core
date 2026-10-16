/**
 * RT-562 (RT-556 F2) — the console sales read over HTTP against real Postgres
 * (Testcontainers, every migration incl. 0048, the NOBYPASSRLS `app_test`
 * pool) and the real module graph (`SessionOnlyAdminGuard`,
 * `TenantContextGuard`, `RolesGuard`, `MembershipRepository`). Only cookie
 * authentication is faked: a header names the session (the RT-192 / RT-383
 * pattern); bearer tokens go through the real session-only guard.
 *
 *   GET /api/v1/sales            consoleListSales
 *   GET /api/v1/sales/{saleRef}  consoleGetSale
 *
 * What this proves (RT-562 acceptance, Admin-Console spec 012 §6.5 item 2):
 *   - the operator store scope (owner / tenant_admin not narrowed by the
 *     active store, store_manager narrowed, platform admin per the
 *     shift-closes runtime); cross-store, cross-tenant, absent and
 *     `store_staff` reads are one non-disclosing 404; every bearer is 401;
 *   - the inclusive 31-day range (400 beyond it), foreign cursors (400), and
 *     the 23:30 UTC sale on the next Cairo business date;
 *   - voided, partial / full return, tender-unknown, pre-RT-77 and unknown-ERP
 *     sales read correctly in the list and the detail;
 *   - the bounded page (empty with a non-null cursor), walks that see each sale
 *     once at every page size and stay stable while sales arrive;
 *   - the audit events and their metadata, after a 200 only;
 *   - every 200 and error body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import request from "supertest";

import type { AuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../src/audit/audit-job.types";
import { encodeSaleHistoryCursor } from "../../src/catalog/sales/history/sale-history.query";
import { ConsoleSalesModule } from "../../src/console-sales/console-sales.module";
import { encodeConsoleSaleCursor, SCAN_LIMIT_DEFAULT } from "../../src/console-sales/console-sales.query";
import { loadOpenApiContracts } from "../../src/openapi/loader";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../catalog/__support__/isolation-harness";
import {
  bootScopedApp,
  NON_EXISTENT,
  S_DELETED,
  SES_ADMIN_SPEC,
  SES_OWNER_ALL,
  SES_OWNER_ALL_ACTIVE,
  SES_OWNER_SPEC,
} from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  B_OCT02,
  BULK_COUNT,
  BULK_RANGE,
  BULK_REPAIR,
  BULK_REPAIR_NUMBER,
  BULK_VOID,
  CASHIER,
  DASHBOARD_TOKEN,
  DEL_OCT02,
  DEVICE_TOKEN,
  DEVICE_X,
  insertArrival,
  NO_SALE,
  OPERATOR_TOKEN,
  RETURN_PARTIAL,
  SALE_DOC,
  seedConsoleSalesFixture,
  SES_ADMIN_EMPTY,
  SES_MANAGER,
  SES_MANAGER_ACTIVE,
  SES_PLATFORM,
  SES_PLATFORM_ACTIVE,
  SES_PLATFORM_OWNER_ACTIVE,
  SES_STAFF,
  USER_MANAGER,
  X_FULL,
  X_LATE,
  X_LEGACY,
  X_NOV01,
  X_OCT01,
  X_OCT01_SALE_NUMBER,
  X_OCT31,
  X_OCTOBER,
  X_PARTIAL,
  X_SEP30,
  X_TIE_A,
  X_TIE_B,
  X_VOID,
  Y_OCT02,
} from "./__support__/console-sales-fixture";

const LIST = "/api/v1/sales";
const detailPath = (saleRef: string): string => `${LIST}/${saleRef}`;
const NOT_FOUND = { code: "not_found", message: "Not Found" };
const CONTRACT_ID = "console-sales.openapi";
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };
const X_OCT = { store_id: STORE_A_X, ...OCTOBER };

type Query = Record<string, string | number>;
interface Item {
  saleRef: string;
  storeRef: string;
  businessDate: string;
  [key: string]: unknown;
}
interface Page {
  items: Item[];
  nextCursor: string | null;
  [key: string]: unknown;
}

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  readonly payloads: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.payloads.push(payload);
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;
const audit = new SpyAuditEnqueuer();

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
  pageSchema = compiled("ConsoleSalePage");
  detailSchema = compiled("ConsoleSaleDetail");
  errorSchema = compiled("Error");

  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedConsoleSalesFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-562 console-sales] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  // Bearer tokens resolve on the RLS-exempt pool, as the production auth-lookup role does.
  app = await bootScopedApp(env, ConsoleSalesModule, audit, { authLookupPool: env.admin });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-562 console-sales] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function E(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

function get(path: string, session: string | null, query: Query | string = {}): request.Test {
  const req = request(app!.getHttpServer()).get(path).query(query);
  return session === null ? req : req.set("x-test-session", session);
}

function expectValid(validate: ValidateFunction, body: unknown): void {
  if (!validate(body)) throw new Error(`contract violation: ${JSON.stringify(validate.errors)}`);
}

/** One page; asserts 200, no-store and the `ConsoleSalePage` shape. */
async function page(session: string, query: Query): Promise<Page> {
  const res = await get(LIST, session, query);
  if (res.status !== 200) throw new Error(`list ${res.status}: ${JSON.stringify(res.body)}`);
  expect(res.headers["cache-control"]).toBe("no-store");
  expectValid(pageSchema, res.body);
  return res.body as Page;
}

/** The sale refs of one page that must also be the last. */
async function refs(session: string, query: Query): Promise<string[]> {
  const body = await page(session, { page_size: 100, ...query });
  expect(body.nextCursor).toBeNull();
  return body.items.map((i) => i.saleRef);
}

/** Walk every page; the refs in order and the number of pages. */
async function walk(session: string, query: Query): Promise<{ refs: string[]; pages: Page[] }> {
  const seen: string[] = [];
  const pages: Page[] = [];
  let cursor: string | null = null;
  for (let n = 1; n <= 100; n += 1) {
    const body = await page(session, { ...query, ...(cursor ? { cursor } : {}) });
    pages.push(body);
    seen.push(...body.items.map((i) => i.saleRef));
    cursor = body.nextCursor;
    if (cursor === null) return { refs: seen, pages };
  }
  throw new Error("console sales paging did not terminate");
}

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

/** A cursor issued for `query` on the X October range (page_size 1, after the first sale). */
async function cursorFor(session: string, query: Query): Promise<string> {
  const body = await page(session, { ...query, page_size: 1 });
  expect(body.nextCursor).not.toBeNull();
  return body.nextCursor!;
}

// ===========================================================================
// Auth, role and store scope
// ===========================================================================

describe("RT-562 console sales — role and store scope", () => {
  it.each([
    ["owner, all, no active store", SES_OWNER_ALL],
    ["owner, all, X active", SES_OWNER_ALL_ACTIVE],
    ["owner, specific (X + deleted)", SES_OWNER_SPEC],
    ["tenant_admin, specific (X)", SES_ADMIN_SPEC],
    ["store_manager, specific (X + Y)", SES_MANAGER],
    ["platform admin, no active store", SES_PLATFORM],
    ["platform admin, X active", SES_PLATFORM_ACTIVE],
  ])("%s lists store X", async (_label, session) => {
    if (skip()) return;
    expect(await refs(session, X_OCT)).toEqual(X_OCTOBER);
  });

  it.each([
    ["owner, all, no active store", SES_OWNER_ALL],
    ["owner, all, X active (not narrowed)", SES_OWNER_ALL_ACTIVE],
    ["store_manager, specific (X + Y)", SES_MANAGER],
    ["store_manager, Y active", SES_MANAGER_ACTIVE],
    ["platform admin, no active store (tenant-wide)", SES_PLATFORM],
  ])("%s lists store Y", async (_label, session) => {
    if (skip()) return;
    expect(await refs(session, { store_id: STORE_A_Y, ...OCTOBER })).toEqual([Y_OCT02]);
  });

  it("a platform admin who is also an owner gets the owner rule: not narrowed by the active store (shift-closes precedent)", async () => {
    if (skip()) return;
    expect(await refs(SES_PLATFORM_OWNER_ACTIVE, { store_id: STORE_A_Y, ...OCTOBER })).toEqual([Y_OCT02]);
    expect((await get(detailPath(Y_OCT02), SES_PLATFORM_OWNER_ACTIVE)).status).toBe(200);
    await expectNotFound(await get(LIST, SES_PLATFORM_OWNER_ACTIVE, { store_id: STORE_B_X, ...OCTOBER }));
    await expectNotFound(await get(detailPath(B_OCT02), SES_PLATFORM_OWNER_ACTIVE));
  });

  it("an owner with an `all` grant reads a soft-deleted store; a specific grant of it does not", async () => {
    if (skip()) return;
    expect(await refs(SES_OWNER_ALL, { store_id: S_DELETED, ...OCTOBER })).toEqual([DEL_OCT02]);
    await expectNotFound(await get(LIST, SES_OWNER_SPEC, { store_id: S_DELETED, ...OCTOBER }));
  });

  it.each([
    ["a store outside a specific owner's scope", SES_OWNER_SPEC, STORE_A_Y],
    ["a store outside a specific tenant_admin's scope", SES_ADMIN_SPEC, STORE_A_Y],
    ["a store outside a narrowed manager's scope", SES_MANAGER_ACTIVE, STORE_A_X],
    ["a store outside a narrowed platform admin's scope", SES_PLATFORM_ACTIVE, STORE_A_Y],
    ["an empty scope", SES_ADMIN_EMPTY, STORE_A_X],
    ["another tenant's store (owner, all)", SES_OWNER_ALL, STORE_B_X],
    ["another tenant's store (platform admin)", SES_PLATFORM, STORE_B_X],
    ["an absent store", SES_OWNER_ALL, NON_EXISTENT],
    ["store_staff", SES_STAFF, STORE_A_X],
  ])("a list of %s is the non-disclosing 404", async (_label, session, storeId) => {
    if (skip()) return;
    await expectNotFound(await get(LIST, session, { store_id: storeId, ...OCTOBER }));
  });

  it.each([
    ["another tenant's sale (owner, all)", SES_OWNER_ALL, B_OCT02],
    ["another tenant's sale (platform admin)", SES_PLATFORM, B_OCT02],
    ["a sale outside a specific owner's scope", SES_OWNER_SPEC, Y_OCT02],
    ["a deleted store's sale for a specific grant", SES_OWNER_SPEC, DEL_OCT02],
    ["a sale outside a narrowed manager's scope", SES_MANAGER_ACTIVE, X_OCT01],
    ["a sale outside a narrowed platform admin's scope", SES_PLATFORM_ACTIVE, Y_OCT02],
    ["an empty scope", SES_ADMIN_EMPTY, X_OCT01],
    ["an absent sale", SES_OWNER_ALL, NO_SALE],
    ["store_staff", SES_STAFF, X_OCT01],
  ])("the detail of %s is the non-disclosing 404", async (_label, session, saleRef) => {
    if (skip()) return;
    await expectNotFound(await get(detailPath(saleRef), session));
  });

  it("the same sales open where they are in scope, wherever the session's active store is", async () => {
    if (skip()) return;
    for (const [session, saleRef] of [
      [SES_OWNER_ALL, Y_OCT02],
      [SES_OWNER_ALL_ACTIVE, Y_OCT02],
      [SES_OWNER_ALL, DEL_OCT02],
      [SES_MANAGER, X_OCT01],
      [SES_MANAGER_ACTIVE, Y_OCT02],
      [SES_PLATFORM, Y_OCT02],
      [SES_PLATFORM_ACTIVE, X_OCT01],
    ] as const) {
      const res = await get(detailPath(saleRef), session);
      expect(res.status).toBe(200);
      expectValid(detailSchema, res.body);
      expect(res.body.summary.saleRef).toBe(saleRef);
    }
  });

  it("store_staff is a 404 whatever the input, a malformed one included (guards before validation)", async () => {
    if (skip()) return;
    await expectNotFound(await get(LIST, SES_STAFF));
    await expectNotFound(await get(LIST, SES_STAFF, { store_id: "nope", from: "2026-01-01", to: "2026-12-31" }));
    await expectNotFound(await get(detailPath("not-a-uuid"), SES_STAFF));
  });

  it("no session is 401, whatever the input", async () => {
    if (skip()) return;
    for (const res of [await get(LIST, null, X_OCT), await get(LIST, null), await get(detailPath(X_OCT01), null), await get(detailPath("x"), null)]) {
      expect(res.status).toBe(401);
      expectValid(errorSchema, res.body);
    }
  });

  it.each([
    ["a dashboard_api token of an allowed, in-scope manager", DASHBOARD_TOKEN],
    ["a POS operator (pos_operator) token", OPERATOR_TOKEN],
    ["the till's device token", DEVICE_TOKEN],
    ["an unknown bearer", "not-a-real-token"],
  ])("%s is 401 on both reads (cookie session only)", async (_label, token) => {
    if (skip()) return;
    for (const path of [LIST, detailPath(X_OCT01)]) {
      const res = await get(path, null, path === LIST ? X_OCT : {}).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
      expectValid(errorSchema, res.body);
    }
  });
});

// ===========================================================================
// Request validation (400), after the guards and before any read
// ===========================================================================

describe("RT-562 console sales — validation", () => {
  it.each<[string, Query | string]>([
    ["a missing store_id", OCTOBER],
    ["a missing from", { store_id: STORE_A_X, to: "2026-10-31" }],
    ["a missing to", { store_id: STORE_A_X, from: "2026-10-01" }],
    ["32 business days", { ...X_OCT, to: "2026-11-01" }],
    ["to before from", { ...X_OCT, from: "2026-10-02", to: "2026-10-01" }],
    ["a non-calendar date", { ...X_OCT, from: "2026-02-30", to: "2026-03-01" }],
    ["a malformed store_id", { ...X_OCT, store_id: "store-x" }],
    ["voided=1", { ...X_OCT, voided: 1 }],
    ["an unknown sync_status", { ...X_OCT, sync_status: "posted" }],
    ["an unknown key", { ...X_OCT, device_ref: DEVICE_X }],
    ["a smuggled tenant_id", { ...X_OCT, tenant_id: TENANT_B }],
    ["page_size 0", { ...X_OCT, page_size: 0 }],
    ["page_size 101", { ...X_OCT, page_size: 101 }],
    ["a repeated store_id", `store_id=${STORE_A_X}&store_id=${STORE_A_Y}&from=2026-10-01&to=2026-10-31`],
    ["a repeated voided", `store_id=${STORE_A_X}&from=2026-10-01&to=2026-10-31&voided=true&voided=false`],
    ["a non-token cursor", { ...X_OCT, cursor: "not a token" }],
    ["an undecodable cursor", { ...X_OCT, cursor: "bm9wZQ" }],
  ])("%s is 400 validation_error", async (_label, query) => {
    if (skip()) return;
    await expectValidationError(await get(LIST, SES_OWNER_ALL, query));
  });

  it("exactly 31 business days (to - from = 30) is accepted", async () => {
    if (skip()) return;
    await page(SES_OWNER_ALL, { store_id: STORE_A_X, from: "2026-10-02", to: "2026-11-01" });
  });

  it("a cursor reused with another store, another filter or another range is 400", async () => {
    if (skip()) return;
    const cursor = await cursorFor(SES_OWNER_ALL, X_OCT);
    await expectValidationError(await get(LIST, SES_OWNER_ALL, { store_id: STORE_A_Y, ...OCTOBER, cursor }));
    await expectValidationError(await get(LIST, SES_OWNER_ALL, { ...X_OCT, voided: "false", cursor }));
    await expectValidationError(await get(LIST, SES_OWNER_ALL, { ...X_OCT, sale_number: "X-0001", cursor }));
    await expectValidationError(await get(LIST, SES_OWNER_ALL, { ...X_OCT, to: "2026-10-30", cursor }));
    // The same cursor is accepted with the query it was issued for.
    await page(SES_OWNER_ALL, { ...X_OCT, cursor });
  });

  it("another tenant's cursor and a POS sale-history cursor for the same store and range are 400", async () => {
    if (skip()) return;
    const keyset = { businessDate: "2026-10-31", occurredAtKey: "2026-10-31T10:00:00.000000Z", saleId: X_OCT31 };
    const filters = { from: OCTOBER.from, to: OCTOBER.to, saleNumber: null, syncStatus: null, voided: null, returnState: null, erpPostingState: null };
    const foreign = encodeConsoleSaleCursor({ tenantId: TENANT_B, storeId: STORE_A_X, filters }, keyset);
    const pos = encodeSaleHistoryCursor({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      filters: { ...OCTOBER, deviceRef: null, operatorUserId: null, saleNumber: null },
      keyset,
    });
    await expectValidationError(await get(LIST, SES_OWNER_ALL, { ...X_OCT, cursor: foreign }));
    await expectValidationError(await get(LIST, SES_OWNER_ALL, { ...X_OCT, cursor: pos }));
    // Bound to tenant A, the hand-built cursor is accepted and only repositions the walk.
    const own = encodeConsoleSaleCursor({ tenantId: TENANT_A, storeId: STORE_A_X, filters }, keyset);
    expect((await page(SES_OWNER_ALL, { ...X_OCT, page_size: 100, cursor: own })).items.map((i) => i.saleRef)).toEqual(
      X_OCTOBER.slice(1),
    );
  });

  it("the detail refuses a malformed saleRef and any query key with 400, and accepts upper case", async () => {
    if (skip()) return;
    await expectValidationError(await get(detailPath("not-a-uuid"), SES_OWNER_ALL));
    await expectValidationError(await get(detailPath(X_OCT01), SES_OWNER_ALL, { store_id: STORE_A_X }));
    const res = await get(detailPath(X_OCT01.toUpperCase()), SES_OWNER_ALL).expect(200);
    expect(res.body.summary.saleRef).toBe(X_OCT01);
  });
});

// ===========================================================================
// List: range, dates, facts, filters, paging
// ===========================================================================

describe("RT-562 console sales — list", () => {
  it("both bounds are inclusive and nothing outside them is listed", async () => {
    if (skip()) return;
    const october = await refs(SES_OWNER_ALL, X_OCT);
    expect(october).toEqual(X_OCTOBER);
    expect(october).not.toContain(X_SEP30);
    expect(october).not.toContain(X_NOV01);
    expect(await refs(SES_OWNER_ALL, { store_id: STORE_A_X, from: "2026-10-01", to: "2026-10-01" })).toEqual([X_OCT01]);
    expect(await refs(SES_OWNER_ALL, { store_id: STORE_A_X, from: "2026-10-31", to: "2026-10-31" })).toEqual([X_OCT31]);
  });

  it("a 23:30 UTC sale lands on the next Cairo business date", async () => {
    if (skip()) return;
    const stored = await E().admin.query<{ d: string }>(`SELECT business_date::text AS d FROM sales WHERE id = $1`, [X_LATE]);
    expect(stored.rows[0]!.d).toBe("2026-10-05");
    const next = await page(SES_OWNER_ALL, { store_id: STORE_A_X, from: "2026-10-05", to: "2026-10-05" });
    expect(next.items.map((i) => i.saleRef)).toEqual([X_LATE]);
    expect(next.items[0]).toMatchObject({ businessDate: "2026-10-05", occurredAt: "2026-10-04T23:30:00.000Z" });
    expect(await refs(SES_OWNER_ALL, { store_id: STORE_A_X, from: "2026-10-04", to: "2026-10-04" })).toEqual([X_LEGACY]);
  });

  it("the page names the store, its timezone, the range and the read time", async () => {
    if (skip()) return;
    const before = Date.now();
    const body = await page(SES_OWNER_ALL, { ...X_OCT, store_id: STORE_A_X.toUpperCase() });
    expect(body).toMatchObject({ storeRef: STORE_A_X, storeTimezone: "Africa/Cairo", from: OCTOBER.from, to: OCTOBER.to });
    expect(Date.parse(body["asOf"] as string)).toBeGreaterThanOrEqual(before - 5_000);
    expect(body.items.every((i) => i.storeRef === STORE_A_X)).toBe(true);
    const y = await page(SES_OWNER_ALL, { store_id: STORE_A_Y, ...OCTOBER });
    expect(y.storeTimezone).toBe("UTC");
  });

  it("reads voided, returned, tender-unknown, pre-RT-77 and unknown-ERP sales as recorded", async () => {
    if (skip()) return;
    const body = await page(SES_OWNER_ALL, { ...X_OCT, page_size: 100 });
    const by = new Map(body.items.map((i) => [i.saleRef, i]));
    expect(by.get(X_OCT01)).toMatchObject({ saleNumber: X_OCT01_SALE_NUMBER, voided: false, returnState: "none", erpPostingState: "posted", syncStatus: "synced" });
    expect(by.get(X_VOID)).toMatchObject({ voided: true, returnState: "none", erpPostingState: "posted" });
    expect(by.get(X_PARTIAL)).toMatchObject({ voided: false, returnState: "partial", erpPostingState: "pending" });
    expect(by.get(X_FULL)).toMatchObject({ voided: false, returnState: "full", erpPostingState: "failed" });
    expect(by.get(X_LEGACY)).toMatchObject({
      saleNumber: null,
      syncStatus: "failed-needs-repair",
      erpPostingState: "unknown",
      device: { deviceRef: null, label: null, labelSource: "unavailable" },
      operator: { userRef: CASHIER, displayName: "Cashier One", nameSource: "current" },
    });
    expect(by.get(X_LATE)).toMatchObject({ device: { deviceRef: DEVICE_X, label: "till-1", labelSource: "current" } });
    expect(by.get(X_OCT01)).toMatchObject({
      device: { deviceRef: DEVICE_X, label: "till-1 (printed)", labelSource: "snapshot" },
      operator: { displayName: "Cashier One (printed)", nameSource: "snapshot" },
    });
  });

  it("orders newest first and breaks an occurredAt tie by saleRef", async () => {
    if (skip()) return;
    const tie = await refs(SES_OWNER_ALL, { store_id: STORE_A_X, from: "2026-10-06", to: "2026-10-06" });
    expect(tie).toEqual([X_TIE_B, X_TIE_A]);
  });

  it.each<[string, Query, string[]]>([
    ["sale_number", { sale_number: X_OCT01_SALE_NUMBER }, [X_OCT01]],
    ["an absent sale_number", { sale_number: "X-9999" }, []],
    ["sync_status", { sync_status: "failed-needs-repair" }, [X_LEGACY]],
    ["voided=true", { voided: "true" }, [X_VOID]],
    ["voided=false", { voided: "false" }, X_OCTOBER.filter((r) => r !== X_VOID)],
    ["return_state=partial", { return_state: "partial" }, [X_PARTIAL]],
    ["return_state=full", { return_state: "full" }, [X_FULL]],
    ["return_state=none", { return_state: "none" }, X_OCTOBER.filter((r) => r !== X_PARTIAL && r !== X_FULL)],
    ["erp_posting_state=posted", { erp_posting_state: "posted" }, [X_VOID, X_OCT01]],
    ["erp_posting_state=pending (failed_transient)", { erp_posting_state: "pending" }, [X_PARTIAL]],
    ["erp_posting_state=failed (permanently_rejected)", { erp_posting_state: "failed" }, [X_FULL]],
    ["erp_posting_state=unknown (no posting row)", { erp_posting_state: "unknown" }, [X_OCT31, X_TIE_B, X_TIE_A, X_LATE, X_LEGACY]],
    ["filters combined with AND", { voided: "false", return_state: "none", erp_posting_state: "posted" }, [X_OCT01]],
  ])("filters by %s", async (_label, filter, expected) => {
    if (skip()) return;
    expect(await refs(SES_OWNER_ALL, { ...X_OCT, ...filter })).toEqual(expected);
  });

  it.each([1, 2, 3, 4, 8, 9, 10])("walks every sale once at page_size %i", async (pageSize) => {
    if (skip()) return;
    const { refs: seen, pages } = await walk(SES_OWNER_ALL, { ...X_OCT, page_size: pageSize });
    expect(seen).toEqual(X_OCTOBER);
    expect(pages.every((p) => p.items.length <= pageSize)).toBe(true);
  });

  it("walks a derived filter at every page size and returns the same sales", async () => {
    if (skip()) return;
    for (const pageSize of [1, 2, 5]) {
      const { refs: seen } = await walk(SES_OWNER_ALL, { ...X_OCT, return_state: "none", page_size: pageSize });
      expect(seen).toEqual(X_OCTOBER.filter((r) => r !== X_PARTIAL && r !== X_FULL));
    }
  });

  it.each<[string, Query, string[]]>([
    ["voided=true", { voided: "true" }, [BULK_VOID]],
    ["sync_status", { sync_status: "failed-needs-repair" }, [BULK_REPAIR]],
    ["sale_number", { sale_number: BULK_REPAIR_NUMBER }, [BULK_REPAIR]],
    ["return_state=partial", { return_state: "partial" }, []],
  ])("bounds the rows a %s request reads: an empty first page with a non-null cursor", async (_label, filter, expected) => {
    if (skip()) return;
    expect(BULK_COUNT).toBeGreaterThan(SCAN_LIMIT_DEFAULT);
    const query = { store_id: STORE_A_Y, ...BULK_RANGE, ...filter, page_size: 50 };
    const { refs: seen, pages } = await walk(SES_OWNER_ALL, query);
    expect(pages[0]!.items).toEqual([]);
    expect(pages[0]!.nextCursor).not.toBeNull();
    expect(pages).toHaveLength(2);
    expect(seen).toEqual(expected);
  });

  it("unfiltered pages are full until the last one", async () => {
    if (skip()) return;
    const all = await walk(SES_OWNER_ALL, { store_id: STORE_A_Y, ...BULK_RANGE, page_size: 100 });
    expect(all.refs).toHaveLength(BULK_COUNT + 2);
    expect(new Set(all.refs).size).toBe(BULK_COUNT + 2);
    expect(all.pages.slice(0, -1).every((p) => p.items.length === 100)).toBe(true);
    expect(all.refs.slice(-2)).toEqual([BULK_VOID, BULK_REPAIR]);
  });

  it("asOf is never earlier than the receivedAt of any sale on the page", async () => {
    if (skip()) return;
    const body = await page(SES_OWNER_ALL, { ...X_OCT, page_size: 100 });
    const asOf = Date.parse(body["asOf"] as string);
    for (const item of body.items) expect(Date.parse(item["receivedAt"] as string)).toBeLessThanOrEqual(asOf);
  });

  it("stays stable while sales arrive: a newer arrival is not returned, an older one is returned once", async () => {
    if (skip()) return;
    const newer = "0a000000-0000-7000-8000-000000562a91";
    const older = "0a000000-0000-7000-8000-000000562a92";
    const first = await page(SES_OWNER_ALL, { ...X_OCT, page_size: 3 });
    expect(first.items.map((i) => i.saleRef)).toEqual(X_OCTOBER.slice(0, 3));
    const cleanups = [
      await insertArrival(E().admin, newer, "2026-10-31T11:00:00Z"),
      await insertArrival(E().admin, older, "2026-10-01T08:00:00Z"),
    ];
    try {
      const seen = first.items.map((i) => i.saleRef);
      let cursor = first.nextCursor;
      while (cursor !== null) {
        const next = await page(SES_OWNER_ALL, { ...X_OCT, page_size: 3, cursor });
        seen.push(...next.items.map((i) => i.saleRef));
        cursor = next.nextCursor;
      }
      expect(seen).toEqual([...X_OCTOBER, older]);
      expect(seen).not.toContain(newer);
    } finally {
      for (const cleanup of cleanups) await cleanup();
    }
  });
});

// ===========================================================================
// Detail
// ===========================================================================

describe("RT-562 console sales — detail", () => {
  async function detail(saleRef: string, session = SES_OWNER_ALL): Promise<Record<string, unknown> & { summary: Item }> {
    const res = await get(detailPath(saleRef), session);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expectValid(detailSchema, res.body);
    expect(res.body).not.toHaveProperty("receiptFacts");
    expect(res.body).not.toHaveProperty("reprint");
    return res.body;
  }

  it("a complete sale: snapshot, receipt-ordered lines, tender, header, posted ERP document", async () => {
    if (skip()) return;
    const d = await detail(X_OCT01);
    expect(d).toMatchObject({
      summary: { saleRef: X_OCT01, storeRef: STORE_A_X, saleNumber: X_OCT01_SALE_NUMBER, businessDate: "2026-10-01" },
      storeTimezone: "Africa/Cairo",
      lineOrder: "recorded",
      tenderState: "recorded",
      tenders: [{ method: "cash", amount: "12.5000", reference: null, sequence: 1 }],
      changeGiven: "2.5000",
      settledAt: "2026-10-01T09:00:00.000Z",
      receiptNumber: X_OCT01_SALE_NUMBER,
      receiptHeader: { branchName: "Nile Branch", branchAddress: "1 Nile St, Cairo", taxRegistrationId: "123-456-789" },
      void: null,
      returns: [],
      erpPosting: { sale: "posted", saleDocumentRef: SALE_DOC, reversal: null, reversalDocumentRef: null },
    });
    expect((d["lines"] as Array<{ sequence: number; lineName: string }>).map((l) => [l.sequence, l.lineName])).toEqual([
      [1, "Widget"],
      [2, "Gadget"],
    ]);
  });

  it("a voided sale: the approved void with the approver's role only, and the reversal state", async () => {
    if (skip()) return;
    const d = await detail(X_VOID);
    expect(d).toMatchObject({
      summary: { voided: true },
      void: { voidedAt: expect.any(String), voidBusinessDate: "2026-10-02", approved: true, approverRole: "store_manager" },
      erpPosting: { sale: "posted", reversal: "pending", reversalDocumentRef: null },
    });
    expect(JSON.stringify(d)).not.toContain(USER_MANAGER);
  });

  it("a partial return: the return summary and the returned quantity per line; a pending posting shows no document", async () => {
    if (skip()) return;
    const d = await detail(X_PARTIAL);
    expect(d).toMatchObject({
      summary: { returnState: "partial", erpPostingState: "pending" },
      erpPosting: { sale: "pending", saleDocumentRef: null },
      returns: [{ returnRef: RETURN_PARTIAL, businessDate: "2026-10-03", returnTotal: "7.5000", lines: [{ quantity: expect.any(String) }] }],
    });
    const lines = d["lines"] as Array<{ lineName: string; returnedQuantity: string }>;
    expect(Object.fromEntries(lines.map((l) => [l.lineName, Number(l.returnedQuantity)]))).toEqual({ Widget: 0, Gadget: 1 });
  });

  it("a pre-RT-77, tender-unknown sale without a snapshot or posting row shows facts as not recorded", async () => {
    if (skip()) return;
    const d = await detail(X_LEGACY);
    expect(d).toMatchObject({
      summary: { device: { deviceRef: null, label: null, labelSource: "unavailable" }, erpPostingState: "unknown", syncStatus: "failed-needs-repair" },
      lineOrder: "not_recorded",
      tenderState: "unknown",
      tenders: [],
      changeGiven: null,
      settledAt: null,
      receiptNumber: null,
      receiptHeader: null,
      erpPosting: { sale: "unknown", saleDocumentRef: null, reversal: null, reversalDocumentRef: null },
    });
  });

  it("a full return and a failed posting", async () => {
    if (skip()) return;
    const d = await detail(X_FULL);
    expect(d).toMatchObject({ summary: { returnState: "full" }, erpPosting: { sale: "failed", saleDocumentRef: null } });
    expect(d["returns"] as unknown[]).toHaveLength(1);
  });

  it("names the sale's own store and its timezone, not the session's active store", async () => {
    if (skip()) return;
    const d = await detail(Y_OCT02, SES_OWNER_ALL_ACTIVE);
    expect(d).toMatchObject({ summary: { storeRef: STORE_A_Y }, storeTimezone: "UTC" });
  });
});

// ===========================================================================
// Audit
// ===========================================================================

describe("RT-562 console sales — audit", () => {
  beforeEach(() => {
    audit.payloads.length = 0;
  });

  const events = (action: string): AuditJobPayload[] => audit.payloads.filter((p) => p.action === action);

  it("one console_sales.listed per list request: store, filters and count; the sale number only as a flag", async () => {
    if (skip()) return;
    await page(SES_MANAGER, { ...X_OCT, sale_number: X_OCT01_SALE_NUMBER, voided: "false" });
    expect(audit.payloads).toHaveLength(1);
    const [event] = events("console_sales.listed");
    expect(event).toMatchObject({ actor_user_id: USER_MANAGER, tenant_id: TENANT_A, target_type: null, target_id: null });
    expect(event!.metadata).toEqual({
      store_id: STORE_A_X,
      from: OCTOBER.from,
      to: OCTOBER.to,
      sale_number_filtered: true,
      sync_status: null,
      voided: false,
      return_state: null,
      erp_posting_state: null,
      page_size: 50,
      continued: false,
      item_count: 1,
    });
    expect(JSON.stringify(event)).not.toContain(X_OCT01_SALE_NUMBER);
  });

  it("a continued page is one more event, flagged continued", async () => {
    if (skip()) return;
    const query = { ...X_OCT, sync_status: "synced", return_state: "none", page_size: 2 };
    const cursor = await cursorFor(SES_MANAGER, query);
    audit.payloads.length = 0;
    const second = await page(SES_MANAGER, { ...query, cursor });
    expect(audit.payloads).toHaveLength(1);
    expect(events("console_sales.listed")[0]!.metadata).toMatchObject({
      sync_status: "synced",
      return_state: "none",
      page_size: 2,
      continued: true,
      item_count: second.items.length,
    });
  });

  it("the list event carries no row id", async () => {
    if (skip()) return;
    await page(SES_OWNER_ALL, X_OCT);
    const [event] = events("console_sales.listed");
    const serialized = JSON.stringify(event);
    for (const saleRef of X_OCTOBER) expect(serialized).not.toContain(saleRef);
    expect(event!.metadata).toMatchObject({ item_count: X_OCTOBER.length, continued: false, page_size: 50 });
  });

  it("one console_sales.detail_read per open, with the sale ref and the SALE's store in the metadata", async () => {
    if (skip()) return;
    await get(detailPath(Y_OCT02), SES_OWNER_ALL_ACTIVE).expect(200);
    expect(audit.payloads).toHaveLength(1);
    const [event] = events("console_sales.detail_read");
    expect(event!.metadata).toEqual({ sale_ref: Y_OCT02, store_id: STORE_A_Y });
    // The interceptor's column is the session's active store, which differs here.
    expect(event).toMatchObject({ store_id: STORE_A_X, target_type: null, target_id: null });
  });

  it("refusals are not audited: 400, 401 and 404", async () => {
    if (skip()) return;
    await get(LIST, SES_OWNER_ALL, { ...X_OCT, to: "2026-11-01" }).expect(400);
    await get(LIST, SES_OWNER_ALL, { ...X_OCT, cursor: "bm9wZQ" }).expect(400);
    await get(detailPath("nope"), SES_OWNER_ALL).expect(400);
    await get(LIST, null, X_OCT).expect(401);
    await get(detailPath(X_OCT01), null).set("Authorization", `Bearer ${DASHBOARD_TOKEN}`).expect(401);
    await get(LIST, SES_OWNER_SPEC, { store_id: STORE_A_Y, ...OCTOBER }).expect(404);
    await get(detailPath(B_OCT02), SES_OWNER_ALL).expect(404);
    await get(detailPath(X_OCT01), SES_STAFF).expect(404);
    expect(audit.payloads).toEqual([]);
  });
});
