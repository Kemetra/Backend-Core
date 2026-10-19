/**
 * RT-649 — the console sales summary over HTTP against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool) and the
 * real module graph (`SessionOnlyAdminGuard`, `TenantContextGuard`,
 * `RolesGuard`, `MembershipRepository`). Only cookie authentication is faked
 * (the RT-192 / RT-562 header pattern).
 *
 *   GET /api/v1/sales-summary  consoleGetSalesSummary
 *
 * What this proves (RT-649 acceptance):
 *   - exact figures per store, business date and currency (sales, voids,
 *     returns, legacy refunds, shift closes, sync and ERP counts), dense days,
 *     store range totals and scope totals that equal the stores' sums;
 *   - `unknown` ERP and approval buckets are counted, never folded into zero;
 *   - store-local bucketing of refunds and closes: the Cairo midnight and both
 *     America/New_York DST days (23 and 25 hours); stored sale business dates
 *     are never recomputed after a timezone change;
 *   - role and store scope (owner / tenant_admin / store_manager / platform
 *     admin; active-store narrowing), tenant isolation, the one
 *     non-disclosing 404 and 401 for every bearer;
 *   - the 31-day bound, foreign cursors and store paging;
 *   - the audit event and its metadata, after a 200 only;
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
import { encodeSalesSummaryCursor } from "../../src/console-sales/console-sales-summary.query";
import { ConsoleSalesModule } from "../../src/console-sales/console-sales.module";
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
  DASHBOARD_TOKEN,
  DEVICE_TOKEN,
  OPERATOR_TOKEN,
  SES_ADMIN_EMPTY,
  SES_MANAGER,
  SES_MANAGER_ACTIVE,
  SES_PLATFORM,
  SES_PLATFORM_ACTIVE,
  SES_STAFF,
} from "./__support__/console-sales-fixture";
import { seedConsoleSalesSummaryFixture, Y_DST_CLOSES } from "./__support__/console-sales-summary-fixture";

const PATH = "/api/v1/sales-summary";
const CONTRACT_ID = "console-sales-summary.openapi";
const NOT_FOUND = { code: "not_found", message: "Not Found" };
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };

type Query = Record<string, string | number>;

interface Money {
  count: number;
  byCurrency: Array<{ currencyCode: string; count: number; total: string }>;
}
interface Kpis {
  receivedSales: Money;
  voids: Money;
  returns: Money;
  legacyRefunds: Money;
  syncStatus: Record<string, number>;
  erpPosting: Record<string, number>;
  shiftCloses: { count: number; normal: number; forced: number; withVariance: number; approvalMissing: Record<string, number> };
}
interface Day {
  businessDate: string;
  kpis: Kpis;
}
interface StoreSummary {
  storeRef: string;
  storeTimezone: string;
  currentBusinessDate: string;
  days: Day[];
  rangeTotals: Kpis;
}
interface Summary {
  scope: string;
  storeRef: string | null;
  from: string;
  to: string;
  asOf: string;
  completeness: string;
  stores: StoreSummary[];
  nextCursor: string | null;
  scopeTotals: { storeCount: number; days: Day[]; rangeTotals: Kpis };
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
let summarySchema: ValidateFunction;
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
  summarySchema = compiled("ConsoleSalesSummary");
  errorSchema = compiled("Error");

  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedConsoleSalesSummaryFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-649 sales summary] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  app = await bootScopedApp(env, ConsoleSalesModule, audit, { authLookupPool: env.admin });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-649 sales summary] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function E(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

function get(session: string | null, query: Query | string = {}): request.Test {
  const req = request(app!.getHttpServer()).get(PATH).query(query);
  return session === null ? req : req.set("x-test-session", session);
}

function expectValid(validate: ValidateFunction, body: unknown): void {
  if (!validate(body)) throw new Error(`contract violation: ${JSON.stringify(validate.errors)}`);
}

async function summary(session: string, query: Query): Promise<Summary> {
  const res = await get(session, query);
  if (res.status !== 200) throw new Error(`summary ${res.status}: ${JSON.stringify(res.body)}`);
  expect(res.headers["cache-control"]).toBe("no-store");
  expectValid(summarySchema, res.body);
  return res.body as Summary;
}

async function expectNotFound(res: request.Response): Promise<void> {
  expect(res.status).toBe(404);
  expectValid(errorSchema, res.body);
  expect({ ...res.body.error, request_id: undefined }).toEqual({ ...NOT_FOUND, request_id: undefined });
}

async function expectValidationError(res: request.Response): Promise<void> {
  expect(res.status).toBe(400);
  expectValid(errorSchema, res.body);
  expect(res.body.error.code).toBe("validation_error");
}

function day(s: { days: Day[] }, businessDate: string): Kpis {
  const found = s.days.find((d) => d.businessDate === businessDate);
  if (!found) throw new Error(`no bucket for ${businessDate}`);
  return found.kpis;
}

function store(s: Summary, storeRef: string): StoreSummary {
  const found = s.stores.find((x) => x.storeRef === storeRef);
  if (!found) throw new Error(`no store ${storeRef}`);
  return found;
}

const egp = (count: number, total: string): Money => ({ count, byCurrency: [{ currencyCode: "EGP", count, total }] });
const NONE: Money = { count: 0, byCurrency: [] };

/** Tenant A's stores (STORE_A_X, STORE_A_Y, S_DELETED), sorted. */
async function tenantAStores(): Promise<string[]> {
  const r = await E().admin.query<{ id: string }>(`SELECT id::text FROM stores WHERE tenant_id = $1 ORDER BY id`, [TENANT_A]);
  return r.rows.map((row) => row.id);
}

// ===========================================================================
// Figures
// ===========================================================================

describe("RT-649 sales summary — figures of one store", () => {
  it("states the scope, the range, asOf and the received_only completeness", async () => {
    if (skip()) return;
    const before = Date.now();
    const s = await summary(SES_OWNER_ALL, { store_id: STORE_A_X, ...OCTOBER });
    expect(s).toMatchObject({ scope: "store", storeRef: STORE_A_X, ...OCTOBER, completeness: "received_only", nextCursor: null });
    expect(Date.parse(s.asOf)).toBeGreaterThanOrEqual(before - 1000);
    expect(s.stores.map((x) => x.storeRef)).toEqual([STORE_A_X]);
    expect(store(s, STORE_A_X).storeTimezone).toBe("Africa/Cairo");
    expect(store(s, STORE_A_X).currentBusinessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns one dense bucket per business date, zero-filled", async () => {
    if (skip()) return;
    const x = store(await summary(SES_OWNER_ALL, { store_id: STORE_A_X, ...OCTOBER }), STORE_A_X);
    expect(x.days).toHaveLength(31);
    expect(x.days[0]!.businessDate).toBe("2026-10-01");
    expect(x.days[30]!.businessDate).toBe("2026-10-31");
    const empty = day(x, "2026-10-15");
    expect(empty.receivedSales).toEqual(NONE);
    expect(empty.erpPosting).toEqual({ posted: 0, pending: 0, failed: 0, unknown: 0 });
  });

  it("counts and sums the received sales exactly, by stored business date", async () => {
    if (skip()) return;
    const x = store(await summary(SES_OWNER_ALL, { store_id: STORE_A_X, ...OCTOBER }), STORE_A_X);
    expect(x.rangeTotals.receivedSales).toEqual(egp(9, "112.5000"));
    expect(day(x, "2026-10-01").receivedSales).toEqual(egp(1, "12.5000"));
    expect(day(x, "2026-10-03").receivedSales).toEqual(egp(2, "25.0000"));
    // X_LATE: captured at 2026-10-04T23:30Z, the next Cairo business date.
    expect(day(x, "2026-10-05").receivedSales).toEqual(egp(1, "12.5000"));
    expect(day(x, "2026-10-06").receivedSales).toEqual(egp(2, "25.0000"));
    expect(day(x, "2026-10-31").receivedSales).toEqual(egp(1, "12.5000"));
  });

  it("reports voids and returns on their own business dates, beside the gross (never netted)", async () => {
    if (skip()) return;
    const x = store(await summary(SES_OWNER_ALL, { store_id: STORE_A_X, ...OCTOBER }), STORE_A_X);
    expect(day(x, "2026-10-02").voids).toEqual(egp(1, "12.5000"));
    expect(day(x, "2026-10-02").receivedSales).toEqual(egp(1, "12.5000"));
    expect(day(x, "2026-10-03").returns).toEqual(egp(2, "20.0000"));
    expect(x.rangeTotals.voids).toEqual(egp(1, "12.5000"));
    expect(x.rangeTotals.returns).toEqual(egp(2, "20.0000"));
  });

  it("keeps unknown ERP posting apart: posted + pending + failed is not every sale", async () => {
    if (skip()) return;
    const x = store(await summary(SES_OWNER_ALL, { store_id: STORE_A_X, ...OCTOBER }), STORE_A_X);
    expect(x.rangeTotals.erpPosting).toEqual({ posted: 2, pending: 1, failed: 1, unknown: 5 });
    expect(day(x, "2026-10-03").erpPosting).toEqual({ posted: 0, pending: 1, failed: 1, unknown: 0 });
    expect(day(x, "2026-10-04").erpPosting).toEqual({ posted: 0, pending: 0, failed: 0, unknown: 1 });
    expect(x.rangeTotals.syncStatus).toEqual({ captured: 0, synced: 8, failedRetryable: 0, failedNeedsRepair: 1 });
  });

  it("buckets legacy refunds and shift closes by the Cairo local date of their instant", async () => {
    if (skip()) return;
    const x = store(await summary(SES_OWNER_ALL, { store_id: STORE_A_X, ...OCTOBER }), STORE_A_X);
    expect(day(x, "2026-10-04").legacyRefunds).toEqual(egp(1, "2.0000"));
    expect(day(x, "2026-10-05").legacyRefunds).toEqual(egp(1, "2.0000"));
    expect(day(x, "2026-10-04").shiftCloses).toEqual({
      count: 1,
      normal: 0,
      forced: 1,
      withVariance: 1,
      approvalMissing: { yes: 0, no: 0, unknown: 1 },
    });
    expect(day(x, "2026-10-05").shiftCloses).toEqual({
      count: 1,
      normal: 1,
      forced: 0,
      withVariance: 0,
      approvalMissing: { yes: 0, no: 0, unknown: 1 },
    });
    expect(x.rangeTotals.legacyRefunds).toEqual(egp(2, "4.0000"));
    expect(x.rangeTotals.shiftCloses.count).toBe(2);
  });

  it("splits money by currency and never adds currencies together", async () => {
    if (skip()) return;
    // The 008 seed's tenant-A sales of 2026-05-01 are USD on STORE_A_X.
    const x = store(await summary(SES_OWNER_ALL, { store_id: STORE_A_X, from: "2026-05-01", to: "2026-05-01" }), STORE_A_X);
    expect(x.rangeTotals.receivedSales.byCurrency.map((c) => c.currencyCode)).toEqual(["USD"]);
    expect(x.rangeTotals.legacyRefunds).toEqual({ count: 1, byCurrency: [{ currencyCode: "USD", count: 1, total: "9.0000" }] });
  });
});

describe("RT-649 sales summary — DST and timezone changes", () => {
  it("puts America/New_York closes on their local date across the 25-hour fall-back day", async () => {
    if (skip()) return;
    const y = store(await summary(SES_OWNER_ALL, { store_id: STORE_A_Y, from: "2026-10-25", to: "2026-11-05" }), STORE_A_Y);
    expect(y.storeTimezone).toBe("America/New_York");
    const expected = new Map<string, number>();
    for (const c of Y_DST_CLOSES) if (c.localDate >= "2026-10-25") expected.set(c.localDate, (expected.get(c.localDate) ?? 0) + 1);
    for (const d of y.days) expect([d.businessDate, d.kpis.shiftCloses.count]).toEqual([d.businessDate, expected.get(d.businessDate) ?? 0]);
    expect(day(y, "2026-11-01").shiftCloses.count).toBe(2);
  });

  it("puts America/New_York closes on their local date across the 23-hour spring-forward day", async () => {
    if (skip()) return;
    const y = store(await summary(SES_OWNER_ALL, { store_id: STORE_A_Y, from: "2026-03-07", to: "2026-03-09" }), STORE_A_Y);
    expect(y.days.map((d) => d.kpis.shiftCloses.count)).toEqual([1, 2, 1]);
  });

  it("never recomputes a stored sale business date after the store timezone changed", async () => {
    if (skip()) return;
    // Y_OCT02 was captured at 2026-10-02T09:00Z while STORE_A_Y was UTC.
    const y = store(await summary(SES_OWNER_ALL, { store_id: STORE_A_Y, ...OCTOBER }), STORE_A_Y);
    expect(day(y, "2026-10-02").receivedSales).toEqual(egp(1, "12.5000"));
    expect(y.rangeTotals.receivedSales).toEqual(egp(1, "12.5000"));
  });
});

// ===========================================================================
// Scope
// ===========================================================================

describe("RT-649 sales summary — scope and isolation", () => {
  it("an `all` owner without store_id gets every tenant store and server scope totals", async () => {
    if (skip()) return;
    const s = await summary(SES_OWNER_ALL, OCTOBER);
    expect(s.scope).toBe("all_in_scope");
    expect(s.storeRef).toBeNull();
    expect(s.stores.map((x) => x.storeRef)).toEqual(await tenantAStores());
    expect(s.scopeTotals.storeCount).toBe(3);
    // X 9 + Y 1 + deleted store 1, all EGP; no tenant-B sale.
    expect(s.scopeTotals.rangeTotals.receivedSales).toEqual(egp(11, "137.5000"));
    expect(day(s.scopeTotals, "2026-10-02").receivedSales).toEqual(egp(3, "37.5000"));
    expect(s.stores.map((x) => x.storeRef)).not.toContain(STORE_B_X);
  });

  it("scope totals equal the sum of the store figures", async () => {
    if (skip()) return;
    const s = await summary(SES_OWNER_ALL, OCTOBER);
    const counts = s.stores.reduce((n, x) => n + x.rangeTotals.receivedSales.count, 0);
    expect(s.scopeTotals.rangeTotals.receivedSales.count).toBe(counts);
    const closes = s.stores.reduce((n, x) => n + x.rangeTotals.shiftCloses.count, 0);
    expect(s.scopeTotals.rangeTotals.shiftCloses.count).toBe(closes);
  });

  it.each([
    ["owner, all, X active (not narrowed)", SES_OWNER_ALL_ACTIVE, [STORE_A_X, STORE_A_Y, S_DELETED]],
    ["owner, specific (X + deleted)", SES_OWNER_SPEC, [STORE_A_X]],
    ["tenant_admin, specific (X)", SES_ADMIN_SPEC, [STORE_A_X]],
    ["store_manager, specific (X + Y)", SES_MANAGER, [STORE_A_X, STORE_A_Y]],
    ["store_manager, Y active (narrowed)", SES_MANAGER_ACTIVE, [STORE_A_Y]],
    ["platform admin, no active store", SES_PLATFORM, [STORE_A_X, STORE_A_Y, S_DELETED]],
    ["platform admin, X active", SES_PLATFORM_ACTIVE, [STORE_A_X]],
    ["tenant_admin with no live store", SES_ADMIN_EMPTY, []],
  ])("%s: the stores and totals of its scope only", async (_label, session, stores) => {
    if (skip()) return;
    const s = await summary(session, OCTOBER);
    expect(s.stores.map((x) => x.storeRef).sort()).toEqual([...stores].sort());
    expect(s.scopeTotals.storeCount).toBe(stores.length);
    const counts = s.stores.reduce((n, x) => n + x.rangeTotals.receivedSales.count, 0);
    expect(s.scopeTotals.rangeTotals.receivedSales.count).toBe(counts);
  });

  it("an empty scope is a 200 of zeros, never an error", async () => {
    if (skip()) return;
    const s = await summary(SES_ADMIN_EMPTY, OCTOBER);
    expect(s.scopeTotals.rangeTotals.receivedSales).toEqual(NONE);
    expect(s.scopeTotals.days).toHaveLength(31);
  });

  it.each([
    ["a store outside a specific tenant_admin's scope", SES_ADMIN_SPEC, STORE_A_Y],
    ["a store outside a narrowed manager's scope", SES_MANAGER_ACTIVE, STORE_A_X],
    ["a deleted store granted to a specific owner", SES_OWNER_SPEC, S_DELETED],
    ["a store of another tenant", SES_OWNER_ALL, STORE_B_X],
    ["an absent store", SES_OWNER_ALL, NON_EXISTENT],
  ])("%s is the non-disclosing 404", async (_label, session, storeId) => {
    if (skip()) return;
    await expectNotFound(await get(session, { store_id: storeId, ...OCTOBER }));
  });

  it("store_staff is the same 404, before any validation", async () => {
    if (skip()) return;
    await expectNotFound(await get(SES_STAFF, OCTOBER));
    await expectNotFound(await get(SES_STAFF, { store_id: "nope", from: "x", to: "y" }));
  });

  it.each([
    ["a dashboard_api token", DASHBOARD_TOKEN],
    ["a POS operator token", OPERATOR_TOKEN],
    ["a device token", DEVICE_TOKEN],
  ])("%s is 401", async (_label, token) => {
    if (skip()) return;
    const res = await get(null, OCTOBER).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("no session is 401", async () => {
    if (skip()) return;
    expect((await get(null, OCTOBER)).status).toBe(401);
  });

  it("tenant B's owner-less data never appears: tenant B sales are not in tenant A totals", async () => {
    if (skip()) return;
    const b = await E().admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sales WHERE tenant_id = $1 AND business_date BETWEEN '2026-10-01' AND '2026-10-31'`,
      [TENANT_B],
    );
    expect(Number(b.rows[0]!.n)).toBeGreaterThan(0);
    const s = await summary(SES_OWNER_ALL, OCTOBER);
    expect(s.scopeTotals.rangeTotals.receivedSales.count).toBe(11);
  });
});

// ===========================================================================
// Validation and paging
// ===========================================================================

describe("RT-649 sales summary — validation and paging", () => {
  it.each([
    ["a missing from", { to: "2026-10-31" }],
    ["a missing to", { from: "2026-10-01" }],
    ["a non-calendar date", { from: "2026-02-30", to: "2026-03-01" }],
    ["to before from", { from: "2026-10-02", to: "2026-10-01" }],
    ["32 business days", { from: "2026-10-01", to: "2026-11-01" }],
    ["a malformed store_id", { store_id: "nope", ...OCTOBER }],
    ["a page_size of 51", { page_size: 51, ...OCTOBER }],
    ["a page_size of 0", { page_size: 0, ...OCTOBER }],
    ["an unknown key", { tenant_id: TENANT_B, ...OCTOBER }],
    ["a garbage cursor", { cursor: "bm9wZQ", ...OCTOBER }],
  ])("%s is 400 validation_error", async (_label, query) => {
    if (skip()) return;
    await expectValidationError(await get(SES_OWNER_ALL, query as Query));
  });

  it("accepts exactly 31 business days", async () => {
    if (skip()) return;
    const s = await summary(SES_OWNER_ALL, { store_id: STORE_A_X, ...OCTOBER });
    expect(s.stores[0]!.days).toHaveLength(31);
  });

  it("a repeated key is 400", async () => {
    if (skip()) return;
    await expectValidationError(await get(SES_OWNER_ALL, "from=2026-10-01&from=2026-10-02&to=2026-10-31"));
  });

  it("pages stores by storeRef and every page carries the same scope totals", async () => {
    if (skip()) return;
    const all = await tenantAStores();
    const first = await summary(SES_OWNER_ALL, { ...OCTOBER, page_size: 2 });
    expect(first.stores.map((x) => x.storeRef)).toEqual(all.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    const second = await summary(SES_OWNER_ALL, { ...OCTOBER, page_size: 2, cursor: first.nextCursor! });
    expect(second.stores.map((x) => x.storeRef)).toEqual(all.slice(2));
    expect(second.nextCursor).toBeNull();
    expect(second.scopeTotals).toEqual(first.scopeTotals);
  });

  it.each([
    ["another range", { from: "2026-10-02", to: "2026-10-31", page_size: 2 }],
    ["another page size", { ...OCTOBER, page_size: 1 }],
    ["a store_id", { store_id: STORE_A_X, ...OCTOBER, page_size: 2 }],
  ])("a cursor reused with %s is 400", async (_label, query) => {
    if (skip()) return;
    const first = await summary(SES_OWNER_ALL, { ...OCTOBER, page_size: 2 });
    await expectValidationError(await get(SES_OWNER_ALL, { ...query, cursor: first.nextCursor! }));
  });

  it("a cursor issued for another tenant is 400", async () => {
    if (skip()) return;
    const foreign = encodeSalesSummaryCursor(
      { tenantId: TENANT_B, storeId: null, from: OCTOBER.from, to: OCTOBER.to, pageSize: 2 },
      STORE_A_X,
    );
    await expectValidationError(await get(SES_OWNER_ALL, { ...OCTOBER, page_size: 2, cursor: foreign }));
  });

  it("a hand-built cursor only skips stores inside the caller's scope", async () => {
    if (skip()) return;
    const cursor = encodeSalesSummaryCursor(
      { tenantId: TENANT_A, storeId: null, from: OCTOBER.from, to: OCTOBER.to, pageSize: 50 },
      "00000000-0000-0000-0000-000000000000",
    );
    const s = await summary(SES_ADMIN_SPEC, { ...OCTOBER, cursor });
    expect(s.stores.map((x) => x.storeRef)).toEqual([STORE_A_X]);
  });
});

// ===========================================================================
// Audit
// ===========================================================================

describe("RT-649 sales summary — audit", () => {
  it("emits one console_sales.summary_read with no figure, after a 200 only", async () => {
    if (skip()) return;
    audit.payloads.length = 0;
    await summary(SES_OWNER_ALL, { store_id: STORE_A_X, ...OCTOBER });
    await get(SES_OWNER_ALL, { from: "2026-10-01" });
    await get(SES_STAFF, OCTOBER);
    await get(SES_OWNER_ALL, { store_id: STORE_B_X, ...OCTOBER });
    // The interceptor enqueues after the response; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    const events = audit.payloads.filter((p) => JSON.stringify(p).includes("console_sales.summary_read"));
    expect(events).toHaveLength(1);
    const text = JSON.stringify(events[0]);
    expect(text).toContain(STORE_A_X);
    expect(text).toContain('"scope":"store"');
    expect(text).toContain('"store_count":1');
    expect(text).not.toContain("112.5000");
  });
});
