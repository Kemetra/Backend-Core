/**
 * RT-448 (RT-50 Inventory Gate 7, G7-1 + G7-2) — Tracking Profile set/read and
 * the tracking-identity list, end-to-end against a Testcontainers Postgres 16
 * (RLS-active app pool), with the 014 harness pattern: production guards
 * overridden, a ConfigurableContextGuard publishing `request.context`, and a
 * SpyAuditEnqueuer behind the real AuditEmitterInterceptor.
 *
 * Routes under test:
 *   GET /api/v1/catalog/products/:productId/tracking-profile        (tracking-profile.yaml)
 *   PUT /api/v1/catalog/products/:productId/tracking-profile
 *   GET /api/inventory/v1/products/:productId/tracking-identities   (inventory.yaml)
 *
 * Covered:
 *   §1 read — a new product reads none / false / unlocked.
 *   §2 set — not yet activated: batch / serial is 409
 *      tracking_activation_pending and writes nothing; resetting a profile to
 *      none succeeds with one audit subject.
 *   §3 lock (387) — a movement or a captured sale line locks the profile: a
 *      change is 409 tracking_profile_locked, the same values still succeed,
 *      and GET reads profile_locked = true.
 *   §4 validation — expiry without batch, an unknown mode, a smuggled key and a
 *      non-uuid path are 400 and write nothing.
 *   §5 isolation — another tenant's product is a non-disclosing 404.
 *   §6 roles — every route is owner / tenant-admin only, denyAs 404.
 *   §7 identities — empty list, ordering, projection, cross-tenant 404; a
 *      movement projects trackingIdentityId (null for every existing row).
 */
import "reflect-metadata";

import { type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";

import { AuditEmitterInterceptor } from "../../../src/audit/audit-emitter.interceptor";
import { AUDIT_JOB_ENQUEUER, type AuditJobEnqueuer } from "../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../src/audit/audit-job.types";
import { PG_POOL } from "../../../src/auth/auth.module";
import { DashboardAuthGuard } from "../../../src/auth/dashboard-auth.guard";
import { ROLES_METADATA_KEY, type RolesMetadata } from "../../../src/auth/roles.decorator";
import { RolesGuard } from "../../../src/auth/roles.guard";
import { TrackingProfileController } from "../../../src/catalog/tracking-profile/tracking-profile.controller";
import { TrackingProfileService } from "../../../src/catalog/tracking-profile/tracking-profile.service";
import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { TenantContextGuard } from "../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../src/context/types";
import { InventoryService } from "../../../src/inventory/inventory.service";
import { TrackingIdentitiesController } from "../../../src/inventory/tracking-identities.controller";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import {
  ACTOR_A,
  PRODUCT_B_ACTIVE,
  STORE_A_X,
  TENANT_A,
  seedCatalogIsolationFixture,
} from "../__support__/isolation-harness";

// IDs: `0a…d448…` mnemonic, unique against the other catalog corpora.
const PRODUCT_FRESH = "0a000000-0000-7000-8000-00000d448a01";
const PRODUCT_MOVED = "0a000000-0000-7000-8000-00000d448a02";
const PRODUCT_SOLD = "0a000000-0000-7000-8000-00000d448a03";
const PRODUCT_LOTS = "0a000000-0000-7000-8000-00000d448a04";
const PRODUCT_PLAIN_MOVED = "0a000000-0000-7000-8000-00000d448a05";
const MOVE_ID = "0a000000-0000-7000-8000-00000d448b01";
const MOVE_PLAIN_ID = "0a000000-0000-7000-8000-00000d448b02";
const SALE_ID = "0a000000-0000-7000-8000-00000d448c01";
const LOT_LATE = "0a000000-0000-7000-8000-00000d448d01";
const LOT_EARLY = "0a000000-0000-7000-8000-00000d448d02";
const LOT_UNDATED = "0a000000-0000-7000-8000-00000d448d03";
const SERIAL_1 = "0a000000-0000-7000-8000-00000d448d04";

const profileUrl = (id: string): string => `/api/v1/catalog/products/${id}/tracking-profile`;
const identitiesUrl = (id: string): string =>
  `/api/inventory/v1/products/${id}/tracking-identities`;

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.calls.push(payload);
  }
}

class ConfigurableContextGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    req.context = {
      userId: ACTOR_A,
      tenantId: TENANT_A,
      storeId: null,
      isPlatformAdmin: false,
      source: "session",
    };
    req.principal = { userId: ACTOR_A };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let auditSpy: SpyAuditEnqueuer;
let dockerSkipped = false;

function pg(): PgTestEnv {
  if (!env) throw new Error("env not initialised");
  return env;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[tracking-profile.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedCatalogIsolationFixture(env);
  const a = env.admin;
  await a.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by,
                                  tracking_mode) VALUES
       ($1, $5, 'Fresh', 'standard', $6, $6, 'none'),
       ($2, $5, 'Moved', 'standard', $6, $6, 'batch'),
       ($3, $5, 'Sold', 'standard', $6, $6, 'batch'),
       ($4, $5, 'Lots', 'standard', $6, $6, 'none'),
       ($7, $5, 'Plain moved', 'standard', $6, $6, 'none')`,
    [PRODUCT_FRESH, PRODUCT_MOVED, PRODUCT_SOLD, PRODUCT_LOTS, TENANT_A, ACTOR_A, PRODUCT_PLAIN_MOVED],
  );
  await a.query(
    `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
                                  occurred_at, created_by, stock_location_id, inventory_status,
                                  tenant_product_ref)
     SELECT $1, $2, $3, 'inbound', 5, 'ea', now(), $4, l.id, 'sellable', $5
       FROM stock_locations l WHERE l.store_id = $3 AND l.kind = 'primary'`,
    [MOVE_ID, TENANT_A, STORE_A_X, ACTOR_A, PRODUCT_MOVED],
  );
  await a.query(
    `INSERT INTO stock_movements (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
                                  occurred_at, created_by, stock_location_id, inventory_status,
                                  tenant_product_ref)
     SELECT $1, $2, $3, 'inbound', 5, 'ea', now(), $4, l.id, 'sellable', $5
       FROM stock_locations l WHERE l.store_id = $3 AND l.kind = 'primary'`,
    [MOVE_PLAIN_ID, TENANT_A, STORE_A_X, ACTOR_A, PRODUCT_PLAIN_MOVED],
  );
  await a.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'EGP', 5.00, now(), '2026-10-13', 'pos-rt448', 'ext-rt448', $4, $5)`,
    [SALE_ID, TENANT_A, STORE_A_X, "e".repeat(64), ACTOR_A],
  );
  await a.query(
    `INSERT INTO sale_lines
       (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code,
        quantity, line_amount, tax_amount, unit, tenant_product_ref)
     VALUES (gen_random_uuid(), $1, $2, $3, 'Sold', 5.0000, 'EGP', 1.000000, 5.0000, 0.0000, 'ea', $4)`,
    [SALE_ID, TENANT_A, STORE_A_X, PRODUCT_SOLD],
  );
  await a.query(
    `INSERT INTO tracking_identities (id, tenant_id, tenant_product_ref, kind, code, expiry_date, manufactured_on)
     VALUES ($1, $5, $6, 'batch', 'LOT-B', '2027-06-30', '2026-01-15'),
            ($2, $5, $6, 'batch', 'LOT-A', '2026-12-31', NULL),
            ($3, $5, $6, 'batch', 'LOT-C', NULL, NULL),
            ($4, $5, $6, 'serial', 'SN-1', NULL, NULL)`,
    [LOT_LATE, LOT_EARLY, LOT_UNDATED, SERIAL_1, TENANT_A, PRODUCT_LOTS],
  );

  const localEnv = env;
  auditSpy = new SpyAuditEnqueuer();
  const auditInterceptor = new AuditEmitterInterceptor(new Reflector(), auditSpy);
  const moduleRef = await Test.createTestingModule({
    controllers: [TrackingProfileController, TrackingIdentitiesController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      TrackingProfileService,
      InventoryService,
      { provide: AUDIT_JOB_ENQUEUER, useValue: auditSpy },
      { provide: APP_INTERCEPTOR, useValue: auditInterceptor },
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(new ConfigurableContextGuard());
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  if (auditSpy) auditSpy.calls = [];
});

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[tracking-profile.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function http(): ReturnType<typeof request> {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

async function profileRow(id: string): Promise<{ tracking_mode: string; expiry_required: boolean }> {
  const r = await pg().admin.query<{ tracking_mode: string; expiry_required: boolean }>(
    `SELECT tracking_mode, expiry_required FROM tenant_products WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
}

describe("RT-448 §1 — read", () => {
  it("a new product reads tracking_mode none, no expiry, unlocked", async () => {
    if (skip()) return;
    const res = await http().get(profileUrl(PRODUCT_FRESH)).expect(200);
    expect(res.body).toEqual({
      product_id: PRODUCT_FRESH,
      tracking_mode: "none",
      expiry_required: false,
      profile_locked: false,
    });
  });
});

describe("RT-448 §2 — set (tracked profiles not yet activated)", () => {
  afterEach(async () => {
    if (dockerSkipped) return;
    await pg().admin.query(
      `UPDATE tenant_products SET tracking_mode = 'none', expiry_required = false WHERE id = $1`,
      [PRODUCT_FRESH],
    );
  });

  it.each([
    ["batch with expiry", { tracking_mode: "batch", expiry_required: true }],
    ["batch", { tracking_mode: "batch", expiry_required: false }],
    ["serial", { tracking_mode: "serial", expiry_required: false }],
  ])("%s is 409 tracking_activation_pending and writes nothing", async (_label, body) => {
    if (skip()) return;
    const res = await http().put(profileUrl(PRODUCT_FRESH)).send(body).expect(409);
    expect(res.body.error.code).toBe("tracking_activation_pending");
    expect(await profileRow(PRODUCT_FRESH)).toEqual({ tracking_mode: "none", expiry_required: false });
    expect(auditSpy.calls).toHaveLength(0);
  });

  it("a product without history is reset to none, with one audit subject", async () => {
    if (skip()) return;
    await pg().admin.query(
      `UPDATE tenant_products SET tracking_mode = 'batch', expiry_required = true WHERE id = $1`,
      [PRODUCT_FRESH],
    );
    const res = await http()
      .put(profileUrl(PRODUCT_FRESH))
      .send({ tracking_mode: "none", expiry_required: false })
      .expect(200);
    expect(res.body).toEqual({
      product_id: PRODUCT_FRESH,
      tracking_mode: "none",
      expiry_required: false,
      profile_locked: false,
    });
    expect(await profileRow(PRODUCT_FRESH)).toEqual({ tracking_mode: "none", expiry_required: false });
    expect(auditSpy.calls).toHaveLength(1);
    expect(JSON.stringify(auditSpy.calls[0])).toContain("catalog.tracking_profile.set");
  });
});

describe("RT-448 §3 — the profile locks after history (387)", () => {
  it.each([
    ["a stock movement", PRODUCT_MOVED],
    ["a captured sale line", PRODUCT_SOLD],
  ])("%s locks it: a change is 409 tracking_profile_locked", async (_label, product) => {
    if (skip()) return;
    const res = await http()
      .put(profileUrl(product))
      .send({ tracking_mode: "none", expiry_required: false })
      .expect(409);
    expect(res.body.error.code).toBe("tracking_profile_locked");
    expect(await profileRow(product)).toEqual({ tracking_mode: "batch", expiry_required: false });
    expect(auditSpy.calls).toHaveLength(0);
  });

  it("writing the same values again is not a change and succeeds", async () => {
    if (skip()) return;
    const res = await http()
      .put(profileUrl(PRODUCT_PLAIN_MOVED))
      .send({ tracking_mode: "none", expiry_required: false })
      .expect(200);
    expect(res.body.profile_locked).toBe(true);
  });

  it("GET reads profile_locked = true", async () => {
    if (skip()) return;
    const res = await http().get(profileUrl(PRODUCT_SOLD)).expect(200);
    expect(res.body.profile_locked).toBe(true);
  });
});

describe("RT-448 §4 — validation", () => {
  it.each([
    ["expiry without batch", { tracking_mode: "serial", expiry_required: true }],
    ["expiry on an untracked product", { tracking_mode: "none", expiry_required: true }],
    ["an unknown mode", { tracking_mode: "lot", expiry_required: false }],
    ["a missing field", { tracking_mode: "batch" }],
    ["a smuggled tenant_id", { tracking_mode: "batch", expiry_required: false, tenant_id: TENANT_A }],
  ])("rejects %s with 400 and writes nothing", async (_label, body) => {
    if (skip()) return;
    await http().put(profileUrl(PRODUCT_FRESH)).send(body).expect(400);
    expect(await profileRow(PRODUCT_FRESH)).toEqual({ tracking_mode: "none", expiry_required: false });
  });

  it("a non-uuid path is 400", async () => {
    if (skip()) return;
    await http().get(profileUrl("not-a-uuid")).expect(400);
    await http().get(identitiesUrl("not-a-uuid")).expect(400);
  });
});

describe("RT-448 §5 — tenant isolation", () => {
  it("another tenant's product is a non-disclosing 404 on every route", async () => {
    if (skip()) return;
    await http().get(profileUrl(PRODUCT_B_ACTIVE)).expect(404);
    await http()
      .put(profileUrl(PRODUCT_B_ACTIVE))
      .send({ tracking_mode: "batch", expiry_required: false })
      .expect(404);
    await http().get(identitiesUrl(PRODUCT_B_ACTIVE)).expect(404);
    const r = await pg().admin.query<{ tracking_mode: string }>(
      `SELECT tracking_mode FROM tenant_products WHERE id = $1`,
      [PRODUCT_B_ACTIVE],
    );
    expect(r.rows[0]?.tracking_mode).toBe("none");
  });
});

describe("RT-448 §6 — roles", () => {
  it.each([
    [TrackingProfileController.prototype, "get"],
    [TrackingProfileController.prototype, "set"],
    [TrackingIdentitiesController.prototype, "listTrackingIdentities"],
  ] as const)("%# is owner / tenant-admin only with a non-disclosing 404", (proto, method) => {
    const handler = (proto as unknown as Record<string, unknown>)[method] as object;
    const meta = Reflect.getMetadata(ROLES_METADATA_KEY, handler) as RolesMetadata | undefined;
    expect(meta?.any).toEqual(["owner", "tenant_admin"]);
    expect(meta?.denyAs).toBe(404);
  });
});

describe("RT-448 §7 — tracking identities", () => {
  it("a product without identities lists none", async () => {
    if (skip()) return;
    const res = await http().get(identitiesUrl(PRODUCT_FRESH)).expect(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it("lists by kind, then earliest expiry (none last), then code, with the strict projection", async () => {
    if (skip()) return;
    const res = await http().get(identitiesUrl(PRODUCT_LOTS)).expect(200);
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([
      LOT_EARLY,
      LOT_LATE,
      LOT_UNDATED,
      SERIAL_1,
    ]);
    expect(res.body.items[1]).toEqual({
      id: LOT_LATE,
      productId: PRODUCT_LOTS,
      kind: "batch",
      code: "LOT-B",
      expiryDate: "2027-06-30",
      manufacturedOn: "2026-01-15",
      origin: "erp_external",
    });
  });

  it("pages with a keyset cursor in the same order, then ends with a null cursor", async () => {
    if (skip()) return;
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `${identitiesUrl(PRODUCT_LOTS)}?limit=1${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`;
      const res = await http().get(url).expect(200);
      expect(res.body.items.length).toBeLessThanOrEqual(1);
      ids.push(...res.body.items.map((i: { id: string }) => i.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(ids).toEqual([LOT_EARLY, LOT_LATE, LOT_UNDATED, SERIAL_1]);
  });

  it("rejects a malformed cursor, one from another product, an impossible date and an out-of-range limit with 400", async () => {
    if (skip()) return;
    const first = await http().get(`${identitiesUrl(PRODUCT_LOTS)}?limit=1`).expect(200);
    const foreign = encodeURIComponent(first.body.nextCursor as string);
    await http().get(`${identitiesUrl(PRODUCT_FRESH)}?cursor=${foreign}`).expect(400);
    await http().get(`${identitiesUrl(PRODUCT_LOTS)}?cursor=not-a-cursor`).expect(400);
    const impossibleDate = Buffer.from(
      JSON.stringify({ p: PRODUCT_LOTS, k: "batch", e: "2026-02-31", c: "LOT-A", i: LOT_EARLY }),
      "utf8",
    ).toString("base64url");
    await http().get(`${identitiesUrl(PRODUCT_LOTS)}?cursor=${impossibleDate}`).expect(400);
    await http().get(`${identitiesUrl(PRODUCT_LOTS)}?limit=201`).expect(400);
  });

  it("a movement projects trackingIdentityId, null for every existing row", async () => {
    if (skip()) return;
    const service = new InventoryService(pg().app);
    const list = await service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_MOVED,
    });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toHaveProperty("trackingIdentityId", null);
  });
});
