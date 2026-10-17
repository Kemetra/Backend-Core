/**
 * RT-577 — `recordCreditSaleReversal` end to end against a real RLS-forced
 * Postgres (the capture harness, audit spy wired). Contract: `pos-sales/sales.yaml`
 * 1.11.0-draft; owner-approved V1 decision and rulings D6 / D7 / D8 (2026-10-17).
 *
 * The ticket's test list:
 *   - cashier rejection (403 `credit_reversal_role_refused`, zero writes);
 *   - the authorized Manager/Admin path (void and return, 201, response valid
 *     against the contract, the sale reads voided / returned);
 *   - mixed cash + credit allocation: pro rata, floor to the minor unit,
 *     cumulative (repeating fractions and a 0-decimal currency sum exactly);
 *   - no payout of uncollected credit (full-credit sale refunds nothing; a
 *     payout above the collected share is 422 `credit_reversal_refund_mismatch`);
 *   - audit trail (`sale.credit_reversed` with the decision's evidence);
 *   - fail-closed conditions (allocation, payer settlement, role, credit status);
 *   - D6 second approval of a cash-paying return; D8 mirrored void tenders;
 *   - replay / idempotency, and zero writes on every refusal.
 */
import { resolve } from "node:path";

import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import type { AuditJobEnqueuer } from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";
import { loadOpenApiContracts } from "../../../../src/openapi/loader";
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  STORE_A_X,
  TENANT_A,
  type HarnessHandle,
} from "../capture/__capture-harness";
import {
  APPROVER_CASHIER,
  APPROVER_MANAGER,
  APPROVER_OWNER,
  APPROVER_REVOKED,
  APPROVER_TENANT_ADMIN,
  HARNESS_REQUESTER,
} from "../__support__/void-approval-fixture";
import { disableReturns, enableReturns } from "../terminal/__returns-support";

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.calls.push(payload);
  }
}

const spy = new SpyAuditEnqueuer();
const TENDERS_FLAG = "POS_SALE_TENDERS_ENABLED";
const h: HarnessHandle = { harness: null, dockerSkipped: false };
const PAYER = "0a000000-0000-7000-8000-0000005771a1";
const TENDER_CASH = "0a000000-0000-7000-8000-0000005771c1";
const TENDER_CARD = "0a000000-0000-7000-8000-0000005771c2";

const SALES_DIR = resolve(__dirname, "..", "..", "..", "..", "..", "..", "packages", "contracts", "openapi", "pos-sales");

function reversalValidator(): ValidateFunction {
  const contract = loadOpenApiContracts({ dir: SALES_DIR }).find((c) => c.id === "sales");
  if (!contract) throw new Error("pos-sales/sales.yaml not found");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...(contract.document as object), $id: "sales" });
  return ajv.compile({ $ref: "sales#/components/schemas/CreditSaleReversal" });
}
const validateReversal = reversalValidator();

function expectValidReversal(body: unknown): void {
  const ok = validateReversal(body);
  expect(validateReversal.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness({ auditEnqueuer: spy }));
  if (!h.harness) return;
  await h.harness.env.admin.query(
    `INSERT INTO payer_account (id, tenant_id, store_id, category, display_name, external_ref, status)
     VALUES ($1, $2, $3, 'corporate', 'RT-577 corp', 'CUST-577', 'active')`,
    [PAYER, TENANT_A, STORE_A_X],
  );
}, 180_000);
afterAll(async () => {
  delete process.env[TENDERS_FLAG];
  delete process.env["POS_SALE_TENDER_SAME_METHOD_ENABLED"];
  disableReturns();
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  spy.calls = [];
  process.env[TENDERS_FLAG] = "true";
  enableReturns();
  if (h.harness) h.harness.contextGuard.userId = APPROVER_TENANT_ADMIN;
});
afterEach(async () => {
  if (!h.harness) return;
  const q = (sql: string) => h.harness!.env.admin.query(sql);
  const sales = "SELECT id FROM sales WHERE source_system = 'pos-1'";
  await q(`DELETE FROM sale_credit_reversal_tenders`);
  await q(`DELETE FROM sale_credit_reversals`);
  await q(`DELETE FROM sale_approval_uses`);
  await q(`DELETE FROM sale_return_tenders WHERE return_id IN (SELECT id FROM sale_returns WHERE sale_id IN (${sales}))`);
  await q(`DELETE FROM sale_return_lines WHERE return_id IN (SELECT id FROM sale_returns WHERE sale_id IN (${sales}))`);
  await q(`DELETE FROM sale_returns WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_voids WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_responsibilities WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_tenders WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_lines WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sales WHERE source_system = 'pos-1'`);
  await q(`DELETE FROM outbox_events`);
  await q(`UPDATE payer_account SET status = 'active', external_ref = 'CUST-577' WHERE id = '${PAYER}'`);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

let keySeq = 0;
const nextKey = (): string => idempKey(`rt577c${(keySeq += 1)}`);
let approvalSeq = 0;
const nextApprovalId = (): string => `0a000000-0000-7000-8000-${(0x5772000000 + (approvalSeq += 1)).toString(16).padStart(12, "0")}`;

interface Line {
  readonly lineName: string;
  readonly unitPrice: string;
  readonly lineAmount: string;
}

interface CaptureSpec {
  readonly externalId: string;
  readonly tenders?: ReadonlyArray<Record<string, unknown>>;
  readonly credit?: string;
  readonly lines?: ReadonlyArray<Line>;
  readonly posTotal?: string;
  readonly currency?: string;
}

interface CapturedSale {
  readonly saleRef: string;
  readonly lineRefs: string[];
}

/** Capture as the store manager (the seller). Defaults: USD 12.5 = cash 2.5 + credit 10, lines 5 + 7.5. */
async function captureSale(spec: CaptureSpec): Promise<CapturedSale> {
  const harness = h.harness!;
  const actor = harness.contextGuard.userId;
  harness.contextGuard.userId = APPROVER_MANAGER;
  const currency = spec.currency ?? "USD";
  const lines = (spec.lines ?? [
    { lineName: "Widget", unitPrice: "5.0000", lineAmount: "5.0000" },
    { lineName: "Gadget", unitPrice: "7.5000", lineAmount: "7.5000" },
  ]).map((l) => ({ ...l, currencyCode: currency, quantity: "1", unit: "ea" }));
  const credit = spec.credit === undefined ? "10" : spec.credit;
  const body = captureBody({
    externalId: spec.externalId,
    currencyCode: currency,
    posTotal: spec.posTotal ?? "12.5000",
    lines,
    ...(spec.tenders === undefined ? { tenders: [{ method: "cash", amount: "2.5" }] } : spec.tenders.length === 0 ? {} : { tenders: spec.tenders }),
    ...(credit === "0" ? {} : { responsibilities: [{ payerRef: PAYER, amount: credit, sequence: 1 }] }),
  });
  const res = await harness.http().post("/api/pos/v1/sales").set("Idempotency-Key", nextKey()).send(body);
  harness.contextGuard.userId = actor;
  if (res.status !== 201) throw new Error(`capture failed: ${res.status} ${JSON.stringify(res.body)}`);
  // Line refs in REQUEST order (the projection's order is not the request's).
  const byName = new Map((res.body.lines as Array<{ lineRef: string; lineName: string }>).map((l) => [l.lineName, l.lineRef]));
  return { saleRef: res.body.saleRef, lineRefs: lines.map((l) => byName.get(l.lineName)!) };
}

async function saleFacts(saleRef: string): Promise<{ amount: string; businessDate: string }> {
  const r = await h.harness!.env.admin.query<{ amount: string; business_date: string }>(
    `SELECT pos_total::text AS amount, business_date::text AS business_date FROM sales WHERE id = $1`,
    [saleRef],
  );
  return { amount: r.rows[0]!.amount, businessDate: r.rows[0]!.business_date };
}

function approval(saleRef: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    approvalId: nextApprovalId(),
    action: "sale.credit_return",
    saleRef,
    amount: "0",
    requesterUserId: h.harness!.contextGuard.userId,
    approverUserId: APPROVER_OWNER,
    policyVersion: "rt114-2026-10-07",
    approvedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function voidBody(saleRef: string, overrides: Record<string, unknown> = {}, approvalOverrides: Record<string, unknown> = {}) {
  const facts = await saleFacts(saleRef);
  return {
    sourceSystem: "pos-1",
    externalId: "credit-void-1",
    kind: "void",
    refundTenders: [{ method: "cash", amount: "2.5" }],
    reason: "customer cancelled the order",
    businessDate: facts.businessDate,
    approval: approval(saleRef, { action: "sale.void", amount: facts.amount, ...approvalOverrides }),
    ...overrides,
  };
}

function returnBody(
  saleRef: string,
  lineRefs: string[],
  refund: string | null,
  overrides: Record<string, unknown> = {},
  approvalOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sourceSystem: "pos-1",
    externalId: `credit-return-${lineRefs.join("-").slice(-12)}`,
    kind: "return",
    lines: lineRefs.map((lineRef) => ({ lineRef, quantity: "1" })),
    refundTenders: refund === null || Number(refund) === 0 ? [] : [{ method: "cash", amount: refund }],
    reason: "customer returned the goods",
    ...(refund === null || Number(refund) === 0 ? {} : { approval: approval(saleRef, { amount: refund, ...approvalOverrides }) }),
    ...overrides,
  };
}

function post(saleRef: string, body: Record<string, unknown>, key = nextKey()) {
  return h.harness!.http().post(`/api/pos/v1/sales/${saleRef}/credit-reversals`).set("Idempotency-Key", key).send(body);
}

interface Written {
  voids: number;
  returns: number;
  reversals: number;
  tenders: number;
  returnTenders: number;
  outbox: number;
  approvalUses: number;
}

async function written(saleRef: string): Promise<Written> {
  const r = await h.harness!.env.admin.query<Record<keyof Written, string>>(
    `SELECT (SELECT count(*) FROM sale_voids WHERE sale_id = $1)::text AS voids,
            (SELECT count(*) FROM sale_returns WHERE sale_id = $1)::text AS returns,
            (SELECT count(*) FROM sale_credit_reversals WHERE sale_id = $1)::text AS reversals,
            (SELECT count(*) FROM sale_credit_reversal_tenders t JOIN sale_credit_reversals c ON c.id = t.reversal_id
              WHERE c.sale_id = $1)::text AS tenders,
            (SELECT count(*) FROM sale_return_tenders t JOIN sale_returns r ON r.id = t.return_id
              WHERE r.sale_id = $1)::text AS "returnTenders",
            (SELECT count(*) FROM outbox_events WHERE payload->>'sale_id' = $1::text)::text AS outbox,
            (SELECT count(*) FROM sale_approval_uses)::text AS "approvalUses"`,
    [saleRef],
  );
  const row = r.rows[0]!;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)])) as unknown as Written;
}

type Res = { status: number; body: { error?: { code?: string } } & Record<string, unknown>; headers: Record<string, string> };

function expectCode(res: Res, status: number, code: string): void {
  expect({ status: res.status, code: res.body.error?.code }).toEqual({ status, code });
}

/** Assert a refusal changed nothing and emitted no audit event. */
async function expectRefusedWithoutWrites(saleRef: string, send: () => Promise<Res>, status: number, code: string): Promise<void> {
  const before = await written(saleRef);
  const audits = spy.calls.length;
  expectCode(await send(), status, code);
  expect(await written(saleRef)).toEqual(before);
  expect(spy.calls.length).toBe(audits);
}

describe("RT-577 credit reversal — authorization", () => {
  it.each([
    ["a cashier", HARNESS_REQUESTER],
    ["a store-staff user with all-store access", APPROVER_CASHIER],
    ["a revoked store manager", APPROVER_REVOKED],
  ])("refuses %s with 403 credit_reversal_role_refused and writes nothing", async (_who, actor) => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "auth-1" });
    h.harness!.contextGuard.userId = actor;
    await expectRefusedWithoutWrites(saleRef, () => post(saleRef, returnBody(saleRef, [lineRefs[0]!], "1")), 403, "credit_reversal_role_refused");
  });

  it("refuses the role before the credit status: a cashier on a cash sale is 403, not 422", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "auth-2", credit: "0", tenders: [{ method: "cash", amount: "12.5" }] });
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    expectCode(await post(saleRef, returnBody(saleRef, [lineRefs[0]!], "5")), 403, "credit_reversal_role_refused");
  });

  it("refuses a sale without responsibilities with 422 credit_reversal_not_applicable", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "auth-3", credit: "0", tenders: [{ method: "cash", amount: "12.5" }] });
    await expectRefusedWithoutWrites(saleRef, () => post(saleRef, returnBody(saleRef, [lineRefs[0]!], "5")), 422, "credit_reversal_not_applicable");
  });
});

describe("RT-577 credit reversal — the Manager/Admin void (D8 mirror)", () => {
  it("voids a mixed sale: refunds the collected cash, adjusts the credit share, sale reads voided", async () => {
    if (skip()) return;
    const { saleRef } = await captureSale({ externalId: "void-1" });
    const res = await post(saleRef, await voidBody(saleRef));
    expect(res.status).toBe(201);
    expectValidReversal(res.body);
    expect(res.body).toMatchObject({
      saleRef,
      kind: "void",
      currencyCode: "USD",
      reversalTotal: "12.5000",
      refundableAmount: "2.5000",
      receivableAdjustment: { payerRef: PAYER, amount: "10.0000" },
      lines: [],
      refundTenders: [{ method: "cash", amount: "2.5000" }],
      reason: "customer cancelled the order",
    });
    const read = await h.harness!.http().get(`/api/pos/v1/sales/${saleRef}`);
    expect(read.body.voided).toBe(true);
    expect(await written(saleRef)).toMatchObject({ voids: 1, reversals: 1, tenders: 1, approvalUses: 1 });
  });

  it("mirrors a cash + card sale tender for tender; card goes back to card", async () => {
    if (skip()) return;
    const { saleRef } = await captureSale({
      externalId: "void-card",
      tenders: [
        { method: "cash", amount: "1.5", tenderRef: TENDER_CASH, sequence: 1 },
        { method: "card_external", amount: "1", reference: "AB12", tenderRef: TENDER_CARD, sequence: 2 },
      ],
    });
    const mirror = [
      { method: "card_external", amount: "1", tenderRef: TENDER_CARD, reference: "RF9" },
      { method: "cash", amount: "1.5", tenderRef: TENDER_CASH },
    ];
    const res = await post(saleRef, await voidBody(saleRef, { refundTenders: mirror }));
    expect(res.status).toBe(201);
    expectValidReversal(res.body);
    expect(res.body["refundTenders"]).toEqual([
      { method: "card_external", amount: "1.0000", tenderRef: TENDER_CARD, reference: "RF9" },
      { method: "cash", amount: "1.5000", tenderRef: TENDER_CASH },
    ]);
  });

  it.each([
    ["the card share paid back as cash", [{ method: "cash", amount: "2.5" }]],
    ["a tender missing", [{ method: "cash", amount: "1.5", tenderRef: TENDER_CASH }]],
    ["a wrong tenderRef", [{ method: "cash", amount: "1.5", tenderRef: TENDER_CARD }, { method: "card_external", amount: "1", tenderRef: TENDER_CASH }]],
  ])("refuses %s with 422 credit_reversal_refund_mismatch and writes nothing", async (_name, refundTenders) => {
    if (skip()) return;
    const { saleRef } = await captureSale({
      externalId: "void-card-bad",
      tenders: [
        { method: "cash", amount: "1.5", tenderRef: TENDER_CASH, sequence: 1 },
        { method: "card_external", amount: "1", tenderRef: TENDER_CARD, sequence: 2 },
      ],
    });
    const body = await voidBody(saleRef, { refundTenders });
    await expectRefusedWithoutWrites(saleRef, () => post(saleRef, body), 422, "credit_reversal_refund_mismatch");
  });

  it("keeps RT-530 on a credit void: no approval → 403 void_approval_required; another day → 422", async () => {
    if (skip()) return;
    const { saleRef } = await captureSale({ externalId: "void-530" });
    const body = await voidBody(saleRef);
    const { approval: _a, ...noApproval } = body;
    await expectRefusedWithoutWrites(saleRef, () => post(saleRef, noApproval), 403, "void_approval_required");
    await expectRefusedWithoutWrites(saleRef, () => post(saleRef, { ...body, businessDate: "2020-01-01" }), 422, "void_outside_business_day");
    await expectRefusedWithoutWrites(
      saleRef,
      async () => post(saleRef, await voidBody(saleRef, {}, { approverUserId: APPROVER_MANAGER })),
      403,
      "void_self_approval",
    );
  });

  it("refuses a credit void of a sale with a return: 409 already_reversed", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "void-excl" });
    expect((await post(saleRef, returnBody(saleRef, [lineRefs[0]!], "1"))).status).toBe(201);
    await expectRefusedWithoutWrites(saleRef, async () => post(saleRef, await voidBody(saleRef, { externalId: "credit-void-2" })), 409, "already_reversed");
  });
});

describe("RT-577 credit reversal — allocation (D7: pro rata, floor, cumulative)", () => {
  it("allocates two partial returns of a mixed sale so refunds sum to the cash and adjustments to the credit", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "alloc-1" });
    const first = await post(saleRef, returnBody(saleRef, [lineRefs[0]!], "1"));
    expect(first.status).toBe(201);
    expectValidReversal(first.body);
    expect(first.body).toMatchObject({ reversalTotal: "5.0000", refundableAmount: "1.0000", receivableAdjustment: { amount: "4.0000" } });
    const second = await post(saleRef, returnBody(saleRef, [lineRefs[1]!], "1.5"));
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ reversalTotal: "7.5000", refundableAmount: "1.5000", receivableAdjustment: { amount: "6.0000" } });
  });

  it("sums a repeating fraction exactly: 1.00 of 3.00 collected, three 1.00 returns refund 0.33 + 0.33 + 0.34", async () => {
    if (skip()) return;
    const one = { unitPrice: "1.0000", lineAmount: "1.0000" };
    const { saleRef, lineRefs } = await captureSale({
      externalId: "alloc-3",
      posTotal: "3.0000",
      tenders: [{ method: "cash", amount: "1" }],
      credit: "2",
      lines: [{ lineName: "A", ...one }, { lineName: "B", ...one }, { lineName: "C", ...one }],
    });
    const refunds: string[] = [];
    const adjustments: string[] = [];
    for (const [i, refund] of ["0.33", "0.33", "0.34"].entries()) {
      const res = await post(saleRef, returnBody(saleRef, [lineRefs[i]!], refund));
      expect(res.status).toBe(201);
      refunds.push(res.body["refundableAmount"] as string);
      adjustments.push((res.body["receivableAdjustment"] as { amount: string }).amount);
    }
    expect(refunds).toEqual(["0.3300", "0.3300", "0.3400"]);
    expect(adjustments).toEqual(["0.6700", "0.6700", "0.6600"]);
  });

  it("floors to a 0-decimal currency (JPY): 100 of 300 collected refunds 33 + 33 + 34", async () => {
    if (skip()) return;
    const hundred = { unitPrice: "100", lineAmount: "100" };
    const { saleRef, lineRefs } = await captureSale({
      externalId: "alloc-jpy",
      currency: "JPY",
      posTotal: "300",
      tenders: [{ method: "cash", amount: "100" }],
      credit: "200",
      lines: [{ lineName: "A", ...hundred }, { lineName: "B", ...hundred }, { lineName: "C", ...hundred }],
    });
    const refunds: string[] = [];
    for (const [i, refund] of ["33", "33", "34"].entries()) {
      const res = await post(saleRef, returnBody(saleRef, [lineRefs[i]!], refund));
      expect(res.status).toBe(201);
      refunds.push(res.body["refundableAmount"] as string);
    }
    expect(refunds).toEqual(["33.0000", "33.0000", "34.0000"]);
  });

  it("refunds nothing on a full-credit sale and needs no second approval", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "alloc-full", tenders: [], credit: "12.5" });
    const res = await post(saleRef, returnBody(saleRef, [lineRefs[0]!], null));
    expect(res.status).toBe(201);
    expectValidReversal(res.body);
    expect(res.body).toMatchObject({ refundableAmount: "0.0000", refundTenders: [], receivableAdjustment: { amount: "5.0000" } });
    expect(await written(saleRef)).toMatchObject({ returnTenders: 0, approvalUses: 0 });
  });

  it("never pays out uncollected credit: a refund above the collected share is 422 credit_reversal_refund_mismatch", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "alloc-over" });
    // The collected share of the 5.00 line is 1.00; the till asks for the whole
    // line (the second approval is bound to the true 1.00, so only the tenders fail).
    const body = returnBody(saleRef, [lineRefs[0]!], "5", {}, { amount: "1" });
    await expectRefusedWithoutWrites(saleRef, () => post(saleRef, body), 422, "credit_reversal_refund_mismatch");
    const full = await captureSale({ externalId: "alloc-over-2", tenders: [], credit: "12.5" });
    const payout = returnBody(full.saleRef, [full.lineRefs[0]!], "1", {}, { amount: "0", saleRef: full.saleRef });
    await expectRefusedWithoutWrites(full.saleRef, () => post(full.saleRef, payout), 422, "credit_reversal_refund_mismatch");
  });
});

describe("RT-577 credit reversal — D6 second approval of a cash-paying return", () => {
  it("requires it when the return pays out cash: 403 credit_return_approval_required", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "d6-1" });
    const { approval: _a, ...body } = returnBody(saleRef, [lineRefs[0]!], "1");
    await expectRefusedWithoutWrites(saleRef, () => post(saleRef, body), 403, "credit_return_approval_required");
  });

  it.each([
    ["the requester approving their own return", { approverUserId: APPROVER_TENANT_ADMIN }],
    ["the seller approving", { approverUserId: APPROVER_MANAGER }],
    ["a cashier approving", { approverUserId: APPROVER_CASHIER }],
    ["a revoked manager approving", { approverUserId: APPROVER_REVOKED }],
    ["an approval bound to another action", { action: "sale.void" }],
    ["an approval bound to another amount", { amount: "2" }],
    ["an approval bound to another sale", { saleRef: "0a000000-0000-7000-8000-0000005771ff" }],
    ["a requester who is not the actor", { requesterUserId: APPROVER_OWNER }],
    ["a future-dated approval", { approvedAt: new Date(Date.now() + 3_600_000).toISOString() }],
  ])("refuses %s with 403 credit_return_approval_refused and writes nothing", async (_name, overrides) => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "d6-2" });
    const body = returnBody(saleRef, [lineRefs[0]!], "1", {}, overrides);
    await expectRefusedWithoutWrites(saleRef, () => post(saleRef, body), 403, "credit_return_approval_refused");
  });

  it("refuses an approval id already used by a void: single use across routes", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "d6-3" });
    const used = nextApprovalId();
    await h.harness!.env.admin.query(`INSERT INTO sale_approval_uses (tenant_id, approval_id, source) VALUES ($1, $2, 'void')`, [TENANT_A, used]);
    const body = returnBody(saleRef, [lineRefs[0]!], "1", {}, { approvalId: used });
    await expectRefusedWithoutWrites(saleRef, () => post(saleRef, body), 403, "credit_return_approval_refused");
  });

  it("checks an approval sent with a zero-payout return (its amount must be 0)", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "d6-4", tenders: [], credit: "12.5" });
    const stale = { ...returnBody(saleRef, [lineRefs[0]!], null), approval: approval(saleRef, { amount: "1" }) };
    await expectRefusedWithoutWrites(saleRef, () => post(saleRef, stale), 403, "credit_return_approval_refused");
    const zero = { ...returnBody(saleRef, [lineRefs[0]!], null), approval: approval(saleRef, { amount: "0" }) };
    expect((await post(saleRef, zero)).status).toBe(201);
  });

  it("records the approval and consumes its id", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "d6-5" });
    const body = returnBody(saleRef, [lineRefs[0]!], "1");
    expect((await post(saleRef, body)).status).toBe(201);
    const id = (body["approval"] as { approvalId: string }).approvalId;
    const r = await h.harness!.env.admin.query(`SELECT source FROM sale_approval_uses WHERE approval_id = $1`, [id]);
    expect(r.rows).toEqual([{ source: "credit_return" }]);
  });
});

describe("RT-577 credit reversal — fail closed", () => {
  async function seedOrdinaryReturn(saleRef: string): Promise<void> {
    await h.harness!.env.admin.query(
      `INSERT INTO sale_returns (sale_id, tenant_id, store_id, return_seq, business_date, currency_code, return_total,
                                 source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, 1, CURRENT_DATE, 'USD', 1, 'pos-1', 'legacy-ret', $4, $5)`,
      [saleRef, TENANT_A, STORE_A_X, "a".repeat(64), APPROVER_MANAGER],
    );
  }

  it.each([
    ["a return recorded through recordReturn", (saleRef: string) => seedOrdinaryReturn(saleRef)],
    ["lines that do not sum to posTotal (mismatch_flag true)", (saleRef: string) =>
      h.harness!.env.admin.query(`UPDATE sales SET mismatch_flag = true WHERE id = $1`, [saleRef]).then(() => undefined)],
    ["a mismatch_flag never recorded (null)", (saleRef: string) =>
      h.harness!.env.admin.query(`UPDATE sales SET mismatch_flag = NULL WHERE id = $1`, [saleRef]).then(() => undefined)],
  ])("refuses %s with 422 credit_reversal_allocation_unavailable", async (_name, seed) => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "fc-alloc" });
    await seed(saleRef);
    await expectRefusedWithoutWrites(saleRef, () => post(saleRef, returnBody(saleRef, [lineRefs[1]!], "1.5")), 422, "credit_reversal_allocation_unavailable");
  });

  it.each([
    ["a suspended payer", `UPDATE payer_account SET status = 'suspended' WHERE id = '${PAYER}'`],
    ["a payer with no ERPNext link", `UPDATE payer_account SET external_ref = ' ' WHERE id = '${PAYER}'`],
  ])("refuses %s with 422 credit_reversal_settlement_unavailable", async (_name, sql) => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "fc-settle" });
    await h.harness!.env.admin.query(sql);
    await expectRefusedWithoutWrites(saleRef, () => post(saleRef, returnBody(saleRef, [lineRefs[0]!], "1")), 422, "credit_reversal_settlement_unavailable");
  });
});

describe("RT-577 credit reversal — request validation and precedence", () => {
  it.each([
    ["a void with lines", (s: string, l: string[]) => ({ ...returnBody(s, [l[0]!], null), kind: "void" })],
    ["a return with a businessDate", (s: string, l: string[]) => ({ ...returnBody(s, [l[0]!], null), businessDate: "2026-10-17" })],
    ["a return with a card refund", (s: string, l: string[]) => ({ ...returnBody(s, [l[0]!], "1"), refundTenders: [{ method: "card_external", amount: "1" }] })],
    ["a blank reason", (s: string, l: string[]) => ({ ...returnBody(s, [l[0]!], null), reason: "   " })],
    ["a reason holding NUL", (s: string, l: string[]) => ({ ...returnBody(s, [l[0]!], null), reason: "bad\u0000reason" })],
    ["no reason", (s: string, l: string[]) => { const { reason: _r, ...b } = returnBody(s, [l[0]!], null); return b; }],
    ["an unknown field", (s: string, l: string[]) => ({ ...returnBody(s, [l[0]!], null), tenantId: TENANT_A })],
  ])("refuses %s with 400 and writes nothing", async (_name, build) => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "val-1" });
    const before = await written(saleRef);
    expect((await post(saleRef, build(saleRef, lineRefs))).status).toBe(400);
    expect(await written(saleRef)).toEqual(before);
  });

  it("answers 404 for an unknown sale and for a credit return while POS_RETURNS_ENABLED is off", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "val-2" });
    const ghost = "0a000000-0000-7000-8000-0000005771fe";
    expect((await post(ghost, returnBody(ghost, [lineRefs[0]!], null))).status).toBe(404);
    disableReturns();
    expect((await post(saleRef, returnBody(saleRef, [lineRefs[0]!], null))).status).toBe(404);
  });

  it("over-returns are 409 over_return, and a foreign line is 400", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "val-3" });
    await expectRefusedWithoutWrites(
      saleRef,
      () => post(saleRef, { ...returnBody(saleRef, [lineRefs[0]!], null), lines: [{ lineRef: lineRefs[0], quantity: "2" }] }),
      409,
      "over_return",
    );
    const other = await captureSale({ externalId: "val-3b" });
    expect((await post(saleRef, returnBody(saleRef, [other.lineRefs[0]!], null))).status).toBe(400);
  });
});

describe("RT-577 credit reversal — replay and idempotency", () => {
  it("replays the same provenance and payload with 200 and the identical body, writing nothing", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "rep-1" });
    const body = returnBody(saleRef, [lineRefs[0]!], "1");
    const first = await post(saleRef, body);
    expect(first.status).toBe(201);
    const before = await written(saleRef);
    const again = await post(saleRef, body);
    expect({ status: again.status, replayed: again.headers["idempotent-replayed"] }).toEqual({ status: 200, replayed: "true" });
    expect(again.body).toEqual(first.body);
    expect(await written(saleRef)).toEqual(before);
  });

  it("replays a same-key retry with the stored 201", async () => {
    if (skip()) return;
    const { saleRef } = await captureSale({ externalId: "rep-2" });
    const body = await voidBody(saleRef);
    const key = nextKey();
    const first = await post(saleRef, body, key);
    const retry = await post(saleRef, body, key);
    expect({ status: retry.status, replayed: retry.headers["idempotent-replayed"] }).toEqual({ status: 201, replayed: "true" });
    expect(retry.body).toEqual(first.body);
  });

  it("refuses the same provenance with a different payload or on another sale: 409 conflict", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "rep-3" });
    const body = returnBody(saleRef, [lineRefs[0]!], "1");
    expect((await post(saleRef, body)).status).toBe(201);
    expectCode(await post(saleRef, { ...body, reason: "changed" }), 409, "conflict");
    const other = await captureSale({ externalId: "rep-3b" });
    expectCode(await post(other.saleRef, { ...body, lines: [{ lineRef: other.lineRefs[0], quantity: "1" }] }), 409, "conflict");
  });

  it("a replay never re-checks: a stored result survives the payer's suspension", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "rep-4" });
    const body = returnBody(saleRef, [lineRefs[0]!], "1");
    expect((await post(saleRef, body)).status).toBe(201);
    await h.harness!.env.admin.query(`UPDATE payer_account SET status = 'suspended' WHERE id = $1`, [PAYER]);
    expect((await post(saleRef, body)).status).toBe(200);
  });
});

describe("RT-577 credit reversal — audit trail and posting", () => {
  it("emits one sale.credit_reversed audit event with the decision's evidence, and one posting reversal", async () => {
    if (skip()) return;
    const { saleRef, lineRefs } = await captureSale({ externalId: "audit-1" });
    const body = returnBody(saleRef, [lineRefs[0]!], "1");
    const res = await post(saleRef, body);
    expect(res.status).toBe(201);
    const events = spy.calls.filter((c) => c.action === "sale.credit_reversed");
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({ actor_user_id: APPROVER_TENANT_ADMIN, tenant_id: TENANT_A, store_id: STORE_A_X });
    expect(e.metadata).toMatchObject({
      sale_ref: saleRef,
      reversal_ref: res.body["reversalRef"],
      kind: "return",
      actor_role: "tenant_admin",
      reason: "customer returned the goods",
      reversal_total: "5.0000",
      refundable_amount: "1.0000",
      refund_tenders: [{ method: "cash", amount: "1.0000" }],
      receivable_adjustment: { payer_ref: PAYER, amount: "4.0000", adjustment_ref: (res.body["receivableAdjustment"] as { adjustmentRef: string }).adjustmentRef },
      approval_id: (body["approval"] as { approvalId: string }).approvalId,
      approver_user_id: APPROVER_OWNER,
      requester_user_id: APPROVER_TENANT_ADMIN,
    });
    expect(typeof (e.metadata as Record<string, unknown>)["recorded_at"]).toBe("string");
    const outbox = await h.harness!.env.admin.query(
      `SELECT payload->>'kind' AS kind FROM outbox_events WHERE payload->>'sale_id' = $1 AND payload->>'kind' = 'reversal'`,
      [saleRef],
    );
    expect(outbox.rows).toEqual([{ kind: "reversal" }]);
  });
});
