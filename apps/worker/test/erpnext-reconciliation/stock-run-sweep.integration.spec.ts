/**
 * RT-179 — scheduled stock reconciliation run sweep on real PostgreSQL (every
 * migration applied), driven as `app_test` (NOSUPERUSER, NOBYPASSRLS) so FORCE
 * RLS applies to every statement the sweep issues.
 *
 *   AC1  one tick creates exactly one `scheduled` run per store with an active
 *        stock map; none for unmapped, returns-only, retired-map or inactive
 *        stores. Mapped runs defer to the connector (no outbox event).
 *   AC2  a second tick in the same period, or while a run is `running`,
 *        creates nothing; the next period creates again; concurrent ticks
 *        create one run per store.
 *   AC3  tenant isolation: per-tenant listings and decisions never cross
 *        tenants, and a foreign store id is refused rather than stamped.
 *   AC4  a returns-only store is unmapped everywhere: the sweep skips it, the
 *        shared creation path emits for it at once, and the run processor
 *        classes it `unmapped_store`.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1 (RT-123
 * retention-rls precedent).
 */
import { createStockReconciliationRun, runWithTenantContext } from "@data-pulse-2/db";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import {
  EMPTY_BIN_VIEW,
  ReconciliationRunProcessor,
} from "../../src/erpnext-reconciliation/reconciliation-run.processor";
import {
  STOCK_RUN_SWEEP_JOB_NAME,
  StockRunSweepProcessor,
  type StockRunSweepResult,
} from "../../src/erpnext-reconciliation/stock-run-sweep.processor";
import {
  PgStockRunSweepRepository,
  STOCK_RUN_SWEEP_ACTOR_LABEL,
  StockRunSweepStoreNotEligibleError,
} from "../../src/erpnext-reconciliation/stock-run-sweep.repository";

const TENANT_A = "0a000000-0000-7000-8000-000000179a01";
const TENANT_B = "0b000000-0000-7000-8000-000000179b01";
const TENANT_SUSPENDED = "0c000000-0000-7000-8000-000000179c01";

const A_MAPPED = "0a000000-0000-7000-8000-000000179a10";
const A_MAPPED_2 = "0a000000-0000-7000-8000-000000179a11";
const A_UNMAPPED = "0a000000-0000-7000-8000-000000179a12";
const A_RETURNS_ONLY = "0a000000-0000-7000-8000-000000179a13";
const A_RETIRED = "0a000000-0000-7000-8000-000000179a14";
const A_INACTIVE = "0a000000-0000-7000-8000-000000179a15";
const B_MAPPED = "0b000000-0000-7000-8000-000000179b10";
const SUSPENDED_MAPPED = "0c000000-0000-7000-8000-000000179c10";
const ACTOR = "0a000000-0000-7000-8000-000000179a99";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-10-04T02:00:00.000Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

let env: PgTestEnv | null = null;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[stock-run-sweep.integration] Docker NOT AVAILABLE — skipping: ${String(err)}\n`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  const a = env.admin;
  await a.query(
    `INSERT INTO tenants (id, slug, name, status) VALUES
       ($1, 'rt179-a', 'A', 'active'), ($2, 'rt179-b', 'B', 'active'),
       ($3, 'rt179-c', 'C', 'suspended')`,
    [TENANT_A, TENANT_B, TENANT_SUSPENDED],
  );
  await a.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'rt179@fixture.invalid', NULL)`,
    [ACTOR],
  );
  await a.query(
    `INSERT INTO stores (id, tenant_id, code, name, is_active) VALUES
       ($1, $9, 'M1', 'Mapped', true),
       ($2, $9, 'M2', 'Mapped 2', true),
       ($3, $9, 'UN', 'Unmapped', true),
       ($4, $9, 'RO', 'Returns only', true),
       ($5, $9, 'RT', 'Retired map', true),
       ($6, $9, 'IN', 'Inactive', false),
       ($7, $10, 'BM', 'B mapped', true),
       ($8, $11, 'CM', 'Suspended tenant', true)`,
    [
      A_MAPPED, A_MAPPED_2, A_UNMAPPED, A_RETURNS_ONLY, A_RETIRED, A_INACTIVE,
      B_MAPPED, SUSPENDED_MAPPED, TENANT_A, TENANT_B, TENANT_SUSPENDED,
    ],
  );
  await a.query(
    `INSERT INTO erpnext_warehouse_map
       (tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, retired_at) VALUES
       ($1, $2, 'stock',   'WH-A1', $8, NULL),
       ($1, $3, 'stock',   'WH-A2', $8, NULL),
       ($1, $4, 'returns', 'WH-AR', $8, NULL),
       ($1, $5, 'stock',   'WH-AT', $8, now()),
       ($1, $6, 'stock',   'WH-AI', $8, NULL),
       ($7, $9, 'stock',   'WH-B1', $8, NULL),
       ($10, $11, 'stock', 'WH-C1', $8, NULL)`,
    [
      TENANT_A, A_MAPPED, A_MAPPED_2, A_RETURNS_ONLY, A_RETIRED, A_INACTIVE,
      TENANT_B, ACTOR, B_MAPPED, TENANT_SUSPENDED, SUSPENDED_MAPPED,
    ],
  );
}, 240_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function pg(): PgTestEnv {
  if (!env) throw new Error("Docker unavailable");
  return env;
}

function sweeper(now: Date): StockRunSweepProcessor {
  return new StockRunSweepProcessor(
    new PgStockRunSweepRepository(pg().app),
    DAY,
    () => now,
    () => undefined,
  );
}

async function tick(now: Date): Promise<StockRunSweepResult> {
  return sweeper(now).process(STOCK_RUN_SWEEP_JOB_NAME, {});
}

interface RunRow {
  id: string;
  tenant_id: string;
  store_id: string;
  trigger: string;
  status: string;
  actor_user_id: string | null;
  started_at: Date;
}

async function runsFor(storeId: string): Promise<RunRow[]> {
  const r = await pg().admin.query<RunRow>(
    `SELECT id, tenant_id, store_id, trigger, status, actor_user_id, started_at
       FROM erpnext_reconciliation_run WHERE store_id = $1 ORDER BY started_at, id`,
    [storeId],
  );
  return r.rows;
}

async function completeRuns(storeId: string): Promise<void> {
  await pg().admin.query(
    `UPDATE erpnext_reconciliation_run
        SET status = 'completed', finished_at = now()
      WHERE store_id = $1 AND status = 'running'`,
    [storeId],
  );
}

const skipped = (): boolean => env === null;

describe("RT-179 AC1 — one scheduled run per stock-mapped store", () => {
  it("creates exactly one run per mapped store and none for any other store", async () => {
    if (skipped()) return;
    const result = await tick(T0);
    expect(result).toMatchObject({
      tenants: 2, // the suspended tenant is not swept
      created: 3,
      skippedRunning: 0,
      skippedPeriod: 0,
      failedTenants: 0,
    });

    for (const [store, tenant] of [
      [A_MAPPED, TENANT_A],
      [A_MAPPED_2, TENANT_A],
      [B_MAPPED, TENANT_B],
    ] as const) {
      const runs = await runsFor(store);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        tenant_id: tenant,
        trigger: "scheduled",
        status: "running",
        actor_user_id: null,
      });
      expect(runs[0]!.started_at.toISOString()).toBe(T0.toISOString());
    }
    for (const store of [A_UNMAPPED, A_RETURNS_ONLY, A_RETIRED, A_INACTIVE, SUSPENDED_MAPPED]) {
      expect(await runsFor(store)).toHaveLength(0);
    }
  });

  it("writes the run audit row with the sweep's system actor label", async () => {
    if (skipped()) return;
    const [run] = await runsFor(A_MAPPED);
    const audit = await pg().admin.query<{
      actor_user_id: string | null;
      actor_label: string | null;
      tenant_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, actor_label, tenant_id, metadata FROM audit_events
        WHERE action = 'erpnext_reconciliation.run.triggered' AND target_id = $1`,
      [run!.id],
    );
    expect(audit.rows).toEqual([
      {
        actor_user_id: null,
        actor_label: STOCK_RUN_SWEEP_ACTOR_LABEL,
        tenant_id: TENANT_A,
        metadata: { store_id: A_MAPPED },
      },
    ]);
  });

  it("defers mapped runs to the connector: no reconciliation event is emitted", async () => {
    if (skipped()) return;
    const events = await pg().admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox_events
        WHERE event_type = 'erpnext.reconciliation.requested'
          AND store_id = ANY($1::uuid[])`,
      [[A_MAPPED, A_MAPPED_2, B_MAPPED]],
    );
    expect(events.rows[0]!.n).toBe("0");
  });
});

describe("RT-179 AC2 — idempotent per store per period", () => {
  it("a second tick while the runs are running creates nothing", async () => {
    if (skipped()) return;
    const result = await tick(at(60 * 60 * 1000));
    expect(result).toMatchObject({ created: 0, skippedRunning: 3, skippedPeriod: 0 });
    expect(await runsFor(A_MAPPED)).toHaveLength(1);
  });

  it("a completed run still blocks a second scheduled run in the same period", async () => {
    if (skipped()) return;
    await completeRuns(A_MAPPED);
    const result = await tick(at(2 * 60 * 60 * 1000));
    expect(result).toMatchObject({ created: 0, skippedRunning: 2, skippedPeriod: 1 });
    expect(await runsFor(A_MAPPED)).toHaveLength(1);
  });

  it("the next period creates a new run for the free store only", async () => {
    if (skipped()) return;
    const result = await tick(at(DAY));
    expect(result).toMatchObject({ created: 1, skippedRunning: 2, skippedPeriod: 0 });
    const runs = await runsFor(A_MAPPED);
    expect(runs.map((r) => r.status)).toEqual(["completed", "running"]);
    expect(runs[1]!.trigger).toBe("scheduled");
  });

  it("an on-demand running run also blocks the sweep", async () => {
    if (skipped()) return;
    await completeRuns(A_MAPPED);
    await runWithTenantContext(pg().app, { tenantId: TENANT_A, isPlatformAdmin: false }, (c) =>
      createStockReconciliationRun(c, {
        runId: "0a000000-0000-7000-8000-000000179ad1",
        auditEventId: "0a000000-0000-7000-8000-000000179ad2",
        tenantId: TENANT_A,
        storeId: A_MAPPED,
        trigger: "on_demand",
        actorUserId: ACTOR,
        actorLabel: null,
      }),
    );
    const result = await tick(at(2 * DAY));
    expect(result.created).toBe(0);
    expect(await runsFor(A_MAPPED)).toHaveLength(3);
  });

  it("concurrent ticks create one run per store", async () => {
    if (skipped()) return;
    for (const s of [A_MAPPED, A_MAPPED_2, B_MAPPED]) await completeRuns(s);
    const now = at(3 * DAY);
    const results = await Promise.all([tick(now), tick(now), tick(now)]);
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(3);
    for (const s of [A_MAPPED, A_MAPPED_2, B_MAPPED]) {
      const running = (await runsFor(s)).filter((r) => r.status === "running");
      expect(running).toHaveLength(1);
    }
  });
});

describe("RT-179 AC3 — tenant isolation", () => {
  it("a tenant's store listing never contains another tenant's stores", async () => {
    if (skipped()) return;
    const repo = new PgStockRunSweepRepository(pg().app);
    expect(await repo.listMappedStoreIds(TENANT_A)).toEqual([A_MAPPED, A_MAPPED_2].sort());
    expect(await repo.listMappedStoreIds(TENANT_B)).toEqual([B_MAPPED]);
  });

  it("tenant A's sweep refuses tenant B's store and writes nothing", async () => {
    if (skipped()) return;
    await completeRuns(B_MAPPED);
    const before = await runsFor(B_MAPPED);
    const repo = new PgStockRunSweepRepository(pg().app);
    await expect(
      repo.sweepStore({ tenantId: TENANT_A, storeId: B_MAPPED, periodStart: at(10 * DAY), now: at(10 * DAY) }),
    ).rejects.toBeInstanceOf(StockRunSweepStoreNotEligibleError);
    expect(await runsFor(B_MAPPED)).toEqual(before);
  });

  it("tenant B's running run does not affect tenant A's decisions", async () => {
    if (skipped()) return;
    for (const s of [A_MAPPED, A_MAPPED_2]) await completeRuns(s);
    // B_MAPPED gets a running run of its own in this period.
    const now = at(4 * DAY);
    const repo = new PgStockRunSweepRepository(pg().app);
    const periodStart = new Date(Math.floor(now.getTime() / DAY) * DAY);
    expect((await repo.sweepStore({ tenantId: TENANT_B, storeId: B_MAPPED, periodStart, now })).outcome).toBe(
      "created",
    );
    const result = await tick(now);
    expect(result).toMatchObject({ created: 2, skippedRunning: 1, skippedPeriod: 0 });
  });

  it("every run is stamped with its own store's tenant", async () => {
    if (skipped()) return;
    const r = await pg().admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM erpnext_reconciliation_run run
         JOIN stores s ON s.id = run.store_id
        WHERE run.tenant_id <> s.tenant_id`,
    );
    expect(r.rows[0]!.n).toBe("0");
  });

  it("a store whose stock map was retired is refused at sweep time", async () => {
    if (skipped()) return;
    const repo = new PgStockRunSweepRepository(pg().app);
    await expect(
      repo.sweepStore({ tenantId: TENANT_A, storeId: A_RETIRED, periodStart: at(20 * DAY), now: at(20 * DAY) }),
    ).rejects.toBeInstanceOf(StockRunSweepStoreNotEligibleError);
  });
});

describe("RT-179 AC4 — a returns-only map is unmapped everywhere", () => {
  it("the shared creation path emits at once and the processor classes it unmapped_store", async () => {
    if (skipped()) return;
    const runId = "0a000000-0000-7000-8000-000000179ae1";
    const created = await runWithTenantContext(
      pg().app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      (c) =>
        createStockReconciliationRun(c, {
          runId,
          auditEventId: "0a000000-0000-7000-8000-000000179ae2",
          tenantId: TENANT_A,
          storeId: A_RETURNS_ONLY,
          trigger: "on_demand",
          actorUserId: ACTOR,
          actorLabel: null,
        }),
    );
    expect(created.emitted).toBe(true);
    const events = await pg().admin.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events
        WHERE event_type = 'erpnext.reconciliation.requested' AND store_id = $1`,
      [A_RETURNS_ONLY],
    );
    expect(events.rows).toEqual([{ payload: { run_id: runId, store_id: A_RETURNS_ONLY } }]);

    const res = await new ReconciliationRunProcessor(pg().app, EMPTY_BIN_VIEW).process({
      runId,
      tenantId: TENANT_A,
    });
    expect(res).toEqual({ runId, status: "completed", counts: { unmapped_store: 1 } });
  });

  it("a stock-mapped store's run is NOT classed unmapped_store", async () => {
    if (skipped()) return;
    const [running] = (await runsFor(A_MAPPED)).filter((r) => r.status === "running");
    const res = await new ReconciliationRunProcessor(pg().app, EMPTY_BIN_VIEW).process({
      runId: running!.id,
      tenantId: TENANT_A,
    });
    expect(res.status).toBe("completed");
    expect(res.counts["unmapped_store"]).toBeUndefined();
  });
});
