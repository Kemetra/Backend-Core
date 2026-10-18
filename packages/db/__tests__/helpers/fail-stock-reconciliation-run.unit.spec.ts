/**
 * RT-688 — `failStockReconciliationRun` Docker-free unit tests (fake client).
 *
 * Pins the guarded UPDATE (running + incomplete report, re-checked under the
 * row lock), the `summary.failure` shape and the audit row. The real lock race,
 * RLS and the report-complete exclusion are proven by the worker
 * stock-run-sweep integration suite and the api bin-view warehouse-binding
 * suite.
 */
import type { PoolClient } from "pg";

import {
  failStockReconciliationRun,
  stockRunReportCompleteSql,
  type FailStockReconciliationRunInput,
} from "../../src/helpers/stock-reconciliation-run";

const RUN_ID = "0a000000-0000-7000-8000-000000688f01";
const AUDIT_ID = "0a000000-0000-7000-8000-000000688f02";
const TENANT = "0a000000-0000-7000-8000-000000688f03";
const STORE = "0a000000-0000-7000-8000-000000688f04";

interface Call {
  sql: string;
  params: unknown[];
}

function fakeClient(updated: boolean): { client: PoolClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("UPDATE erpnext_reconciliation_run")) {
        return { rows: updated ? [{ store_id: STORE }] : [] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

const BASE: FailStockReconciliationRunInput = {
  runId: RUN_ID,
  auditEventId: AUDIT_ID,
  tenantId: TENANT,
  reason: "bin_view_not_completed",
  actorUserId: null,
  actorLabel: "system:erpnext-stock-run-expiry",
};

describe("RT-688 failStockReconciliationRun", () => {
  it("fails only a running stock run whose report is not complete", async () => {
    const { client, calls } = fakeClient(true);
    await failStockReconciliationRun(client, BASE);
    const update = calls[0]!;
    expect(update.sql).toContain("SET status      = 'failed'");
    expect(update.sql).toContain("finished_at = now()");
    expect(update.sql).toContain("run.status = 'running'");
    expect(update.sql).toContain("run.kind = 'stock'");
    expect(update.sql).toContain(`AND NOT ${stockRunReportCompleteSql("run")}`);
    expect(update.sql).toContain("'failure', jsonb_strip_nulls");
    expect(update.params).toEqual([RUN_ID, "bin_view_not_completed"]);
  });

  it("writes one audit row with the store and reason (no quantities) and returns the store", async () => {
    const { client, calls } = fakeClient(true);
    expect(await failStockReconciliationRun(client, BASE)).toEqual({ storeId: STORE });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.sql).toContain("'erpnext_reconciliation.run.failed'");
    expect(calls[1]!.params).toEqual([
      AUDIT_ID,
      null,
      "system:erpnext-stock-run-expiry",
      TENANT,
      RUN_ID,
      JSON.stringify({ store_id: STORE, reason: "bin_view_not_completed" }),
    ]);
  });

  it("writes nothing more when the guarded update matched no row", async () => {
    const { client, calls } = fakeClient(false);
    expect(await failStockReconciliationRun(client, { ...BASE, reason: "warehouse_remapped" })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("the complete-report predicate reads a NULL summary as incomplete and a v1 report as complete", () => {
    const sql = stockRunReportCompleteSql("r");
    expect(sql).toMatch(/^COALESCE\(/);
    expect(sql).toContain("jsonb_typeof(r.summary->'bin_view_report') = 'object'");
    expect(sql).toContain("IS DISTINCT FROM 'false'::jsonb, false)");
  });
});
