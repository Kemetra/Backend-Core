/**
 * RT-539 — the reprint decision (`sale-reprint.ts`) and the controller's
 * scope and refusal mapping, against a scripted client. Docker-free.
 *
 * Pins the branches the HTTP suite cannot reach because the idempotency layer
 * answers a retry first: a reprint already recorded under the same key (an
 * idempotency-cache miss) is replayed without a second audit row, or refused
 * as `key_reused` when the request differs; the key check runs BEFORE the
 * duplicate eligibility, so a replay is never a 422. Also: the detail refuses
 * a partial tender list, `callerScope` fails closed, and every refusal reason
 * maps to its contract status.
 */
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { PoolClient } from "pg";

import type { TenantContextRequest } from "../../../../src/context/types";
import { callerScope, REPRINT_REFUSALS } from "../../../../src/catalog/sales/history/sale-history.controller";
import { loadDetail } from "../../../../src/catalog/sales/history/sale-history.reads";
import type { RecordReprintInput } from "../../../../src/catalog/sales/history/sale-history.types";
import { recordReprintInTransaction } from "../../../../src/catalog/sales/history/sale-reprint";

const TENANT = "0a539000-0000-4000-8000-000000000001";
const STORE = "0a539000-0000-4000-8000-0000000000a1";
const DEVICE = "0a539000-0000-4000-8000-0000000000e1";
const CASHIER = "0a539000-0000-4000-8000-0000000000c1";
const SALE = "0a539000-0000-4000-8000-0000000000f1";
const REPRINT = "0a539000-0000-4000-8000-0000000000f9";

/** A sale row as SALE_SELECT_SQL returns it: incomplete facts, no tenders. */
function saleRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sale_id: SALE,
    tender_count: 0,
    business_date: "2026-10-15",
    occurred_at: new Date("2026-10-15T09:00:00Z"),
    occurred_at_key: "2026-10-15T09:00:00.000000Z",
    received_at: new Date("2026-10-15T09:01:00Z"),
    device_id: DEVICE,
    device_label: "till-1",
    created_by: CASHIER,
    user_display_name: "Cashier One",
    currency_code: "EGP",
    pos_total: "12.5000",
    sync_status: "synced",
    receipt_sale_number: null,
    receipt_number: null,
    receipt_terminal_label: null,
    receipt_operator_display_name: null,
    receipt_settled_at: null,
    receipt_branch_name: null,
    receipt_branch_address: null,
    receipt_tax_registration_id: null,
    receipt_change_given: null,
    voided: false,
    return_state: "none",
    erp_status: null,
    erp_document_ref: null,
    ...extra,
  };
}

interface Script {
  sale?: Record<string, unknown> | null;
  tenders?: Record<string, unknown>[];
  stored?: Record<string, unknown> | null;
}

/** A client answering each statement by its SQL; records every statement. */
function scriptedClient(script: Script): PoolClient & { query: jest.Mock } {
  const routes: ReadonlyArray<readonly [RegExp, () => unknown[]]> = [
    [/FROM sales s/, () => (script.sale === null ? [] : [script.sale ?? saleRow()])],
    [/FROM sale_tenders/, () => script.tenders ?? []],
    [/AS same/, () => (script.stored ? [script.stored] : [])],
    [/INSERT INTO sale_reprints/, () => [{ ...STORED, mode: "record", copy_number: 4 }]],
  ];
  const query = jest.fn(async (sql: string) => ({ rows: routes.find(([re]) => re.test(sql))?.[1]() ?? [] }));
  return { query } as unknown as PoolClient & { query: jest.Mock };
}

function input(body: RecordReprintInput["body"]): RecordReprintInput {
  return {
    tenantId: TENANT,
    storeId: STORE,
    visibility: { kind: "own_sales", userId: CASHIER },
    saleRef: SALE,
    actorUserId: CASHIER,
    deviceId: DEVICE,
    idempotencyKey: "print-event-0001",
    requestId: null,
    body,
  };
}

const STORED = {
  id: REPRINT,
  mode: "authorize",
  kind: "duplicate",
  marked_voided: false,
  marked_returned: false,
  copy_number: 3,
  recorded_at: new Date("2026-10-16T08:00:01Z"),
};

const auditInserts = (client: { query: jest.Mock }): number =>
  client.query.mock.calls.filter(([sql]) => /INSERT INTO audit_events/.test(String(sql))).length;

describe("recordReprintInTransaction — an idempotency-cache miss", () => {
  const authorizeDuplicate = { mode: "authorize", kind: "duplicate", printedAt: "2026-10-16T08:00:00Z" } as const;

  it("replays the stored reprint, without a second audit row, even when a duplicate is no longer allowed", async () => {
    const client = scriptedClient({ stored: { ...STORED, same: true } });
    const outcome = await recordReprintInTransaction(client, input(authorizeDuplicate));
    expect(outcome).toEqual({
      ok: true,
      replayed: true,
      projection: {
        reprintRef: REPRINT,
        saleRef: SALE,
        mode: "authorize",
        kind: "duplicate",
        marks: [],
        copyNumber: 3,
        recordedAt: "2026-10-16T08:00:01.000Z",
      },
    });
    expect(auditInserts(client)).toBe(0);
    expect(client.query.mock.calls.some(([sql]) => /INSERT INTO sale_reprints/.test(String(sql)))).toBe(false);
  });

  it("refuses the same key with another request (key_reused), audited", async () => {
    const client = scriptedClient({ stored: { ...STORED, marked_voided: true, marked_returned: true, same: false } });
    const outcome = await recordReprintInTransaction(client, input(authorizeDuplicate));
    expect(outcome).toEqual({ ok: false, reason: "key_reused" });
    expect(auditInserts(client)).toBe(1);
    const audit = client.query.mock.calls.find(([sql]) => /INSERT INTO audit_events/.test(String(sql)));
    expect(JSON.parse(String((audit?.[1] as unknown[])[7]))).toMatchObject({ outcome: "refused", reason: "key_reused" });
  });

  it("compares the printed instant and the copy number in Postgres", async () => {
    const client = scriptedClient({ stored: null });
    const outcome = await recordReprintInTransaction(
      client,
      input({ ...authorizeDuplicate, mode: "record", localCopyNumber: 4 }),
    );
    // A record is never refused for eligibility, and keeps the terminal's number.
    expect(outcome).toMatchObject({ ok: true, replayed: false, projection: { mode: "record", copyNumber: 4 } });
    expect(auditInserts(client)).toBe(1);
    const lookup = client.query.mock.calls.find(([sql]) => /AS same/.test(String(sql)));
    expect(String(lookup?.[0])).toMatch(/printed_at = \$8::timestamptz/);
    expect((lookup?.[1] as unknown[]).slice(5)).toEqual(["record", "duplicate", "2026-10-16T08:00:00Z", 4]);
  });

  it("a fresh authorize of an unavailable duplicate is refused after the key check", async () => {
    const client = scriptedClient({ stored: null });
    const outcome = await recordReprintInTransaction(client, input(authorizeDuplicate));
    expect(outcome).toEqual({ ok: false, reason: "duplicate_unavailable" });
    const order = client.query.mock.calls.map(([sql]) => String(sql));
    expect(order.findIndex((s) => /AS same/.test(s))).toBeLessThan(order.findIndex((s) => /audit_events/.test(s)));
  });
});

describe("loadDetail", () => {
  it("refuses to present a partial tender list (the sale's tender_count is authoritative)", async () => {
    const client = scriptedClient({ sale: saleRow({ tender_count: 2 }), tenders: [{ method: "cash" }] });
    await expect(
      loadDetail(client, { tenantId: TENANT, storeId: STORE, visibility: { kind: "store" } }, SALE),
    ).rejects.toThrow("tenders are not all visible");
  });

  it("scopes every child read by sale, tenant and store", async () => {
    const client = scriptedClient({ sale: saleRow({ tender_count: 1 }), tenders: [{ method: "cash", amount: "1", reference: null, sequence: null }] });
    await loadDetail(client, { tenantId: TENANT, storeId: STORE, visibility: { kind: "store" } }, SALE);
    for (const [sql, params] of client.query.mock.calls.slice(1)) {
      expect({ sql: String(sql).slice(0, 40), params }).toEqual({ sql: String(sql).slice(0, 40), params: [SALE, TENANT, STORE] });
    }
  });
});

describe("controller: caller scope and refusal mapping", () => {
  const context = { userId: CASHIER, tenantId: TENANT, storeId: STORE, isPlatformAdmin: false, source: "token" as const };

  function req(principal: unknown, extra: Record<string, unknown> = {}): TenantContextRequest {
    return { principal, context, posDeviceId: DEVICE, ...extra } as unknown as TenantContextRequest;
  }

  it("gives the envelope its store and the device path its cashier's own sales", () => {
    const envelope = { kind: "token", tokenId: "t", tenantId: TENANT, userId: CASHIER, storeId: STORE, scope: "pos_operator" };
    expect(callerScope(req(envelope)).visibility).toEqual({ kind: "store" });
    expect(callerScope(req({ ...envelope, scope: "pos" })).visibility).toEqual({ kind: "own_sales", userId: CASHIER });
  });

  it.each([
    ["no principal", undefined],
    ["a session principal", { kind: "session", sessionId: "s", userId: CASHIER }],
    ["another token scope", { kind: "token", tokenId: "t", tenantId: TENANT, userId: CASHIER, storeId: STORE, scope: "api" }],
  ])("fails closed (401) for %s", (_label, principal) => {
    expect(() => callerScope(req(principal))).toThrow(UnauthorizedException);
  });

  it("fails closed (401) without a full context or a device", () => {
    const envelope = { kind: "token", tokenId: "t", tenantId: TENANT, userId: CASHIER, storeId: STORE, scope: "pos_operator" };
    expect(() => callerScope(req(envelope, { posDeviceId: undefined }))).toThrow(UnauthorizedException);
    expect(() => callerScope(req(envelope, { context: { ...context, storeId: null } }))).toThrow(UnauthorizedException);
  });

  it("maps every refusal reason to its contract status", () => {
    expect(REPRINT_REFUSALS.not_visible()).toBeInstanceOf(NotFoundException);
    expect(REPRINT_REFUSALS.not_capturing_device()).toBeInstanceOf(ForbiddenException);
    expect(REPRINT_REFUSALS.duplicate_unavailable()).toBeInstanceOf(UnprocessableEntityException);
    const conflict = REPRINT_REFUSALS.key_reused();
    expect(conflict).toBeInstanceOf(ConflictException);
    expect((conflict as ConflictException).getResponse()).toMatchObject({ code: "idempotency_key_conflict" });
  });
});
