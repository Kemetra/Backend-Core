/**
 * RT-730 (CAT-R2) — the console catalog read over HTTP against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool) and the
 * real module graph (`SessionOnlyAdminGuard`, `TenantContextGuard`,
 * `RolesGuard`, `MembershipRepository`). Only cookie authentication is faked:
 * a header names the session (the RT-192 / RT-562 pattern); bearer tokens go
 * through the real session-only guard.
 *
 *   GET /api/v1/catalog/products              consoleListCatalogProducts
 *   GET /api/v1/catalog/products/{productId}  consoleGetCatalogProduct
 *   GET /api/v1/catalog/categories            consoleListCatalogCategories
 *
 * What this proves (RT-730 acceptance):
 *   - every allowed role reads every tenant product (O-7); cross-tenant,
 *     out-of-scope `store_id` and `store_staff` reads are one non-disclosing
 *     404; every bearer is 401;
 *   - store data (storeView, store-scoped identifiers, overrides) stays in
 *     the caller's store scope;
 *   - `q`: exact identifier with leading zeros, exact hits first, a retired
 *     identifier never matches, `%` / `_` are literal, the name match is
 *     case-insensitive;
 *   - cursor walks terminate, see every product once, and a cursor is
 *     rejected when the filters change;
 *   - `storeView` equals the POS read-down projection for the same store;
 *   - every 200 and error body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import request from "supertest";

import { ConsoleCatalogModule } from "../../../src/catalog/console-catalog/console-catalog.module";
import { ReadDownService } from "../../../src/catalog/read-down/read-down.service";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../_helpers/postgres-container";
import { allContracts, contractDocument } from "../../_helpers/openapi-contract";
import {
  DASHBOARD_TOKEN,
  DEVICE_TOKEN,
  OPERATOR_TOKEN,
  SES_MANAGER,
  SES_MANAGER_ACTIVE,
  SES_PLATFORM,
  SES_STAFF,
} from "../../console-sales/__support__/console-sales-fixture";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A } from "../__support__/isolation-harness";
import {
  bootScopedApp,
  NON_EXISTENT,
  S_DELETED,
  SES_ADMIN_SPEC,
  SES_OWNER_ALL,
  SES_OWNER_ALL_ACTIVE,
} from "../erpnext-reconciliation/__support__/read-store-scope";
import {
  ACTIVE_BY_NAME,
  ALL_BY_NAME,
  CAT_B,
  CAT_DRINKS,
  CAT_OLD,
  P_B,
  P_INACTIVE,
  P_JUICE,
  P_LOOKALIKE,
  P_ODD,
  P_PERCENT,
  P_RETIRED,
  P_UNPRICED,
  P_WATER,
  seedConsoleCatalogFixture,
} from "./__support__/console-catalog-fixture";

const LIST = "/api/v1/catalog/products";
const CATEGORIES = "/api/v1/catalog/categories";
const detailPath = (productId: string): string => `${LIST}/${productId}`;
const NOT_FOUND = { code: "not_found", message: "Not Found" };
const CONTRACT_ID = "console-catalog";
const FIXTURE = { q: "rt730" };

type Query = Record<string, string | number>;
interface StoreViewBody {
  storeId: string;
  effectivePrice: { amount: string; currencyCode: string } | null;
  effectiveActive: boolean;
  effectiveTaxCategory: string;
  hasOverride: boolean;
}
interface Item {
  productId: string;
  name: string;
  status: string;
  storeView?: StoreViewBody;
  [key: string]: unknown;
}
interface Page {
  items: Item[];
  nextCursor: string | null;
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
let pageSchema: ValidateFunction;
let detailSchema: ValidateFunction;
let categoriesSchema: ValidateFunction;
let errorSchema: ValidateFunction;

beforeAll(async () => {
  ajv.addSchema(contractDocument(allContracts(), CONTRACT_ID) as object, CONTRACT_ID);
  const compiled = (name: string): ValidateFunction => {
    const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
    if (!v) throw new Error(`ajv cannot resolve ${name}`);
    return v;
  };
  pageSchema = compiled("ConsoleCatalogProductPage");
  detailSchema = compiled("ConsoleCatalogProductDetail");
  categoriesSchema = compiled("ConsoleCatalogCategoryList");
  errorSchema = compiled("Error");

  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedConsoleCatalogFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-730 console-catalog] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  // Bearer tokens resolve on the RLS-exempt pool, as the production auth-lookup role does.
  app = await bootScopedApp(env, ConsoleCatalogModule, undefined, { authLookupPool: env.admin });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-730 console-catalog] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function get(path: string, session: string | null, query: Query = {}): request.Test {
  const req = request(app!.getHttpServer()).get(path).query(query);
  return session === null ? req : req.set("x-test-session", session);
}

function expectValid(validate: ValidateFunction, body: unknown): void {
  if (!validate(body)) throw new Error(`contract violation: ${JSON.stringify(validate.errors)}`);
}

/** One page; asserts 200, no-store and the page shape. */
async function page(session: string, query: Query): Promise<Page> {
  const res = await get(LIST, session, query);
  if (res.status !== 200) throw new Error(`list ${res.status}: ${JSON.stringify(res.body)}`);
  expect(res.headers["cache-control"]).toBe("no-store");
  expectValid(pageSchema, res.body);
  return res.body as Page;
}

/** The product ids of one page that must also be the last. */
async function ids(session: string, query: Query): Promise<string[]> {
  const body = await page(session, { limit: 100, ...query });
  expect(body.nextCursor).toBeNull();
  return body.items.map((i) => i.productId);
}

/** Walk every page; the ids in order. */
async function walk(session: string, query: Query): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let n = 1; n <= 200; n += 1) {
    const body = await page(session, { ...query, ...(cursor ? { cursor } : {}) });
    seen.push(...body.items.map((i) => i.productId));
    cursor = body.nextCursor;
    if (cursor === null) return seen;
  }
  throw new Error("console catalog paging did not terminate");
}

async function detail(session: string, productId: string): Promise<Record<string, unknown>> {
  const res = await get(detailPath(productId), session);
  if (res.status !== 200) throw new Error(`detail ${res.status}: ${JSON.stringify(res.body)}`);
  expect(res.headers["cache-control"]).toBe("no-store");
  expectValid(detailSchema, res.body);
  return res.body as Record<string, unknown>;
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

// ===========================================================================
// Auth, role and store scope
// ===========================================================================

describe("RT-730 console catalog — role and scope", () => {
  it.each([
    ["owner, all", SES_OWNER_ALL],
    ["owner, all, X active", SES_OWNER_ALL_ACTIVE],
    ["tenant_admin, specific (X)", SES_ADMIN_SPEC],
    ["store_manager, specific (X + Y)", SES_MANAGER],
    ["store_manager, Y active", SES_MANAGER_ACTIVE],
    ["platform admin", SES_PLATFORM],
  ])("%s reads every active tenant product (O-7)", async (_label, session) => {
    if (skip()) return;
    expect(await ids(session, FIXTURE)).toEqual(ACTIVE_BY_NAME);
  });

  it("store_staff is the non-disclosing 404 on every read", async () => {
    if (skip()) return;
    await expectNotFound(await get(LIST, SES_STAFF, FIXTURE));
    await expectNotFound(await get(detailPath(P_WATER), SES_STAFF));
    await expectNotFound(await get(CATEGORIES, SES_STAFF));
    await expectNotFound(await get(LIST, SES_STAFF, { limit: "nope" }));
  });

  it.each([
    ["another tenant's store", SES_OWNER_ALL, STORE_B_X],
    ["an absent store", SES_OWNER_ALL, NON_EXISTENT],
    ["a store outside a specific grant", SES_ADMIN_SPEC, STORE_A_Y],
    ["a store outside the active-store narrowing", SES_MANAGER_ACTIVE, STORE_A_X],
    // Owner decision on RT-730: a soft-deleted store is absent here, even tenant-wide
    // (an intentional divergence from console-sales).
    ["a soft-deleted store, tenant-wide", SES_OWNER_ALL, S_DELETED],
  ])("%s as store_id is the non-disclosing 404", async (_label, session, storeId) => {
    if (skip()) return;
    await expectNotFound(await get(LIST, session, { ...FIXTURE, store_id: storeId }));
  });

  it.each([
    ["another tenant's product", P_B],
    ["an absent product", NON_EXISTENT],
  ])("%s is the non-disclosing 404 on the detail", async (_label, productId) => {
    if (skip()) return;
    await expectNotFound(await get(detailPath(productId), SES_OWNER_ALL));
  });

  it.each([
    ["a dashboard_api token", DASHBOARD_TOKEN],
    ["a POS operator token", OPERATOR_TOKEN],
    ["a device token", DEVICE_TOKEN],
    ["an unknown bearer", "not-a-real-token"],
  ])("%s is 401 on every read (cookie session only)", async (_label, token) => {
    if (skip()) return;
    for (const path of [LIST, detailPath(P_WATER), CATEGORIES]) {
      const res = await get(path, null).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
      expectValid(errorSchema, res.body);
    }
  });

  it("no credential is 401", async () => {
    if (skip()) return;
    expect((await get(LIST, null)).status).toBe(401);
  });
});

// ===========================================================================
// Validation (400), after the guards and before any read
// ===========================================================================

describe("RT-730 console catalog — validation", () => {
  it.each<[string, Query]>([
    ["an unknown key", { tenant_id: TENANT_A }],
    ["an empty q", { q: "" }],
    ["a q over 100 characters", { q: "x".repeat(101) }],
    ["an unknown status", { status: "deleted" }],
    ["limit 0", { limit: 0 }],
    ["limit 101", { limit: 101 }],
    ["a malformed category_id", { category_id: "x" }],
    ["a foreign cursor", { cursor: "c2FsZXM" }],
  ])("the list refuses %s", async (_label, query) => {
    if (skip()) return;
    await expectValidationError(await get(LIST, SES_OWNER_ALL, query));
  });

  it("the list refuses a repeated key", async () => {
    if (skip()) return;
    await expectValidationError(await get(LIST, SES_OWNER_ALL).query("q=a&q=b"));
  });

  it("the detail and the categories take no query key; the detail id must be a UUID", async () => {
    if (skip()) return;
    await expectValidationError(await get(detailPath(P_WATER), SES_OWNER_ALL, { store_id: STORE_A_X }));
    await expectValidationError(await get(CATEGORIES, SES_OWNER_ALL, { limit: 5 }));
    await expectValidationError(await get(detailPath("not-a-uuid"), SES_OWNER_ALL));
  });
});

// ===========================================================================
// Search, status and category
// ===========================================================================

describe("RT-730 console catalog — search and filters", () => {
  it("matches an exact barcode with its leading zeros, in the session's tenant only", async () => {
    if (skip()) return;
    expect(await ids(SES_OWNER_ALL, { q: "000123" })).toEqual([P_WATER]);
    expect(await ids(SES_OWNER_ALL, { q: "123" })).toEqual([P_JUICE]);
    expect(await ids(SES_OWNER_ALL, { q: "00123" })).toEqual([]);
  });

  it("never matches a retired identifier", async () => {
    if (skip()) return;
    expect(await ids(SES_OWNER_ALL, { q: "999000" })).toEqual([]);
  });

  it("ranks exact identifier hits before name matches", async () => {
    if (skip()) return;
    // P_LOOKALIKE sorts first by name; P_WATER's sku is exactly `W-1`.
    expect(await ids(SES_OWNER_ALL, { q: "W-1" })).toEqual([P_WATER, P_LOOKALIKE]);
  });

  it("matches the name case-insensitively, with % and _ literal", async () => {
    if (skip()) return;
    expect(await ids(SES_OWNER_ALL, { q: "rt730 WAT" })).toEqual([P_WATER]);
    expect(await ids(SES_OWNER_ALL, { q: "%" })).toEqual([P_PERCENT]);
    expect(await ids(SES_OWNER_ALL, { q: "_" })).toEqual([]);
  });

  it("counts a store-scoped identifier only for a store in scope", async () => {
    if (skip()) return;
    expect(await ids(SES_OWNER_ALL, { q: "4242" })).toEqual([P_WATER]);
    expect(await ids(SES_OWNER_ALL, { q: "4242", store_id: STORE_A_Y })).toEqual([P_WATER]);
    expect(await ids(SES_OWNER_ALL, { q: "4242", store_id: STORE_A_X })).toEqual([]);
    expect(await ids(SES_ADMIN_SPEC, { q: "4242" })).toEqual([]);
  });

  it("filters by tenant status, default active", async () => {
    if (skip()) return;
    expect(await ids(SES_OWNER_ALL, { ...FIXTURE, status: "active" })).toEqual(ACTIVE_BY_NAME);
    expect(await ids(SES_OWNER_ALL, { ...FIXTURE, status: "inactive" })).toEqual([P_INACTIVE]);
    expect(await ids(SES_OWNER_ALL, { ...FIXTURE, status: "retired" })).toEqual([P_RETIRED]);
    expect(await ids(SES_OWNER_ALL, { ...FIXTURE, status: "any" })).toEqual(ALL_BY_NAME);
  });

  it("filters by category; another tenant's category matches nothing", async () => {
    if (skip()) return;
    expect(await ids(SES_OWNER_ALL, { category_id: CAT_DRINKS })).toEqual([P_WATER]);
    expect(await ids(SES_OWNER_ALL, { category_id: CAT_B })).toEqual([]);
  });

  it("projects the summary with stored money and the category name", async () => {
    if (skip()) return;
    const items = (await page(SES_OWNER_ALL, { ...FIXTURE, status: "any", limit: 100 })).items;
    const byId = new Map(items.map((i) => [i.productId, i]));
    expect(byId.get(P_WATER)).toEqual({
      productId: P_WATER,
      name: "RT730 Water",
      status: "active",
      categoryId: CAT_DRINKS,
      categoryName: "RT730 Drinks",
      primarySku: "W-1",
      primaryBarcode: "000123",
      defaultPrice: { amount: "8.50", currencyCode: "EGP" },
      taxCategory: "standard",
      trackingMode: "none",
      updatedAt: expect.any(String),
    });
    expect(byId.get(P_JUICE)).toMatchObject({ categoryId: CAT_OLD, categoryName: "RT730 Old", primarySku: null });
    expect(byId.get(P_ODD)!["defaultPrice"]).toEqual({ amount: "9.999", currencyCode: "EGP" });
    expect(byId.get(P_UNPRICED)!["defaultPrice"]).toBeNull();
    expect(byId.get(P_INACTIVE)!.status).toBe("inactive");
    expect(byId.get(P_RETIRED)!.status).toBe("retired");
    expect(items.every((i) => i.storeView === undefined)).toBe(true);
  });
});

// ===========================================================================
// Paging
// ===========================================================================

describe("RT-730 console catalog — paging", () => {
  it.each([1, 2, 3, 7])("walks every product once at limit %i", async (limit) => {
    if (skip()) return;
    expect(await walk(SES_OWNER_ALL, { ...FIXTURE, status: "any", limit })).toEqual(ALL_BY_NAME);
  });

  it("walks the exact-first order across pages", async () => {
    if (skip()) return;
    expect(await walk(SES_OWNER_ALL, { q: "W-1", limit: 1 })).toEqual([P_WATER, P_LOOKALIKE]);
  });

  it("walks the whole tenant without a duplicate", async () => {
    if (skip()) return;
    const all = await walk(SES_OWNER_ALL, { status: "any", limit: 2 });
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(expect.arrayContaining(ALL_BY_NAME));
    expect(all).not.toContain(P_B);
  });

  it("rejects a cursor reused with other filters or by another tenant's session", async () => {
    if (skip()) return;
    const first = await page(SES_OWNER_ALL, { ...FIXTURE, status: "any", limit: 1 });
    const cursor = first.nextCursor!;
    expect(cursor).not.toBeNull();
    await expectValidationError(await get(LIST, SES_OWNER_ALL, { ...FIXTURE, status: "active", limit: 1, cursor }));
    await expectValidationError(await get(LIST, SES_OWNER_ALL, { q: "rt73", status: "any", limit: 1, cursor }));
    await expectValidationError(
      await get(LIST, SES_OWNER_ALL, { ...FIXTURE, status: "any", store_id: STORE_A_X, limit: 1, cursor }),
    );
    // The same filters continue the walk.
    expect((await page(SES_OWNER_ALL, { ...FIXTURE, status: "any", limit: 1, cursor })).items).toHaveLength(1);
  });
});

// ===========================================================================
// storeView and read-down parity
// ===========================================================================

describe("RT-730 console catalog — storeView", () => {
  async function storeViews(session: string, storeId: string): Promise<Map<string, StoreViewBody>> {
    const items = (await page(session, { ...FIXTURE, status: "any", store_id: storeId, limit: 100 })).items;
    return new Map(items.map((i) => [i.productId, i.storeView!]));
  }

  it("resolves the store's overrides over the tenant values", async () => {
    if (skip()) return;
    const x = await storeViews(SES_OWNER_ALL, STORE_A_X);
    expect(x.get(P_WATER)).toEqual({
      storeId: STORE_A_X,
      effectivePrice: { amount: "9.00", currencyCode: "EGP" },
      effectiveActive: true,
      effectiveTaxCategory: "reduced",
      hasOverride: true,
    });
    expect(x.get(P_JUICE)).toMatchObject({ effectiveActive: false, hasOverride: true });
    expect(x.get(P_RETIRED)).toMatchObject({ effectiveActive: false, hasOverride: false });
    expect(x.get(P_UNPRICED)).toMatchObject({ effectivePrice: null, effectiveActive: true });
    const y = await storeViews(SES_MANAGER_ACTIVE, STORE_A_Y);
    expect(y.get(P_WATER)).toMatchObject({ effectivePrice: { amount: "7.00", currencyCode: "EGP" }, effectiveTaxCategory: "standard" });
    expect(y.get(P_JUICE)).toMatchObject({ effectiveActive: true, hasOverride: false });
  });

  /** A product the read-down leaves off the POS stream: inactive, retired, unpriced or not representable. */
  function offStream(view: StoreViewBody): boolean {
    const price = view.effectivePrice;
    return !view.effectiveActive || price === null || /\.\d{3,}$/.test(price.amount);
  }

  it.each([STORE_A_X, STORE_A_Y])("equals the POS read-down projection for store %s", async (storeId) => {
    if (skip()) return;
    const snapshot = await new ReadDownService(env!.app).getSnapshot(TENANT_A, storeId, { limit: 1000 });
    expect(snapshot.next_page_token).toBeNull();
    const sellable = new Map(snapshot.items.map((row) => [row.product_id, row]));
    const views = await storeViews(SES_OWNER_ALL, storeId);
    const published = [...views].filter(([productId]) => sellable.has(productId));
    const unpublished = [...views].filter(([productId]) => !sellable.has(productId));
    for (const [productId, view] of published) {
      const row = sellable.get(productId)!;
      expect({ price: view.effectivePrice, tax: view.effectiveTaxCategory, active: view.effectiveActive }).toEqual({
        price: { amount: row.price.amount, currencyCode: row.price.currency_code },
        tax: row.tax_category,
        active: row.active,
      });
    }
    expect(unpublished.filter(([, view]) => !offStream(view))).toEqual([]);
    expect(published.map(([productId]) => productId).sort()).toEqual(
      ACTIVE_BY_NAME.filter((productId) => sellable.has(productId)).sort(),
    );
    expect(sellable.has(P_ODD)).toBe(false);
    expect(published.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Detail and categories
// ===========================================================================

describe("RT-730 console catalog — detail", () => {
  it("lists active identifiers and overrides of every store for a tenant-wide owner", async () => {
    if (skip()) return;
    const body = await detail(SES_OWNER_ALL, P_WATER);
    expect(body["identifiers"]).toEqual([
      { identifierType: "barcode", value: "000123", storeId: null, sourceSystem: null, createdAt: expect.any(String) },
      { identifierType: "plu", value: "4242", storeId: STORE_A_Y, sourceSystem: null, createdAt: expect.any(String) },
      { identifierType: "sku", value: "W-1", storeId: null, sourceSystem: null, createdAt: expect.any(String) },
    ]);
    const stores = (body["storeOverrides"] as Array<{ storeId: string }>).map((o) => o.storeId);
    expect(stores.sort()).toEqual([STORE_A_X, STORE_A_Y].sort());
    expect(body).toMatchObject({ description: null, expiryRequired: false, sourceGlobalProductId: null });
  });

  it("never shows a soft-deleted store's overrides or identifiers, even tenant-wide", async () => {
    if (skip()) return;
    const body = await detail(SES_OWNER_ALL, P_WATER);
    expect((body["storeOverrides"] as Array<{ storeId: string }>).map((o) => o.storeId)).not.toContain(S_DELETED);
    expect((body["identifiers"] as Array<{ storeId: string | null }>).map((i) => i.storeId)).not.toContain(S_DELETED);
    // A deleted store's identifier does not match the search either.
    expect(await ids(SES_OWNER_ALL, { q: "555000" })).toEqual([]);
  });

  it("keeps store identifiers and overrides inside a narrower scope", async () => {
    if (skip()) return;
    const admin = await detail(SES_ADMIN_SPEC, P_WATER);
    expect((admin["identifiers"] as Array<{ value: string }>).map((i) => i.value)).toEqual(["000123", "W-1"]);
    expect(admin["storeOverrides"]).toEqual([
      { storeId: STORE_A_X, price: { amount: "9.00", currencyCode: "EGP" }, isActive: null, taxCategory: "reduced", updatedAt: expect.any(String) },
    ]);
    const manager = await detail(SES_MANAGER_ACTIVE, P_WATER);
    expect((manager["storeOverrides"] as Array<{ storeId: string }>).map((o) => o.storeId)).toEqual([STORE_A_Y]);
  });

  it("reads an inactive or retired product with its status", async () => {
    if (skip()) return;
    expect(((await detail(SES_MANAGER, P_RETIRED))["summary"] as Item).status).toBe("retired");
    expect(((await detail(SES_MANAGER, P_INACTIVE))["summary"] as Item).status).toBe("inactive");
  });
});

describe("RT-730 console catalog — categories", () => {
  it("lists the tenant's active categories only", async () => {
    if (skip()) return;
    const res = await get(CATEGORIES, SES_MANAGER);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expectValid(categoriesSchema, res.body);
    const categoryIds = (res.body.items as Array<{ categoryId: string }>).map((c) => c.categoryId);
    expect(categoryIds).toContain(CAT_DRINKS);
    expect(categoryIds).not.toContain(CAT_OLD);
    expect(categoryIds).not.toContain(CAT_B);
  });
});
