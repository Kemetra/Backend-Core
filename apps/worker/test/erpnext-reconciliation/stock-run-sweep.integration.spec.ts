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
 *   RT-688  run expiry (RT-187 D5): a stock run still `running` 2 h after
 *        `started_at` without a complete Bin report moves to `failed` with
 *        `summary.failure` and an audit row; a run with a complete report is
 *        never expired, only counted as stranded; the pass is tenant-scoped.
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
  StockRunSweepIncompleteError,
  StockRunSweepProcessor,
  type StockRunSweepResult,
} from "../../src/erpnext-reconciliation/stock-run-sweep.processor";
import { sweepPeriod } from "../../src/erpnext-reconciliation/stock-run-sweep.config";
import {
  PgStockRunSweepRepository,
  STOCK_RUN_EXPIRY_ACTOR_LABEL,
  STOCK_RUN_SWEEP_ACTOR_LABEL,
  STOCK_RUN_TTL_MS,
  type StockRunSweepRepository,
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

  it("the next period creates a new run for the free store, and replaces the abandoned ones", async () => {
    if (skipped()) return;
    const result = await tick(at(DAY));
    // RT-688: the two runs still running since T0 never got a Bin report, so
    // the tick expires them (24 h > the 2 h TTL) and the stores get new runs.
    expect(result).toMatchObject({ created: 3, skippedRunning: 0, skippedPeriod: 0, expired: 2 });
    const runs = await runsFor(A_MAPPED);
    expect(runs.map((r) => r.status)).toEqual(["completed", "running"]);
    expect(runs[1]!.trigger).toBe("scheduled");
    expect((await runsFor(A_MAPPED_2)).map((r) => r.status)).toEqual(["failed", "running"]);
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
    // A_MAPPED is skipped (its on-demand run is running and within the TTL);
    // the other two stores' runs from the previous day are expired and replaced.
    expect(result).toMatchObject({ created: 2, skippedRunning: 1, expired: 2 });
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
    const swept = await repo.sweepStore({
      target: { tenantId: TENANT_A, storeId: B_MAPPED },
      period: sweepPeriod(at(10 * DAY), DAY),
    });
    expect(swept).toEqual({ outcome: "skipped_ineligible", runId: null });
    expect(await runsFor(B_MAPPED)).toEqual(before);
  });

  it("tenant B's running run does not affect tenant A's decisions", async () => {
    if (skipped()) return;
    for (const s of [A_MAPPED, A_MAPPED_2]) await completeRuns(s);
    // B_MAPPED gets a running run of its own in this period.
    const now = at(4 * DAY);
    const repo = new PgStockRunSweepRepository(pg().app);
    const swept = await repo.sweepStore({
      target: { tenantId: TENANT_B, storeId: B_MAPPED },
      period: sweepPeriod(now, DAY),
    });
    expect(swept.outcome).toBe("created");
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

  it("a store whose stock map was retired is skipped as ineligible at sweep time", async () => {
    if (skipped()) return;
    const repo = new PgStockRunSweepRepository(pg().app);
    const swept = await repo.sweepStore({
      target: { tenantId: TENANT_A, storeId: A_RETIRED },
      period: sweepPeriod(at(20 * DAY), DAY),
    });
    expect(swept).toEqual({ outcome: "skipped_ineligible", runId: null });
    expect(await runsFor(A_RETIRED)).toHaveLength(0);
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

describe("RT-179 retry of an incomplete sweep", () => {
  it("a retry creates only the runs the failed attempt missed, even across the period boundary", async () => {
    if (skipped()) return;
    for (const s of [A_MAPPED, A_MAPPED_2, B_MAPPED]) await completeRuns(s);
    const real = new PgStockRunSweepRepository(pg().app);
    let failB = true;
    const flaky: StockRunSweepRepository = {
      listActiveTenantIds: () => real.listActiveTenantIds(),
      listMappedStoreIds: async (tenantId) => {
        if (tenantId === TENANT_B && failB) throw new Error("transient");
        return real.listMappedStoreIds(tenantId);
      },
      sweepStore: (input) => real.sweepStore(input),
      expireStaleRuns: (t, now) => real.expireStaleRuns(t, now),
    };
    const attemptAt = (now: Date): Promise<StockRunSweepResult> =>
      new StockRunSweepProcessor(flaky, DAY, () => now, () => undefined).process(
        STOCK_RUN_SWEEP_JOB_NAME,
        {},
      );

    // First attempt, 1 s before the period ends: tenant B fails, A is swept.
    const lastSecond = at(31 * DAY - 2 * 60 * 60 * 1000 - 1000);
    await expect(attemptAt(lastSecond)).rejects.toBeInstanceOf(StockRunSweepIncompleteError);

    // The BullMQ retry lands 15 s later, in the NEXT period. A's stores are
    // still running, so only B gets its run, once.
    failB = false;
    const retry = await attemptAt(new Date(lastSecond.getTime() + 15_000));
    expect(retry).toMatchObject({ created: 1, skippedRunning: 2, failedTenants: 0 });

    // The next period's own tick then creates nothing more for anyone.
    const tickResult = await attemptAt(new Date(lastSecond.getTime() + 60_000));
    expect(tickResult).toMatchObject({ created: 0, skippedRunning: 3 });
    for (const s of [A_MAPPED, A_MAPPED_2, B_MAPPED]) {
      expect((await runsFor(s)).filter((r) => r.status === "running")).toHaveLength(1);
    }
  });
});

describe("RT-179 eligibility is atomic with run creation", () => {
  const TENANT_D = "0d000000-0000-7000-8000-000000179d01";
  const D_MAPPED = "0d000000-0000-7000-8000-000000179d10";
  const A_RACE = "0a000000-0000-7000-8000-000000179a20";

  beforeAll(async () => {
    if (!env) return;
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name, status) VALUES ($1, 'rt179-d', 'D', 'active')`,
      [TENANT_D],
    );
    await env.admin.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'DM', 'D mapped'), ($3, $4, 'AR', 'A race')`,
      [D_MAPPED, TENANT_D, A_RACE, TENANT_A],
    );
    await env.admin.query(
      `INSERT INTO erpnext_warehouse_map (tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by)
       VALUES ($1, $2, 'stock', 'WH-D1', $5), ($3, $4, 'stock', 'WH-AR', $5)`,
      [TENANT_D, D_MAPPED, TENANT_A, A_RACE, ACTOR],
    );
  });

  async function eventsFor(storeId: string): Promise<number> {
    const r = await pg().admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox_events WHERE store_id = $1`,
      [storeId],
    );
    return Number(r.rows[0]!.n);
  }

  async function setTenantStatus(status: "active" | "suspended"): Promise<void> {
    await pg().admin.query(`UPDATE tenants SET status = $2 WHERE id = $1`, [TENANT_D, status]);
  }

  async function setRaceMapRetired(retired: boolean): Promise<void> {
    await pg().admin.query(
      `UPDATE erpnext_warehouse_map
          SET retired_at = CASE WHEN $2::boolean THEN now() ELSE NULL END
        WHERE store_id = $1`,
      [A_RACE, retired],
    );
  }

  /**
   * A repository whose sweepStore first runs `between` (after the listing).
   * The sweep is limited to TENANT_D so other tenants' stores stay untouched.
   */
  function interleaved(
    between: (target: { storeId: string }) => Promise<void>,
  ): StockRunSweepRepository {
    const real = new PgStockRunSweepRepository(pg().app);
    return {
      listActiveTenantIds: async () =>
        (await real.listActiveTenantIds()).filter((t) => t === TENANT_D),
      listMappedStoreIds: (tenantId) => real.listMappedStoreIds(tenantId),
      sweepStore: async (input) => {
        await between(input.target);
        return real.sweepStore(input);
      },
      expireStaleRuns: (tenantId, now) => real.expireStaleRuns(tenantId, now),
    };
  }

  it("a tenant suspended between listing and creation gets no run and no event", async () => {
    if (skipped()) return;
    const repo = interleaved(async ({ storeId }) => {
      if (storeId === D_MAPPED) await setTenantStatus("suspended");
    });
    const result = await new StockRunSweepProcessor(
      repo,
      DAY,
      () => at(40 * DAY),
      () => undefined,
    ).process(STOCK_RUN_SWEEP_JOB_NAME, {});
    expect(result.skippedIneligible).toBe(1);
    expect(result.failedTenants).toBe(0);
    expect(await runsFor(D_MAPPED)).toHaveLength(0);
    expect(await eventsFor(D_MAPPED)).toBe(0);
  });

  it("a stock map retired between listing and creation gets no run and no event", async () => {
    if (skipped()) return;
    const real = new PgStockRunSweepRepository(pg().app);
    expect(await real.listMappedStoreIds(TENANT_A)).toContain(A_RACE);
    const repo = interleaved(async ({ storeId }) => {
      if (storeId === A_RACE) await setRaceMapRetired(true);
    });
    const swept = await repo.sweepStore({
      target: { tenantId: TENANT_A, storeId: A_RACE },
      period: sweepPeriod(at(41 * DAY), DAY),
    });
    expect(swept).toEqual({ outcome: "skipped_ineligible", runId: null });
    expect(await runsFor(A_RACE)).toHaveLength(0);
    expect(await eventsFor(A_RACE)).toBe(0);
  });

  it("a retirement in flight on another connection is waited for, then honoured", async () => {
    if (skipped()) return;
    await setRaceMapRetired(false);
    const other = await pg().admin.connect();
    try {
      await other.query("BEGIN");
      await other.query(
        `UPDATE erpnext_warehouse_map SET retired_at = now() WHERE store_id = $1`,
        [A_RACE],
      );
      // The sweep's FOR SHARE blocks on the uncommitted retirement...
      const pending = new PgStockRunSweepRepository(pg().app).sweepStore({
        target: { tenantId: TENANT_A, storeId: A_RACE },
        period: sweepPeriod(at(42 * DAY), DAY),
      });
      await new Promise((r) => setTimeout(r, 500));
      await other.query("COMMIT");
      // ...then re-reads the committed row and skips the store.
      expect(await pending).toEqual({ outcome: "skipped_ineligible", runId: null });
    } finally {
      other.release();
    }
    expect(await runsFor(A_RACE)).toHaveLength(0);
    expect(await eventsFor(A_RACE)).toBe(0);
  });

  it("a suspension in flight waits for an open sweep transaction holding the lock", async () => {
    if (skipped()) return;
    await setTenantStatus("active");
    // Reproduce the sweep's eligibility lock on its own connection (app role,
    // tenant GUC) and keep the transaction open.
    const sweepConn = await pg().app.connect();
    let suspended = false;
    try {
      await sweepConn.query("BEGIN");
      await sweepConn.query("SELECT set_config('app.current_tenant', $1, true)", [TENANT_D]);
      await sweepConn.query("SELECT set_config('app.is_platform_admin', 'false', true)");
      const locked = await sweepConn.query(
        `SELECT s.id FROM stores s JOIN tenants t ON t.id = s.tenant_id
          WHERE s.id = $1 AND t.status = 'active' FOR SHARE OF t, s`,
        [D_MAPPED],
      );
      expect(locked.rows).toHaveLength(1);
      const suspension = setTenantStatus("suspended").then(() => {
        suspended = true;
      });
      await new Promise((r) => setTimeout(r, 500));
      expect(suspended).toBe(false); // blocked by the sweep's row lock
      await sweepConn.query("COMMIT");
      await suspension;
      expect(suspended).toBe(true);
    } finally {
      sweepConn.release();
    }
  });
});

describe("RT-179 one scheduled run per UTC day, whatever the processing delay", () => {
  const TENANT_E = "0e000000-0000-7000-8000-000000179e01";
  const E_MAPPED = "0e000000-0000-7000-8000-000000179e10";
  const DAY0 = Date.parse("2026-12-01T00:00:00.000Z");

  beforeAll(async () => {
    if (!env) return;
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name, status) VALUES ($1, 'rt179-e', 'E', 'active')`,
      [TENANT_E],
    );
    await env.admin.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'EM', 'E mapped')`,
      [E_MAPPED, TENANT_E],
    );
    await env.admin.query(
      `INSERT INTO erpnext_warehouse_map (tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by)
       VALUES ($1, $2, 'stock', 'WH-E1', $3)`,
      [TENANT_E, E_MAPPED, ACTOR],
    );
  });

  /** Sweeps tenant E only, with a given processing clock. */
  function sweeperE(clockMs: number): StockRunSweepProcessor {
    const real = new PgStockRunSweepRepository(pg().app);
    const onlyE: StockRunSweepRepository = {
      listActiveTenantIds: async () =>
        (await real.listActiveTenantIds()).filter((t) => t === TENANT_E),
      listMappedStoreIds: (t) => real.listMappedStoreIds(t),
      sweepStore: (input) => real.sweepStore(input),
      expireStaleRuns: (t, now) => real.expireStaleRuns(t, now),
    };
    return new StockRunSweepProcessor(onlyE, DAY, () => new Date(clockMs), () => undefined);
  }

  async function runsPerUtcDay(): Promise<Record<string, number>> {
    const r = await pg().admin.query<{ day: string; n: string }>(
      `SELECT to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::text AS n
         FROM erpnext_reconciliation_run
        WHERE store_id = $1 AND trigger = 'scheduled'
        GROUP BY 1 ORDER BY 1`,
      [E_MAPPED],
    );
    return Object.fromEntries(r.rows.map((row) => [row.day, Number(row.n)]));
  }

  /**
   * Drives one tick per day. `scheduled(d)` is the tick's scheduled time (what
   * BullMQ puts in the job id); `processedAt(d)` the worker clock when it runs.
   * Each tick is delivered twice (a BullMQ retry) and the run is completed
   * between days, as the connector would.
   */
  async function driveDays(
    days: number,
    scheduled: (d: number) => number,
    processedAt: (d: number) => number,
  ): Promise<void> {
    for (let d = 0; d < days; d += 1) {
      const job = {
        name: STOCK_RUN_SWEEP_JOB_NAME,
        data: {},
        scheduledAt: new Date(scheduled(d)),
      };
      await sweeperE(processedAt(d)).processJob(job);
      await sweeperE(processedAt(d) + 15_000).processJob(job); // retry
      await completeRuns(E_MAPPED);
    }
  }

  it("boundary-anchored ticks, processed late or with the clock a little early", async () => {
    if (skipped()) return;
    const slot = (d: number): number => DAY0 + d * DAY; // midnight, offset 0
    // Day 0 on time, day 1 ten ms "early" (clock skew), day 2 forty s late,
    // day 3 nearly an hour late.
    const lag = [0, -10, 40_000, 3_500_000];
    await driveDays(4, slot, (d) => slot(d) + lag[d]!);
    expect(await runsPerUtcDay()).toEqual({
      "2026-12-01": 1,
      "2026-12-02": 1,
      "2026-12-03": 1,
      "2026-12-04": 1,
    });
  });

  it("even a schedule anchored a second before midnight keeps one run per UTC day", async () => {
    if (skipped()) return;
    // A legacy, un-anchored schedule: every tick at 23:59:59.000, each picked
    // up after midnight by queue delay. The period follows the SCHEDULED time,
    // so every tick still counts for its own day.
    const lastSecond = (d: number): number => DAY0 + 10 * DAY + d * DAY - 1000;
    await driveDays(3, lastSecond, (d) => lastSecond(d) + 2_500);
    const perDay = await runsPerUtcDay();
    expect(perDay["2026-12-10"]).toBe(1);
    expect(perDay["2026-12-11"]).toBe(1);
    expect(perDay["2026-12-12"]).toBe(1);
  });
});

describe("RT-688 run expiry (RT-187 D5)", () => {
  const TENANT_F = "0f000000-0000-7000-8000-000000688f01";
  const TENANT_G = "0f000000-0000-7000-8000-000000688f02";
  const F_MAPPED = "0f000000-0000-7000-8000-000000688f10";
  const F_UNMAPPED = "0f000000-0000-7000-8000-000000688f11";
  const G_MAPPED = "0f000000-0000-7000-8000-000000688f20";
  const NOW = new Date("2027-01-10T12:00:00.000Z");
  const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
  const HOUR = 60 * 60 * 1000;

  const RUN_NO_REPORT = "0f000000-0000-7000-8000-000000688a01";
  const RUN_PARTIAL = "0f000000-0000-7000-8000-000000688a02";
  const RUN_COMPLETE = "0f000000-0000-7000-8000-000000688a03";
  const RUN_LEGACY_REPORT = "0f000000-0000-7000-8000-000000688a04";
  const RUN_FRESH = "0f000000-0000-7000-8000-000000688a05";
  const RUN_AT_TTL = "0f000000-0000-7000-8000-000000688a06";
  const RUN_UNMAPPED = "0f000000-0000-7000-8000-000000688a07";
  const RUN_G = "0f000000-0000-7000-8000-000000688a08";

  const PARTIAL_REPORT = {
    requestRef: "req",
    runRef: RUN_PARTIAL,
    erpnextWarehouseRef: "WH-F1",
    attemptRef: "att-1",
    readAt: "2027-01-10T08:00:00.000Z",
    recordedAt: "2027-01-10T08:00:05.000Z",
    complete: false,
    windowsRecorded: 2,
    acceptedEntryCount: 3,
    windows: [],
    entries: [{ erpnextItemRef: "ITEM-1", tenant_product_ref: null, quantity: "4", stockUom: "Nos" }],
  };

  beforeAll(async () => {
    if (!env) return;
    const a = env.admin;
    await a.query(
      `INSERT INTO tenants (id, slug, name, status) VALUES
         ($1, 'rt688-f', 'F', 'active'), ($2, 'rt688-g', 'G', 'active')`,
      [TENANT_F, TENANT_G],
    );
    await a.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES
         ($1, $4, 'FM', 'F mapped'), ($2, $4, 'FU', 'F unmapped'), ($3, $5, 'GM', 'G mapped')`,
      [F_MAPPED, F_UNMAPPED, G_MAPPED, TENANT_F, TENANT_G],
    );
    await a.query(
      `INSERT INTO erpnext_warehouse_map (tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by)
       VALUES ($1, $2, 'stock', 'WH-F1', $5), ($3, $4, 'stock', 'WH-G1', $5)`,
      [TENANT_F, F_MAPPED, TENANT_G, G_MAPPED, ACTOR],
    );
    const run = (id: string, tenant: string, store: string, startedAt: Date, summary: unknown) =>
      a.query(
        `INSERT INTO erpnext_reconciliation_run
           (id, tenant_id, store_id, kind, trigger, status, started_at, summary)
         VALUES ($1, $2, $3, 'stock', 'scheduled', 'running', $4, $5::jsonb)`,
        [id, tenant, store, startedAt, summary === null ? null : JSON.stringify(summary)],
      );
    await run(RUN_NO_REPORT, TENANT_F, F_MAPPED, ago(5 * HOUR), null);
    await run(RUN_PARTIAL, TENANT_F, F_MAPPED, ago(4 * HOUR), { bin_view_report: PARTIAL_REPORT });
    await run(RUN_COMPLETE, TENANT_F, F_MAPPED, ago(3 * HOUR), {
      bin_view_report: { ...PARTIAL_REPORT, complete: true },
    });
    // A pre-RT-175 report has no `complete` key: it was a whole snapshot.
    const { complete: _c, windowsRecorded: _w, attemptRef: _a, ...legacy } = PARTIAL_REPORT;
    await run(RUN_LEGACY_REPORT, TENANT_F, F_MAPPED, ago(3 * HOUR), { bin_view_report: legacy });
    await run(RUN_FRESH, TENANT_F, F_MAPPED, ago(HOUR), null);
    await run(RUN_AT_TTL, TENANT_F, F_MAPPED, ago(STOCK_RUN_TTL_MS), null);
    await run(RUN_UNMAPPED, TENANT_F, F_UNMAPPED, ago(6 * HOUR), null);
    await run(RUN_G, TENANT_G, G_MAPPED, ago(6 * HOUR), null);
  });

  interface ExpiredRow {
    id: string;
    status: string;
    finished_at: Date | null;
    summary: Record<string, unknown> | null;
  }

  async function run(id: string): Promise<ExpiredRow> {
    const r = await pg().admin.query<ExpiredRow>(
      `SELECT id, status, finished_at, summary FROM erpnext_reconciliation_run WHERE id = $1`,
      [id],
    );
    return r.rows[0]!;
  }

  it("tenant F's pass expires only F's incomplete runs past the TTL and counts the stranded complete ones", async () => {
    if (skipped()) return;
    const repo = new PgStockRunSweepRepository(pg().app);
    const pass = await repo.expireStaleRuns(TENANT_F, NOW);

    expect([...pass.expired].sort()).toEqual([RUN_NO_REPORT, RUN_PARTIAL, RUN_UNMAPPED].sort());
    expect(pass).toMatchObject({ strandedIncomplete: 0, strandedComplete: 2 });

    for (const id of [RUN_COMPLETE, RUN_LEGACY_REPORT, RUN_FRESH, RUN_AT_TTL]) {
      expect(await run(id)).toMatchObject({ status: "running", finished_at: null });
    }
    // Tenant isolation: G's stale run is untouched by F's pass.
    expect(await run(RUN_G)).toMatchObject({ status: "running", finished_at: null });
  });

  it("an expired run is failed with summary.failure; a partial report is kept as evidence", async () => {
    if (skipped()) return;
    const none = await run(RUN_NO_REPORT);
    expect(none.status).toBe("failed");
    expect(none.finished_at).not.toBeNull();
    expect(none.summary).toEqual({ failure: { reason: "bin_view_not_completed" } });

    const partial = await run(RUN_PARTIAL);
    expect(partial.status).toBe("failed");
    expect(partial.summary).toEqual({
      bin_view_report: PARTIAL_REPORT,
      failure: { reason: "bin_view_not_completed", attemptRef: "att-1", windowsRecorded: 2 },
    });
  });

  it("each expiry writes one audit row with the expiry system actor", async () => {
    if (skipped()) return;
    const audit = await pg().admin.query<{
      target_id: string;
      actor_user_id: string | null;
      actor_label: string | null;
      tenant_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT target_id, actor_user_id, actor_label, tenant_id, metadata FROM audit_events
        WHERE action = 'erpnext_reconciliation.run.failed' AND tenant_id = $1
        ORDER BY target_id`,
      [TENANT_F],
    );
    expect(audit.rows).toEqual(
      [
        [RUN_NO_REPORT, F_MAPPED],
        [RUN_PARTIAL, F_MAPPED],
        [RUN_UNMAPPED, F_UNMAPPED],
      ]
        .sort(([x], [y]) => x!.localeCompare(y!))
        .map(([target_id, store_id]) => ({
          target_id,
          actor_user_id: null,
          actor_label: STOCK_RUN_EXPIRY_ACTOR_LABEL,
          tenant_id: TENANT_F,
          metadata: { store_id, reason: "bin_view_not_completed" },
        })),
    );
  });

  it("a second pass is a no-op", async () => {
    if (skipped()) return;
    const pass = await new PgStockRunSweepRepository(pg().app).expireStaleRuns(TENANT_F, NOW);
    expect(pass).toEqual({ expired: [], strandedIncomplete: 0, strandedComplete: 2 });
  });

  it("a report completed while the pass was deciding is never expired", async () => {
    if (skipped()) return;
    const id = "0f000000-0000-7000-8000-000000688a09";
    await pg().admin.query(
      `INSERT INTO erpnext_reconciliation_run
         (id, tenant_id, store_id, kind, trigger, status, started_at, summary)
       VALUES ($1, $2, $3, 'stock', 'scheduled', 'running', $4, $5::jsonb)`,
      [id, TENANT_G, G_MAPPED, ago(7 * HOUR), JSON.stringify({ bin_view_report: PARTIAL_REPORT })],
    );
    // Hold the run's row lock as binViewReportSnapshot does, complete the
    // report, and commit only after the expiry has started waiting on it.
    const reporter = await pg().admin.connect();
    try {
      await reporter.query("BEGIN");
      await reporter.query(`SELECT id FROM erpnext_reconciliation_run WHERE id = $1 FOR UPDATE`, [id]);
      await reporter.query(
        `UPDATE erpnext_reconciliation_run
            SET summary = jsonb_set(summary, '{bin_view_report,complete}', 'true'::jsonb)
          WHERE id = $1`,
        [id],
      );
      const pending = new PgStockRunSweepRepository(pg().app).expireStaleRuns(TENANT_G, NOW);
      await new Promise((r) => setTimeout(r, 500));
      await reporter.query("COMMIT");
      const pass = await pending;
      expect(pass.expired).toEqual([RUN_G]);
      expect(pass.strandedComplete).toBe(1);
    } finally {
      reporter.release();
    }
    expect(await run(id)).toMatchObject({ status: "running", finished_at: null });
  });

  it("the sweep tick expires the abandoned run first, so the store gets its scheduled run in the same tick", async () => {
    if (skipped()) return;
    // Tenant F still has RUN_AT_TTL (exactly 2 h old at NOW, so not expired
    // then) and the two complete ones; a tick an hour later expires RUN_AT_TTL
    // and RUN_FRESH (now 2 h past start), but the complete runs keep the store
    // skipped_running.
    const onlyF: StockRunSweepRepository = (() => {
      const real = new PgStockRunSweepRepository(pg().app);
      return {
        listActiveTenantIds: async () => [TENANT_F],
        listMappedStoreIds: (t) => real.listMappedStoreIds(t),
        sweepStore: (input) => real.sweepStore(input),
        expireStaleRuns: (t, now) => real.expireStaleRuns(t, now),
      };
    })();
    const later = new Date(NOW.getTime() + HOUR + 1);
    const result = await new StockRunSweepProcessor(onlyF, DAY, () => later, () => undefined).process(
      STOCK_RUN_SWEEP_JOB_NAME,
      {},
    );
    expect(result).toMatchObject({
      expired: 2,
      strandedIncomplete: 0,
      strandedComplete: 2,
      skippedRunning: 1,
      created: 0,
    });
    expect(await run(RUN_AT_TTL)).toMatchObject({ status: "failed" });

    // Once the reconciliation worker has finished the complete runs, the next
    // tick creates the store's scheduled run.
    await completeRuns(F_MAPPED);
    const next = await new StockRunSweepProcessor(
      onlyF,
      DAY,
      () => new Date(later.getTime() + DAY),
      () => undefined,
    ).process(STOCK_RUN_SWEEP_JOB_NAME, {});
    expect(next).toMatchObject({ created: 1, expired: 0, strandedComplete: 0 });
  });
});
