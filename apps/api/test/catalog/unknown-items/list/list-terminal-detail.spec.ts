/**
 * list-terminal-detail.spec.ts  (007 — T031 RED / T032 GREEN)
 *
 * When a client filters the review queue to `dismissed` or `resolved`, each
 * in-scope terminal item carries the FR-001a / FR-008 terminal-detail field
 * set, and the linked/created product reference (`resolved_product_id`) is
 * present ONLY if the caller has authority to see that product — otherwise the
 * KEY is omitted while the item itself is still returned (006 FR-001a).
 *
 * canSeeProduct policy (007 decision, 2026-05-29): a TENANT-WIDE actor
 * (ctx.storeId === null) may see the product reference; a STORE-SCOPED actor
 * (ctx.storeId === UUID) gets it omitted (aligned with SC-007 no-cross-store-
 * leak; FR-001a's conditional is given real meaning). The item row is returned
 * in both cases.
 *
 * RED (T031): the list currently maps `rowToUnknownItemWireShape`, which always
 * includes `sale_context` AND always includes `resolved_product_id` (never
 * suppressed). These cases assert: no `sale_context`; tenant-wide sees the
 * product id; store-scoped has the KEY omitted. RED until T032 swaps to
 * `toReviewQueueItem(row, ctx.storeId === null)`.
 *
 * Fixture: T024 seeded a dismissed + a resolved barcode row per cell. The
 * resolved rows carry resolved_product_id = the tenant's PRODUCT_*_ACTIVE.
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
      console.warn(`\n[T031 list-terminal-detail] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[T031 list-terminal-detail] skipping — Docker unavailable");
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

function itemById(
  items: ReadonlyArray<Record<string, unknown>>,
  id: string,
): Record<string, unknown> | undefined {
  return items.find((i) => i["id"] === id);
}

describe("T031 — terminal detail: dismissed (FR-008 / FR-001a)", () => {
  it("?status=dismissed → terminal fields present, no sale_context", async () => {
    if (maybeSkip()) return;
    const res = await http()
      .get("/api/v1/catalog/unknown-items?status=dismissed")
      .expect(200);
    const body = res.body as { items: ReadonlyArray<Record<string, unknown>> };
    const row = itemById(body.items, UNKNOWN_ITEMS_FIXTURE_IDS.dismissedAX);
    expect(row).toBeDefined();
    if (!row) return;
    expect(Object.prototype.hasOwnProperty.call(row, "sale_context")).toBe(false);
    expect(row["resolution_status"]).toBe("dismissed");
    expect(row["resolution_action"]).toBe("dismissed");
    expect(typeof row["resolved_at"]).toBe("string");
    expect(typeof row["resolved_by"]).toBe("string");
  });
});

describe("T031 — terminal detail: resolved + FR-001a product-reference conditioning", () => {
  it("tenant-wide actor, ?status=resolved → resolved_product_id PRESENT (canSeeProduct)", async () => {
    if (maybeSkip()) return;
    // contextGuard.storeId === null (tenant-wide) per beforeEach
    const res = await http()
      .get("/api/v1/catalog/unknown-items?status=resolved")
      .expect(200);
    const body = res.body as { items: ReadonlyArray<Record<string, unknown>> };
    const row = itemById(body.items, UNKNOWN_ITEMS_FIXTURE_IDS.resolvedAX);
    expect(row).toBeDefined();
    if (!row) return;
    expect(Object.prototype.hasOwnProperty.call(row, "sale_context")).toBe(false);
    expect(row["resolution_status"]).toBe("resolved");
    expect(row["resolution_action"]).toBe("linked");
    expect(
      Object.prototype.hasOwnProperty.call(row, "resolved_product_id"),
    ).toBe(true);
    expect(row["resolved_product_id"]).toBe(
      UNKNOWN_ITEMS_FIXTURE_IDS.resolvedProductA,
    );
  });

  it("store-scoped actor, ?status=resolved → resolved_product_id KEY OMITTED, item still returned (FR-001a)", async () => {
    if (maybeSkip()) return;
    if (contextGuard) contextGuard.storeId = UNKNOWN_ITEMS_FIXTURE_IDS.storeAX;
    const res = await http()
      .get("/api/v1/catalog/unknown-items?status=resolved")
      .expect(200);
    const body = res.body as { items: ReadonlyArray<Record<string, unknown>> };
    const row = itemById(body.items, UNKNOWN_ITEMS_FIXTURE_IDS.resolvedAX);
    // the resolved A.X row is in the store-A-X scope, so it IS returned …
    expect(row).toBeDefined();
    if (!row) return;
    // … but the product reference is suppressed for the store-scoped actor.
    expect(
      Object.prototype.hasOwnProperty.call(row, "resolved_product_id"),
    ).toBe(false);
    expect(row["resolution_status"]).toBe("resolved");
    expect(Object.prototype.hasOwnProperty.call(row, "sale_context")).toBe(false);
  });
});
