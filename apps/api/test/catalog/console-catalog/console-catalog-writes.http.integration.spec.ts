/**
 * RT-738 (CAT-W1 + CAT-W2) — the interim console catalog writes over HTTP
 * against real Postgres (Testcontainers, every migration, the NOBYPASSRLS
 * `app_test` pool) and the real module graph (`SessionOnlyAdminGuard`,
 * `TenantContextGuard`, `RolesGuard`, `MembershipRepository`, the shared
 * `IdempotencyInterceptor` over a fake Redis). Only cookie authentication is
 * faked: a header names the session; without it the real guard decides, so
 * a bearer is 401 and a cookie write with no `Origin` is 403.
 *
 * What this proves (RT-738 acceptance):
 *   - CAT-W1 is owner / tenant_admin only; store_manager and store_staff are
 *     the non-disclosing 404; every bearer is 401; a cookie write without a
 *     trusted Origin is 403 `origin_rejected`;
 *   - a product of another tenant, an absent product, and a store outside the
 *     caller's scope, of another tenant or soft-deleted are one 404;
 *   - the create replays on its `Idempotency-Key` (one product, one audit
 *     row) and refuses key reuse with another body;
 *   - `expectedUpdatedAt` → 409 `stale_write`, and a retried write is stale;
 *   - `alias_conflict` is identical whichever product holds the value and
 *     names none; identifiers are tenant-isolated and byte-exact;
 *   - store_manager sets availability only, in its scope; a tax override or
 *     a priced override retire is refused; an override's price is kept;
 *   - every accepted write has exactly one audit row, and a sellability
 *     change reaches the `catalog_change_log` (the POS read-down delta)
 *     through the existing triggers; a refused write writes neither;
 *   - every body validates against the contract schemas.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type { INestApplication, Provider } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { IdempotencyKeyStore } from "@data-pulse-2/shared";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import request from "supertest";

import { ConsoleCatalogModule } from "../../../src/catalog/console-catalog/console-catalog.module";
import { IDEMPOTENCY_KEY_STORE, IdempotencyInterceptor } from "../../../src/idempotency/idempotency.interceptor";
import { INFLIGHT_REDIS, InProgressMarker } from "../../../src/idempotency/in-progress-marker";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../_helpers/postgres-container";
import { allContracts, contractDocument } from "../../_helpers/openapi-contract";
import {
  DASHBOARD_TOKEN,
  SES_MANAGER,
  SES_MANAGER_ACTIVE,
  SES_STAFF,
} from "../../console-sales/__support__/console-sales-fixture";
import { STORE_A_X, STORE_A_Y, STORE_B_X, TENANT_A, TENANT_B } from "../__support__/isolation-harness";
import {
  bootScopedApp,
  NON_EXISTENT,
  S_DELETED,
  SES_ADMIN_SPEC,
  SES_OWNER_ALL,
} from "../erpnext-reconciliation/__support__/read-store-scope";
import { CAT_B, CAT_DRINKS, CAT_OLD, P_B, P_WATER, seedConsoleCatalogFixture } from "./__support__/console-catalog-fixture";

const PRODUCTS = "/api/v1/catalog/products";
const product = (id: string): string => `${PRODUCTS}/${id}`;
const override = (id: string, storeId: string): string => `${product(id)}/store-overrides/${storeId}`;
const ORIGIN = "http://127.0.0.1";
const NOT_FOUND = { code: "not_found", message: "Not Found" };
const CONTRACT_ID = "console-catalog";

const a = (tag: string): string => `0a000000-0000-7000-8000-${tag.padStart(12, "0")}`;
const ACTOR = a("738e01");

class FakeRedis {
  private readonly s = new Map<string, { value: string; expiresAt: number }>();
  async get(k: string): Promise<string | null> {
    const e = this.s.get(k);
    if (!e || Date.now() > e.expiresAt) return null;
    return e.value;
  }
  async set(k: string, v: string, o: { px: number }): Promise<unknown> {
    this.s.set(k, { value: v, expiresAt: Date.now() + o.px });
    return "OK";
  }
}
class FakeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {}
}

interface Detail {
  summary: { productId: string; name: string; status: string; categoryId: string | null; taxCategory: string; updatedAt: string };
  description: string | null;
  identifiers: { identifierType: string; value: string; storeId: string | null; sourceSystem: string | null }[];
  storeOverrides: {
    storeId: string;
    price: { amount: string; currencyCode: string } | null;
    isActive: boolean | null;
    taxCategory: string | null;
    updatedAt: string;
  }[];
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;
let seq = 0;

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
let detailSchema: ValidateFunction;
let errorSchema: ValidateFunction;

beforeAll(async () => {
  ajv.addSchema(contractDocument(allContracts(), CONTRACT_ID) as object, CONTRACT_ID);
  const compiled = (name: string): ValidateFunction => {
    const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
    if (!v) throw new Error(`ajv cannot resolve ${name}`);
    return v;
  };
  detailSchema = compiled("ConsoleCatalogProductDetail");
  errorSchema = compiled("Error");

  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedConsoleCatalogFixture(env);
    await env.admin.query(`INSERT INTO users (id, email) VALUES ($1, 'rt738-actor@example.test')`, [ACTOR]);
    // A value tenant B holds and tenant A does not: identifiers are tenant-isolated.
    await env.admin.query(
      `INSERT INTO product_aliases (tenant_id, product_id, identifier_type, value, created_by)
       VALUES ($1, $2, 'barcode', 'RT738-B-ONLY', $3)`,
      [TENANT_B, P_B, ACTOR],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[RT-738 console-catalog writes] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  const redis = new FakeRedis();
  const marker = new FakeMarker();
  const store = new IdempotencyKeyStore({
    redis,
    pgWriter: { async insert(): Promise<void> {} },
    pgReader: { async find(): Promise<null> { return null; } },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
  const providers: Provider[] = [
    { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
    { provide: INFLIGHT_REDIS, useValue: redis },
    { provide: InProgressMarker, useValue: marker },
    {
      provide: APP_INTERCEPTOR,
      useValue: new IdempotencyInterceptor(new Reflector(), store, marker as unknown as InProgressMarker),
    },
  ];
  app = await bootScopedApp(env, ConsoleCatalogModule, undefined, { authLookupPool: env.admin, providers });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[RT-738 console-catalog writes] skipping — Docker unavailable");
    return true;
  }
  return false;
}

type Method = "post" | "patch" | "put";

/** A write as `session` with a trusted Origin; chain `.set("Idempotency-Key", …)` for the create. */
function send(method: Method, path: string, session: string | null, body: unknown): request.Test {
  const req = request(app!.getHttpServer())[method](path).set("Origin", ORIGIN).send(body as object);
  return session === null ? req : req.set("x-test-session", session);
}

function expectValid(validate: ValidateFunction, body: unknown): void {
  if (!validate(body)) throw new Error(`contract violation: ${JSON.stringify(validate.errors)}`);
}

/** A 2xx write: asserts the status, no-store and the detail shape. */
async function ok(res: request.Response, status: 200 | 201): Promise<Detail> {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  expect(res.headers["cache-control"]).toBe("no-store");
  expectValid(detailSchema, res.body);
  return res.body as Detail;
}

/** A refusal: asserts the status and the `{ code, message }` of the error envelope. */
function refused(res: request.Response, status: number, code: string): { code: string; message: string } {
  if (res.status !== status) throw new Error(`expected ${status} ${code}, got ${res.status}: ${JSON.stringify(res.body)}`);
  expectValid(errorSchema, res.body);
  const { code: actual, message } = (res.body as { error: { code: string; message: string } }).error;
  expect(actual).toBe(code);
  return { code: actual, message };
}

function key(): string {
  seq += 1;
  return `rt738-key-${String(seq).padStart(8, "0")}-${Date.now()}`;
}

/** A fresh tenant-A product (admin pool), so every test owns its rows. */
async function seedProduct(opts: { price?: string; retired?: boolean } = {}): Promise<string> {
  seq += 1;
  const id = a(`738${seq.toString(16).padStart(3, "0")}`);
  await env!.admin.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, default_price, default_currency_code, tax_category, retired_at, created_by, updated_by)
     VALUES ($1, $2, $3, $4::numeric, CASE WHEN $4::numeric IS NULL THEN NULL ELSE 'EGP' END, 'standard',
             CASE WHEN $5::boolean THEN now() END, $6, $6)`,
    [id, TENANT_A, `RT738 product ${seq}`, opts.price ?? null, opts.retired ?? false, ACTOR],
  );
  return id;
}

async function seedOverride(productId: string, storeId: string, o: { price?: string; active?: boolean; tax?: string }): Promise<void> {
  await env!.admin.query(
    `INSERT INTO store_product_overrides
       (tenant_id, store_id, product_id, price, currency_code, is_active, tax_category, created_by, updated_by)
     VALUES ($1, $2, $3, $4::numeric, CASE WHEN $4::numeric IS NULL THEN NULL ELSE 'EGP' END, $5, $6, $7, $7)`,
    [TENANT_A, storeId, productId, o.price ?? null, o.active ?? null, o.tax ?? null, ACTOR],
  );
}

async function updatedAt(productId: string): Promise<string> {
  const r = await env!.admin.query<{ updated_at: Date }>(`SELECT updated_at FROM tenant_products WHERE id = $1`, [productId]);
  return r.rows[0]!.updated_at.toISOString();
}

async function overrideUpdatedAt(productId: string, storeId: string): Promise<string> {
  const r = await env!.admin.query<{ updated_at: Date }>(
    `SELECT updated_at FROM store_product_overrides WHERE product_id = $1 AND store_id = $2 AND retired_at IS NULL`,
    [productId, storeId],
  );
  return r.rows[0]!.updated_at.toISOString();
}

async function audits(targetOrProduct: string): Promise<{ action: string; actor_user_id: string; store_id: string | null; metadata: Record<string, unknown> }[]> {
  const r = await env!.admin.query(
    `SELECT action, actor_user_id::text, store_id::text, metadata FROM audit_events
      WHERE action LIKE 'catalog.%' AND (target_id = $1::uuid OR metadata->>'product_id' = $1::text)
      ORDER BY occurred_at, id`,
    [targetOrProduct],
  );
  return r.rows as { action: string; actor_user_id: string; store_id: string | null; metadata: Record<string, unknown> }[];
}

async function changeLogCount(productId: string): Promise<number> {
  const r = await env!.admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM catalog_change_log WHERE product_id = $1`, [productId]);
  return Number(r.rows[0]!.n);
}

// ===========================================================================
// Auth and roles
// ===========================================================================
describe("console catalog writes — auth, origin and roles", () => {
  it("refuses a bearer with 401 and a cookie write without a trusted Origin with 403 origin_rejected", async () => {
    if (skip()) return;
    const bearer = await request(app!.getHttpServer())
      .post(PRODUCTS)
      .set("Authorization", `Bearer ${DASHBOARD_TOKEN}`)
      .set("Idempotency-Key", key())
      .send({ name: "x", taxCategory: "standard" });
    expect(bearer.status).toBe(401);

    const noOrigin = await request(app!.getHttpServer())
      .patch(product(P_WATER))
      .set("Cookie", "dp2_session=rt738-not-a-session")
      .send({ expectedUpdatedAt: new Date().toISOString(), name: "x" });
    refused(noOrigin, 403, "origin_rejected");
    const foreign = await request(app!.getHttpServer())
      .put(override(P_WATER, STORE_A_X))
      .set("Cookie", "dp2_session=rt738-not-a-session")
      .set("Origin", "https://evil.example")
      .send({ expectedUpdatedAt: null, isActive: false });
    refused(foreign, 403, "origin_rejected");
  });

  it("answers store_manager and store_staff on every CAT-W1 write, and store_staff on CAT-W2, with the identical 404", async () => {
    if (skip()) return;
    const id = await seedProduct();
    const at = await updatedAt(id);
    const calls: [Method, string, unknown][] = [
      ["post", PRODUCTS, { name: "x", taxCategory: "standard" }],
      ["patch", product(id), { expectedUpdatedAt: at, name: "x" }],
      ["post", `${product(id)}/retire`, { expectedUpdatedAt: at }],
      ["post", `${product(id)}/identifiers`, { identifierType: "sku", value: "RT738-ROLE" }],
      ["post", `${product(id)}/identifiers/retire`, { identifierType: "sku", value: "RT738-ROLE" }],
    ];
    for (const session of [SES_MANAGER, SES_STAFF]) {
      for (const [method, path, body] of calls) {
        const res = await send(method, path, session, body).set("Idempotency-Key", key());
        expect({ path, status: res.status, body: res.body.error }).toEqual({
          path,
          status: 404,
          body: expect.objectContaining(NOT_FOUND),
        });
      }
    }
    for (const [method, path, body] of [
      ["put", override(id, STORE_A_X), { expectedUpdatedAt: null, isActive: false }],
      ["post", `${override(id, STORE_A_X)}/retire`, { expectedUpdatedAt: at }],
    ] as [Method, string, unknown][]) {
      const res = await send(method, path, SES_STAFF, body);
      expect(res.status).toBe(404);
    }
    expect(await audits(id)).toEqual([]);
    expect((await env!.admin.query(`SELECT 1 FROM tenant_products WHERE name = 'x'`)).rowCount).toBe(0);
  });
});

// ===========================================================================
// Create
// ===========================================================================
describe("console catalog writes — create (consoleCreateCatalogProduct)", () => {
  it("creates a product with no price, audits it once, logs it for the POS, and replays on the same key", async () => {
    if (skip()) return;
    const k = key();
    const body = { name: "RT738 Created", taxCategory: "standard", description: "d", categoryId: CAT_DRINKS.toUpperCase() };
    const first = await send("post", PRODUCTS, SES_OWNER_ALL, body).set("Idempotency-Key", k);
    const created = await ok(first, 201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(created.summary).toMatchObject({
      name: "RT738 Created",
      status: "active",
      categoryId: CAT_DRINKS,
      taxCategory: "standard",
      defaultPrice: null,
      trackingMode: "none",
    });
    expect(created.identifiers).toEqual([]);
    expect(created.storeOverrides).toEqual([]);
    const productId = created.summary.productId;

    const replay = await send("post", PRODUCTS, SES_OWNER_ALL, body).set("Idempotency-Key", k);
    expect(replay.status).toBe(201);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect((replay.body as Detail).summary.productId).toBe(productId);

    const rows = await env!.admin.query(`SELECT 1 FROM tenant_products WHERE tenant_id = $1 AND name = 'RT738 Created'`, [TENANT_A]);
    expect(rows.rowCount).toBe(1);
    const audit = await audits(productId);
    expect(audit.map((r) => r.action)).toEqual(["catalog.product.create"]);
    expect(audit[0]!.metadata).toMatchObject({ product_id: productId, new: { name: "RT738 Created", isActive: true } });
    // A new product has no price, so it is not sellable: the 0015 trigger logs nothing for the POS yet.
    expect(await changeLogCount(productId)).toBe(0);

    refused(
      await send("post", PRODUCTS, SES_OWNER_ALL, { ...body, name: "RT738 Other" }).set("Idempotency-Key", k),
      409,
      "idempotency_key_conflict",
    );
  });

  it("refuses a missing key, a price, a tenant id, a blank or NUL name, and an unusable category; nothing is written", async () => {
    if (skip()) return;
    refused(await send("post", PRODUCTS, SES_ADMIN_SPEC, { name: "RT738 NoKey", taxCategory: "s" }), 400, "idempotency_key_required");
    for (const body of [
      { name: "RT738 Bad", taxCategory: "s", defaultPrice: { amount: "1.00", currencyCode: "EGP" } },
      { name: "RT738 Bad", taxCategory: "s", tenantId: TENANT_B },
      { name: "   ", taxCategory: "s" },
      { name: "RT738 \u0000 Bad", taxCategory: "s" },
      { name: "RT738 \ud800 Bad", taxCategory: "s" },
      { name: "RT738 Bad" },
    ]) {
      refused(await send("post", PRODUCTS, SES_ADMIN_SPEC, body).set("Idempotency-Key", key()), 400, "validation_error");
    }
    for (const categoryId of [CAT_OLD, CAT_B, NON_EXISTENT]) {
      refused(
        await send("post", PRODUCTS, SES_ADMIN_SPEC, { name: "RT738 Bad", taxCategory: "s", categoryId }).set("Idempotency-Key", key()),
        422,
        "category_unavailable",
      );
    }
    const rows = await env!.admin.query(`SELECT 1 FROM tenant_products WHERE name LIKE 'RT738 %Bad%' OR name = 'RT738 NoKey'`);
    expect(rows.rowCount).toBe(0);
  });
});

// ===========================================================================
// Update and retire
// ===========================================================================
describe("console catalog writes — update and retire", () => {
  it("edits the given fields, advances updatedAt, audits old/new, and makes a stale or retried write 409 stale_write", async () => {
    if (skip()) return;
    const id = await seedProduct({ price: "4.0000" });
    const at0 = await updatedAt(id);
    const logged = await changeLogCount(id);
    const first = await ok(
      await send("patch", product(id), SES_OWNER_ALL, { expectedUpdatedAt: at0, name: "RT738 Renamed", categoryId: CAT_DRINKS, isActive: false }),
      200,
    );
    expect(first.summary).toMatchObject({ name: "RT738 Renamed", categoryId: CAT_DRINKS, status: "inactive" });
    expect((first.summary as unknown as { defaultPrice: unknown }).defaultPrice).toEqual({ amount: "4.00", currencyCode: "EGP" });
    expect(Date.parse(first.summary.updatedAt)).toBeGreaterThan(Date.parse(at0));
    // Deactivating a sellable product reaches the POS delta through the 0015 trigger.
    expect(await changeLogCount(id)).toBe(logged + 1);

    // The same request again: its precondition is now stale.
    refused(
      await send("patch", product(id), SES_OWNER_ALL, { expectedUpdatedAt: at0, name: "RT738 Renamed" }),
      409,
      "stale_write",
    );
    // Back-to-back writes each advance updatedAt by at least one millisecond.
    let at = first.summary.updatedAt;
    for (const name of ["RT738 R1", "RT738 R2", "RT738 R3"]) {
      const next = await ok(await send("patch", product(id), SES_ADMIN_SPEC, { expectedUpdatedAt: at, name }), 200);
      expect(Date.parse(next.summary.updatedAt)).toBeGreaterThan(Date.parse(at));
      at = next.summary.updatedAt;
    }
    const second = await ok(
      await send("patch", product(id), SES_OWNER_ALL, { expectedUpdatedAt: at, description: null, categoryId: null }),
      200,
    );
    expect(second.summary.categoryId).toBeNull();

    const audit = await audits(id);
    expect(audit.map((r) => r.action)).toEqual(Array(5).fill("catalog.product.update"));
    expect(audit[0]!.metadata).toMatchObject({
      old: { name: expect.stringMatching(/^RT738 product/), categoryId: null, isActive: true },
      new: { name: "RT738 Renamed", categoryId: CAT_DRINKS, isActive: false },
    });
  });

  it("refuses an empty update, a server-owned field, a retired product, and a category it cannot use", async () => {
    if (skip()) return;
    const id = await seedProduct();
    const at = await updatedAt(id);
    for (const body of [{ expectedUpdatedAt: at }, { expectedUpdatedAt: at, trackingMode: "batch" }, { name: "x" }, { expectedUpdatedAt: "now", name: "x" }]) {
      refused(await send("patch", product(id), SES_OWNER_ALL, body), 400, "validation_error");
    }
    refused(await send("patch", product(id), SES_OWNER_ALL, { expectedUpdatedAt: at, categoryId: CAT_OLD }), 422, "category_unavailable");
    const retired = await seedProduct({ retired: true });
    refused(
      await send("patch", product(retired), SES_OWNER_ALL, { expectedUpdatedAt: await updatedAt(retired), name: "x" }),
      409,
      "product_retired",
    );
    expect(await audits(id)).toEqual([]);
  });

  it("answers another tenant's product and an absent product with the identical 404", async () => {
    if (skip()) return;
    const at = new Date().toISOString();
    for (const target of [P_B, NON_EXISTENT]) {
      const res = await send("patch", product(target), SES_OWNER_ALL, { expectedUpdatedAt: at, name: "RT738 Hijack" });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatchObject(NOT_FOUND);
      expect((await send("post", `${product(target)}/retire`, SES_OWNER_ALL, { expectedUpdatedAt: at })).status).toBe(404);
    }
    const b = await env!.admin.query(`SELECT name FROM tenant_products WHERE id = $1`, [P_B]);
    expect(b.rows[0]!.name).toBe("RT730 Water B");
  });

  it("retires a product once (status retired, identifiers kept); a second retire is 409 product_retired", async () => {
    if (skip()) return;
    const id = await seedProduct();
    await env!.admin.query(
      `INSERT INTO product_aliases (tenant_id, product_id, identifier_type, value, created_by) VALUES ($1, $2, 'sku', 'RT738-KEEP', $3)`,
      [TENANT_A, id, ACTOR],
    );
    const stale = new Date(Date.parse(await updatedAt(id)) - 1).toISOString();
    refused(await send("post", `${product(id)}/retire`, SES_OWNER_ALL, { expectedUpdatedAt: stale }), 409, "stale_write");
    const retired = await ok(await send("post", `${product(id)}/retire`, SES_OWNER_ALL, { expectedUpdatedAt: await updatedAt(id) }), 200);
    expect(retired.summary.status).toBe("retired");
    expect(retired.identifiers.map((i) => i.value)).toEqual(["RT738-KEEP"]);
    refused(
      await send("post", `${product(id)}/retire`, SES_OWNER_ALL, { expectedUpdatedAt: retired.summary.updatedAt }),
      409,
      "product_retired",
    );
    expect((await audits(id)).map((r) => r.action)).toEqual(["catalog.product.retire"]);
  });
});

// ===========================================================================
// Identifiers
// ===========================================================================
describe("console catalog writes — identifiers", () => {
  it("adds an identifier byte for byte, audits it and logs it for the POS", async () => {
    if (skip()) return;
    const id = await seedProduct();
    const before = await changeLogCount(id);
    const added = await ok(
      await send("post", `${product(id)}/identifiers`, SES_OWNER_ALL, { identifierType: "barcode", value: "0000738" }),
      201,
    );
    expect(added.identifiers).toEqual([
      expect.objectContaining({ identifierType: "barcode", value: "0000738", storeId: null, sourceSystem: null }),
    ]);
    const scoped = await ok(
      await send("post", `${product(id)}/identifiers`, SES_ADMIN_SPEC, { identifierType: "plu", value: "738", storeId: STORE_A_X }),
      201,
    );
    expect(scoped.identifiers.map((i) => [i.identifierType, i.value, i.storeId])).toEqual([
      ["barcode", "0000738", null],
      ["plu", "738", STORE_A_X],
    ]);
    const ext = await ok(
      await send("post", `${product(id)}/identifiers`, SES_OWNER_ALL, {
        identifierType: "external_pos_id",
        value: "LEGACY-738",
        sourceSystem: "legacy-pos",
      }),
      201,
    );
    expect(ext.identifiers).toHaveLength(3);
    const audit = await audits(id);
    expect(audit.map((r) => r.action)).toEqual(Array(3).fill("catalog.product_identifier.add"));
    expect(audit[1]!.store_id).toBe(STORE_A_X);
    expect(await changeLogCount(id)).toBeGreaterThanOrEqual(before + 3);
  });

  it("answers a value active anywhere in its scope with one non-disclosing 409 alias_conflict", async () => {
    if (skip()) return;
    const id = await seedProduct();
    await ok(await send("post", `${product(id)}/identifiers`, SES_OWNER_ALL, { identifierType: "sku", value: "RT738-MINE" }), 201);
    // Held by another product (P_WATER's barcode) and by this product: the same body.
    const other = refused(
      await send("post", `${product(id)}/identifiers`, SES_OWNER_ALL, { identifierType: "barcode", value: "000123" }),
      409,
      "alias_conflict",
    );
    const mine = refused(
      await send("post", `${product(id)}/identifiers`, SES_OWNER_ALL, { identifierType: "sku", value: "RT738-MINE" }),
      409,
      "alias_conflict",
    );
    expect(other).toEqual(mine);
    expect(JSON.stringify(other)).not.toMatch(new RegExp(`${P_WATER}|Water`, "i"));
    // `00123` is not `000123`; another tenant's value is free in this one.
    await ok(await send("post", `${product(id)}/identifiers`, SES_OWNER_ALL, { identifierType: "barcode", value: "00123" }), 201);
    await ok(await send("post", `${product(id)}/identifiers`, SES_OWNER_ALL, { identifierType: "barcode", value: "RT738-B-ONLY" }), 201);
    expect((await audits(id)).map((r) => r.action)).toEqual(Array(3).fill("catalog.product_identifier.add"));
  });

  it("refuses a store outside the scope, of another tenant or soft-deleted with 404, and a retired product with 409", async () => {
    if (skip()) return;
    const id = await seedProduct();
    for (const [session, storeId] of [
      [SES_ADMIN_SPEC, STORE_A_Y],
      [SES_OWNER_ALL, STORE_B_X],
      [SES_OWNER_ALL, S_DELETED],
      [SES_OWNER_ALL, NON_EXISTENT],
    ] as const) {
      const res = await send("post", `${product(id)}/identifiers`, session, { identifierType: "plu", value: "7381", storeId });
      expect({ storeId, status: res.status, error: res.body.error }).toEqual({ storeId, status: 404, error: expect.objectContaining(NOT_FOUND) });
    }
    refused(
      await send("post", `${product(id)}/identifiers`, SES_OWNER_ALL, { identifierType: "external_pos_id", value: "X", sourceSystem: "s", storeId: STORE_A_X }),
      400,
      "validation_error",
    );
    refused(await send("post", `${product(id)}/identifiers`, SES_OWNER_ALL, { identifierType: "sku", value: " lead" }), 400, "validation_error");
    const retired = await seedProduct({ retired: true });
    refused(await send("post", `${product(retired)}/identifiers`, SES_OWNER_ALL, { identifierType: "sku", value: "RT738-R" }), 409, "product_retired");
    expect(await audits(id)).toEqual([]);
  });

  it("retires an identifier by its full key, freeing its value; any other key is the 404", async () => {
    if (skip()) return;
    const id = await seedProduct();
    const other = await seedProduct();
    await ok(await send("post", `${product(id)}/identifiers`, SES_OWNER_ALL, { identifierType: "barcode", value: "7380001" }), 201);
    await ok(
      await send("post", `${product(id)}/identifiers`, SES_OWNER_ALL, { identifierType: "plu", value: "7382", storeId: STORE_A_Y }),
      201,
    );
    // Not on this product, wrong scope, or out of the caller's store scope: 404.
    expect((await send("post", `${product(other)}/identifiers/retire`, SES_OWNER_ALL, { identifierType: "barcode", value: "7380001" })).status).toBe(404);
    expect((await send("post", `${product(id)}/identifiers/retire`, SES_OWNER_ALL, { identifierType: "barcode", value: "7380001", storeId: STORE_A_X })).status).toBe(404);
    expect((await send("post", `${product(id)}/identifiers/retire`, SES_ADMIN_SPEC, { identifierType: "plu", value: "7382", storeId: STORE_A_Y })).status).toBe(404);

    const retired = await ok(
      await send("post", `${product(id)}/identifiers/retire`, SES_OWNER_ALL, { identifierType: "barcode", value: "7380001" }),
      200,
    );
    expect(retired.identifiers.map((i) => i.value)).toEqual(["7382"]);
    // The value is free: another product may take it (no move, decision 317).
    await ok(await send("post", `${product(other)}/identifiers`, SES_OWNER_ALL, { identifierType: "barcode", value: "7380001" }), 201);
    expect((await send("post", `${product(id)}/identifiers/retire`, SES_OWNER_ALL, { identifierType: "barcode", value: "7380001" })).status).toBe(404);
    expect((await audits(id)).map((r) => r.action)).toEqual([
      "catalog.product_identifier.add",
      "catalog.product_identifier.add",
      "catalog.product_identifier.retire",
    ]);
  });
});

// ===========================================================================
// Store overrides
// ===========================================================================
describe("console catalog writes — store overrides", () => {
  it("lets a store_manager set availability on a store in its scope, and nothing else", async () => {
    if (skip()) return;
    const id = await seedProduct({ price: "5.0000" });
    const set = await ok(await send("put", override(id, STORE_A_X), SES_MANAGER, { expectedUpdatedAt: null, isActive: false }), 200);
    expect(set.storeOverrides).toEqual([
      expect.objectContaining({ storeId: STORE_A_X, isActive: false, taxCategory: null, price: null }),
    ]);
    const at = set.storeOverrides[0]!.updatedAt;
    refused(
      await send("put", override(id, STORE_A_X), SES_MANAGER, { expectedUpdatedAt: at, taxCategory: "zero" }),
      403,
      "tax_override_forbidden",
    );
    refused(
      await send("put", override(id, STORE_A_X), SES_MANAGER, { expectedUpdatedAt: at, isActive: true, taxCategory: null }),
      403,
      "tax_override_forbidden",
    );
    // Narrowed to Y by its active store: X is out of scope; the deleted store and tenant B's are 404 too.
    for (const [session, storeId] of [
      [SES_MANAGER_ACTIVE, STORE_A_X],
      [SES_ADMIN_SPEC, STORE_A_Y],
      [SES_OWNER_ALL, S_DELETED],
      [SES_OWNER_ALL, STORE_B_X],
    ] as const) {
      const res = await send("put", override(id, storeId), session, { expectedUpdatedAt: null, isActive: true });
      expect({ storeId, status: res.status, error: res.body.error }).toEqual({ storeId, status: 404, error: expect.objectContaining(NOT_FOUND) });
    }
    expect((await send("put", override(P_B, STORE_A_X), SES_OWNER_ALL, { expectedUpdatedAt: null, isActive: true })).status).toBe(404);

    const audit = await audits(id);
    expect(audit.map((r) => [r.action, r.store_id])).toEqual([["catalog.store_override.upsert", STORE_A_X]]);
  });

  it("checks expectedUpdatedAt against the active override or its absence, and refuses an empty override", async () => {
    if (skip()) return;
    const id = await seedProduct();
    refused(
      await send("put", override(id, STORE_A_Y), SES_OWNER_ALL, { expectedUpdatedAt: new Date().toISOString(), isActive: false }),
      409,
      "stale_write",
    );
    const set = await ok(await send("put", override(id, STORE_A_Y), SES_OWNER_ALL, { expectedUpdatedAt: null, taxCategory: "zero" }), 200);
    refused(await send("put", override(id, STORE_A_Y), SES_OWNER_ALL, { expectedUpdatedAt: null, isActive: false }), 409, "stale_write");
    const at = set.storeOverrides[0]!.updatedAt;
    refused(await send("put", override(id, STORE_A_Y), SES_OWNER_ALL, { expectedUpdatedAt: at, taxCategory: null }), 422, "override_empty");
    const both = await ok(await send("put", override(id, STORE_A_Y), SES_OWNER_ALL, { expectedUpdatedAt: at, isActive: false }), 200);
    expect(both.storeOverrides[0]).toMatchObject({ isActive: false, taxCategory: "zero" });
    expect(Date.parse(both.storeOverrides[0]!.updatedAt)).toBeGreaterThan(Date.parse(at));
    refused(await send("put", override(id, STORE_A_Y), SES_OWNER_ALL, { expectedUpdatedAt: at, isActive: true }), 409, "stale_write");
    refused(await send("put", override(id, STORE_A_Y), SES_OWNER_ALL, { expectedUpdatedAt: null }), 400, "validation_error");
    refused(
      await send("put", override(id, STORE_A_Y), SES_OWNER_ALL, { expectedUpdatedAt: null, isActive: true, price: { amount: "1.00", currencyCode: "EGP" } }),
      400,
      "validation_error",
    );
    const retiredProduct = await seedProduct({ retired: true });
    refused(
      await send("put", override(retiredProduct, STORE_A_Y), SES_OWNER_ALL, { expectedUpdatedAt: null, isActive: true }),
      409,
      "product_retired",
    );
    expect((await audits(id)).map((r) => r.action)).toEqual(Array(2).fill("catalog.store_override.upsert"));
  });

  it("keeps an override's price when an owner changes its tax category", async () => {
    if (skip()) return;
    const id = await seedProduct({ price: "5.0000" });
    await seedOverride(id, STORE_A_X, { price: "6.0000", tax: "reduced" });
    const at = await overrideUpdatedAt(id, STORE_A_X);
    const changed = await ok(
      await send("put", override(id, STORE_A_X), SES_ADMIN_SPEC, { expectedUpdatedAt: at, taxCategory: null }),
      200,
    );
    expect(changed.storeOverrides).toEqual([
      expect.objectContaining({ storeId: STORE_A_X, price: { amount: "6.00", currencyCode: "EGP" }, taxCategory: null, isActive: null }),
    ]);
  });

  it("retires an override: availability-only by a store_manager, never one with a tax category (403) or a price (409)", async () => {
    if (skip()) return;
    const id = await seedProduct();
    await seedOverride(id, STORE_A_X, { active: false });
    await seedOverride(id, STORE_A_Y, { tax: "zero" });
    const priced = await seedProduct();
    await seedOverride(priced, STORE_A_X, { price: "3.0000", active: false });

    const atX = await overrideUpdatedAt(id, STORE_A_X);
    refused(
      await send("post", `${override(id, STORE_A_X)}/retire`, SES_MANAGER, { expectedUpdatedAt: new Date(Date.parse(atX) - 1).toISOString() }),
      409,
      "stale_write",
    );
    const retired = await ok(await send("post", `${override(id, STORE_A_X)}/retire`, SES_MANAGER, { expectedUpdatedAt: atX }), 200);
    expect(retired.storeOverrides.map((o) => o.storeId)).toEqual([STORE_A_Y]);
    expect((await send("post", `${override(id, STORE_A_X)}/retire`, SES_MANAGER, { expectedUpdatedAt: atX })).status).toBe(404);

    const atY = await overrideUpdatedAt(id, STORE_A_Y);
    refused(await send("post", `${override(id, STORE_A_Y)}/retire`, SES_MANAGER, { expectedUpdatedAt: atY }), 403, "tax_override_forbidden");
    await ok(await send("post", `${override(id, STORE_A_Y)}/retire`, SES_OWNER_ALL, { expectedUpdatedAt: atY }), 200);

    refused(
      await send("post", `${override(priced, STORE_A_X)}/retire`, SES_OWNER_ALL, { expectedUpdatedAt: await overrideUpdatedAt(priced, STORE_A_X) }),
      409,
      "price_override_present",
    );
    const audit = await audits(id);
    expect(audit.map((r) => [r.action, r.store_id])).toEqual([
      ["catalog.store_override.retire", STORE_A_X],
      ["catalog.store_override.retire", STORE_A_Y],
    ]);
    expect(audit.every((r) => typeof r.actor_user_id === "string")).toBe(true);
    expect(await audits(priced)).toEqual([]);
  });
});
