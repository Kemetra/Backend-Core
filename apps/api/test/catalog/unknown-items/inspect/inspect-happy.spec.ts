/**
 * inspect-happy.spec.ts  (007 — T040 RED / T042 GREEN)
 *
 * US3 / FR-009: GET /api/v1/catalog/unknown-items/{id} returns the addressed
 * row as a `ReviewQueueItem` — no `sale_context` (FR-007), no candidate-match
 * hint (FR-070, v1). Inherits document-level cookieAuth (list posture — no
 * RolesGuard; RLS governs visibility).
 *
 * RED (T040): the GET /{id} route does not exist yet → 404 route-not-found.
 * After T042 the route returns 200 + ReviewQueueItem.
 *
 * Supertest harness mirrors list-projection.spec.ts (controller → service →
 * DB) with a ConfigurableContextGuard.
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
import { seedCatalogIsolationFixture } from "../../__support__/isolation-harness";
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

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let app: INestApplication | null = null;
let contextGuard: ConfigurableContextGuard | null = null;

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = UNKNOWN_ITEMS_FIXTURE_IDS.tenantA;
  public storeId: string | null = null;
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
      console.warn(`\n[T040 inspect-happy] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  contextGuard = new ConfigurableContextGuard();
  const localEnv = env;
  const moduleRef = await Test.createTestingModule({
    controllers: [UnknownItemsController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      UnknownItemsService,
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(PosOperatorAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(TenantContextGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
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
    console.warn("[T040 inspect-happy] skipping — Docker unavailable");
    return true;
  }
  return false;
}

beforeEach(() => {
  if (contextGuard) {
    contextGuard.tenantId = UNKNOWN_ITEMS_FIXTURE_IDS.tenantA;
    contextGuard.storeId = null;
  }
});

describe("T040 — inspect GET /{id} happy path (FR-009 / FR-007 / FR-070)", () => {
  it("in-scope pending item → 200 ReviewQueueItem, no sale_context", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get(`/api/v1/catalog/unknown-items/${UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode}`)
      .expect(200);
    const body = res.body as Record<string, unknown>;
    expect(body["id"]).toBe(UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode);
    expect(body["resolution_status"]).toBe("pending");
    expect(Object.prototype.hasOwnProperty.call(body, "sale_context")).toBe(false);
  });

  it("in-scope resolved item, tenant-wide → 200 with resolved_product_id, no candidate hint", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get(`/api/v1/catalog/unknown-items/${UNKNOWN_ITEMS_FIXTURE_IDS.resolvedAX}`)
      .expect(200);
    const body = res.body as Record<string, unknown>;
    expect(body["resolution_status"]).toBe("resolved");
    expect(body["resolved_product_id"]).toBe(
      UNKNOWN_ITEMS_FIXTURE_IDS.resolvedProductA,
    );
    expect(Object.prototype.hasOwnProperty.call(body, "sale_context")).toBe(false);
    // FR-070: no candidate-match hint in v1 — no such field on the projection.
    expect(Object.prototype.hasOwnProperty.call(body, "candidate_match")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, "candidates")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(body, "suggested_product_id")).toBe(false);
  });

  it("store-scoped actor inspecting a resolved item in its store → product reference suppressed (FR-001a)", async () => {
    if (maybeSkip()) return;
    if (contextGuard) contextGuard.storeId = UNKNOWN_ITEMS_FIXTURE_IDS.storeAX;
    const res = await http()
      .get(`/api/v1/catalog/unknown-items/${UNKNOWN_ITEMS_FIXTURE_IDS.resolvedAX}`)
      .expect(200);
    const body = res.body as Record<string, unknown>;
    expect(body["id"]).toBe(UNKNOWN_ITEMS_FIXTURE_IDS.resolvedAX);
    expect(Object.prototype.hasOwnProperty.call(body, "resolved_product_id")).toBe(false);
  });

  it("malformed UUID path → 400 validation", async () => {
    if (maybeSkip()) return;
    await http().get("/api/v1/catalog/unknown-items/not-a-uuid").expect(400);
  });
});
