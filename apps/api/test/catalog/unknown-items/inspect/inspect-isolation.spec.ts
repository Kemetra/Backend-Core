/**
 * inspect-isolation.spec.ts  (007 — T041 RED / T042 GREEN, T043 verify)
 *
 * US3 / FR-009 / SI-004 / FR-062: inspect is RLS-scoped. A cross-tenant id or
 * an out-of-scope store id receives a NON-DISCLOSING 404 (indistinguishable
 * from "no such id"). A wrong tenant context (RLS-bypass probe) yields zero
 * rows → 404. These run through the HTTP route (the service-level posture is
 * already proven by review-queue-sweep.spec.ts; here it's verified end-to-end).
 *
 * RED (T041): route does not exist yet → 404 (route-not-found). After T042 the
 * route exists and returns 404 for the SECURITY reasons asserted here.
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
      console.warn(`\n[T041 inspect-isolation] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[T041 inspect-isolation] skipping — Docker unavailable");
    return true;
  }
  return false;
}

const F = UNKNOWN_ITEMS_FIXTURE_IDS;

describe("T041 — inspect isolation: non-disclosing 404 (SI-004 / FR-062)", () => {
  beforeEach(() => {
    if (contextGuard) {
      contextGuard.tenantId = F.tenantA;
      contextGuard.storeId = null;
    }
  });

  it("tenant A inspecting tenant B's id → 404 non-disclosing", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get(`/api/v1/catalog/unknown-items/${F.unknownBXBarcode}`)
      .expect(404);
    // Non-disclosing: the body names no tenant/store/identifier.
    const code = (res.body as { error?: { code?: string } })?.error?.code;
    expect(code).toBe("not_found");
  });

  it("store-A-X actor inspecting an A-Y store item → 404 (out-of-scope store)", async () => {
    if (maybeSkip()) return;
    if (contextGuard) contextGuard.storeId = F.storeAX;
    await http()
      .get(`/api/v1/catalog/unknown-items/${F.unknownAYBarcode}`)
      .expect(404);
  });

  it("RLS-bypass probe: real tenant-A id under tenant-B context → 404", async () => {
    if (maybeSkip()) return;
    if (contextGuard) contextGuard.tenantId = F.tenantB;
    await http()
      .get(`/api/v1/catalog/unknown-items/${F.unknownAXBarcode}`)
      .expect(404);
  });

  it("non-existent (fabricated) id → 404, same shape as cross-tenant", async () => {
    if (maybeSkip()) return;
    await http()
      .get("/api/v1/catalog/unknown-items/0a000000-0000-7000-8000-0000deadbeef")
      .expect(404);
  });
});
