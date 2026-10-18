/**
 * RT-688 (RT-187 F1 / §5.1) — bin-view requests are bound to the warehouse map
 * they were pulled under, and a stock-map retire ends the store's in-flight run.
 *
 * Real PostgreSQL (every migration), service calls on the RLS-active `app`
 * pool (app_test: NOSUPERUSER, NOBYPASSRLS).
 *
 *   §1 the feed's `requestRef` is derived from (run, active stock map);
 *   §2 a retire between windows k and k+1 fails the in-flight run
 *      (`warehouse_remapped`, audit row with the operator), and under the old
 *      `requestRef` window k+1 AND a fresh window 0 both get the non-disclosing
 *      404; nothing is recorded under the new mapping, and the feed offers the
 *      run no more;
 *   §3 a run whose report is already complete is NOT failed by the retire; its
 *      old `requestRef` still gets 404, and a report under the new mapping's ref
 *      is a window-sequence conflict, never a second snapshot or emit;
 *   §4 retiring a `returns` map, or another tenant's map, fails nothing.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  BinViewNotFoundError,
  BinViewWindowSequenceConflictError,
  binViewRequestRef,
  ErpnextBinViewService,
} from "../../../../src/catalog/erpnext-bin-view/erpnext-bin-view.service";
import { ErpnextWarehouseMapService } from "../../../../src/catalog/erpnext-warehouse-map/erpnext-warehouse-map.service";
import { ACTOR_A, TENANT_A, TENANT_B } from "../../__support__/isolation-harness";
import { seedReconciliationFixture } from "../../erpnext-reconciliation/__support__/seed-reconciliation";

let env: PgTestEnv | null = null;
let skip = false;

const STORE_REMAP = "0a000000-0000-7000-8000-000000688b01";
const STORE_COMPLETE = "0a000000-0000-7000-8000-000000688b02";
const STORE_RETURNS = "0a000000-0000-7000-8000-000000688b03";
const RUN_REMAP = "0a000000-0000-7000-8000-000000688c01";
const RUN_COMPLETE = "0a000000-0000-7000-8000-000000688c02";
const RUN_RETURNS = "0a000000-0000-7000-8000-000000688c03";
const ATTEMPT = "0a000000-0000-4000-8000-000000688d01";
const READ_AT = "2026-10-18T08:00:00.000Z";

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReconciliationFixture(env);
    const a = env.admin;
    await a.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES
         ($1, $4, 'R688', 'Remap'), ($2, $4, 'C688', 'Complete'), ($3, $4, 'T688', 'Returns')`,
      [STORE_REMAP, STORE_COMPLETE, STORE_RETURNS, TENANT_A],
    );
    for (const [runId, storeId] of [
      [RUN_REMAP, STORE_REMAP],
      [RUN_COMPLETE, STORE_COMPLETE],
      [RUN_RETURNS, STORE_RETURNS],
    ] as const) {
      await a.query(
        `INSERT INTO erpnext_reconciliation_run
           (id, tenant_id, store_id, kind, trigger, status, actor_user_id)
         VALUES ($1, $2, $3, 'stock', 'on_demand', 'running', $4)`,
        [runId, TENANT_A, storeId, ACTOR_A],
      );
    }
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[bin-view-warehouse-binding.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

/** One seeded reconciliation run. */
interface RunKey {
  readonly runId: string;
}

/** A store's warehouse map to set. */
interface MapSpec {
  readonly storeId: string;
  readonly erpnextWarehouseRef: string;
}

/** A warehouse map row to retire (optimistic version), as a given tenant. */
interface RetireSpec {
  readonly map: { readonly id: string; readonly version: number };
  readonly tenantId?: string;
}

/** One `reportSnapshot` call under a requestRef. */
interface ReportSpec {
  readonly requestRef: string;
  readonly body: object;
}

/** A one-item report window: item `${prefix}-1`. */
interface WindowSpec {
  readonly prefix: string;
  readonly seq: number;
  readonly isFinal: boolean;
  readonly attemptRef?: string;
}

const bins = () => new ErpnextBinViewService(env!.app);
const maps = () => new ErpnextWarehouseMapService(env!.app);

async function setMap({ storeId, erpnextWarehouseRef }: MapSpec): Promise<{ id: string; version: number }> {
  const r = await maps().set({ tenantId: TENANT_A, storeId, erpnextWarehouseRef, actorUserId: ACTOR_A });
  if (r.kind !== "ok") throw new Error(`set map: ${r.kind}`);
  return { id: r.row.id, version: r.row.version };
}

async function retire({ map, tenantId = TENANT_A }: RetireSpec) {
  return maps().retire({ tenantId, id: map.id, version: map.version, actorUserId: ACTOR_A });
}

async function feedRef({ runId }: RunKey): Promise<string | undefined> {
  const page = await bins().pullRequests({ tenantId: TENANT_A, since: null, limit: 500 });
  return page.items.find((i) => i.runRef === runId)?.requestRef;
}

let keySeq = 0;
function report({ requestRef, body }: ReportSpec) {
  keySeq += 1;
  return bins().reportSnapshot({
    tenantId: TENANT_A,
    requestRef,
    body: body as Parameters<ErpnextBinViewService["reportSnapshot"]>[0]["body"],
    idempotencyKey: `rt688-${keySeq}`,
  });
}

const entries = ({ prefix }: Pick<WindowSpec, "prefix">) => [
  { erpnextItemRef: { doctype: "Item" as const, name: `${prefix}-1` }, quantity: "1.000000", stockUom: "Nos" },
];
const win = ({ prefix, seq, isFinal, attemptRef = ATTEMPT }: WindowSpec) => ({
  entries: entries({ prefix }),
  window: { attemptRef, windowSeq: seq, isFinal },
  readAt: READ_AT,
});

interface RunRow {
  status: string;
  finished_at: Date | null;
  summary: Record<string, unknown> | null;
}

async function runRow({ runId }: RunKey): Promise<RunRow> {
  const r = await env!.admin.query<RunRow>(
    `SELECT status, finished_at, summary FROM erpnext_reconciliation_run WHERE id = $1`,
    [runId],
  );
  return r.rows[0]!;
}

async function failedAudits({ runId }: RunKey) {
  const r = await env!.admin.query<{
    actor_user_id: string | null;
    actor_label: string | null;
    tenant_id: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT actor_user_id, actor_label, tenant_id, metadata FROM audit_events
      WHERE action = 'erpnext_reconciliation.run.failed' AND target_id = $1`,
    [runId],
  );
  return r.rows;
}

async function requestedEvents({ runId }: RunKey): Promise<number> {
  const r = await env!.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM outbox_events
      WHERE event_type = 'erpnext.reconciliation.requested' AND payload->>'run_id' = $1`,
    [runId],
  );
  return Number(r.rows[0]!.n);
}

describe("RT-688 §1/§2 — a remap between windows ends the attempt and the run", () => {
  let oldMap: { id: string; version: number };
  let oldRef = "";

  it("the feed's requestRef is derived from the run and its active stock map", async () => {
    if (skip) return;
    oldMap = await setMap({ storeId: STORE_REMAP, erpnextWarehouseRef: "WH-688-OLD" });
    oldRef = (await feedRef({ runId: RUN_REMAP }))!;
    expect(oldRef).toBe(binViewRequestRef(RUN_REMAP, oldMap.id));
  });

  it("window 0 is recorded under the old mapping", async () => {
    if (skip) return;
    const w0 = await report({ requestRef: oldRef, body: win({ prefix: "OLD", seq: 0, isFinal: false }) });
    expect(w0.view).toMatchObject({ windowSeq: 0, complete: false, erpnextWarehouseRef: "WH-688-OLD" });
  });

  it("the retire fails the in-flight run with warehouse_remapped and an operator audit row", async () => {
    if (skip) return;
    const retired = await retire({ map: oldMap });
    expect(retired.kind).toBe("ok");

    const run = await runRow({ runId: RUN_REMAP });
    expect(run.status).toBe("failed");
    expect(run.finished_at).not.toBeNull();
    expect(run.summary?.["failure"]).toEqual({
      reason: "warehouse_remapped",
      attemptRef: ATTEMPT,
      windowsRecorded: 1,
    });
    // The partial report stays as evidence.
    expect(run.summary?.["bin_view_report"]).toMatchObject({ attemptRef: ATTEMPT, complete: false });
    expect(await failedAudits({ runId: RUN_REMAP })).toEqual([
      {
        actor_user_id: ACTOR_A,
        actor_label: null,
        tenant_id: TENANT_A,
        metadata: { store_id: STORE_REMAP, reason: "warehouse_remapped" },
      },
    ]);
  });

  it("after the new map is set, the old requestRef gets 404 on window k+1 AND on a fresh window 0", async () => {
    if (skip) return;
    const newMap = await setMap({ storeId: STORE_REMAP, erpnextWarehouseRef: "WH-688-NEW" });
    await expect(report({ requestRef: oldRef, body: win({ prefix: "OLD", seq: 1, isFinal: true }) })).rejects.toBeInstanceOf(BinViewNotFoundError);
    await expect(
      report({ requestRef: oldRef, body: win({ prefix: "OLD", seq: 0, isFinal: true, attemptRef: "0a000000-0000-4000-8000-000000688d02" }) }),
    ).rejects.toBeInstanceOf(BinViewNotFoundError);
    // The run is terminal, so the new mapping's ref resolves to nothing either.
    await expect(
      report({
        requestRef: binViewRequestRef(RUN_REMAP, newMap.id),
        body: win({ prefix: "NEW", seq: 0, isFinal: true }),
      }),
    ).rejects.toBeInstanceOf(BinViewNotFoundError);

    // Nothing was recorded under the new mapping, nothing was emitted, and the
    // feed no longer offers the run.
    const run = await runRow({ runId: RUN_REMAP });
    expect(run.summary?.["bin_view_report"]).toMatchObject({
      erpnextWarehouseRef: "WH-688-OLD",
      windowsRecorded: 1,
    });
    expect(await requestedEvents({ runId: RUN_REMAP })).toBe(0);
    expect(await feedRef({ runId: RUN_REMAP })).toBeUndefined();
  });
});

describe("RT-688 §3 — a run with a complete report survives the retire, bound to its old map", () => {
  let oldRef = "";

  it("a complete report under the old mapping emits once; the retire leaves the run running", async () => {
    if (skip) return;
    const oldMap = await setMap({ storeId: STORE_COMPLETE, erpnextWarehouseRef: "WH-688-C-OLD" });
    oldRef = (await feedRef({ runId: RUN_COMPLETE }))!;
    await report({ requestRef: oldRef, body: win({ prefix: "C", seq: 0, isFinal: true }) });
    expect(await requestedEvents({ runId: RUN_COMPLETE })).toBe(1);

    expect((await retire({ map: oldMap })).kind).toBe("ok");
    const run = await runRow({ runId: RUN_COMPLETE });
    expect(run).toMatchObject({ status: "running", finished_at: null });
    expect(run.summary?.["failure"]).toBeUndefined();
    expect(await failedAudits({ runId: RUN_COMPLETE })).toEqual([]);
  });

  it("the old requestRef gets 404; the new mapping's ref is a conflict, never a second snapshot", async () => {
    if (skip) return;
    await setMap({ storeId: STORE_COMPLETE, erpnextWarehouseRef: "WH-688-C-NEW" });
    await expect(report({ requestRef: oldRef, body: win({ prefix: "C", seq: 0, isFinal: true }) })).rejects.toBeInstanceOf(BinViewNotFoundError);

    const newRef = (await feedRef({ runId: RUN_COMPLETE }))!;
    expect(newRef).not.toBe(oldRef);
    await expect(report({ requestRef: newRef, body: win({ prefix: "C2", seq: 0, isFinal: true, attemptRef: "0a000000-0000-4000-8000-000000688d03" }) })).rejects.toBeInstanceOf(
      BinViewWindowSequenceConflictError,
    );
    await expect(
      report({ requestRef: newRef, body: { entries: entries({ prefix: "C3" }), readAt: READ_AT } }),
    ).rejects.toBeInstanceOf(BinViewWindowSequenceConflictError);

    expect(await requestedEvents({ runId: RUN_COMPLETE })).toBe(1);
    expect((await runRow({ runId: RUN_COMPLETE })).summary?.["bin_view_report"]).toMatchObject({
      erpnextWarehouseRef: "WH-688-C-OLD",
      complete: true,
    });
  });
});

describe("RT-688 §4 — retires that must not fail a run", () => {
  it("retiring a returns map leaves the store's running stock run alone", async () => {
    if (skip) return;
    const r = await env!.admin.query<{ id: string; version: number }>(
      `INSERT INTO erpnext_warehouse_map
         (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
       VALUES (gen_random_uuid(), $1, $2, 'returns', 'WH-688-RET', $3, 1)
       RETURNING id, version`,
      [TENANT_A, STORE_RETURNS, ACTOR_A],
    );
    expect((await retire({ map: r.rows[0]! })).kind).toBe("ok");
    expect(await runRow({ runId: RUN_RETURNS })).toMatchObject({ status: "running", finished_at: null });
    expect(await failedAudits({ runId: RUN_RETURNS })).toEqual([]);
  });

  it("another tenant cannot retire the map, and the run stays running", async () => {
    if (skip) return;
    const map = await setMap({ storeId: STORE_RETURNS, erpnextWarehouseRef: "WH-688-STOCK" });
    expect((await retire({ map: map, tenantId: TENANT_B })).kind).toBe("not_found");
    expect(await runRow({ runId: RUN_RETURNS })).toMatchObject({ status: "running", finished_at: null });
    expect(await failedAudits({ runId: RUN_RETURNS })).toEqual([]);
  });
});
