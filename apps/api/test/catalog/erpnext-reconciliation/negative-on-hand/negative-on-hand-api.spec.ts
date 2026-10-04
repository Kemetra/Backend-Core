/**
 * RT-177 — ERPNext negative on-hand read model: HTTP + Testcontainers spec.
 *
 * Boots the REAL `ErpnextReconciliationModule` graph (its imports AuthModule /
 * AuditModule / ContextModule and its own providers) over real Postgres (the
 * NOBYPASSRLS `app_test` pool, full migration set). Nothing on the authorization
 * path is hand-registered: `TenantContextGuard`, `RolesGuard`,
 * `SessionRepository` and `MembershipRepository` come from the production module
 * wiring, so a missing guard provider would show up here. Only cookie
 * authentication is faked: a header names the session; with no header the real
 * `DashboardAuthGuard` runs (no cookie → 401). The pools are pointed at the
 * container and the audit enqueuer is a no-op.
 *
 * The main fixture's snapshots are recorded through the real
 * `ErpnextBinViewService.reportSnapshot` (019), so the stored report shape is the
 * one production writes; the edge states (stale, incomplete, paging volume) are
 * seeded directly (`__support__/seed-negative-on-hand.ts`). Every 200 body is
 * validated against the contract (Ajv 2020).
 *
 * Maps to the RT-177 acceptance criteria:
 *   AC1 contract conformance of every response;
 *   AC2 A=-3.000000 / B=5.000000 / C(unmapped)=-1.500000 → exactly A and C;
 *   AC3 no_warehouse_mapping / no_snapshot / stale / pendingRequest;
 *   AC4 a newer report supersedes; a later A=0 removes A;
 *   AC5 store_manager scope, cross-tenant 404, role default-deny 404, no session 401;
 *   AC6 limit 1..500 default 100, stable paging without duplicates or gaps;
 *   AC7 the reads write nothing.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import request from "supertest";

import { deterministicId } from "@data-pulse-2/shared";

import { AUDIT_JOB_ENQUEUER } from "../../../../src/audit/audit-job.enqueuer";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { AUTH_LOOKUP_POOL } from "../../../../src/auth/database-pools";
import { AuthTokenRepository } from "../../../../src/auth/auth-token.repository";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { SessionRepository } from "../../../../src/auth/session.repository";
import { ErpnextBinViewService } from "../../../../src/catalog/erpnext-bin-view/erpnext-bin-view.service";
import { ErpnextReconciliationModule } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.module";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { loadOpenApiContracts } from "../../../../src/openapi/loader";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { PRODUCT_A_ACTIVE, STORE_B_X, TENANT_A } from "../../__support__/isolation-harness";
import {
  BIN_VIEW_REQUEST_NS,
  HeaderSessionAuthGuard,
  ITEM_A,
  ITEM_B,
  ITEM_C,
  NON_EXISTENT,
  RUN_FIX_1,
  RUN_FIX_2,
  RUN_INC_NEW,
  RUN_INC_OLD,
  RUN_PEND,
  RUN_STALE,
  SES_ADMIN,
  SES_ADMIN_ACTIVE,
  SES_MGR,
  SES_OWNER,
  SES_OWNER_ACTIVE,
  SES_STAFF,
  S_DELETED,
  S_FIX,
  S_INCOMPLETE,
  S_NOSNAP,
  S_PAGE,
  S_PEND,
  S_STALE,
  S_UNMAPPED,
  hoursAgo,
  insertRun,
  seedNegativeOnHandFixture,
} from "../__support__/seed-negative-on-hand";

const READ_AT_1 = "2026-10-04T09:00:00.000+02:00";
const READ_AT_2 = "2026-10-04T10:00:00.000+02:00";

const BASE = "/api/v1/catalog/erpnext-reconciliation";
const STORES = `${BASE}/negative-on-hand/stores`;

/** A store addressed by the per-store operation. */
interface StoreRef {
  readonly storeId: string;
}
const itemsPath = (store: StoreRef): string => `${BASE}/stores/${store.storeId}/negative-on-hand`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let app: INestApplication | null = null;
let binView: ErpnextBinViewService;
let productAName = "";

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    productAName = await seedNegativeOnHandFixture(env.admin);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-177 negative-on-hand] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  const appPool = env.app;
  binView = new ErpnextBinViewService(appPool);
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
    console.warn("[RT-177 negative-on-hand] skipping — Docker unavailable");
    return true;
  }
  return false;
}

/** One GET: a path, an optional raw query string, and the session (default owner; null = none). */
interface GetRequest {
  readonly path: string;
  readonly query?: string;
  readonly session?: string | null;
}
function get(req: GetRequest) {
  const call = request(app!.getHttpServer()).get(`${req.path}${req.query ?? ""}`);
  const session = req.session === undefined ? SES_OWNER : req.session;
  return session ? call.set("x-test-session", session) : call;
}

// ---------------------------------------------------------------------------
// Contract validators (AC1 — every 200 body conforms)
// ---------------------------------------------------------------------------

let validators: { stores: ValidateFunction; items: ValidateFunction; error: ValidateFunction } | null = null;
function contract(): NonNullable<typeof validators> {
  if (validators) return validators;
  const dir = resolve(__dirname, "..", "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "erpnext-reconciliation");
  const c = loadOpenApiContracts({ dir }).find((x) => x.id === "reconciliation");
  if (!c) throw new Error("reconciliation.yaml not found");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(c.document as object), $id: "reconciliation" });
  validators = {
    stores: ajv.compile({ $ref: "reconciliation#/components/schemas/StoreNegativeOnHandSummaryPage" }),
    items: ajv.compile({ $ref: "reconciliation#/components/schemas/StoreNegativeOnHandPage" }),
    error: ajv.compile({ $ref: "reconciliation#/components/schemas/Error" }),
  };
  return validators;
}

interface ItemBody {
  discrepancyKind: string;
  erpnextItemRef: { doctype: string; name: string };
  mappingStatus: string;
  tenantProduct: { id: string; name: string } | null;
  erpnextWarehouseRef: string;
  quantity: string;
  stockUom: string;
}
interface SnapshotBody {
  status: string;
  erpnextWarehouseRef: string | null;
  runId: string | null;
  readAt: string | null;
  recordedAt: string | null;
  staleAfterSeconds: number;
  reportedEntryCount: number | null;
  pendingRequest: { runId: string; requestedAt: string } | null;
}
interface ItemsPage { storeId: string; snapshot: SnapshotBody; items: ItemBody[]; nextCursor: string | null }
interface SummaryBody { storeId: string; storeName: string; snapshot: SnapshotBody; negativeItemCount: number }
interface StoresPage { items: SummaryBody[]; nextCursor: string | null }

/** Page parameters of either operation; `session` defaults to the owner. */
interface PageQuery {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly session?: string;
}
interface ItemsQuery extends PageQuery, StoreRef {}

function queryString(q: PageQuery): string {
  const parts: string[] = [];
  if (q.limit !== undefined) parts.push(`limit=${q.limit}`);
  if (q.cursor) parts.push(`cursor=${q.cursor}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

/** GET a page, assert 200, and validate it against the contract schema. */
async function getPage<T>(req: GetRequest, validate: ValidateFunction): Promise<T> {
  const res = await get(req).expect(200);
  if (!validate(res.body)) throw new Error(JSON.stringify(validate.errors));
  return res.body as T;
}

async function getItems(q: ItemsQuery): Promise<ItemsPage> {
  const req = { path: itemsPath(q), query: queryString(q), session: q.session ?? SES_OWNER };
  return getPage<ItemsPage>(req, contract().items);
}

async function getStores(q: PageQuery = {}): Promise<StoresPage> {
  const req = { path: STORES, query: queryString(q), session: q.session ?? SES_OWNER };
  return getPage<StoresPage>(req, contract().stores);
}

/** Walk every summary page at `limit` and return the concatenation. */
async function allStores(q: Required<Pick<PageQuery, "session" | "limit">>): Promise<SummaryBody[]> {
  const out: SummaryBody[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const page: StoresPage = await getStores({ ...q, cursor });
    expect(page.items.length).toBeLessThanOrEqual(q.limit);
    out.push(...page.items);
    cursor = page.nextCursor;
    if (cursor === null) return out;
  }
  throw new Error("paging did not terminate");
}

/** The tenant-wide summary row of one store (owner session, one page of 500). */
async function summaryFor(store: StoreRef): Promise<SummaryBody> {
  return summaryIn({ list: (await getStores({ limit: 500 })).items, ...store });
}

function summaryIn(q: StoreRef & { readonly list: readonly SummaryBody[] }): SummaryBody {
  const s = q.list.find((x) => x.storeId === q.storeId);
  if (!s) throw new Error(`store ${q.storeId} missing from the summary`);
  return s;
}

/** One Connector Bin entry, as the Connector reports it. */
interface ReportedEntry {
  readonly name: string;
  readonly quantity: string;
}

/** Record a Connector snapshot for a running run through the real 019 service. */
async function report(r: { runId: string; readAt: string; entries: readonly ReportedEntry[] }): Promise<void> {
  await binView.reportSnapshot({
    tenantId: TENANT_A,
    requestRef: deterministicId(BIN_VIEW_REQUEST_NS, `${r.runId}:0`),
    body: {
      readAt: r.readAt,
      entries: r.entries.map((e) => ({
        erpnextItemRef: { doctype: "Item" as const, name: e.name },
        quantity: e.quantity,
        stockUom: "Nos",
      })),
    },
    idempotencyKey: `rt177-${r.runId}`,
  });
}

// ---------------------------------------------------------------------------
// AC2 + AC3(pending) + AC4 — the S_FIX lifecycle (ordered)
// ---------------------------------------------------------------------------

describe("RT-177 AC2/AC3/AC4 — snapshot lifecycle of a mapped store", () => {
  it("before any report: no_snapshot, items [], count 0", async () => {
    if (skip()) return;
    const page = await getItems({ storeId: S_FIX });
    expect(page.storeId).toBe(S_FIX);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.snapshot).toMatchObject({
      status: "no_snapshot",
      erpnextWarehouseRef: "WH-FIX",
      runId: null,
      readAt: null,
      recordedAt: null,
      staleAfterSeconds: 86400,
      reportedEntryCount: null,
      pendingRequest: null,
    });
  });

  it("AC2: A=-3.000000, B=5.000000, C(unmapped)=-1.500000 → exactly A then C, verbatim", async () => {
    if (skip()) return;
    await insertRun(env!.admin, { id: RUN_FIX_1, storeId: S_FIX, status: "running", startedAt: hoursAgo(0.5) });
    // Before the Connector reports, the run is a pending request with no snapshot.
    const waiting = await getItems({ storeId: S_FIX });
    expect(waiting.snapshot.status).toBe("no_snapshot");
    expect(waiting.snapshot.pendingRequest?.runId).toBe(RUN_FIX_1);

    await report({
      runId: RUN_FIX_1,
      readAt: READ_AT_1,
      entries: [
        { name: ITEM_A, quantity: "-3.000000" },
        { name: ITEM_B, quantity: "5.000000" },
        { name: ITEM_C, quantity: "-1.500000" },
      ],
    });

    const page = await getItems({ storeId: S_FIX });
    expect(page.snapshot.status).toBe("fresh");
    expect(page.snapshot.runId).toBe(RUN_FIX_1);
    expect(page.snapshot.readAt).toBe(READ_AT_1);
    expect(page.snapshot.recordedAt).not.toBeNull();
    expect(page.snapshot.reportedEntryCount).toBe(3);
    expect(page.snapshot.erpnextWarehouseRef).toBe("WH-FIX");
    // The reported run is still `running` but carries a report: not pending.
    expect(page.snapshot.pendingRequest).toBeNull();
    expect(page.items).toEqual([
      {
        discrepancyKind: "erpnext_negative_on_hand",
        erpnextItemRef: { doctype: "Item", name: ITEM_A },
        mappingStatus: "mapped",
        tenantProduct: { id: PRODUCT_A_ACTIVE, name: productAName },
        erpnextWarehouseRef: "WH-FIX",
        quantity: "-3.000000",
        stockUom: "Nos",
      },
      {
        discrepancyKind: "erpnext_negative_on_hand",
        erpnextItemRef: { doctype: "Item", name: ITEM_C },
        mappingStatus: "unmapped",
        tenantProduct: null,
        erpnextWarehouseRef: "WH-FIX",
        quantity: "-1.500000",
        stockUom: "Nos",
      },
    ]);
    expect(page.nextCursor).toBeNull();

    const summary = await summaryFor({ storeId: S_FIX });
    expect(summary.negativeItemCount).toBe(2);
    expect(summary.snapshot).toEqual(page.snapshot);
  });

  it("AC3: a newer running run without a report → pendingRequest, previous snapshot still served", async () => {
    if (skip()) return;
    await insertRun(env!.admin, { id: RUN_FIX_2, storeId: S_FIX, status: "running", startedAt: new Date().toISOString() });
    const page = await getItems({ storeId: S_FIX });
    expect(page.snapshot.status).toBe("fresh");
    expect(page.snapshot.runId).toBe(RUN_FIX_1);
    expect(page.snapshot.pendingRequest?.runId).toBe(RUN_FIX_2);
    expect(Number.isNaN(Date.parse(page.snapshot.pendingRequest!.requestedAt))).toBe(false);
    expect(page.items.map((i) => i.erpnextItemRef.name)).toEqual([ITEM_A, ITEM_C]);
  });

  it("AC4: the newer report supersedes; A=0 removes A; -0.000000 is not negative", async () => {
    if (skip()) return;
    await report({
      runId: RUN_FIX_2,
      readAt: READ_AT_2,
      entries: [
        { name: ITEM_A, quantity: "0" },
        { name: ITEM_C, quantity: "-1.500000" },
        { name: "RT177-ITEM-Z", quantity: "-0.000000" },
      ],
    });
    const page = await getItems({ storeId: S_FIX });
    expect(page.snapshot.runId).toBe(RUN_FIX_2);
    expect(page.snapshot.readAt).toBe(READ_AT_2);
    expect(page.snapshot.reportedEntryCount).toBe(3);
    expect(page.snapshot.pendingRequest).toBeNull();
    expect(page.items.map((i) => [i.erpnextItemRef.name, i.quantity])).toEqual([[ITEM_C, "-1.500000"]]);
    expect((await summaryFor({ storeId: S_FIX })).negativeItemCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC3 — freshness states
// ---------------------------------------------------------------------------

describe("RT-177 AC3 — snapshot freshness states", () => {
  it("no active stock map (only returns + retired maps, old snapshot) → no_warehouse_mapping", async () => {
    if (skip()) return;
    const page = await getItems({ storeId: S_UNMAPPED });
    expect(page.items).toEqual([]);
    expect(page.snapshot).toEqual({
      status: "no_warehouse_mapping",
      erpnextWarehouseRef: null,
      runId: null,
      readAt: null,
      recordedAt: null,
      staleAfterSeconds: 86400,
      reportedEntryCount: null,
      pendingRequest: null,
    });
    expect((await summaryFor({ storeId: S_UNMAPPED })).negativeItemCount).toBe(0);
  });

  it("mapped with no report → no_snapshot, items []", async () => {
    if (skip()) return;
    const page = await getItems({ storeId: S_NOSNAP });
    expect(page.snapshot.status).toBe("no_snapshot");
    expect(page.snapshot.pendingRequest).toBeNull();
    expect(page.items).toEqual([]);
  });

  it("mapped with only a running request → no_snapshot + pendingRequest", async () => {
    if (skip()) return;
    const page = await getItems({ storeId: S_PEND });
    expect(page.snapshot.status).toBe("no_snapshot");
    expect(page.snapshot.pendingRequest?.runId).toBe(RUN_PEND);
    expect(page.items).toEqual([]);
    expect((await summaryFor({ storeId: S_PEND })).negativeItemCount).toBe(0);
  });

  it("recordedAt older than staleAfterSeconds → stale, items still returned", async () => {
    if (skip()) return;
    const page = await getItems({ storeId: S_STALE });
    expect(page.snapshot.status).toBe("stale");
    expect(page.snapshot.runId).toBe(RUN_STALE);
    expect(page.items.map((i) => [i.erpnextItemRef.name, i.quantity])).toEqual([["STALE-X", "-2.000000"]]);
    expect((await summaryFor({ storeId: S_STALE })).negativeItemCount).toBe(1);
  });

  it("a report with complete:false is not a snapshot; its running run is the pending request", async () => {
    if (skip()) return;
    const page = await getItems({ storeId: S_INCOMPLETE });
    expect(page.snapshot.status).toBe("fresh");
    expect(page.snapshot.runId).toBe(RUN_INC_OLD);
    expect(page.snapshot.pendingRequest?.runId).toBe(RUN_INC_NEW);
    expect(page.items.map((i) => [i.erpnextItemRef.name, i.quantity])).toEqual([["INC-Q", "-1.000000"]]);
  });
});

// ---------------------------------------------------------------------------
// AC6 — pagination
// ---------------------------------------------------------------------------

describe("RT-177 AC6 — pagination", () => {
  it("items: default limit 100, then the rest; ordered by exact quantity then name", async () => {
    if (skip()) return;
    const first = await getItems({ storeId: S_PAGE });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).not.toBeNull();
    const second = await getItems({ storeId: S_PAGE, cursor: first.nextCursor });
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();

    const all = (await getItems({ storeId: S_PAGE, limit: 500 })).items;
    expect(all).toHaveLength(105);
    expect([...first.items, ...second.items]).toEqual(all);
    expect(all.some((i) => i.erpnextItemRef.name === "ZERO")).toBe(false);
    // Most negative first; ties by name.
    const key = (i: ItemBody) => Number(i.quantity);
    for (let k = 1; k < all.length; k++) {
      const prev = all[k - 1]!;
      const cur = all[k]!;
      expect(key(prev) < key(cur) || (key(prev) === key(cur) && prev.erpnextItemRef.name <= cur.erpnextItemRef.name)).toBe(true);
    }
  });

  it("items: small pages cover every row exactly once, in order", async () => {
    if (skip()) return;
    const all = (await getItems({ storeId: S_PAGE, limit: 500 })).items;
    for (const limit of [1, 7, 104, 105]) {
      const seen: ItemBody[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 200; i++) {
        const page: ItemsPage = await getItems({ storeId: S_PAGE, limit, cursor });
        expect(page.items.length).toBeLessThanOrEqual(limit);
        seen.push(...page.items);
        cursor = page.nextCursor;
        if (cursor === null) break;
      }
      expect(seen).toEqual(all);
    }
  });

  it("stores: limit=1 paging covers every visible store exactly once, ordered by id", async () => {
    if (skip()) return;
    const full = (await getStores({ limit: 500 })).items;
    const paged = await allStores({ session: SES_OWNER, limit: 1 });
    expect(paged.map((s) => s.storeId)).toEqual(full.map((s) => s.storeId));
    expect(new Set(paged.map((s) => s.storeId)).size).toBe(paged.length);
    const ids = full.map((s) => s.storeId);
    expect(ids).toEqual([...ids].sort());
    // Every live tenant-A store, nothing else (no deleted store, no tenant B).
    expect(ids.sort()).toEqual(
      [S_FIX, S_STALE, S_UNMAPPED, S_NOSNAP, S_PEND, S_INCOMPLETE, S_PAGE].sort(),
    );
    expect(summaryIn({ list: full, storeId: S_PAGE }).negativeItemCount).toBe(105);
  });

  it.each([
    { label: "limit=0", query: "?limit=0" },
    { label: "limit=501", query: "?limit=501" },
    { label: "limit=abc", query: "?limit=abc" },
    { label: "garbage cursor", query: "?cursor=bm90LWpzb24" },
    { label: "non-base64url cursor", query: "?cursor=a.b" },
    { label: "unknown query key", query: "?storeId=" + S_FIX },
  ])("400 validation_error on $label (both operations)", async ({ query }) => {
    if (skip()) return;
    for (const path of [STORES, itemsPath({ storeId: S_PAGE })]) {
      const res = await get({ path, query }).expect(400);
      expect(res.body.error.code).toBe("validation_error");
      // Envelope shape only: the shared ZodValidationPipe adds `error.details`,
      // which this file's `Error` schema does not declare (pre-existing for every
      // operation of the file; not changed by RT-177).
      expect(typeof res.body.error.message).toBe("string");
    }
  });

  it("a cursor issued by one operation is a 400 on the other", async () => {
    if (skip()) return;
    const itemsPage = await getItems({ storeId: S_PAGE, limit: 1 });
    const storesPage = await getStores({ limit: 1 });
    await get({ path: STORES, query: `?cursor=${itemsPage.nextCursor}` }).expect(400);
    await get({ path: itemsPath({ storeId: S_PAGE }), query: `?cursor=${storesPage.nextCursor}` }).expect(400);
  });

  it("an item cursor is bound to its store: replaying it on another store is a 400", async () => {
    if (skip()) return;
    const itemsPage = await getItems({ storeId: S_PAGE, limit: 1 });
    expect(itemsPage.nextCursor).not.toBeNull();
    const res = await get({ path: itemsPath({ storeId: S_STALE }), query: `?cursor=${itemsPage.nextCursor}` }).expect(400);
    expect(res.body.error.code).toBe("validation_error");
    // The same cursor still continues its own store.
    await getItems({ storeId: S_PAGE, cursor: itemsPage.nextCursor });
  });

  it("a malformed storeId → 400 validation_error", async () => {
    if (skip()) return;
    const res = await get({ path: itemsPath({ storeId: "not-a-uuid" }) }).expect(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

// ---------------------------------------------------------------------------
// AC5 — authorization
// ---------------------------------------------------------------------------

describe("RT-177 AC5 — authorization + non-disclosure", () => {
  it("store_manager scoped to S1 sees only S1 in the summary and gets 404 on S2", async () => {
    if (skip()) return;
    const list = await allStores({ session: SES_MGR, limit: 500 });
    expect(list.map((s) => s.storeId)).toEqual([S_FIX]);
    await getItems({ storeId: S_FIX, session: SES_MGR });
    const res = await get({ path: itemsPath({ storeId: S_STALE }), session: SES_MGR }).expect(404);
    expect(res.body.error.code).toBe("not_found");
    expect(contract().error(res.body)).toBe(true);
  });

  it.each([
    { role: "owner", session: SES_OWNER_ACTIVE },
    { role: "tenant_admin", session: SES_ADMIN_ACTIVE },
  ])("$role with an active store selected still reads tenant-wide", async ({ session }) => {
    if (skip()) return;
    const tenantWide = (await allStores({ session: SES_OWNER, limit: 500 })).map((s) => s.storeId);
    const list = await allStores({ session, limit: 500 });
    expect(list.map((s) => s.storeId)).toEqual(tenantWide);
    expect(tenantWide.length).toBeGreaterThan(1);
    // A store other than the active one (S_PAGE) is readable.
    const stale = await getItems({ storeId: S_STALE, session });
    expect(stale.items.map((i) => i.erpnextItemRef.name)).toEqual(["STALE-X"]);
  });

  it("tenant_admin reads tenant-wide", async () => {
    if (skip()) return;
    const list = await allStores({ session: SES_ADMIN, limit: 500 });
    expect(list.map((s) => s.storeId)).toContain(S_STALE);
    await getItems({ storeId: S_STALE, session: SES_ADMIN });
  });

  it("cross-tenant, deleted and nonexistent stores → identical 404 not_found", async () => {
    if (skip()) return;
    const bodies = [];
    for (const storeId of [STORE_B_X, S_DELETED, NON_EXISTENT]) {
      const res = await get({ path: itemsPath({ storeId }) }).expect(404);
      bodies.push({ code: res.body.error.code, message: res.body.error.message });
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]!.code).toBe("not_found");
  });

  it("a role outside owner/tenant_admin/store_manager gets the default 404 on both operations (production module wiring)", async () => {
    if (skip()) return;
    // store_staff is an authenticated member of tenant A with 'all' store access:
    // TenantContextGuard admits it, so only RolesGuard (resolved from the real
    // ErpnextReconciliationModule graph, not hand-registered) can deny it.
    for (const path of [STORES, itemsPath({ storeId: S_FIX })]) {
      const res = await get({ path, session: SES_STAFF }).expect(404);
      expect(res.body.error.code).toBe("not_found");
      expect(contract().error(res.body)).toBe(true);
    }
    // The existing 017 routes in the same module are gated by the same guard.
    await get({ path: `${BASE}/postings/backlog`, session: SES_STAFF }).expect(404);
    await get({ path: `${BASE}/runs/${RUN_STALE}`, session: SES_STAFF }).expect(404);
    await get({ path: `${BASE}/runs/${RUN_STALE}` }).expect(200);
  });

  it("no session → 401 on both operations", async () => {
    if (skip()) return;
    await get({ path: STORES, session: null }).expect(401);
    await get({ path: itemsPath({ storeId: S_FIX }), session: null }).expect(401);
  });
});

// ---------------------------------------------------------------------------
// AC7 — no write path
// ---------------------------------------------------------------------------

describe("RT-177 AC7 — the reads write nothing", () => {
  it("leaves runs, results, stock_movements, outbox and audit untouched", async () => {
    if (skip()) return;
    const fingerprint = async (): Promise<string> => {
      const r = await env!.admin.query<{ f: string }>(
        `SELECT concat_ws('|',
           (SELECT md5(coalesce(string_agg(id::text || status || coalesce(summary::text, '') || updated_at::text, ',' ORDER BY id), ''))
              FROM erpnext_reconciliation_run),
           (SELECT count(*) FROM erpnext_reconciliation_result),
           (SELECT count(*) FROM erpnext_reconciliation_repair_attempt),
           (SELECT count(*) FROM stock_movements),
           (SELECT count(*) FROM outbox_events),
           (SELECT count(*) FROM audit_events)) AS f`,
      );
      return r.rows[0]!.f;
    };
    const before = await fingerprint();
    await getStores({ limit: 500 });
    await getStores({ limit: 500, session: SES_MGR });
    for (const storeId of [S_FIX, S_STALE, S_UNMAPPED, S_NOSNAP, S_PEND, S_INCOMPLETE, S_PAGE]) {
      await getItems({ storeId, limit: 500 });
    }
    await get({ path: itemsPath({ storeId: STORE_B_X }) }).expect(404);
    expect(await fingerprint()).toBe(before);
  });
});
