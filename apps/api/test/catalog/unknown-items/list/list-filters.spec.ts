/**
 * list-filters.spec.ts  (007 — T034 RED / T037 GREEN)
 *
 * US2 / FR-002 / FR-006: the review list accepts an optional `source_system`
 * filter. Filtering is scope-safe — RLS still bounds visibility, and a filtered
 * page never reveals an out-of-scope dimension (SC-007). The contract declares
 * `source_system` as a free string (1..64); there is NO separate age-bucket
 * param and NO facets object in the response (`ListUnknownItemsResponse` is
 * `{ items, next_cursor }`, additionalProperties:false).
 *
 * Fixture: the external_pos_id pending rows (A.X, B.X) carry
 * source_system='t506-pos'; the barcode rows carry source_system=NULL.
 *
 * RED (T034): the shipped list ignores `source_system` (and `.strict()`
 * rejects it as an unknown param → 400). After T037 it filters.
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
      console.warn(`\n[T034 list-filters] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[T034 list-filters] skipping — Docker unavailable");
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

describe("T034 — list source_system filter (FR-002 / FR-006 / SC-007)", () => {
  it("?source_system=t506-pos → only rows with that source system (the external_pos_id row)", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get(
        `/api/v1/catalog/unknown-items?source_system=${UNKNOWN_ITEMS_FIXTURE_IDS.sourceSystem}`,
      )
      .expect(200);
    const body = res.body as { items: ReadonlyArray<Record<string, unknown>> };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item["source_system"]).toBe(UNKNOWN_ITEMS_FIXTURE_IDS.sourceSystem);
    }
    // tenant A's external_pos_id pending row is present
    expect(body.items.some((i) => i["id"] === UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXPos)).toBe(
      true,
    );
    // a barcode row (source_system NULL) is NOT present
    expect(
      body.items.some((i) => i["id"] === UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode),
    ).toBe(false);
  });

  it("filter is scope-safe — tenant A filtering never returns tenant B's matching row", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get(
        `/api/v1/catalog/unknown-items?source_system=${UNKNOWN_ITEMS_FIXTURE_IDS.sourceSystem}`,
      )
      .expect(200);
    const body = res.body as { items: ReadonlyArray<Record<string, unknown>> };
    // tenant B's external_pos_id row shares the same source_system but is out of scope
    expect(
      body.items.some((i) => i["id"] === UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXPos),
    ).toBe(false);
    for (const item of body.items) {
      expect(item["tenant_id"]).toBe(UNKNOWN_ITEMS_FIXTURE_IDS.tenantA);
    }
  });

  it("no source_system filter → barcode (null source) rows are included", async () => {
    if (maybeSkip()) return;
    const res = await http().get("/api/v1/catalog/unknown-items").expect(200);
    const body = res.body as { items: ReadonlyArray<Record<string, unknown>> };
    expect(
      body.items.some((i) => i["id"] === UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode),
    ).toBe(true);
  });
});
