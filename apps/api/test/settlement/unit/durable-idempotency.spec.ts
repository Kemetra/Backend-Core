import type { Pool, PoolClient, QueryResult } from "pg";

import { ReceivableService } from "../../../src/settlement/receivable.service";
import * as apiMetrics from "../../../src/observability/metrics/api.metrics";

const TENANT_ID = "71000000-0000-4000-8000-000000000001";
const STORE_ID = "71000000-0000-4000-8000-000000000002";
const ACTOR_ID = "71000000-0000-4000-8000-000000000003";
const SALE_ID = "71000000-0000-4000-8000-000000000004";
const PAYER_ID = "71000000-0000-4000-8000-000000000005";
const RECEIVABLE_ID = "71000000-0000-4000-8000-000000000006";

function result(rows: unknown[] = [], rowCount = rows.length): QueryResult {
  return { rows, rowCount, command: "", oid: 0, fields: [] } as QueryResult;
}

function harness(options: { saleExists?: boolean; auditFails?: boolean } = {}) {
  let durableFingerprint: Buffer | null = null;
  let durableBody: unknown = null;
  let operationExists = false;
  let receivableInsertCount = 0;
  let auditInsertCount = 0;
  const reservationClients: unknown[] = [];
  const commands: string[] = [];

  const handlers: Array<{
    matches: (sql: string) => boolean;
    run: (params?: unknown[]) => QueryResult;
  }> = [
    { matches: (sql) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || sql.includes("set_config"),
      run: () => result() },
    { matches: (sql) => sql.includes("INSERT INTO idempotency_keys"), run: (params) => {
      reservationClients.push(params?.[3]);
      if (operationExists) return result();
      operationExists = true;
      durableFingerprint = params?.[5] as Buffer;
      return result([{ id: "71000000-0000-4000-8000-000000000007" }]);
    } },
    { matches: (sql) => sql.includes("SELECT request_hash, response_body"),
      run: () => result([{ request_hash: durableFingerprint, response_body: durableBody }]) },
    { matches: (sql) => sql.includes("FROM payer_account"),
      run: () => result([{ id: PAYER_ID }]) },
    { matches: (sql) => sql.includes("INSERT INTO receivable"), run: (params) => {
      if (options.saleExists === false) {
        throw Object.assign(new Error("sale FK violation"), { code: "23503" });
      }
      receivableInsertCount += 1;
      return result([{ id: RECEIVABLE_ID, sale_id: SALE_ID, payer_id: PAYER_ID,
        outstanding_balance: params?.[5] as string, state: "open",
        erpnext_payment_entry_ref: null, tax_placeholder: null, version: 0 }]);
    } },
    { matches: (sql) => sql.includes("UPDATE idempotency_keys"), run: (params) => {
      durableBody = JSON.parse(params?.[0] as string) as unknown;
      return result([], 1);
    } },
    { matches: (sql) => sql.includes("INSERT INTO audit_events"), run: () => {
      auditInsertCount += 1;
      if (options.auditFails) throw new Error("injected audit failure");
      return result([], 1);
    } },
  ];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    commands.push(sql);
    const handler = handlers.find((entry) => entry.matches(sql));
    if (!handler) throw new Error(`unexpected SQL: ${sql}`);
    return handler.run(params);
  });
  const client = { query, release: jest.fn() } as unknown as PoolClient;
  const pool = {
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as Pool;

  return {
    service: new ReceivableService(pool),
    commands,
    reservationClients,
    get receivableInsertCount() {
      return receivableInsertCount;
    },
    get auditInsertCount() {
      return auditInsertCount;
    },
  };
}

function input(owedAmount = "12.00") {
  return {
    tenantId: TENANT_ID,
    storeId: STORE_ID,
    operation: {
      idempotencyKey: "settlement-unit-idempotency-key",
      terminalId: "settlement-test-terminal",
      actorUserId: ACTOR_ID,
      requestId: "b3000000-0000-4000-8000-000000000001",
    },
    saleRef: SALE_ID,
    payers: [{ payerRef: PAYER_ID, owedAmount }],
  } as const;
}

describe("ReceivableService durable settlement idempotency", () => {
  it("stores the result in the business transaction and replays without another receivable", async () => {
    const h = harness();
    const metric = jest.spyOn(apiMetrics, "recordSettlementReceivable");
    try {
      const first = await h.service.openFromIntent(input());
      const retry = await h.service.openFromIntent(input());

      expect(first).toEqual(retry);
      expect(h.receivableInsertCount).toBe(1);
      expect(h.auditInsertCount).toBe(1);
      expect(h.commands.filter((sql) => sql === "COMMIT")).toHaveLength(2);
      expect(metric).toHaveBeenCalledTimes(1);
    } finally {
      metric.mockRestore();
    }
  });

  it("keeps the durable reservation on the terminal when the operator changes", async () => {
    const h = harness();
    const first = await h.service.openFromIntent(input());
    const retry = await h.service.openFromIntent({
      ...input(),
      operation: { ...input().operation, actorUserId: "71000000-0000-4000-8000-000000000008" },
    });
    expect(retry).toEqual(first);
    expect(h.reservationClients).toEqual(["settlement-test-terminal", "settlement-test-terminal"]);
    expect(h.receivableInsertCount).toBe(1);
  });

  it("rejects the same operation key with a different logical payload", async () => {
    const h = harness();
    expect((await h.service.openFromIntent(input("12.00"))).kind).toBe("ok");
    expect((await h.service.openFromIntent(input("13.00"))).kind).toBe(
      "idempotency_conflict",
    );
    expect(h.receivableInsertCount).toBe(1);
  });

  it("rolls the durable reservation back when a referenced sale is invalid", async () => {
    const h = harness({ saleExists: false });
    expect((await h.service.openFromIntent(input())).kind).toBe("conflict");
    expect(h.receivableInsertCount).toBe(0);
    expect(h.commands).toContain("ROLLBACK");
    expect(h.commands).not.toContain("COMMIT");
  });

  it("rolls back the financial facts when the required audit insert fails", async () => {
    const h = harness({ auditFails: true });
    await expect(h.service.openFromIntent(input())).rejects.toThrow(
      "injected audit failure",
    );
    expect(h.auditInsertCount).toBe(1);
    expect(h.commands).toContain("ROLLBACK");
    expect(h.commands).not.toContain("COMMIT");
  });
});
