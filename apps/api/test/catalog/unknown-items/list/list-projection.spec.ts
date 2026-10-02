/**
 * list-projection.spec.ts  (007 — T030 RED / T032 GREEN)
 *
 * The shipped `tenantAdminListUnknownItems` response IS the review queue
 * (006 plan §9.1 / 007 TL;DR). FR-007 (006 FR-021a) makes `sale_context` a
 * MUST NOT on the review surface, and T002 decided TIGHTEN — the list switches
 * to the `ReviewQueueItem` projection (shipped `UnknownItem` MINUS
 * `sale_context`) in this slice, via the shared `toReviewQueueItem` helper
 * (R7.2). The POS capture response keeps `sale_context` (R7.3) — out of scope
 * here.
 *
 * RED (T030): the list currently maps `rowToUnknownItemWireShape`, which
 * INCLUDES `sale_context`. These cases assert its ABSENCE on the wire — RED
 * until T032 swaps the projection.
 *
 * Supertest harness mirrors `list-queue.spec.ts` (controller → Zod-pipe →
 * service → DB), with a `ConfigurableContextGuard` supplying the resolved
 * context. The seeded rows carry a non-null `sale_context` in the DB (005
 * capture path), so a leak would be visible if the projection regressed.
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
  public storeId: string | null = null; // tenant-wide by default
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
      console.warn(`\n[T030 list-projection] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[T030 list-projection] skipping — Docker unavailable");
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

describe("T030 — list returns ReviewQueueItem (no sale_context) (FR-007)", () => {
  it("default list (pending) → every item OMITS the sale_context key", async () => {
    if (maybeSkip()) return;
    const res = await http().get("/api/v1/catalog/unknown-items").expect(200);
    const body = res.body as {
      items: ReadonlyArray<Record<string, unknown>>;
      next_cursor: string | null;
    };

    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(Object.prototype.hasOwnProperty.call(item, "sale_context")).toBe(
        false,
      );
      // sanity: the review fields ARE present
      expect(typeof item["id"]).toBe("string");
      expect(typeof item["identifier_type"]).toBe("string");
      expect(typeof item["encountered_at"]).toBe("string");
    }
  });

  it("default list is pending-only (FR-001)", async () => {
    if (maybeSkip()) return;
    const res = await http().get("/api/v1/catalog/unknown-items").expect(200);
    const body = res.body as { items: ReadonlyArray<Record<string, unknown>> };
    // Non-empty guard so the per-item loop can't pass vacuously. (CodeRabbit #405)
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item["resolution_status"]).toBe("pending");
    }
  });

  it("store-scoped actor list → still OMITS sale_context", async () => {
    if (maybeSkip()) return;
    if (contextGuard) contextGuard.storeId = UNKNOWN_ITEMS_FIXTURE_IDS.storeAX;
    const res = await http().get("/api/v1/catalog/unknown-items").expect(200);
    const body = res.body as { items: ReadonlyArray<Record<string, unknown>> };
    // Store A.X has pending fixtures (barcode + external_pos_id), so an empty
    // page would be a regression — guard the loop against a vacuous pass. (CodeRabbit #405)
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(Object.prototype.hasOwnProperty.call(item, "sale_context")).toBe(
        false,
      );
    }
  });
});
