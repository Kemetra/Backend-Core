/**
 * list-sort-group.spec.ts  (007 — T035 RED / T037 GREEN)
 *
 * US2 / FR-003 / FR-004 / FR-032: the review list accepts `sort`
 * (enum age_asc | age_desc | store, default age_desc) and an optional
 * `group_by` (enum store | source_system). Per the contract, group_by does
 * NOT change the response shape — it orders items so same-group members are
 * contiguous (presentation/ordering, not a grouped envelope). Buckets are
 * scope-safe (no out-of-scope group revealed via ordering/count/field).
 *
 * RED (T035): the shipped list ignores `sort`/`group_by` (and `.strict()`
 * rejects them as unknown params → 400). After T037 they order the page.
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
      console.warn(`\n[T035 list-sort-group] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[T035 list-sort-group] skipping — Docker unavailable");
    return true;
  }
  return false;
}
function ts(item: Record<string, unknown>): number {
  return new Date(item["encountered_at"] as string).getTime();
}

beforeEach(() => {
  if (contextGuard) {
    contextGuard.tenantId = UNKNOWN_ITEMS_FIXTURE_IDS.tenantA;
    contextGuard.storeId = null;
  }
});

describe("T035 — list sort (FR-003)", () => {
  it("?sort=age_asc → encountered_at ascending", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get("/api/v1/catalog/unknown-items?sort=age_asc")
      .expect(200);
    const items = (res.body as { items: ReadonlyArray<Record<string, unknown>> })
      .items;
    // Need ≥2 rows or the ordering loop never executes (the tenant-A fixture
    // seeds several pending rows). (CodeRabbit #405)
    expect(items.length).toBeGreaterThan(1);
    for (let i = 1; i < items.length; i++) {
      expect(ts(items[i]!)).toBeGreaterThanOrEqual(ts(items[i - 1]!));
    }
  });

  it("?sort=age_desc → encountered_at descending (default order preserved)", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get("/api/v1/catalog/unknown-items?sort=age_desc")
      .expect(200);
    const items = (res.body as { items: ReadonlyArray<Record<string, unknown>> })
      .items;
    expect(items.length).toBeGreaterThan(1);
    for (let i = 1; i < items.length; i++) {
      expect(ts(items[i]!)).toBeLessThanOrEqual(ts(items[i - 1]!));
    }
  });

  it("invalid sort value → 400 validation (not silently ignored)", async () => {
    if (maybeSkip()) return;
    await http()
      .get("/api/v1/catalog/unknown-items?sort=banana")
      .expect(400);
  });
});

describe("T035 — list group_by (FR-004 / FR-032) — contiguous ordering, flat shape", () => {
  it("?group_by=store → same-store items are contiguous; response stays a flat items array", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get("/api/v1/catalog/unknown-items?group_by=store")
      .expect(200);
    const body = res.body as {
      items: ReadonlyArray<Record<string, unknown>>;
      next_cursor: string | null;
    };
    // flat shape (no grouped envelope)
    expect(Array.isArray(body.items)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(body, "groups")).toBe(false);
    // contiguity: once a store changes in the sequence, it must not reappear
    const seen = new Set<string>();
    let prev: string | null = null;
    for (const item of body.items) {
      const store = item["store_id"] as string;
      if (store !== prev) {
        expect(seen.has(store)).toBe(false); // store block not split
        seen.add(store);
        prev = store;
      }
    }
    // The tenant-A fixture spans stores A.X and A.Y, so grouping must actually
    // have ≥2 distinct stores to group — otherwise contiguity is trivially true
    // and the test proves nothing. (CodeRabbit #405)
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it("invalid group_by value → 400 validation", async () => {
    if (maybeSkip()) return;
    await http()
      .get("/api/v1/catalog/unknown-items?group_by=region")
      .expect(400);
  });
});
