/**
 * 025-US1 🎯 MVP — the consolidated sync-ops summary.
 *
 * Exercises `consoleGetSyncOpsSummary` end-to-end against Testcontainers
 * Postgres 16, mirroring the 017 posting-backlog harness (ConfigurableContextGuard
 * + overridden production guards + RLS-active PG_POOL bound to env.app). The
 * summary is a LIVE compute-on-read projection over 015 erpnext_posting_status +
 * 017 erpnext_reconciliation_run/_result (READ-NOT-MIRROR) — 025 stores nothing.
 *
 * Reuses the 017 `seedReconciliationFixture` (it seeds, across two tenants, the
 * same 015 posting rows + 017 runs/results 025 reads).
 *
 * Route: GET /api/v1/catalog/erpnext-sync-ops/summary
 *
 * Sub-cases (T009/T010/T011):
 *   §1 the summary aggregates posting-health (015) + reconciliation-health (017),
 *      with 020 connector_health + 021 product_master = not_available (FR-004).
 *   §2 empty-tenant zeroed case (no rows → ok / zero counts; deferred still N/A).
 *   §3 tenant isolation — tenant B's state never bleeds into tenant A's summary.
 *   §4 §XII strict DTO — a smuggled tenant_id query key → 400.
 *   §5 auth: the route is guarded (DashboardAuthGuard + RolesGuard); a machine
 *      credential is rejected (unit-level guard wiring asserted separately).
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

import { DashboardAuthGuard } from "../../../src/auth/dashboard-auth.guard";
import { PG_POOL } from "../../../src/auth/auth.module";
import { RolesGuard } from "../../../src/auth/roles.guard";
import { GlobalExceptionFilter } from "../../../src/common/exception.filter";
import { MembershipRepository } from "../../../src/context/membership.repository";
import { TenantContextGuard } from "../../../src/context/tenant-context.guard";
import type { ResolvedContext } from "../../../src/context/types";
import { ErpnextSyncOpsController } from "../../../src/catalog/erpnext-sync-ops/erpnext-sync-ops.controller";
import { ErpnextSyncOpsReadModelService } from "../../../src/catalog/erpnext-sync-ops/erpnext-sync-ops.read-model.service";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import {
  RECONCILIATION_FIXTURE_IDS,
  seedReconciliationFixture,
} from "../erpnext-reconciliation/__support__/seed-reconciliation";

const TENANT_A = RECONCILIATION_FIXTURE_IDS.tenantA;
const TENANT_B = RECONCILIATION_FIXTURE_IDS.tenantB;
const ACTOR_A = RECONCILIATION_FIXTURE_IDS.actorA;
// A tenant with no seeded sync-ops state (the empty-tenant zeroed case).
const TENANT_EMPTY = "0c000000-0000-7000-8000-00000e0517c0";
const BASE = "/api/v1/catalog/erpnext-sync-ops/summary";

class ConfigurableContextGuard implements CanActivate {
  public tenantId: string = TENANT_A;
  public storeId: string | null = null;
  public userId: string = ACTOR_A;
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
      // RT-192: the reads are bound to the membership store scope; this is what
      // TenantContextGuard resolves for an 'all' membership.
      storeAccess: { kind: "all" },
    };
    req.principal = { userId: this.userId };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let contextGuard: ConfigurableContextGuard;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[sync-ops-summary.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedReconciliationFixture(env);

  const localEnv = env;
  contextGuard = new ConfigurableContextGuard();

  const moduleRef = await Test.createTestingModule({
    controllers: [ErpnextSyncOpsController],
    providers: [
      { provide: PG_POOL, useFactory: (): Pool => localEnv.app },
      ErpnextSyncOpsReadModelService,
      { provide: MembershipRepository, useFactory: (): MembershipRepository => new MembershipRepository(localEnv.app) },
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
  app.useGlobalGuards(contextGuard);
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => {
  if (dockerSkipped) return;
  contextGuard.tenantId = TENANT_A;
  contextGuard.storeId = null;
  contextGuard.userId = ACTOR_A;
});

const http = () => request(app!.getHttpServer());
const skip = () => dockerSkipped;

interface DomainSummary {
  domain: string;
  status: string;
  headlineCount: number | null;
  detail: string | null;
}
const byDomain = (body: { domains: DomainSummary[] }) =>
  Object.fromEntries(body.domains.map((d) => [d.domain, d]));

describe("025-US1 §1 — consolidated summary aggregates posting + reconciliation", () => {
  it("returns one DomainSummary per domain; posting + reconciliation populated", async () => {
    if (skip()) return;
    const res = await http().get(BASE).expect(200);
    const d = byDomain(res.body);
    expect(Object.keys(d).sort()).toEqual(
      ["connector_health", "posting", "product_master", "reconciliation"].sort(),
    );
    // Tenant A has a permanently_rejected posting (POSTING_DEADLETTER_A) → posting
    // domain reports a non-null headline count >= 1.
    expect(d["posting"]!.status).toBe("attention");
    expect(d["posting"]!.headlineCount).toBeGreaterThanOrEqual(1);
    // Tenant A has a reconciliation run (RUN_A) with an open result → reconciliation
    // reports attention with the open-mismatch count.
    expect(["ok", "attention"]).toContain(d["reconciliation"]!.status);
    expect(typeof d["reconciliation"]!.headlineCount).toBe("number");
  });

  it("reports 020 connector_health + 021 product_master as not_available (FR-004)", async () => {
    if (skip()) return;
    const res = await http().get(BASE).expect(200);
    const d = byDomain(res.body);
    expect(d["connector_health"]!.status).toBe("not_available");
    expect(d["connector_health"]!.headlineCount).toBeNull();
    expect(d["product_master"]!.status).toBe("not_available");
    expect(d["product_master"]!.headlineCount).toBeNull();
  });
});

describe("025-US1 §2 — empty tenant is zeroed (not errored)", () => {
  it("a tenant with no sync-ops state returns ok/zero domains, deferred still N/A", async () => {
    if (skip()) return;
    contextGuard.tenantId = TENANT_EMPTY;
    const res = await http().get(BASE).expect(200);
    const d = byDomain(res.body);
    expect(d["posting"]!.status).toBe("ok");
    expect(d["posting"]!.headlineCount).toBe(0);
    expect(d["reconciliation"]!.headlineCount).toBe(0);
    expect(d["connector_health"]!.status).toBe("not_available");
  });
});

describe("025-US1 §3 — tenant isolation (RLS actually in effect)", () => {
  it("tenant A sees its own dead-letter count; the EMPTY tenant control sees 0", async () => {
    if (skip()) return;
    // Tenant A has the seeded POSTING_DEADLETTER_A → posting count >= 1.
    const a = byDomain((await http().get(BASE).expect(200)).body);
    expect(a["posting"]!.headlineCount).toBeGreaterThanOrEqual(1);
    // The EMPTY tenant is the control: if RLS were disabled it would see A's rows
    // (count >= 1); proving it sees 0 proves the per-tenant GUC filter is active.
    contextGuard.tenantId = TENANT_EMPTY;
    const empty = byDomain((await http().get(BASE).expect(200)).body);
    expect(empty["posting"]!.headlineCount).toBe(0);
    expect(empty["reconciliation"]!.headlineCount).toBe(0);
  });
});

describe("025-US1 §5 — reconciliation status rollup (failed run → attention)", () => {
  it("a failed latest run yields attention even with zero open mismatches", async () => {
    if (skip()) return;
    // Seed (under TENANT_A, on a NEW dedicated store) a FAILED run with NO results
    // → query the summary FILTERED to that store, so posting + open-mismatch counts
    // are both 0 for the store, but the latest run is 'failed'. The rollup must be
    // 'attention' (a failed run still needs operator eyes), NOT 'ok'. Fails against
    // a count-only rollup. (Also exercises the store-filtered path.)
    const FAILED_RUN = "0a000000-0000-7000-8000-00000e0517cf";
    const FAIL_STORE = "0a000000-0000-7000-8000-00000e0517ce";
    await env!.admin.query(
      `INSERT INTO stores (id, tenant_id, code, name)
       VALUES ($1, $2, 'FAIL1', 'Fail Store') ON CONFLICT DO NOTHING`,
      [FAIL_STORE, TENANT_A],
    );
    await env!.admin.query(
      `INSERT INTO erpnext_reconciliation_run
         (id, tenant_id, store_id, kind, trigger, status, started_at, finished_at)
       VALUES ($1, $2, $3, 'stock', 'on_demand', 'failed', now(), now())
       ON CONFLICT DO NOTHING`,
      [FAILED_RUN, TENANT_A, FAIL_STORE],
    );
    const d = byDomain(
      (await http().get(BASE).query({ store_id: FAIL_STORE }).expect(200)).body,
    );
    expect(d["posting"]!.headlineCount).toBe(0);
    expect(d["reconciliation"]!.headlineCount).toBe(0);
    expect(d["reconciliation"]!.status).toBe("attention");
  });
});

describe("025-US1 §4 — §XII strict DTO", () => {
  it("a smuggled tenant_id query key → 400 (strict)", async () => {
    if (skip()) return;
    await http().get(BASE).query({ tenant_id: TENANT_B }).expect(400);
  });

  it("a well-formed but out-of-scope store_id → non-disclosing 404 (FR-009/SC-002)", async () => {
    if (skip()) return;
    // A valid UUID that is NOT a store in tenant A's scope must be 404, not an
    // empty 200 (the contract's stated non-disclosing behaviour).
    await http()
      .get(BASE)
      .query({ store_id: "0d000000-0000-7000-8000-00000e0517dd" })
      .expect(404);
  });

  it("a non-uuid store_id → 400", async () => {
    if (skip()) return;
    await http().get(BASE).query({ store_id: "not-a-uuid" }).expect(400);
  });
});
