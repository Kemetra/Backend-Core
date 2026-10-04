/**
 * 025-US3 — the console reconciliation run-history.
 *
 * Exercises `consoleListReconciliationRuns` end-to-end against Testcontainers
 * Postgres 16 (same harness; reuses the 017 seedReconciliationFixture, which
 * seeds RUN_A for tenant A + RUN_B for tenant B). Read-projection over 017
 * erpnext_reconciliation_run, newest-first.
 *
 * Route: GET /api/v1/catalog/erpnext-sync-ops/reconciliation-runs
 *
 * Sub-cases (T022/T023/T024):
 *   §1 newest-first ordering + projection (runId/status/trigger/timestamps/mismatchSummary).
 *   §2 tenant isolation — tenant B's run never appears for tenant A.
 *   §3 §XII strict DTO — smuggled tenant_id → 400.
 *   §4 composite-cursor paging across same-timestamp ties.
 *   §5 RT-180 — an out-of-range cursor timestamp is a 400, never a 500; a
 *      server-issued cursor still pages; the Postgres datetime errors the cast
 *      raises are classified as input errors (the 400 backstop).
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
import { isPostgresInputError } from "../../../src/common/postgres-input-error";
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
  RUN_A,
  RUN_B,
  seedReconciliationFixture,
} from "../erpnext-reconciliation/__support__/seed-reconciliation";

const TENANT_A = RECONCILIATION_FIXTURE_IDS.tenantA;
const TENANT_B = RECONCILIATION_FIXTURE_IDS.tenantB;
const ACTOR_A = RECONCILIATION_FIXTURE_IDS.actorA;
const BASE = "/api/v1/catalog/erpnext-sync-ops/reconciliation-runs";
/** RT-192: a tenant-A session with tenant-wide store access (an 'all' membership). */
const ALL_STORES_CTX: ResolvedContext = {
  userId: ACTOR_A,
  tenantId: TENANT_A,
  storeId: null,
  isPlatformAdmin: false,
  source: "session",
  storeAccess: { kind: "all" },
};

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
      console.warn(`\n[reconciliation-runs.spec] Docker NOT AVAILABLE: ${msg}\n`);
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

interface RunView {
  runId: string;
  storeId: string;
  kind: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  mismatchSummary: Record<string, number> | null;
}

describe("025-US3 §1 — run-history projection, newest-first", () => {
  it("returns tenant-A run(s) with the projected fields", async () => {
    if (skip()) return;
    const res = await http().get(BASE).expect(200);
    const items: RunView[] = res.body.items;
    const run = items.find((r) => r.runId === RUN_A);
    expect(run).toBeDefined();
    expect(run!.kind).toBe("stock");
    expect(["on_demand", "scheduled"]).toContain(run!.trigger);
    expect(["running", "completed", "failed"]).toContain(run!.status);
    expect(run!.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("orders newest-first (startedAt descending)", async () => {
    if (skip()) return;
    const items: RunView[] = (await http().get(BASE).expect(200)).body.items;
    const times = items.map((r) => Date.parse(r.startedAt));
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);
  });
});

describe("025-US3 §2 — tenant isolation", () => {
  it("tenant A never sees tenant B's run; tenant B sees its own", async () => {
    if (skip()) return;
    const a = (await http().get(BASE).expect(200)).body.items as RunView[];
    expect(a.map((r) => r.runId)).not.toContain(RUN_B);
    contextGuard.tenantId = TENANT_B;
    const b = (await http().get(BASE).expect(200)).body.items as RunView[];
    expect(b.map((r) => r.runId)).toContain(RUN_B);
    expect(b.map((r) => r.runId)).not.toContain(RUN_A);
  });
});

describe("025-US3 §3 — §XII strict DTO", () => {
  it("a smuggled tenant_id → 400", async () => {
    if (skip()) return;
    await http().get(BASE).query({ tenant_id: TENANT_B }).expect(400);
  });
});

describe("025-US3 §4 — pagination is stable + gap-free across same-timestamp ties", () => {
  it("two runs with the SAME started_at both appear across pages (composite cursor)", async () => {
    if (skip()) return;
    // started_at is not unique. Seed two tenant-A runs at the SAME instant; a
    // timestamp-only cursor would drop one at the page boundary. The composite
    // (started_at, id) cursor must surface BOTH across page_size=1 paging.
    const TIE_1 = "0a000000-0000-7000-8000-00000e0517f1";
    const TIE_2 = "0a000000-0000-7000-8000-00000e0517f2";
    const TIE_STORE = RECONCILIATION_FIXTURE_IDS.storeAMapped;
    // A 'completed' run MUST carry finished_at (the schema CHECK
    // erpnext_reconciliation_run_finished_when_terminal: running iff finished_at NULL).
    await env!.admin.query(
      `INSERT INTO erpnext_reconciliation_run
         (id, tenant_id, store_id, kind, trigger, status, started_at, finished_at)
       VALUES
         ($1, $3, $4, 'stock', 'on_demand', 'completed', '2099-01-01T00:00:00Z', '2099-01-01T00:05:00Z'),
         ($2, $3, $4, 'stock', 'on_demand', 'completed', '2099-01-01T00:00:00Z', '2099-01-01T00:05:00Z')
       ON CONFLICT DO NOTHING`,
      [TIE_1, TIE_2, TENANT_A, TIE_STORE],
    );

    const seen = new Set<string>();
    let cursor: string | null = null;
    // Page through with page_size=1; bounded loop guard.
    for (let i = 0; i < 10; i++) {
      const q: Record<string, string> = { page_size: "1" };
      if (cursor) q["cursor"] = cursor;
      const res = await http().get(BASE).query(q).expect(200);
      for (const r of res.body.items as { runId: string }[]) seen.add(r.runId);
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    // Both tie rows must have been surfaced — neither dropped at the boundary.
    expect(seen.has(TIE_1)).toBe(true);
    expect(seen.has(TIE_2)).toBe(true);
  });
});

describe("RT-180 §5 — run cursor timestamp must be a real instant", () => {
  const RUN_ID = "0a000000-0000-7000-8000-00000e0517f1";

  it.each([`2000-02-30T00:00:00Z|${RUN_ID}`, `0000-00-00T0Z|${RUN_ID}`])(
    "cursor %s → 400 validation_error (was 500)",
    async (cursor) => {
      if (skip()) return;
      const res = await http().get(BASE).query({ cursor }).expect(400);
      expect(res.body.error.code).toBe("validation_error");
    },
  );

  it("a server-issued nextCursor is accepted and pages to older runs", async () => {
    if (skip()) return;
    // Two tenant-A runs at distinct instants so a page_size=1 walk has a second page.
    await env!.admin.query(
      `INSERT INTO erpnext_reconciliation_run
         (id, tenant_id, store_id, kind, trigger, status, started_at, finished_at)
       VALUES
         ($1, $3, $4, 'stock', 'on_demand', 'completed', '2098-06-01T10:00:00.123Z', '2098-06-01T10:05:00Z'),
         ($2, $3, $4, 'stock', 'on_demand', 'completed', '2098-06-01T09:00:00.456Z', '2098-06-01T09:05:00Z')
       ON CONFLICT DO NOTHING`,
      [
        "0a000000-0000-7000-8000-0000000180a1",
        "0a000000-0000-7000-8000-0000000180a2",
        TENANT_A,
        RECONCILIATION_FIXTURE_IDS.storeAMapped,
      ],
    );
    const first = await http().get(BASE).query({ page_size: "1" }).expect(200);
    const cursor: string | null = first.body.nextCursor;
    expect(cursor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|/);
    const second = await http().get(BASE).query({ page_size: "1", cursor }).expect(200);
    expect(second.body.items).toHaveLength(1);
    const [newer] = first.body.items as RunView[];
    const [older] = second.body.items as RunView[];
    expect(older!.runId).not.toBe(newer!.runId);
    expect(Date.parse(older!.startedAt)).toBeLessThanOrEqual(Date.parse(newer!.startedAt));
  });

  it.each([`2000-02-30T00:00:00.000Z|${RUN_ID}`, `0000-00-00T0Z|${RUN_ID}`])(
    "backstop: if %s reached the timestamptz cast, Postgres raises an input error (→ 400)",
    async (cursor) => {
      if (skip()) return;
      // Bypass the DTO and hand the token straight to the read model, as a
      // future caller without the DTO check would.
      const service = app!.get(ErpnextSyncOpsReadModelService);
      const err: unknown = await service
        .listReconciliationRuns({ tenantId: TENANT_A, context: ALL_STORES_CTX, cursor, limit: 1 })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).not.toBeNull();
      expect(["22007", "22008"]).toContain((err as { code?: unknown }).code);
      expect(isPostgresInputError(err)).toBe(true);
    },
  );
});
