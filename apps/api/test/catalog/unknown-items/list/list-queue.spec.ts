/**
 * T523 — 005-WAVE1-LIST — Tenant-admin queue read spec.
 *
 * Acceptance (slice 005-WAVE1-LIST validation contract):
 *   GREEN — FR-014 store-scoped vs tenant-wide visibility:
 *     - Tenant admin (tenant-wide, storeId=null) sees all pending rows
 *       across all stores in their tenant.
 *     - Store-scoped operator (storeId=UUID) sees only their store's
 *       pending rows.
 *     - Cross-tenant probe (RLS does the filtering) returns an empty
 *       page, NOT an error — non-disclosing per SI-001 / FR-013.
 *
 * Spec anchors:
 *   - FR-014 — store-scoped operators see only their store's items;
 *     tenant-wide actors see everything in their tenant.
 *   - SI-001 / SI-004 / FR-013 — cross-tenant probe is non-disclosing
 *     (empty page, no error).
 *   - 003 `unknown_items_tenant_isolation` + `unknown_items_store_read`
 *     RLS policies do the filtering. Service does NOT add explicit
 *     `WHERE store_id = …` — relies on `app.current_store` GUC
 *     (empty-string for tenant-wide actors via 0009 carve-out; store
 *     UUID for store-scoped actors). Same pattern as `findByIdForTenant`
 *     from PR #332 / T522.
 *
 * Fixture (from `seedUnknownItemsFixture`, see
 * `apps/api/test/catalog/__support__/seed-unknown-items.ts`):
 *     - 4 barcode pending rows: A.X / A.Y / B.X / B.Y (1 each)
 *     - 2 external_pos_id pending rows: A.X + B.X
 *   Tenant A total: 2 barcode (A.X, A.Y) + 1 external_pos_id (A.X) = 3 rows
 *   Tenant B total: 2 barcode (B.X, B.Y) + 1 external_pos_id (B.X) = 3 rows
 *   Store A.X total: 1 barcode + 1 external_pos_id = 2 rows
 *   Store A.Y total: 1 barcode = 1 row
 *
 * Wiring strategy
 * ---------------
 * Service-direct test, mirrors `cross-tenant.spec.ts` (PR #332). The
 * service is constructed with `env.app` (the RLS-enforced app-role
 * pool); the seed fixture writes via `env.admin` (RLS bypass — correct
 * for fixture setup). No NestJS DI, no supertest, no controller —
 * T523 exercises the SERVICE method; the controller's `@Get` route
 * (T524) is verified structurally via TS build + the wider catalog
 * regression sweep, not by a per-route supertest call here.
 *
 * Why service-direct vs controller-direct
 * ---------------------------------------
 * The slice brief says "RLS does the cross-store filtering; the
 * service does not add explicit WHERE store_id = …". The invariant
 * lives at the service/SQL boundary, not at the HTTP boundary. A
 * service-direct test exercises the invariant where it lives.
 * Controller-level coverage (Zod validation of query params,
 * 401/403 envelopes) is wider than this slice's scope; T564 polish
 * or a future contract-conformance pass can extend.
 */
import "reflect-metadata";

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
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
  seedCatalogIsolationFixture,
  UNKNOWN_A_X,
  UNKNOWN_A_Y,
  UNKNOWN_B_X,
  UNKNOWN_B_Y,
} from "../../__support__/isolation-harness";
import {
  seedUnknownItemsFixture,
  UNKNOWN_ITEMS_FIXTURE_IDS,
} from "../../__support__/seed-unknown-items";
import { UnknownItemsService } from "../../../../src/catalog/unknown-items/unknown-items.service";
import { UnknownItemsController } from "../../../../src/catalog/unknown-items/unknown-items.controller";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import type { ResolvedContext } from "../../../../src/context/types";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PosOperatorAuthGuard } from "../../../../src/auth/pos-operator-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";

// --------------------------------------------------------------------------
// Suite-level state — mirrors cross-tenant.spec.ts (PR #332) for service-direct
// cases, and capture-happy-path.spec.ts (PR #317) for the supertest case.
// --------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let service: UnknownItemsService | null = null;
let app: INestApplication | null = null;
let contextGuard: ConfigurableContextGuard | null = null;

// --------------------------------------------------------------------------
// ConfigurableContextGuard — same shape as capture-happy-path.spec.ts,
// supplies a configurable POS / dashboard principal per request.
// --------------------------------------------------------------------------

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = UNKNOWN_ITEMS_FIXTURE_IDS.tenantA;
  public storeId: string | null = null; // tenant-wide by default for list
  public userId: string = "0a000000-0000-7000-8000-0000000005ae";

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    req.context = {
      userId: this.userId,
      tenantId: this.tenantId,
      storeId: this.storeId,
      isPlatformAdmin: false,
      source: "session",
      storeAccess: { kind: "all" },
    };
    req.principal = { userId: this.userId };
    return true;
  }
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await seedUnknownItemsFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T523 list-queue.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  // Service-direct handle (used by the FR-014 + SI-001/004 cases below).
  service = new UnknownItemsService(env.app);

  // Nest app boot for the supertest case (controller → Zod-pipe → service →
  // DB end-to-end). Stripped-down providers: GETs aren't `@Idempotent`, so no
  // IdempotencyInterceptor / Redis wiring is needed; no `@Auditable`, so no
  // AuditEmitter providers needed. The configurable guard mounts the
  // `req.context` shape that production's `TenantContextGuard` would publish.
  contextGuard = new ConfigurableContextGuard();
  const localEnv = env;
  const moduleRef = await Test.createTestingModule({
    controllers: [UnknownItemsController],
    providers: [
      // Bind the service to the RLS-enforced app-role pool (same as
      // service-direct cases use). The controller picks up
      // UnknownItemsService via DI.
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      UnknownItemsService,
    ],
  })
    // Real DashboardAuthGuard + TenantContextGuard + RolesGuard are wired
    // method-level on LIST + dismiss as of the auth-guard wiring slice
    // (UnknownItemsController has no class-level guards because the POS
    // capture route uses a different auth model). Tests inject context via
    // the global ConfigurableContextGuard (registered below); override the
    // production guards with no-op pass-throughs so the global guard's
    // context survives to the handler.
    .overrideGuard(DashboardAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(PosOperatorAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard).useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalGuards(contextGuard);
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[T523 list-queue.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// FR-014 — tenant-wide visibility
// --------------------------------------------------------------------------

describe("T523 / 005-WAVE1-LIST — tenant admin sees all stores", () => {
  it("tenant A admin (storeId=null) sees pending rows from A.X AND A.Y", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");

    const result = await service.listForTenant({
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
      storeScope: { kind: "tenant" },
      status: "pending",
      limit: 50,
    });

    // 3 pending rows seeded for tenant A: 1 barcode at A.X, 1 barcode
    // at A.Y, 1 external_pos_id at A.X.
    // + 2 pending rows from 003 isolation harness (A.X, A.Y) — see isolation-harness.ts L122-123
    const ids = result.items.map((r) => r.id).sort();
    expect(ids).toEqual(
      [
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXPos,
        UNKNOWN_A_X,
        UNKNOWN_A_Y,
      ].sort(),
    );

    // No tenant B rows leak across.
    const storeIds = new Set(result.items.map((r) => r.storeId));
    expect(storeIds.has(UNKNOWN_ITEMS_FIXTURE_IDS.storeBX)).toBe(false);
    expect(storeIds.has(UNKNOWN_ITEMS_FIXTURE_IDS.storeBY)).toBe(false);

    // Cursor null on Wave 1 (single-page within limit).
    expect(result.nextCursor).toBeNull();
  });

  it("tenant B admin (storeId=null) sees pending rows from B.X AND B.Y", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");

    const result = await service.listForTenant({
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantB,
      storeScope: { kind: "tenant" },
      status: "pending",
      limit: 50,
    });

    // + 2 pending rows from 003 isolation harness (B.X, B.Y) — see isolation-harness.ts L124-125
    const ids = result.items.map((r) => r.id).sort();
    expect(ids).toEqual(
      [
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownBYBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXPos,
        UNKNOWN_B_X,
        UNKNOWN_B_Y,
      ].sort(),
    );

    // No tenant A rows leak across.
    const storeIds = new Set(result.items.map((r) => r.storeId));
    expect(storeIds.has(UNKNOWN_ITEMS_FIXTURE_IDS.storeAX)).toBe(false);
    expect(storeIds.has(UNKNOWN_ITEMS_FIXTURE_IDS.storeAY)).toBe(false);

    expect(result.nextCursor).toBeNull();
  });
});

// --------------------------------------------------------------------------
// FR-014 — store-scoped visibility
// --------------------------------------------------------------------------

describe("T523 / 005-WAVE1-LIST — store-scoped operator sees only their store", () => {
  it("store-scoped to A.X sees A.X rows only — A.Y row is invisible", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");

    const result = await service.listForTenant({
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
      storeScope: { kind: "stores", storeIds: [UNKNOWN_ITEMS_FIXTURE_IDS.storeAX] },
      status: "pending",
      limit: 50,
    });

    // 2 pending rows at A.X: 1 barcode + 1 external_pos_id.
    // + 1 pending row from 003 isolation harness at A.X — see isolation-harness.ts L122, L393
    const ids = result.items.map((r) => r.id).sort();
    expect(ids).toEqual(
      [
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXPos,
        UNKNOWN_A_X,
      ].sort(),
    );

    // A.Y row is not visible to A.X-scoped operator (FR-014).
    expect(
      result.items.find(
        (r) => r.id === UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode,
      ),
    ).toBeUndefined();

    // Cross-tenant rows obviously also absent.
    for (const r of result.items) {
      expect(r.tenantId).toBe(UNKNOWN_ITEMS_FIXTURE_IDS.tenantA);
      expect(r.storeId).toBe(UNKNOWN_ITEMS_FIXTURE_IDS.storeAX);
    }
  });

  it("store-scoped to A.Y sees A.Y rows only — A.X rows are invisible", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");

    const result = await service.listForTenant({
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
      storeScope: { kind: "stores", storeIds: [UNKNOWN_ITEMS_FIXTURE_IDS.storeAY] },
      status: "pending",
      limit: 50,
    });

    // 1 pending row at A.Y (barcode only — no external_pos_id seeded at A.Y).
    // + 1 pending row from 003 isolation harness at A.Y — see isolation-harness.ts L123, L394
    const ids = result.items.map((r) => r.id).sort();
    expect(ids).toEqual(
      [
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode,
        UNKNOWN_A_Y,
      ].sort(),
    );
  });
});

// --------------------------------------------------------------------------
// SI-001 / SI-004 / FR-013 — cross-tenant probe is non-disclosing
// --------------------------------------------------------------------------

describe("T523 / 005-WAVE1-LIST — cross-tenant probe returns empty, not error", () => {
  it("tenant A listing with tenant A context never returns tenant B rows even by guess", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");

    const result = await service.listForTenant({
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
      storeScope: { kind: "tenant" },
      status: "pending",
      limit: 50,
    });

    // RLS filters tenant B rows at the DB layer (003 unknown_items_tenant_isolation).
    // Service does not add an application-level tenant predicate.
    for (const r of result.items) {
      expect(r.tenantId).toBe(UNKNOWN_ITEMS_FIXTURE_IDS.tenantA);
    }

    // No "permission denied" or other oracle-leaking error — the page
    // is just filtered. (If RLS misbehaved this would throw or return
    // tenant B rows; both would fail the test.)
    expect(Array.isArray(result.items)).toBe(true);
  });

  it("tenant-wide actor narrowing via `storeIdFilter` to a foreign-tenant store returns empty (RLS filter, no error)", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");

    // Tenant A admin (tenant-wide, storeId=null) supplies the
    // OPTIONAL `storeIdFilter` query convenience pointing at tenant B's
    // store. RLS still controls visibility: the
    // `unknown_items_tenant_isolation` policy filters B's rows BEFORE
    // the residual `AND store_id = $X` predicate ever runs, so the page
    // is empty. The non-disclosing posture is preserved
    // (indistinguishable from "no rows at that store in your tenant").
    //
    // Correctness fix from CodeRabbit comment on PR #334: the prior
    // version passed `storeId: storeBX` which would have changed the
    // ACTOR'S scope (a different RLS path: store-scoped actor in
    // foreign store) instead of exercising the residual filter param.
    const result = await service.listForTenant({
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
      storeScope: { kind: "tenant" }, // tenant-wide actor
      storeIdFilter: UNKNOWN_ITEMS_FIXTURE_IDS.storeBX, // foreign-tenant store filter
      status: "pending",
      limit: 50,
    });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});

// --------------------------------------------------------------------------
// Controller-boundary supertest case (CodeRabbit comment #3 on PR #334)
// --------------------------------------------------------------------------
//
// The service-direct cases above prove the SQL / RLS / store-scope
// invariants — the slice's load-bearing behavior. This single supertest
// case validates the additional surface the controller introduces:
//
//   1. HTTP routing — `@Get("api/v1/catalog/unknown-items")` is reachable
//      (proves the controller-prefix refactor in PR #334 didn't break
//       method-level path resolution).
//   2. Zod `.strict()` query parsing — `?status=pending&limit=50` is
//      coerced and validated; unknown params would 400.
//   3. Wire-shape adapter — service's `UnknownItemRow` (camelCase) → the
//      contract's `UnknownItem` (snake_case) survives the round-trip.
//   4. Tenant-context resolution — `req.context.tenantId/storeId` from
//      the guard reaches the service correctly.
//
// One case is sufficient: more would duplicate the service-direct
// assertions above. Per the path-rule from CLAUDE.md
// (`**/*.{spec,test}.{ts,tsx}: Use Jest + Supertest + Testcontainers`).

describe("T523 / 005-WAVE1-LIST — HTTP boundary (supertest)", () => {
  it("GET /api/v1/catalog/unknown-items returns tenant A admin's pending page in contract shape", async () => {
    if (maybeSkip()) return;
    if (!contextGuard) throw new Error("contextGuard not constructed");

    // Tenant A admin, tenant-wide (storeId=null).
    contextGuard.tenantId = UNKNOWN_ITEMS_FIXTURE_IDS.tenantA;
    contextGuard.storeId = null;

    const res = await http()
      .get("/api/v1/catalog/unknown-items")
      .query({ status: "pending", limit: 50 });

    expect(res.status).toBe(200);

    // Response shape: `ListUnknownItemsResponse` per the OpenAPI
    // contract (`packages/contracts/openapi/catalog/unknown-items.yaml`).
    expect(res.body).toMatchObject({
      items: expect.any(Array),
      next_cursor: null, // Wave 1 single-pages; cursor always null.
    });

    // Same 3 ids the service-direct case above asserts, but through
    // the wire-shape adapter — proves snake_case conversion + adapter
    // mapping survives. (`identifier_value` vs service-level
    // `identifierValue`, etc.)
    // + 2 pending rows from 003 isolation harness (A.X, A.Y) — see isolation-harness.ts L122-123
    const ids = res.body.items.map((it: { id: string }) => it.id).sort();
    expect(ids).toEqual(
      [
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXPos,
        UNKNOWN_A_X,
        UNKNOWN_A_Y,
      ].sort(),
    );

    // Sanity-check the snake_case wire fields on at least one row.
    const sample = res.body.items[0];
    expect(sample).toHaveProperty("tenant_id");
    expect(sample).toHaveProperty("store_id");
    expect(sample).toHaveProperty("identifier_type");
    expect(sample).toHaveProperty("identifier_value");
    expect(sample).toHaveProperty("resolution_status", "pending");
    expect(sample).toHaveProperty("encountered_at");
    // Snake_case fields confirm the controller's wire-shape adapter
    // ran; the service exposes camelCase (`identifierValue`).
    expect(sample).not.toHaveProperty("identifierValue");
    expect(sample).not.toHaveProperty("tenantId");
  });
});
