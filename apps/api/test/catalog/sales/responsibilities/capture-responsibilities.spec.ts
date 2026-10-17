/**
 * RT-418 — sale payer responsibilities at capture, end to end against a real
 * RLS-forced Postgres (the capture harness: real SalesController/Service,
 * real IdempotencyInterceptor, `env.app` under RLS). Contract RT-417:
 * `pos-sales/sales.yaml` 1.10.0-draft; owner decisions R-1 and option A.
 *
 * Acceptance covered:
 *   - a cash + credit split and a full-credit sale covering posTotal → 201,
 *     with `responsibilities` on the capture and read projections (`Sale`);
 *   - under / over coverage → 422 `sale_responsibility_mismatch`, nothing written;
 *   - one non-disclosing 422 `sale_responsibility_payer_invalid` for an
 *     unknown, cross-tenant, other-store, suspended, unlinked or blank-linked
 *     payer, nothing written;
 *   - the device path → 422 `sale_responsibility_offline_refused`; an envelope
 *     operator outside owner / tenant_admin / store_manager → 403
 *     `sale_responsibility_role_refused`;
 *   - the order: replay, then the role 403, then offline, coverage, line
 *     pricing, payers;
 *   - replay: same responsibilities → 200; changed / dropped / added → 409; a
 *     payer suspended, a role lost or the device path after capture never turn
 *     a stored result into a 403 or a 422.
 */
import { resolve } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import { loadOpenApiContracts } from "../../../../src/openapi/loader";
import { PayerAccountsService } from "../../../../src/settlement/payer-accounts.service";
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  STORE_A_X,
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
  type HarnessHandle,
} from "../capture/__capture-harness";
import {
  APPROVER_CASHIER,
  APPROVER_MANAGER,
  APPROVER_NO_STORE,
  APPROVER_OWNER,
  APPROVER_TENANT_ADMIN,
  HARNESS_REQUESTER,
} from "../__support__/void-approval-fixture";

const TENDERS_FLAG = "POS_SALE_TENDERS_ENABLED";
const h: HarnessHandle = { harness: null, dockerSkipped: false };

const P_STORE = "0a000000-0000-7000-8000-0000004187a1";
const P_TENANT = "0a000000-0000-7000-8000-0000004187a2";
const P_OTHER_STORE = "0a000000-0000-7000-8000-0000004187a3";
const P_SUSPENDED = "0a000000-0000-7000-8000-0000004187a4";
const P_UNLINKED = "0a000000-0000-7000-8000-0000004187a5";
const P_BLANK = "0a000000-0000-7000-8000-0000004187a6";
const P_TENANT_B = "0b000000-0000-7000-8000-0000004187b1";
const P_UNKNOWN = "0a000000-0000-7000-8000-0000004187ff";

const SALES_DIR = resolve(__dirname, "..", "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "pos-sales");

function saleValidator(): ValidateFunction {
  const contract = loadOpenApiContracts({ dir: SALES_DIR }).find((c) => c.id === "sales");
  if (!contract) throw new Error("pos-sales/sales.yaml not found");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(contract.document as object), $id: "sales" });
  return ajv.compile({ $ref: "sales#/components/schemas/Sale" });
}
const validateSale = saleValidator();

function expectValidSale(body: unknown): void {
  const ok = validateSale(body);
  expect(validateSale.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
  if (!h.harness) return;
  await h.harness.env.admin.query(
    `INSERT INTO payer_account (id, tenant_id, store_id, category, display_name, external_ref, status) VALUES
       ($1, $8,  $10,  'corporate',       'Store X corp',   'CUST-X',  'active'),
       ($2, $8,  NULL, 'credit_customer', 'House account',  'CUST-T',  'active'),
       ($3, $8,  $11,  'corporate',       'Store Y corp',   'CUST-Y',  'active'),
       ($4, $8,  $10,  'insurer',         'Suspended',      'CUST-S',  'suspended'),
       ($5, $8,  NULL, 'insurer',         'Unlinked',       NULL,      'active'),
       ($6, $8,  NULL, 'insurer',         'Blank link',     E' \\t ',  'active'),
       ($7, $9,  $12,  'insurer',         'Tenant B',       'CUST-B',  'active')`,
    [P_STORE, P_TENANT, P_OTHER_STORE, P_SUSPENDED, P_UNLINKED, P_BLANK, P_TENANT_B, TENANT_A, TENANT_B, STORE_A_X, STORE_A_Y, STORE_B_X],
  );
}, 180_000);
afterAll(async () => {
  delete process.env[TENDERS_FLAG];
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  process.env[TENDERS_FLAG] = "true";
  // A store_manager of STORE_A_X on the envelope path: eligible for credit.
  if (h.harness) h.harness.contextGuard.userId = APPROVER_MANAGER;
});
afterEach(async () => {
  delete process.env[TENDERS_FLAG];
  if (!h.harness) return;
  const q = (sql: string) => h.harness!.env.admin.query(sql);
  const sales = "SELECT id FROM sales WHERE source_system = 'pos-1'";
  await q(`DELETE FROM sale_responsibilities WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_tenders WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_lines WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sales WHERE source_system = 'pos-1'`);
  await q(`UPDATE payer_account SET status = 'active' WHERE id = '${P_STORE}'`);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

// captureBody() posts posTotal 12.5000 (USD), two lines 5 + 7.5.
const credit = (payerRef: string, amount: string, sequence = 1) => ({ payerRef, amount, sequence });
const CASH_2_5 = [{ method: "cash", amount: "2.5" }];

let keySeq = 0;
function post(body: Record<string, unknown>) {
  keySeq += 1;
  return h.harness!.http().post("/api/pos/v1/sales").set("Idempotency-Key", idempKey(`rt418k${keySeq}`)).send(body);
}

async function written(externalId: string): Promise<{ sales: number; responsibilities: number }> {
  const r = await h.harness!.env.admin.query<{ sales: string; resp: string }>(
    `SELECT (SELECT count(*) FROM sales WHERE external_id = $1)::text AS sales,
            (SELECT count(*) FROM sale_responsibilities r JOIN sales s ON s.id = r.sale_id
              WHERE s.external_id = $1)::text AS resp`,
    [externalId],
  );
  return { sales: Number(r.rows[0]!.sales), responsibilities: Number(r.rows[0]!.resp) };
}

const NOTHING = { sales: 0, responsibilities: 0 };

function errorOf(res: { status: number; body: { error?: { code?: string; message?: string } } }) {
  return { status: res.status, code: res.body.error?.code };
}

// ===========================================================================
// Accepted
// ===========================================================================
describe("RT-418 — a covered credit sale is captured", () => {
  it("cash + credit covering posTotal → 201, responsibilities on capture and read", async () => {
    if (skip()) return;
    const res = await post(captureBody({ externalId: "rt418-split", tenders: CASH_2_5, responsibilities: [credit(P_STORE, "10")] }));
    expect(res.status).toBe(201);
    expectValidSale(res.body);
    expect(res.body.responsibilities).toEqual([{ payerRef: P_STORE, amount: "10.0000", sequence: 1 }]);
    expect(res.body.tenders).toEqual([{ method: "cash", amount: "2.5000" }]);
    expect(await written("rt418-split")).toEqual({ sales: 1, responsibilities: 1 });
    const row = await h.harness!.env.admin.query(
      `SELECT responsibility_count, tender_count FROM sales WHERE external_id = 'rt418-split'`,
    );
    expect(row.rows[0]).toEqual({ responsibility_count: 1, tender_count: 1 });

    const read = await h.harness!.http().get(`/api/pos/v1/sales/${res.body.saleRef}`);
    expect(read.status).toBe(200);
    expectValidSale(read.body);
    expect(read.body.responsibilities).toEqual(res.body.responsibilities);
  });

  it("a full-credit sale (no tenders) to a tenant-wide payer → 201, not tender-unknown on the payer share", async () => {
    if (skip()) return;
    const res = await post(captureBody({ externalId: "rt418-full", responsibilities: [credit(P_TENANT, "12.5")] }));
    expect(res.status).toBe(201);
    expectValidSale(res.body);
    expect(res.body.tenders).toEqual([]);
    expect(res.body.responsibilities).toEqual([{ payerRef: P_TENANT, amount: "12.5000", sequence: 1 }]);
  });

  it("works with the tenders gate off (a full-credit body carries no tenders)", async () => {
    if (skip()) return;
    delete process.env[TENDERS_FLAG];
    const res = await post(captureBody({ externalId: "rt418-full-off", responsibilities: [credit(P_TENANT, "12.5")] }));
    expect(res.status).toBe(201);
  });

  it.each([
    ["owner", APPROVER_OWNER],
    ["tenant_admin", APPROVER_TENANT_ADMIN],
  ])("accepts an envelope %s", async (_role, userId) => {
    if (skip()) return;
    h.harness!.contextGuard.userId = userId;
    const res = await post(captureBody({ externalId: `rt418-role-${userId}`, responsibilities: [credit(P_STORE, "12.5")] }));
    expect(res.status).toBe(201);
  });

  it("a sale without responsibilities omits the field and records none", async () => {
    if (skip()) return;
    const res = await post(captureBody({ externalId: "rt418-cash", tenders: [{ method: "cash", amount: "12.5" }] }));
    expect(res.status).toBe(201);
    expectValidSale(res.body);
    expect(Object.hasOwn(res.body, "responsibilities")).toBe(false);
    expect(await written("rt418-cash")).toEqual({ sales: 1, responsibilities: 0 });
  });
});

describe("RT-418 — the count and the rows commit together (coordinator condition)", () => {
  it("a failure after both are written (the in-transaction outbox emit) leaves neither the sale nor its responsibility", async () => {
    if (skip()) return;
    const admin = h.harness!.env.admin;
    // Fail the capture's LAST write, after sales.responsibility_count and the
    // sale_responsibilities row are both inserted in the same transaction.
    await admin.query(`CREATE FUNCTION rt418_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'rt418 injected outbox failure'; END $$`);
    await admin.query(`CREATE TRIGGER rt418_fail_outbox BEFORE INSERT ON outbox_events
      FOR EACH ROW EXECUTE FUNCTION rt418_fail_outbox()`);
    try {
      const res = await post(captureBody({ externalId: "rt418-atomic", responsibilities: [credit(P_STORE, "12.5")] }));
      expect(res.status).toBe(500);
    } finally {
      await admin.query(`DROP TRIGGER rt418_fail_outbox ON outbox_events`);
      await admin.query(`DROP FUNCTION rt418_fail_outbox()`);
    }
    expect(await written("rt418-atomic")).toEqual(NOTHING);
    // And the same body then captures normally, with the count and the row together.
    const ok = await post(captureBody({ externalId: "rt418-atomic", responsibilities: [credit(P_STORE, "12.5")] }));
    expect(ok.status).toBe(201);
    const row = await admin.query(`SELECT responsibility_count FROM sales WHERE external_id = 'rt418-atomic'`);
    expect(row.rows).toEqual([{ responsibility_count: 1 }]);
    expect(await written("rt418-atomic")).toEqual({ sales: 1, responsibilities: 1 });
  });
});

// ===========================================================================
// Refused (nothing written)
// ===========================================================================
describe("RT-418 — the coverage rule", () => {
  it.each([
    ["under-covered", "9.9999"],
    ["over-covered", "10.0001"],
  ])("%s → 422 sale_responsibility_mismatch, nothing written", async (_name, amount) => {
    if (skip()) return;
    const id = `rt418-cover-${amount}`;
    const res = await post(captureBody({ externalId: id, tenders: CASH_2_5, responsibilities: [credit(P_STORE, amount)] }));
    expect(errorOf(res)).toEqual({ status: 422, code: "sale_responsibility_mismatch" });
    expect(await written(id)).toEqual(NOTHING);
  });

  it("tenders alone covering posTotal plus a responsibility is over-covered (the combined rule replaces the tender rule)", async () => {
    if (skip()) return;
    const tenders = [{ method: "cash", amount: "12.5" }];
    const res = await post(captureBody({ externalId: "rt418-double", tenders, responsibilities: [credit(P_STORE, "1")] }));
    expect(errorOf(res)).toEqual({ status: 422, code: "sale_responsibility_mismatch" });
  });
});

describe("RT-418 — payer eligibility (one non-disclosing 422)", () => {
  it.each([
    ["an unknown payer", P_UNKNOWN],
    ["another tenant's payer", P_TENANT_B],
    ["a payer of another store", P_OTHER_STORE],
    ["a suspended payer", P_SUSPENDED],
    ["a payer with no ERPNext Customer link", P_UNLINKED],
    ["a payer with a blank link", P_BLANK],
  ])("%s → 422 sale_responsibility_payer_invalid, same body, nothing written", async (_name, payer) => {
    if (skip()) return;
    const id = `rt418-payer-${payer}`;
    const res = await post(captureBody({ externalId: id, responsibilities: [credit(payer, "12.5")] }));
    expect(res.status).toBe(422);
    const { code, message } = res.body.error ?? {};
    expect({ code, message }).toEqual({
      code: "sale_responsibility_payer_invalid",
      message: "a responsibility names a payer that cannot be billed for this sale",
    });
    expect(await written(id)).toEqual(NOTHING);
  });
});

describe("RT-418 — option A: credit only on the envelope path, for managers", () => {
  it("the device path (operatorUserId) → 422 sale_responsibility_offline_refused, nothing written", async () => {
    if (skip()) return;
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    const body = captureBody({ externalId: "rt418-device", operatorUserId: HARNESS_REQUESTER, responsibilities: [credit(P_STORE, "12.5")] });
    const res = await post(body);
    expect(errorOf(res)).toEqual({ status: 422, code: "sale_responsibility_offline_refused" });
    expect(await written("rt418-device")).toEqual(NOTHING);
  });

  it("the device path answers the offline refusal before the coverage rule", async () => {
    if (skip()) return;
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    const body = captureBody({ externalId: "rt418-device-mm", operatorUserId: HARNESS_REQUESTER, responsibilities: [credit(P_UNKNOWN, "1")] });
    expect(errorOf(await post(body))).toEqual({ status: 422, code: "sale_responsibility_offline_refused" });
  });

  it.each([
    ["a store_staff", APPROVER_CASHIER],
    ["the harness cashier", HARNESS_REQUESTER],
    ["a store_manager without access to the store", APPROVER_NO_STORE],
  ])("%s on the envelope path → 403 sale_responsibility_role_refused, nothing written", async (_name, userId) => {
    if (skip()) return;
    h.harness!.contextGuard.userId = userId;
    const id = `rt418-role-refused-${userId}`;
    const res = await post(captureBody({ externalId: id, responsibilities: [credit(P_STORE, "12.5")] }));
    expect(errorOf(res)).toEqual({ status: 403, code: "sale_responsibility_role_refused" });
    expect(await written(id)).toEqual(NOTHING);
  });

  it("the role 403 is decided before every 422", async () => {
    if (skip()) return;
    h.harness!.contextGuard.userId = APPROVER_CASHIER;
    const res = await post(captureBody({ externalId: "rt418-role-first", responsibilities: [credit(P_UNKNOWN, "1")] }));
    expect(errorOf(res)).toEqual({ status: 403, code: "sale_responsibility_role_refused" });
  });

  it("a cashier sale without responsibilities is unaffected by the role check", async () => {
    if (skip()) return;
    h.harness!.contextGuard.userId = APPROVER_CASHIER;
    expect((await post(captureBody({ externalId: "rt418-cashier-cash" }))).status).toBe(201);
  });
});

describe("RT-418 — the order of the 422s", () => {
  it("coverage before payers", async () => {
    if (skip()) return;
    const res = await post(captureBody({ externalId: "rt418-o1", responsibilities: [credit(P_UNKNOWN, "1")] }));
    expect(errorOf(res)).toEqual({ status: 422, code: "sale_responsibility_mismatch" });
  });

  const badLines = {
    posTotal: "10.0000",
    lines: [{ lineName: "Odd", unitPrice: "3.3333", currencyCode: "USD", quantity: "3", lineAmount: "10.0000", unit: "ea" }],
  };

  it("coverage before line pricing", async () => {
    if (skip()) return;
    const res = await post(captureBody({ externalId: "rt418-o2", ...badLines, responsibilities: [credit(P_STORE, "9")] }));
    expect(errorOf(res)).toEqual({ status: 422, code: "sale_responsibility_mismatch" });
  });

  it("line pricing before payers", async () => {
    if (skip()) return;
    const res = await post(captureBody({ externalId: "rt418-o3", ...badLines, responsibilities: [credit(P_UNKNOWN, "10")] }));
    expect(errorOf(res)).toEqual({ status: 422, code: "sale_line_pricing_invalid" });
    expect(await written("rt418-o3")).toEqual(NOTHING);
  });
});

// ===========================================================================
// Replay
// ===========================================================================
describe("RT-418 — replay", () => {
  const SPLIT = { tenders: CASH_2_5, responsibilities: [credit(P_STORE, "10")] };

  async function captureOnce(externalId: string): Promise<string> {
    const res = await post(captureBody({ externalId, ...SPLIT }));
    expect(res.status).toBe(201);
    return res.body.saleRef as string;
  }

  it("the same responsibilities (new Idempotency-Key, 10 vs 10.0000) → 200 replay, same sale, no new row", async () => {
    if (skip()) return;
    const saleRef = await captureOnce("rt418-replay");
    const res = await post(captureBody({ externalId: "rt418-replay", tenders: CASH_2_5, responsibilities: [credit(P_STORE, "10.0000")] }));
    expect(res.status).toBe(200);
    expect(res.headers["idempotent-replayed"]).toBe("true");
    expect(res.body.saleRef).toBe(saleRef);
    expect(res.body.responsibilities).toEqual([{ payerRef: P_STORE, amount: "10.0000", sequence: 1 }]);
    expect(await written("rt418-replay")).toEqual({ sales: 1, responsibilities: 1 });
  });

  it.each([
    ["a changed amount", { tenders: [{ method: "cash", amount: "2.4" }], responsibilities: [credit(P_STORE, "10.1")] }],
    ["a changed payer", { tenders: CASH_2_5, responsibilities: [credit(P_TENANT, "10")] }],
    ["a changed sequence", { tenders: CASH_2_5, responsibilities: [credit(P_STORE, "10", 2)] }],
    ["dropped responsibilities", { tenders: CASH_2_5 }],
  ])("%s → 409, nothing changed", async (_name, change) => {
    if (skip()) return;
    await captureOnce("rt418-replay-409");
    const res = await post(captureBody({ externalId: "rt418-replay-409", ...change }));
    expect(errorOf(res)).toEqual({ status: 409, code: "idempotency_key_conflict" });
    expect(await written("rt418-replay-409")).toEqual({ sales: 1, responsibilities: 1 });
  });

  it("responsibilities added to a replay of a cash sale → 409", async () => {
    if (skip()) return;
    expect((await post(captureBody({ externalId: "rt418-replay-add", tenders: [{ method: "cash", amount: "12.5" }] }))).status).toBe(201);
    const res = await post(
      captureBody({ externalId: "rt418-replay-add", tenders: [{ method: "cash", amount: "2.5" }], responsibilities: [credit(P_STORE, "10")] }),
    );
    expect(errorOf(res)).toEqual({ status: 409, code: "idempotency_key_conflict" });
  });

  it("a payer suspended after capture never turns the stored result into a 422", async () => {
    if (skip()) return;
    const saleRef = await captureOnce("rt418-replay-susp");
    await h.harness!.env.admin.query(`UPDATE payer_account SET status = 'suspended' WHERE id = $1`, [P_STORE]);
    const res = await post(captureBody({ externalId: "rt418-replay-susp", ...SPLIT }));
    expect(res.status).toBe(200);
    expect(res.body.saleRef).toBe(saleRef);
  });

  it("an operator who lost the role replays the stored result (replay before the 403)", async () => {
    if (skip()) return;
    const saleRef = await captureOnce("rt418-replay-role");
    h.harness!.contextGuard.userId = APPROVER_CASHIER;
    const res = await post(captureBody({ externalId: "rt418-replay-role", ...SPLIT }));
    expect(res.status).toBe(200);
    expect(res.body.saleRef).toBe(saleRef);
  });

  it("a device-path re-delivery of a stored credit sale replays (replay before the offline 422)", async () => {
    if (skip()) return;
    const saleRef = await captureOnce("rt418-replay-device");
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    const res = await post(captureBody({ externalId: "rt418-replay-device", operatorUserId: HARNESS_REQUESTER, ...SPLIT }));
    expect(res.status).toBe(200);
    expect(res.body.saleRef).toBe(saleRef);
  });

  it("a replay that breaks the coverage rule is a 409 (a different payload), not a 422", async () => {
    if (skip()) return;
    await captureOnce("rt418-replay-mm");
    const res = await post(captureBody({ externalId: "rt418-replay-mm", tenders: CASH_2_5, responsibilities: [credit(P_STORE, "1")] }));
    expect(errorOf(res)).toEqual({ status: 409, code: "idempotency_key_conflict" });
  });
});

// ===========================================================================
// RT-572 — the payer repair route unblocks capture
// ===========================================================================
describe("RT-572 — repairing a payer's missing ERPNext link lets a credit sale through", () => {
  const P_REPAIR = "0a000000-0000-7000-8000-0000004187c1";

  beforeAll(async () => {
    if (skip()) return;
    await h.harness!.env.admin.query(
      `INSERT INTO payer_account (id, tenant_id, store_id, category, display_name, external_ref, status)
       VALUES ($1, $2, NULL, 'insurer', 'Created without a link', NULL, 'active')`,
      [P_REPAIR, TENANT_A],
    );
  });

  /** The real update path (`PayerAccountsService.update`) as an owner with access to every store. */
  function updatePayer(body: { expectedVersion: number; externalRef?: string; status?: "active" | "suspended" }) {
    return new PayerAccountsService(h.harness!.env.app).update({
      tenantId: TENANT_A,
      context: {
        userId: APPROVER_OWNER,
        tenantId: TENANT_A,
        storeId: null,
        isPlatformAdmin: false,
        source: "session",
        storeAccess: { kind: "all" },
      },
      payerRef: P_REPAIR,
      actorUserId: APPROVER_OWNER,
      requestId: null,
      body,
    });
  }

  const sale = (externalId: string) => captureBody({ externalId, responsibilities: [credit(P_REPAIR, "12.5")] });

  it("an unlinked payer is refused, a repaired one is captured, and a suspended one is refused again", async () => {
    if (skip()) return;
    const refused = await post(sale("rt572-before-repair"));
    expect(errorOf(refused)).toEqual({ status: 422, code: "sale_responsibility_payer_invalid" });
    expect(await written("rt572-before-repair")).toEqual(NOTHING);

    expect(await updatePayer({ expectedVersion: 0, externalRef: "CUST-REPAIRED" })).toMatchObject({
      external_ref: "CUST-REPAIRED",
      version: 1,
    });
    const captured = await post(sale("rt572-after-repair"));
    expect(captured.status).toBe(201);
    expect(await written("rt572-after-repair")).toEqual({ sales: 1, responsibilities: 1 });

    await updatePayer({ expectedVersion: 1, status: "suspended" });
    expect(errorOf(await post(sale("rt572-suspended")))).toEqual({ status: 422, code: "sale_responsibility_payer_invalid" });
    await updatePayer({ expectedVersion: 2, status: "active" });
    expect((await post(sale("rt572-reactivated"))).status).toBe(201);
  });
});
