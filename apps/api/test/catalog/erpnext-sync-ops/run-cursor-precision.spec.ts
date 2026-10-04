/**
 * RT-210 — the reconciliation run-history cursor must not lose sub-millisecond
 * precision.
 *
 * `erpnext_reconciliation_run.started_at` is a microsecond `timestamptz`, but
 * node-postgres hands it back as a JS `Date` (millisecond precision). A cursor
 * built from that `Date` sits BELOW the last row's real `started_at`, so an
 * older run in the same millisecond with larger microseconds fails the keyset
 * predicate `(started_at, id) < (cursorTs, cursorId)` and is silently skipped
 * (the intermittent RT-192 `RUN_X2` miss in sync-ops-store-scope.spec.ts).
 *
 * Deterministic seed: three distinct microsecond instants in ONE millisecond
 * (one of them a two-run tie, to pin the `id DESC` tiebreak) plus one run in
 * the previous millisecond. Walking `page_size` 1, 2 and 3 must return every
 * run exactly once, in `started_at DESC, id DESC` order, and the cursor must
 * keep its contract shape (`YYYY-MM-DDTHH:mm:ss.sssZ|<uuid>`).
 *
 * Route: GET /api/v1/catalog/erpnext-sync-ops/reconciliation-runs
 * Testcontainers Postgres 16 (same harness as reconciliation-runs.spec.ts).
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
const ACTOR_A = RECONCILIATION_FIXTURE_IDS.actorA;
const STORE = RECONCILIATION_FIXTURE_IDS.storeAMapped;
const BASE = "/api/v1/catalog/erpnext-sync-ops/reconciliation-runs";

/** The server-issued cursor keeps the contract `RunCursor` shape (wire-compatible). */
const CURSOR_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[0-9a-f-]{36}$/;

// Seeded runs, in the expected `started_at DESC, id DESC` order. P1..P3 share
// the millisecond 12:00:00.123; P2_HI/P2_LO tie at the same microsecond; P4 is
// in the previous millisecond.
const P1 = "0a000000-0000-7000-8000-0000000210c1";
const P2_HI = "0a000000-0000-7000-8000-0000000210c3";
const P2_LO = "0a000000-0000-7000-8000-0000000210c2";
const P3 = "0a000000-0000-7000-8000-0000000210c4";
const P4 = "0a000000-0000-7000-8000-0000000210c5";
const SEEDED: ReadonlyArray<readonly [string, string]> = [
  [P1, "2097-03-01T12:00:00.123700Z"],
  [P2_HI, "2097-03-01T12:00:00.123400Z"],
  [P2_LO, "2097-03-01T12:00:00.123400Z"],
  [P3, "2097-03-01T12:00:00.123100Z"],
  [P4, "2097-03-01T12:00:00.122900Z"],
];
const SEEDED_ORDER = SEEDED.map(([id]) => id);

class AllStoresContextGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      context?: ResolvedContext;
      principal?: { userId?: string };
    }>();
    req.context = {
      userId: ACTOR_A,
      tenantId: TENANT_A,
      storeId: null,
      isPlatformAdmin: false,
      source: "session",
      storeAccess: { kind: "all" },
    };
    req.principal = { userId: ACTOR_A };
    return true;
  }
}

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[run-cursor-precision.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedReconciliationFixture(env);
  for (const [id, startedAt] of SEEDED) {
    // A 'completed' run carries finished_at (erpnext_reconciliation_run_finished_when_terminal).
    await env.admin.query(
      `INSERT INTO erpnext_reconciliation_run
         (id, tenant_id, store_id, kind, trigger, status, started_at, finished_at)
       VALUES ($1, $2, $3, 'stock', 'on_demand', 'completed', $4::timestamptz,
               $4::timestamptz + interval '5 minutes')`,
      [id, TENANT_A, STORE, startedAt],
    );
  }

  const localEnv = env;
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
  app.useGlobalGuards(new AllStoresContextGuard());
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

const skip = () => dockerSkipped;

/** Walk every page at `pageSize`, returning run ids in served order + every cursor seen. */
async function walk(
  pageSize: number,
  extra: Record<string, string> = {},
): Promise<{ ids: string[]; cursors: string[] }> {
  const ids: string[] = [];
  const cursors: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const q: Record<string, string> = { ...extra, page_size: String(pageSize) };
    if (cursor) q["cursor"] = cursor;
    const res = await request(app!.getHttpServer()).get(BASE).query(q).expect(200);
    for (const r of res.body.items as { runId: string }[]) ids.push(r.runId);
    cursor = res.body.nextCursor;
    if (!cursor) break;
    cursors.push(cursor);
  }
  return { ids, cursors };
}

/** Every tenant-A run in the canonical `started_at DESC, id DESC` order (superuser read). */
async function expectedTenantOrder(storeId?: string): Promise<string[]> {
  const rows = await env!.admin.query<{ id: string }>(
    `SELECT id FROM erpnext_reconciliation_run
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR store_id = $2::uuid)
      ORDER BY started_at DESC, id DESC`,
    [TENANT_A, storeId ?? null],
  );
  return rows.rows.map((r) => r.id);
}

describe("RT-210 — run-history cursor keeps sub-millisecond precision", () => {
  it("the seed really stores distinct microseconds inside one millisecond", async () => {
    if (skip()) return;
    const rows = await env!.admin.query<{ us: string }>(
      `SELECT to_char(started_at AT TIME ZONE 'UTC', 'HH24:MI:SS.US') AS us
         FROM erpnext_reconciliation_run WHERE id = ANY($1::uuid[])
        ORDER BY started_at DESC, id DESC`,
      [SEEDED_ORDER],
    );
    expect(rows.rows.map((r) => r.us)).toEqual([
      "12:00:00.123700",
      "12:00:00.123400",
      "12:00:00.123400",
      "12:00:00.123100",
      "12:00:00.122900",
    ]);
  });

  it.each([1, 2, 3])(
    "page_size=%i returns every run exactly once, in started_at DESC, id DESC order",
    async (pageSize) => {
      if (skip()) return;
      const { ids, cursors } = await walk(pageSize);
      const expected = await expectedTenantOrder();
      // The seeded runs are the newest five, in the pinned order.
      expect(expected.slice(0, SEEDED_ORDER.length)).toEqual(SEEDED_ORDER);
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(ids.length);
      for (const c of cursors) expect(c).toMatch(CURSOR_SHAPE);
    },
  );

  it.each([1, 2])("page_size=%i with a store_id filter is gap-free too", async (pageSize) => {
    if (skip()) return;
    const { ids } = await walk(pageSize, { store_id: STORE });
    expect(ids).toEqual(await expectedTenantOrder(STORE));
    expect(ids.slice(0, SEEDED_ORDER.length)).toEqual(SEEDED_ORDER);
  });
});
