/**
 * list-pagination.spec.ts  (007 — T036 RED / T037 GREEN)
 *
 * US2 / FR-005: the review list reuses the shipped cursor/limit contract —
 * limit default 50, max 200, and out-of-range (>200, <1, non-integer) is
 * REJECTED with 400 validation, NOT clamped. `next_cursor` is opaque and null
 * on the last page (Wave 1 single-page within limit).
 *
 * The shipped Zod schema already enforces min(1).max(200).default(50); these
 * cases lock FR-005's reject-not-clamp invariant and confirm T037's DTO
 * extension (adding source_system/sort/group_by) does not weaken it.
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
      console.warn(`\n[T036 list-pagination] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
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
  contextGuard = new ConfigurableContextGuard();
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
    console.warn("[T036 list-pagination] skipping — Docker unavailable");
    return true;
  }
  return false;
}

// Reset the guard's context between cases — consistent with the sibling list
// specs. These pagination cases are pure param-validation (no context
// mutation), so this is defensive uniformity, not a current-pollution fix.
beforeEach(() => {
  if (contextGuard) {
    contextGuard.tenantId = UNKNOWN_ITEMS_FIXTURE_IDS.tenantA;
    contextGuard.storeId = null;
  }
});

describe("T036 — list pagination / limit (FR-005, reject-not-clamp)", () => {
  it("no limit → defaults to 50 (page returned, next_cursor null)", async () => {
    if (maybeSkip()) return;
    const res = await http().get("/api/v1/catalog/unknown-items").expect(200);
    const body = res.body as {
      items: ReadonlyArray<unknown>;
      next_cursor: string | null;
    };
    // Non-empty guard — the tenant-A fixture seeds multiple pending rows, so an
    // empty page would be a real regression, not a valid "default" result. Without
    // this, `<= 50` passes vacuously on an empty list. (CodeRabbit #405)
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.length).toBeLessThanOrEqual(50);
    expect(body.next_cursor).toBeNull();
  });

  it("limit=200 (max) → accepted", async () => {
    if (maybeSkip()) return;
    await http().get("/api/v1/catalog/unknown-items?limit=200").expect(200);
  });

  it("limit=201 (over max) → 400 validation, NOT clamped to 200", async () => {
    if (maybeSkip()) return;
    await http().get("/api/v1/catalog/unknown-items?limit=201").expect(400);
  });

  it("limit=0 (under min) → 400 validation", async () => {
    if (maybeSkip()) return;
    await http().get("/api/v1/catalog/unknown-items?limit=0").expect(400);
  });

  it("limit=-5 (negative) → 400 validation", async () => {
    if (maybeSkip()) return;
    await http().get("/api/v1/catalog/unknown-items?limit=-5").expect(400);
  });

  it("limit=abc (non-integer) → 400 validation", async () => {
    if (maybeSkip()) return;
    await http().get("/api/v1/catalog/unknown-items?limit=abc").expect(400);
  });

  it("an unknown query param is rejected (.strict) → 400", async () => {
    if (maybeSkip()) return;
    await http()
      .get("/api/v1/catalog/unknown-items?bogus=1")
      .expect(400);
  });
});
