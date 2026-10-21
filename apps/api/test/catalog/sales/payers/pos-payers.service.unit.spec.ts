/**
 * RT-802 — `PosPayersService` without Docker: the ONE shared payer predicate
 * and the contract's outcome order.
 *
 * AC3 (capture and lookup share the predicate): both `captureSale`'s refusal 4
 * (`assertResponsibilityPayersEligible`) and the lookup's `chargeable` embed
 * the SAME exported fragment, `chargeablePayerSql`; the lookup lists the
 * in-scope part of it and computes `chargeable` from the whole of it, so the
 * two decisions cannot drift. The capture query keeps its FOR SHARE lock; the
 * lookup locks nothing. The db-integration suites prove the behavior.
 *
 * Order (`pos-payers.openapi.yaml`): the role 403 is decided before any query
 * validation (400), and a refused operator never reaches the payer read.
 */
import type { Pool, PoolClient } from "pg";
import { ZodError } from "zod";

import { PosPayersService } from "../../../../src/catalog/sales/payers/pos-payers.service";
import { InvalidPosPayersCursorError } from "../../../../src/catalog/sales/payers/pos-payers.query";
import {
  assertResponsibilityPayersEligible,
  chargeablePayerSql,
  PAYER_LINKED_SQL,
  payerInScopeSql,
  SaleResponsibilityRoleRefusedError,
} from "../../../../src/catalog/sales/sale-responsibilities";

const TENANT = "0a802000-0000-4000-8000-000000000001";
const STORE = "0a802000-0000-4000-8000-0000000000a1";
const USER = "0a802000-0000-4000-8000-0000000000b1";
const PAYER = "0a802000-0000-7000-8000-0000000000c1";

interface Recorded {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** A pg client double: records every statement and answers by its shape. */
function fakeClient(opts: { roleCode?: string; payers?: object[] } = {}): { client: PoolClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/role_code/.test(sql)) {
        return { rows: [{ active: true, role_code: opts.roleCode ?? "store_manager", store_access: true }] };
      }
      if (/FROM payer_account/.test(sql)) return { rows: opts.payers ?? [] };
      if (/now\(\)/.test(sql)) return { rows: [{ as_of: "2026-10-21T10:00:00.000Z" }] };
      return { rows: [] };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  return { client, calls };
}

function serviceOn(client: PoolClient): PosPayersService {
  return new PosPayersService({ connect: async () => client } as unknown as Pool);
}

const SCOPE = { tenantId: TENANT, storeId: STORE, actorUserId: USER };
const payerSql = (calls: Recorded[]) => calls.filter((c) => /FROM payer_account/.test(c.sql)).map((c) => c.sql);

describe("RT-802 the shared payer predicate (AC3)", () => {
  it("is the in-scope predicate and the non-blank ERPNext link, nothing else", () => {
    const p = { tenant: "$1", store: "$2" };
    expect(chargeablePayerSql(p)).toBe(`${payerInScopeSql(p)} AND ${PAYER_LINKED_SQL}`);
    expect(payerInScopeSql(p)).toMatch(/tenant_id = \$1/);
    expect(payerInScopeSql(p)).toMatch(/store_id IS NULL OR store_id = \$2/);
    expect(payerInScopeSql(p)).toMatch(/status = 'active'/);
    expect(PAYER_LINKED_SQL).toBe("external_ref ~ '[^[:space:]]'");
  });

  it("capture's refusal 4 filters by exactly that fragment, under FOR SHARE", async () => {
    const { client, calls } = fakeClient({ payers: [{ id: PAYER }] });
    await assertResponsibilityPayersEligible(client, { tenantId: TENANT, storeId: STORE }, [
      { payerRef: PAYER, amount: "1", sequence: 1 },
    ]);
    const [sql] = payerSql(calls);
    expect(sql).toContain(chargeablePayerSql({ tenant: "$2", store: "$3" }));
    expect(sql).toMatch(/FOR SHARE/);
  });

  it("the lookup lists the in-scope part and computes chargeable from the same fragment, locking nothing", async () => {
    const { client, calls } = fakeClient();
    await serviceOn(client).list({ ...SCOPE, rawQuery: {} });
    const [sql] = payerSql(calls);
    expect(sql).toContain(`COALESCE(${chargeablePayerSql({ tenant: "$1", store: "$2" })}, false) AS chargeable`);
    expect(sql).toContain(`COALESCE(${PAYER_LINKED_SQL}, false) AS erp_customer_linked`);
    expect(sql).toContain(`WHERE ${payerInScopeSql({ tenant: "$1", store: "$2" })}`);
    expect(sql).not.toMatch(/FOR (SHARE|UPDATE)/);
  });
});

describe("RT-802 PosPayersService order and projection", () => {
  it("refuses an operator outside the credit roles before validating the query", async () => {
    const { client, calls } = fakeClient({ roleCode: "store_staff" });
    await expect(serviceOn(client).list({ ...SCOPE, rawQuery: { page_size: "0" } })).rejects.toBeInstanceOf(
      SaleResponsibilityRoleRefusedError,
    );
    expect(payerSql(calls)).toEqual([]);
  });

  it("validates the query after the role (ZodError → the 400 envelope)", async () => {
    const { client, calls } = fakeClient();
    await expect(serviceOn(client).list({ ...SCOPE, rawQuery: { store_id: STORE } })).rejects.toBeInstanceOf(ZodError);
    expect(payerSql(calls)).toEqual([]);
  });

  it("refuses a cursor it did not issue", async () => {
    const { client } = fakeClient();
    await expect(serviceOn(client).list({ ...SCOPE, rawQuery: { cursor: PAYER.replace(/-/g, "") } })).rejects.toBeInstanceOf(
      InvalidPosPayersCursorError,
    );
  });

  it("projects only the five picker fields plus asOf, keyset by payerRef DESC", async () => {
    const row = { id: PAYER, display_name: "House", category: "corporate", erp_customer_linked: true, chargeable: true };
    const { client, calls } = fakeClient({ payers: [row] });
    const page = await serviceOn(client).list({ ...SCOPE, rawQuery: { page_size: "1" } });
    expect(page).toEqual({
      items: [{ payerRef: PAYER, displayName: "House", category: "corporate", erpCustomerLinked: true, chargeable: true }],
      nextCursor: null,
      asOf: "2026-10-21T10:00:00.000Z",
    });
    const [sql] = payerSql(calls);
    expect(sql).toMatch(/ORDER BY id DESC/);
  });
});
