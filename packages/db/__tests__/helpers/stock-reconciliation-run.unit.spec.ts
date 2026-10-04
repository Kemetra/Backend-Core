/**
 * RT-179 — `createStockReconciliationRun` Docker-free unit tests (fake client).
 *
 * Pins the statements and parameters the shared run-creation path issues and
 * its 019-T041 conditional emit. RLS and the real inserts are proven by the
 * api triggerRun suites and the worker stock-run-sweep integration suite.
 */
import type { PoolClient } from "pg";

import {
  createStockReconciliationRun,
  STOCK_RECONCILIATION_RUN_COLUMNS,
  type CreateStockReconciliationRunInput,
} from "../../src/helpers/stock-reconciliation-run";

const RUN_ID = "0a000000-0000-7000-8000-000000179f01";
const AUDIT_ID = "0a000000-0000-7000-8000-000000179f02";
const TENANT = "0a000000-0000-7000-8000-000000179f03";
const STORE = "0a000000-0000-7000-8000-000000179f04";
const ACTOR = "0a000000-0000-7000-8000-000000179f05";

interface Call {
  sql: string;
  params: unknown[];
}

function fakeClient(stockMaps: number): { client: PoolClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO erpnext_reconciliation_run")) {
        return { rows: [{ id: params[0], store_id: params[2], trigger: params[3] }] };
      }
      if (sql.includes("FROM erpnext_warehouse_map")) {
        return { rows: [{ n: String(stockMaps) }] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

const BASE: CreateStockReconciliationRunInput = {
  runId: RUN_ID,
  auditEventId: AUDIT_ID,
  tenantId: TENANT,
  storeId: STORE,
  trigger: "on_demand",
  actorUserId: ACTOR,
  actorLabel: null,
};

describe("RT-179 createStockReconciliationRun", () => {
  it("projects the shared run columns", () => {
    expect(STOCK_RECONCILIATION_RUN_COLUMNS).toBe(
      "id, store_id, kind, trigger, status, started_at, finished_at, summary",
    );
  });

  it("on_demand, stock-mapped store: inserts run + audit, defers the emit", async () => {
    const { client, calls } = fakeClient(1);
    const result = await createStockReconciliationRun(client, BASE);

    expect(result.emitted).toBe(false);
    expect(result.run.id).toBe(RUN_ID);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.params).toEqual([RUN_ID, TENANT, STORE, "on_demand", ACTOR, null]);
    expect(calls[0]!.sql).toContain("COALESCE($6::timestamptz, now())");
    expect(calls[1]!.sql).toContain("INSERT INTO audit_events");
    expect(calls[1]!.params).toEqual([
      AUDIT_ID,
      ACTOR,
      null,
      TENANT,
      RUN_ID,
      JSON.stringify({ store_id: STORE }),
    ]);
    // Only an ACTIVE purpose='stock' map defers the run.
    expect(calls[2]!.sql).toContain("purpose = 'stock'");
    expect(calls[2]!.sql).toContain("retired_at IS NULL");
    expect(calls.some((c) => c.sql.includes("outbox_events"))).toBe(false);
  });

  it("scheduled, no stock map: emits erpnext.reconciliation.requested now", async () => {
    const startedAt = new Date("2026-10-04T00:00:00.000Z");
    const { client, calls } = fakeClient(0);
    const result = await createStockReconciliationRun(client, {
      ...BASE,
      trigger: "scheduled",
      actorUserId: null,
      actorLabel: "system:sweep",
      startedAt,
    });

    expect(result.emitted).toBe(true);
    expect(calls[0]!.params).toEqual([RUN_ID, TENANT, STORE, "scheduled", null, startedAt]);
    expect(calls[1]!.params.slice(0, 3)).toEqual([AUDIT_ID, null, "system:sweep"]);
    const outbox = calls.find((c) => c.sql.includes("INSERT INTO outbox_events"));
    expect(outbox).toBeDefined();
    expect(outbox!.params[1]).toBe(TENANT);
    expect(outbox!.params[2]).toBe(STORE);
    expect(outbox!.params[3]).toBe("erpnext.reconciliation.requested");
    expect(JSON.parse(outbox!.params[4] as string)).toEqual({ run_id: RUN_ID, store_id: STORE });
  });
});
