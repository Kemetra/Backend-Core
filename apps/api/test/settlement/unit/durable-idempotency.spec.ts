import type { Pool, PoolClient, QueryResult } from "pg";

import { ReceivableService } from "../../../src/settlement/receivable.service";

const TENANT_ID = "71000000-0000-4000-8000-000000000001";
const STORE_ID = "71000000-0000-4000-8000-000000000002";
const ACTOR_ID = "71000000-0000-4000-8000-000000000003";
const SALE_ID = "71000000-0000-4000-8000-000000000004";
const PAYER_ID = "71000000-0000-4000-8000-000000000005";
const RECEIVABLE_ID = "71000000-0000-4000-8000-000000000006";

function result(rows: unknown[] = [], rowCount = rows.length): QueryResult {
  return { rows, rowCount, command: "", oid: 0, fields: [] } as QueryResult;
}

function harness(options: { saleExists?: boolean } = {}) {
  let durableFingerprint: Buffer | null = null;
  let durableBody: unknown = null;
  let operationExists = false;
  let receivableInsertCount = 0;
  const commands: string[] = [];

  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    const text = String(sql);
    commands.push(text);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text) || text.includes("set_config")) {
      return result();
    }
    if (text.includes("INSERT INTO idempotency_keys")) {
      if (operationExists) return result();
      operationExists = true;
      durableFingerprint = params?.[5] as Buffer;
      return result([{ id: "71000000-0000-4000-8000-000000000007" }]);
    }
    if (text.includes("SELECT request_hash, response_body")) {
      return result([
        { request_hash: durableFingerprint, response_body: durableBody },
      ]);
    }
    if (text.includes("FROM sales")) {
      return result(options.saleExists === false ? [] : [{ id: SALE_ID }]);
    }
    if (text.includes("FROM payer_account")) return result([{ id: PAYER_ID }]);
    if (text.includes("INSERT INTO receivable")) {
      receivableInsertCount += 1;
      return result([
        {
          id: RECEIVABLE_ID,
          sale_id: SALE_ID,
          payer_id: PAYER_ID,
          outstanding_balance: params?.[5] as string,
          state: "open",
          erpnext_payment_entry_ref: null,
          tax_placeholder: null,
          version: 0,
        },
      ]);
    }
    if (text.includes("UPDATE idempotency_keys")) {
      durableBody = JSON.parse(params?.[0] as string) as unknown;
      return result([], 1);
    }
    throw new Error(`unexpected SQL: ${text}`);
  });
  const client = { query, release: jest.fn() } as unknown as PoolClient;
  const pool = {
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as Pool;

  return {
    service: new ReceivableService(pool),
    commands,
    get receivableInsertCount() {
      return receivableInsertCount;
    },
  };
}

function input(owedAmount = "12.00") {
  return {
    tenantId: TENANT_ID,
    storeId: STORE_ID,
    operation: {
      idempotencyKey: "settlement-unit-idempotency-key",
      actorUserId: ACTOR_ID,
    },
    saleRef: SALE_ID,
    payers: [{ payerRef: PAYER_ID, owedAmount }],
  } as const;
}

describe("ReceivableService durable settlement idempotency", () => {
  it("stores the result in the business transaction and replays without another receivable", async () => {
    const h = harness();
    const first = await h.service.openFromIntent(input());
    const retry = await h.service.openFromIntent(input());

    expect(first).toEqual(retry);
    expect(h.receivableInsertCount).toBe(1);
    expect(h.commands.filter((sql) => sql === "COMMIT")).toHaveLength(2);
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
});
