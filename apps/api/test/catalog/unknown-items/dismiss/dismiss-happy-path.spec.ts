/**
 * T540 — 005-WAVE1-DISMISS — Dismiss happy-path spec.
 *
 * Acceptance (slice 005-WAVE1-DISMISS validation contract):
 *   GREEN — FR-002/FR-003/FR-004 monotonic lifecycle:
 *     - A pending unknown-item row transitions to `dismissed` when a
 *       tenant-wide actor calls the dismiss endpoint
 *     - `resolved_at` is populated (post-transition timestamp)
 *     - `resolved_by` is populated (acting principal's user id)
 *     - `resolution_action = 'dismissed'`
 *     - `resolved_product_id` remains NULL (dismiss has no linked
 *       product; that field is reserved for Wave 2's link/create-new)
 *     - NO `product_aliases` row is written
 *     - NO `tenant_products` row is written
 *     - Store-scoped operators dismissing within their own store
 *       succeed the same way (a tenant admin and an operator scoped
 *       to the captured-at store both transition the row identically)
 *
 * Spec anchors:
 *   - FR-002: `pending` → has no `resolved_*` fields; `resolved` /
 *     `dismissed` → has all of them
 *   - FR-003: `resolution_action ∈ {linked, created, dismissed}`
 *     paired with each non-pending state
 *   - FR-004: monotonic lifecycle (`pending → resolved`,
 *     `pending → dismissed`, no other transitions)
 *   - US2 #3 dismiss path
 *   - Contract: POST /api/v1/catalog/unknown-items/{id}/dismiss →
 *     200 with updated `UnknownItem` body
 *
 * Wiring strategy
 * ---------------
 * Service-direct + one supertest case (mirrors PR #334 / LIST). The
 * service-direct portion exercises `dismissUnknownItem` against the
 * RLS-enforced `env.app` pool; the supertest portion verifies the
 * controller's HTTP boundary (`@Post`, `@Auditable`, `@Param` UUID
 * validation, wire-shape adapter).
 *
 * Why the hybrid:
 *   - Service-direct cases are cheap and prove the SQL-level
 *     transition + RLS posture per the slice contract
 *   - Single supertest case proves the HTTP boundary survives the
 *     same way the LIST slice did per CodeRabbit's path-rule
 *     (`Use Jest + Supertest + Testcontainers`)
 *
 * Docker:
 *   Testcontainers Postgres 16 required. Honors
 *   `MIGRATION_TEST_ALLOW_SKIP=1`.
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

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { UnknownItemsController } from "../../../../src/catalog/unknown-items/unknown-items.controller";
import { UnknownItemsService } from "../../../../src/catalog/unknown-items/unknown-items.service";
import { PG_POOL } from "../../../../src/auth/auth.module";
import type { ResolvedContext } from "../../../../src/context/types";
import { DashboardAuthGuard } from "../../../../src/auth/dashboard-auth.guard";
import { PosOperatorAuthGuard } from "../../../../src/auth/pos-operator-auth.guard";
import { RolesGuard } from "../../../../src/auth/roles.guard";
import { TenantContextGuard } from "../../../../src/context/tenant-context.guard";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { seedCatalogIsolationFixture } from "../../__support__/isolation-harness";
import {
  seedUnknownItemsFixture,
  UNKNOWN_ITEMS_FIXTURE_IDS,
} from "../../__support__/seed-unknown-items";

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let service: UnknownItemsService | null = null;
let app: INestApplication | null = null;
let contextGuard: ConfigurableContextGuard | null = null;

// ---------------------------------------------------------------------------
// ConfigurableContextGuard — same shape as list-queue.spec.ts (PR #334)
// ---------------------------------------------------------------------------

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = UNKNOWN_ITEMS_FIXTURE_IDS.tenantA;
  public storeId: string | null = null;
  public userId: string = "0a000000-0000-7000-8000-0000000005af";

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
        `\n[T540 dismiss-happy-path.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  service = new UnknownItemsService(env.app);

  contextGuard = new ConfigurableContextGuard();
  const localEnv = env;
  const moduleRef = await Test.createTestingModule({
    controllers: [UnknownItemsController],
    providers: [
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

// Reset the dismissed fixture row's state between tests so each `it`
// sees `pending` and can transition cleanly.
afterEach(async () => {
  if (dockerSkipped || !env) return;
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status = 'pending',
            resolution_action = NULL,
            resolved_at       = NULL,
            resolved_by       = NULL,
            resolved_product_id = NULL
      WHERE id = ANY($1)`,
    [
      [
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXPos,
      ],
    ],
  );
});

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn(
      "[T540 dismiss-happy-path.spec] skipping — Docker unavailable",
    );
    return true;
  }
  return false;
}

function http() {
  if (!app) throw new Error("app not initialised");
  return request(app.getHttpServer());
}

const ACTOR_USER_ID = "0a000000-0000-7000-8000-0000000005af";

// ---------------------------------------------------------------------------
// T540 — service-direct happy-path
// ---------------------------------------------------------------------------

describe("T540 / 005-WAVE1-DISMISS — service-direct happy-path", () => {
  it("tenant admin (storeId=null) dismisses a pending row → status=dismissed, resolved_* populated", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");
    expect(env).not.toBeNull();

    // FR-001 reinforcement: dismiss MUST NOT create `tenant_products`
    // or `product_aliases` rows as a side-effect. Capture before/after
    // counts to assert the invariant by equality rather than by a
    // brittle magic number tied to the fixture's exact seed state
    // (CodeRabbit nitpick on PR #341 — the prior `>= 0` check was
    // vacuously true).
    const productCountBefore = await env!.admin.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM tenant_products WHERE tenant_id = $1",
      [UNKNOWN_ITEMS_FIXTURE_IDS.tenantA],
    );
    const aliasCountBefore = await env!.admin.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM product_aliases WHERE tenant_id = $1",
      [UNKNOWN_ITEMS_FIXTURE_IDS.tenantA],
    );
    const productsBefore = parseInt(productCountBefore.rows[0]!.count, 10);
    const aliasesBefore = parseInt(aliasCountBefore.rows[0]!.count, 10);

    const result = await service.dismissUnknownItem({
      id: UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode,
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
      storeScope: { kind: "tenant" }, // tenant-wide actor
      actorUserId: ACTOR_USER_ID,
    });

    // FR-002 / FR-003: post-transition fields populated
    expect(result.resolutionStatus).toBe("dismissed");
    expect(result.resolutionAction).toBe("dismissed");
    expect(result.resolvedAt).not.toBeNull();
    expect(result.resolvedAt).toBeInstanceOf(Date);
    expect(result.resolvedBy).toBe(ACTOR_USER_ID);

    // FR-001: dismiss does NOT link a product (that's Wave 2's
    // create-new / link). `resolved_product_id` stays NULL.
    expect(result.resolvedProductId).toBeNull();

    // Identifier/scope preserved through the UPDATE
    expect(result.tenantId).toBe(UNKNOWN_ITEMS_FIXTURE_IDS.tenantA);
    expect(result.storeId).toBe(UNKNOWN_ITEMS_FIXTURE_IDS.storeAX);

    // Invariant: no product or alias row added by the dismiss path.
    const productCountAfter = await env!.admin.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM tenant_products WHERE tenant_id = $1",
      [UNKNOWN_ITEMS_FIXTURE_IDS.tenantA],
    );
    const aliasCountAfter = await env!.admin.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM product_aliases WHERE tenant_id = $1",
      [UNKNOWN_ITEMS_FIXTURE_IDS.tenantA],
    );
    expect(parseInt(productCountAfter.rows[0]!.count, 10)).toBe(productsBefore);
    expect(parseInt(aliasCountAfter.rows[0]!.count, 10)).toBe(aliasesBefore);
  });

  it("store-scoped operator (storeId=their store) dismisses a pending row at THEIR store → same successful transition", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");

    const result = await service.dismissUnknownItem({
      id: UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode,
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
      storeScope: { kind: "stores", storeIds: [UNKNOWN_ITEMS_FIXTURE_IDS.storeAX] }, // store-scoped to A.X
      actorUserId: ACTOR_USER_ID,
    });

    // Same successful transition under store-scoped RLS posture.
    // The `app.current_store` GUC matches the row's `store_id` →
    // unknown_items_store_read policy admits the UPDATE.
    expect(result.resolutionStatus).toBe("dismissed");
    expect(result.resolutionAction).toBe("dismissed");
    expect(result.resolvedAt).not.toBeNull();
    expect(result.resolvedBy).toBe(ACTOR_USER_ID);
    expect(result.storeId).toBe(UNKNOWN_ITEMS_FIXTURE_IDS.storeAX);
  });
});

// ---------------------------------------------------------------------------
// T540 — HTTP boundary supertest
// ---------------------------------------------------------------------------

describe("T540 / 005-WAVE1-DISMISS — HTTP boundary (supertest)", () => {
  it("POST /api/v1/catalog/unknown-items/:id/dismiss → 200 with UnknownItem body", async () => {
    if (maybeSkip()) return;
    if (!contextGuard) throw new Error("contextGuard not constructed");

    contextGuard.tenantId = UNKNOWN_ITEMS_FIXTURE_IDS.tenantA;
    contextGuard.storeId = null; // tenant-wide actor

    const res = await http().post(
      `/api/v1/catalog/unknown-items/${UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode}/dismiss`,
    );

    expect(res.status).toBe(200);

    // Response shape: contract's `UnknownItem` (snake_case via the
    // controller's `rowToUnknownItemWireShape` adapter).
    expect(res.body).toMatchObject({
      id: UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode,
      tenant_id: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
      store_id: UNKNOWN_ITEMS_FIXTURE_IDS.storeAY,
      resolution_status: "dismissed",
      resolution_action: "dismissed",
      resolved_by: ACTOR_USER_ID,
    });
    expect(res.body.resolved_at).toEqual(expect.any(String)); // ISO string
    expect(res.body.resolved_product_id).toBeNull();

    // Snake_case fields confirm the wire-shape adapter ran.
    expect(res.body).not.toHaveProperty("tenantId");
    expect(res.body).not.toHaveProperty("resolutionStatus");
  });
});
