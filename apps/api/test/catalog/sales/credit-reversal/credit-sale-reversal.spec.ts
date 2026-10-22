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
  STORE_A_Y,
  STORE_B_X,
  TENANT_A,
  TENANT_B,
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
import {
  disableReturns,
  enableReturns,
  executionBody,
  postExecution,
  uuidFor,
} from "../terminal/__returns-support";

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

const SALES = "SELECT id FROM sales WHERE source_system = 'pos-1'";
const RETURNS = `SELECT id FROM sale_returns WHERE sale_id IN (${SALES})`;
const CLEANUP: readonly string[] = [
  `DELETE FROM sale_credit_reversal_tenders`,
  `DELETE FROM sale_credit_reversals`,
  `DELETE FROM sale_approval_uses`,
  `DELETE FROM sale_return_tenders WHERE return_id IN (${RETURNS})`,
  `DELETE FROM sale_return_lines WHERE return_id IN (${RETURNS})`,
  `DELETE FROM sale_returns WHERE sale_id IN (${SALES})`,
  `DELETE FROM sale_voids WHERE sale_id IN (${SALES})`,
  `DELETE FROM sale_refunds WHERE sale_id IN (${SALES})`,
  `DELETE FROM sale_responsibilities WHERE sale_id IN (${SALES})`,
  `DELETE FROM sale_tenders WHERE sale_id IN (${SALES})`,
  `DELETE FROM sale_lines WHERE sale_id IN (${SALES})`,
  `DELETE FROM sales WHERE source_system = 'pos-1'`,
  `DELETE FROM outbox_events`,
  `UPDATE payer_account SET status = 'active', external_ref = 'CUST-577', store_id = '${STORE_A_X}' WHERE id = '${PAYER}'`,
];
afterEach(async () => {
  if (!h.harness) return;
  for (const sql of CLEANUP) await h.harness.env.admin.query(sql);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

let keySeq = 0;
const nextKey = (): string => idempKey(`rt577c${(keySeq += 1)}`);
let approvalSeq = 0;
const nextApprovalId = (): string => `0a000000-0000-7000-8000-${(0x5772000000 + (approvalSeq += 1)).toString(16).padStart(12, "0")}`;

type Body = Record<string, unknown>;

interface Line {
  readonly lineName: string;
  readonly unitPrice: string;
  readonly lineAmount: string;
}

interface CaptureSpec {
  readonly externalId: string;
  readonly tenders?: ReadonlyArray<Body>;
  readonly credit?: string;
  readonly lines?: ReadonlyArray<Line>;
  readonly posTotal?: string;
  readonly currency?: string;
}

interface CapturedSale {
  readonly saleRef: string;
  /** Line refs in REQUEST order (the projection's order is not the request's). */
  readonly lineRefs: string[];
}

const DEFAULT_LINES: ReadonlyArray<Line> = [
  { lineName: "Widget", unitPrice: "5.0000", lineAmount: "5.0000" },
  { lineName: "Gadget", unitPrice: "7.5000", lineAmount: "7.5000" },
];

/** The capture body. Defaults: USD 12.5 = cash 2.5 + credit 10, lines 5 + 7.5. */
function captureRequest(spec: CaptureSpec): { body: Body; lines: ReadonlyArray<Line> } {
  const currency = spec.currency ?? "USD";
  const lines = spec.lines ?? DEFAULT_LINES;
  const credit = spec.credit ?? "10";
  const tenders = spec.tenders ?? [{ method: "cash", amount: "2.5" }];
  const body = captureBody({
    externalId: spec.externalId,
    currencyCode: currency,
    posTotal: spec.posTotal ?? "12.5000",
    lines: lines.map((l) => ({ ...l, currencyCode: currency, quantity: "1", unit: "ea" })),
    ...(tenders.length === 0 ? {} : { tenders }),
    ...(credit === "0" ? {} : { responsibilities: [{ payerRef: PAYER, amount: credit, sequence: 1 }] }),
  });
  return { body, lines };
}

/** Capture as the store manager (the seller), then restore the actor. */
async function captureSale(spec: CaptureSpec): Promise<CapturedSale> {
  const harness = h.harness!;
  const actor = harness.contextGuard.userId;
  harness.contextGuard.userId = APPROVER_MANAGER;
  const { body, lines } = captureRequest(spec);
  const res = await harness.http().post("/api/pos/v1/sales").set("Idempotency-Key", nextKey()).send(body);
  harness.contextGuard.userId = actor;
  if (res.status !== 201) throw new Error(`capture failed: ${res.status} ${JSON.stringify(res.body)}`);
  const byName = new Map((res.body.lines as Array<{ lineRef: string; lineName: string }>).map((l) => [l.lineName, l.lineRef]));
  return { saleRef: res.body.saleRef, lineRefs: lines.map((l) => byName.get(l.lineName)!) };
}

async function saleFacts(sale: CapturedSale): Promise<{ amount: string; businessDate: string }> {
  const r = await h.harness!.env.admin.query<{ amount: string; business_date: string }>(
    `SELECT pos_total::text AS amount, business_date::text AS business_date FROM sales WHERE id = $1`,
    [sale.saleRef],
  );
  return { amount: r.rows[0]!.amount, businessDate: r.rows[0]!.business_date };
}

/** An RT-530-shaped second approval for `sale`, requested by the current actor. */
function approval(sale: CapturedSale, overrides: Body): Body {
  return {
    approvalId: nextApprovalId(),
    action: "sale.credit_return",
    saleRef: sale.saleRef,
    amount: "0",
    requesterUserId: h.harness!.contextGuard.userId,
    approverUserId: APPROVER_OWNER,
    policyVersion: "rt114-2026-10-07",
    approvedAt: new Date().toISOString(),
    ...overrides,
  };
}

interface BodyOptions {
  /** Top-level body overrides. */
  readonly overrides?: Body;
  /** Overrides of the approval. */
  readonly approval?: Body;
}

/** A valid credit void: the cash 2.5 mirrored, the RT-530 approval bound to posTotal. */
async function voidBody(sale: CapturedSale, opts: BodyOptions = {}): Promise<Body> {
  const facts = await saleFacts(sale);
  return {
    sourceSystem: "pos-1",
    externalId: "credit-void-1",
    kind: "void",
    refundTenders: [{ method: "cash", amount: "2.5" }],
    reason: "customer cancelled the order",
    businessDate: facts.businessDate,
    approval: approval(sale, { action: "sale.void", amount: facts.amount, ...opts.approval }),
    ...opts.overrides,
  };
}

interface ReturnOptions extends BodyOptions {
  /** Indexes into the sale's lines, each returned in quantity 1. */
  readonly lines: ReadonlyArray<number>;
  /** The cash refund (and its approval's amount); absent for a zero-payout return. */
  readonly refund?: string;
}

function returnBody(sale: CapturedSale, opts: ReturnOptions): Body {
  const lineRefs = opts.lines.map((i) => sale.lineRefs[i]!);
  const paysOut = opts.refund !== undefined;
  return {
    sourceSystem: "pos-1",
    externalId: `credit-return-${lineRefs.join("-").slice(-12)}`,
    kind: "return",
    lines: lineRefs.map((lineRef) => ({ lineRef, quantity: "1" })),
    refundTenders: paysOut ? [{ method: "cash", amount: opts.refund }] : [],
    reason: "customer returned the goods",
    ...(paysOut ? { approval: approval(sale, { amount: opts.refund, ...opts.approval }) } : {}),
    ...opts.overrides,
  };
}

function post(sale: CapturedSale, body: Body, opts: { readonly key?: string } = {}) {
  return h.harness!.http()
    .post(`/api/pos/v1/sales/${sale.saleRef}/credit-reversals`)
    .set("Idempotency-Key", opts.key ?? nextKey())
    .send(body);
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

async function written(sale: CapturedSale): Promise<Written> {
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
    [sale.saleRef],
  );
  return Object.fromEntries(Object.entries(r.rows[0]!).map(([k, v]) => [k, Number(v)])) as unknown as Written;
}

type Res = { status: number; body: { error?: { code?: string } } & Body; headers: Record<string, string> };

interface Refusal {
  readonly status: number;
  readonly code: string;
}

const ROLE_REFUSED: Refusal = { status: 403, code: "credit_reversal_role_refused" };
const NOT_APPLICABLE: Refusal = { status: 422, code: "credit_reversal_not_applicable" };
const REFUND_MISMATCH: Refusal = { status: 422, code: "credit_reversal_refund_mismatch" };
const ALLOCATION_UNAVAILABLE: Refusal = { status: 422, code: "credit_reversal_allocation_unavailable" };
const SETTLEMENT_UNAVAILABLE: Refusal = { status: 422, code: "credit_reversal_settlement_unavailable" };
const APPROVAL_REQUIRED: Refusal = { status: 403, code: "credit_return_approval_required" };
const APPROVAL_REFUSED: Refusal = { status: 403, code: "credit_return_approval_refused" };
const ALREADY_REVERSED: Refusal = { status: 409, code: "already_reversed" };
const OVER_RETURN: Refusal = { status: 409, code: "over_return" };
const CONFLICT: Refusal = { status: 409, code: "conflict" };

function expectRefusal(res: Res, refusal: Refusal): void {
  expect({ status: res.status, code: res.body.error?.code }).toEqual({ status: refusal.status, code: refusal.code });
}

/** Assert a refusal changed nothing and emitted no audit event. */
async function expectRefusedWithoutWrites(sale: CapturedSale, send: () => Promise<Res>, refusal: Refusal): Promise<void> {
  const before = await written(sale);
  const audits = spy.calls.length;
  expectRefusal(await send(), refusal);
  expect(await written(sale)).toEqual(before);
  expect(spy.calls).toHaveLength(audits);
}

const CASH_SALE: Omit<CaptureSpec, "externalId"> = { credit: "0", tenders: [{ method: "cash", amount: "12.5" }] };
const FULL_CREDIT: Omit<CaptureSpec, "externalId"> = { tenders: [], credit: "12.5" };
const MIXED_CARD: Omit<CaptureSpec, "externalId"> = {
  tenders: [
    { method: "cash", amount: "1.5", tenderRef: TENDER_CASH, sequence: 1 },
    { method: "card_external", amount: "1", reference: "AB12", tenderRef: TENDER_CARD, sequence: 2 },
  ],
};

describe("RT-577 credit reversal — authorization", () => {
  it.each([
    ["a cashier", HARNESS_REQUESTER],
    ["a store-staff user with all-store access", APPROVER_CASHIER],
    ["a revoked store manager", APPROVER_REVOKED],
  ])("refuses %s with 403 credit_reversal_role_refused and writes nothing", async (_who, actor) => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "auth-1" });
    h.harness!.contextGuard.userId = actor;
    await expectRefusedWithoutWrites(sale, () => post(sale, returnBody(sale, { lines: [0], refund: "1" })), ROLE_REFUSED);
  });

  it("refuses the role before the credit status: a cashier on a cash sale is 403, not 422", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "auth-2", ...CASH_SALE });
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    expectRefusal(await post(sale, returnBody(sale, { lines: [0], refund: "5" })), ROLE_REFUSED);
  });

  it("refuses a sale without responsibilities with 422 credit_reversal_not_applicable", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "auth-3", ...CASH_SALE });
    await expectRefusedWithoutWrites(sale, () => post(sale, returnBody(sale, { lines: [0], refund: "5" })), NOT_APPLICABLE);
  });
});

describe("RT-577 credit reversal — the Manager/Admin void (D8 mirror)", () => {
  it("voids a mixed sale: refunds the collected cash, adjusts the credit share, sale reads voided", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "void-1" });
    const res = await post(sale, await voidBody(sale));
    expect(res.status).toBe(201);
    expectValidReversal(res.body);
    expect(res.body).toMatchObject({
      saleRef: sale.saleRef,
      kind: "void",
      currencyCode: "USD",
      reversalTotal: "12.5000",
      refundableAmount: "2.5000",
      receivableAdjustment: { payerRef: PAYER, amount: "10.0000" },
      lines: [],
      refundTenders: [{ method: "cash", amount: "2.5000" }],
      reason: "customer cancelled the order",
    });
    const read = await h.harness!.http().get(`/api/pos/v1/sales/${sale.saleRef}`);
    expect(read.body.voided).toBe(true);
    expect(await written(sale)).toMatchObject({ voids: 1, reversals: 1, tenders: 1, approvalUses: 1 });
  });

  it("mirrors a cash + card sale tender for tender; card goes back to card", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "void-card", ...MIXED_CARD });
    const mirror = [
      { method: "card_external", amount: "1", tenderRef: TENDER_CARD, reference: "RF9" },
      { method: "cash", amount: "1.5", tenderRef: TENDER_CASH },
    ];
    const res = await post(sale, await voidBody(sale, { overrides: { refundTenders: mirror } }));
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
    const sale = await captureSale({ externalId: "void-card-bad", ...MIXED_CARD });
    const body = await voidBody(sale, { overrides: { refundTenders } });
    await expectRefusedWithoutWrites(sale, () => post(sale, body), REFUND_MISMATCH);
  });

  it("keeps RT-530 on a credit void: no approval → 403 void_approval_required; another day → 422", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "void-530" });
    const body = await voidBody(sale);
    const { approval: _a, ...noApproval } = body;
    await expectRefusedWithoutWrites(sale, () => post(sale, noApproval), { status: 403, code: "void_approval_required" });
    await expectRefusedWithoutWrites(sale, () => post(sale, { ...body, businessDate: "2020-01-01" }), { status: 422, code: "void_outside_business_day" });
    const seller = await voidBody(sale, { approval: { approverUserId: APPROVER_MANAGER } });
    await expectRefusedWithoutWrites(sale, () => post(sale, seller), { status: 403, code: "void_self_approval" });
  });

  it("refuses a credit void of a sale with a return: 409 already_reversed", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "void-excl" });
    expect((await post(sale, returnBody(sale, { lines: [0], refund: "1" }))).status).toBe(201);
    const body = await voidBody(sale, { overrides: { externalId: "credit-void-2" } });
    await expectRefusedWithoutWrites(sale, () => post(sale, body), ALREADY_REVERSED);
  });
});

describe("RT-577 credit reversal — allocation (D7: pro rata, floor, cumulative)", () => {
  it("allocates two partial returns of a mixed sale so refunds sum to the cash and adjustments to the credit", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "alloc-1" });
    const first = await post(sale, returnBody(sale, { lines: [0], refund: "1" }));
    expect(first.status).toBe(201);
    expectValidReversal(first.body);
    expect(first.body).toMatchObject({ reversalTotal: "5.0000", refundableAmount: "1.0000", receivableAdjustment: { amount: "4.0000" } });
    const second = await post(sale, returnBody(sale, { lines: [1], refund: "1.5" }));
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ reversalTotal: "7.5000", refundableAmount: "1.5000", receivableAdjustment: { amount: "6.0000" } });
  });

  /** Return each of three equal lines in turn; the refunds and adjustments, in order. */
  async function returnEachLine(sale: CapturedSale, refunds: ReadonlyArray<string>): Promise<{ refunds: unknown[]; adjustments: unknown[] }> {
    const out: { refunds: unknown[]; adjustments: unknown[] } = { refunds: [], adjustments: [] };
    for (const [i, refund] of refunds.entries()) {
      const res = await post(sale, returnBody(sale, { lines: [i], refund }));
      expect(res.status).toBe(201);
      out.refunds.push(res.body["refundableAmount"]);
      out.adjustments.push((res.body["receivableAdjustment"] as { amount: string }).amount);
    }
    return out;
  }

  it("sums a repeating fraction exactly: 1.00 of 3.00 collected, three 1.00 returns refund 0.33 + 0.33 + 0.34", async () => {
    if (skip()) return;
    const one = { unitPrice: "1.0000", lineAmount: "1.0000" };
    const sale = await captureSale({
      externalId: "alloc-3",
      posTotal: "3.0000",
      tenders: [{ method: "cash", amount: "1" }],
      credit: "2",
      lines: [{ lineName: "A", ...one }, { lineName: "B", ...one }, { lineName: "C", ...one }],
    });
    expect(await returnEachLine(sale, ["0.33", "0.33", "0.34"])).toEqual({
      refunds: ["0.3300", "0.3300", "0.3400"],
      adjustments: ["0.6700", "0.6700", "0.6600"],
    });
  });

  it("floors to a 0-decimal currency (JPY): 100 of 300 collected refunds 33 + 33 + 34", async () => {
    if (skip()) return;
    const hundred = { unitPrice: "100", lineAmount: "100" };
    const sale = await captureSale({
      externalId: "alloc-jpy",
      currency: "JPY",
      posTotal: "300",
      tenders: [{ method: "cash", amount: "100" }],
      credit: "200",
      lines: [{ lineName: "A", ...hundred }, { lineName: "B", ...hundred }, { lineName: "C", ...hundred }],
    });
    expect((await returnEachLine(sale, ["33", "33", "34"])).refunds).toEqual(["33.0000", "33.0000", "34.0000"]);
  });

  it("refunds nothing on a full-credit sale and needs no second approval", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "alloc-full", ...FULL_CREDIT });
    const res = await post(sale, returnBody(sale, { lines: [0] }));
    expect(res.status).toBe(201);
    expectValidReversal(res.body);
    expect(res.body).toMatchObject({ refundableAmount: "0.0000", refundTenders: [], receivableAdjustment: { amount: "5.0000" } });
    expect(await written(sale)).toMatchObject({ returnTenders: 0, approvalUses: 0 });
  });

  it("never pays out uncollected credit: a refund above the collected share is 422 credit_reversal_refund_mismatch", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "alloc-over" });
    // The collected share of the 5.00 line is 1.00; the till asks for the whole
    // line (the second approval is bound to the true 1.00, so only the tenders fail).
    const body = returnBody(sale, { lines: [0], refund: "5", approval: { amount: "1" } });
    await expectRefusedWithoutWrites(sale, () => post(sale, body), REFUND_MISMATCH);
    const full = await captureSale({ externalId: "alloc-over-2", ...FULL_CREDIT });
    const payout = returnBody(full, { lines: [0], refund: "1", approval: { amount: "0" } });
    await expectRefusedWithoutWrites(full, () => post(full, payout), REFUND_MISMATCH);
  });
});

describe("RT-577 credit reversal — D6 second approval of a cash-paying return", () => {
  it("requires it when the return pays out cash: 403 credit_return_approval_required", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "d6-1" });
    const { approval: _a, ...body } = returnBody(sale, { lines: [0], refund: "1" });
    await expectRefusedWithoutWrites(sale, () => post(sale, body), APPROVAL_REQUIRED);
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
    const sale = await captureSale({ externalId: "d6-2" });
    const body = returnBody(sale, { lines: [0], refund: "1", approval: overrides });
    await expectRefusedWithoutWrites(sale, () => post(sale, body), APPROVAL_REFUSED);
  });

  it("refuses an approval id already used by a void: single use across routes", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "d6-3" });
    const used = nextApprovalId();
    await h.harness!.env.admin.query(`INSERT INTO sale_approval_uses (tenant_id, approval_id, source) VALUES ($1, $2, 'void')`, [TENANT_A, used]);
    const body = returnBody(sale, { lines: [0], refund: "1", approval: { approvalId: used } });
    await expectRefusedWithoutWrites(sale, () => post(sale, body), APPROVAL_REFUSED);
  });

  it("checks an approval sent with a zero-payout return (its amount must be 0)", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "d6-4", ...FULL_CREDIT });
    const stale = { ...returnBody(sale, { lines: [0] }), approval: approval(sale, { amount: "1" }) };
    await expectRefusedWithoutWrites(sale, () => post(sale, stale), APPROVAL_REFUSED);
    const zero = { ...returnBody(sale, { lines: [0] }), approval: approval(sale, { amount: "0" }) };
    expect((await post(sale, zero)).status).toBe(201);
  });

  it("records the approval and consumes its id", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "d6-5" });
    const body = returnBody(sale, { lines: [0], refund: "1" });
    expect((await post(sale, body)).status).toBe(201);
    const id = (body["approval"] as { approvalId: string }).approvalId;
    const r = await h.harness!.env.admin.query(`SELECT source FROM sale_approval_uses WHERE approval_id = $1`, [id]);
    expect(r.rows).toEqual([{ source: "credit_return" }]);
  });
});

/** Seed an ordinary return on the sale (recorded through recordReturn before the runtime). */
async function seedOrdinaryReturn(sale: CapturedSale): Promise<void> {
  await h.harness!.env.admin.query(
    `INSERT INTO sale_returns (sale_id, tenant_id, store_id, return_seq, business_date, currency_code, return_total,
                               source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 1, CURRENT_DATE, 'USD', 1, 'pos-1', 'legacy-ret', $4, $5)`,
    [sale.saleRef, TENANT_A, STORE_A_X, "a".repeat(64), APPROVER_MANAGER],
  );
}

/** Seed an ordinary amount-only refund on the sale (recordRefund before the runtime). */
async function seedOrdinaryRefund(sale: CapturedSale): Promise<void> {
  await h.harness!.env.admin.query(
    `INSERT INTO sale_refunds (sale_id, tenant_id, store_id, pos_refund_amount, currency_code, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 1, 'USD', 'pos-1', 'legacy-ref', $4, $5)`,
    [sale.saleRef, TENANT_A, STORE_A_X, "b".repeat(64), APPROVER_MANAGER],
  );
}

/** Set the stored mismatch flag (true, or NULL: never recorded). */
async function setMismatchFlag(sale: CapturedSale, flag: { readonly value: boolean | null }): Promise<void> {
  await h.harness!.env.admin.query(`UPDATE sales SET mismatch_flag = $2 WHERE id = $1`, [sale.saleRef, flag.value]);
}

describe("RT-577 credit reversal — fail closed", () => {
  it.each([
    ["a return recorded through recordReturn", seedOrdinaryReturn],
    ["a refund recorded through recordRefund", seedOrdinaryRefund],
    ["lines that do not sum to posTotal (mismatch_flag true)", (sale: CapturedSale) => setMismatchFlag(sale, { value: true })],
    ["a mismatch_flag never recorded (null)", (sale: CapturedSale) => setMismatchFlag(sale, { value: null })],
  ])("refuses %s with 422 credit_reversal_allocation_unavailable", async (_name, seed) => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "fc-alloc" });
    await seed(sale);
    await expectRefusedWithoutWrites(sale, () => post(sale, returnBody(sale, { lines: [1], refund: "1.5" })), ALLOCATION_UNAVAILABLE);
  });

  it.each([
    ["a suspended payer", `UPDATE payer_account SET status = 'suspended' WHERE id = '${PAYER}'`],
    ["a payer with no ERPNext link", `UPDATE payer_account SET external_ref = ' ' WHERE id = '${PAYER}'`],
    ["a payer scoped to another store", `UPDATE payer_account SET store_id = '${STORE_A_Y}' WHERE id = '${PAYER}'`],
    // The sale is still a credit sale (responsibility_count 1) but its payer
    // row cannot be found (a visibility fault): never paid out.
    ["a payer that cannot be found", `DELETE FROM sale_responsibilities WHERE payer_id = '${PAYER}'`],
  ])("refuses %s with 422 credit_reversal_settlement_unavailable", async (_name, sql) => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "fc-settle" });
    await h.harness!.env.admin.query(sql);
    await expectRefusedWithoutWrites(sale, () => post(sale, returnBody(sale, { lines: [0], refund: "1" })), SETTLEMENT_UNAVAILABLE);
  });
});

/** A zero-payout return of the first line, with `extra` merged in. */
const zeroReturn = (sale: CapturedSale, extra: Body): Body => ({ ...returnBody(sale, { lines: [0] }), ...extra });

describe("RT-577 credit reversal — request validation and precedence", () => {
  it.each([
    ["a void with lines", (s: CapturedSale) => zeroReturn(s, { kind: "void" })],
    ["a return with a businessDate", (s: CapturedSale) => zeroReturn(s, { businessDate: "2026-10-17" })],
    ["a return with a card refund", (s: CapturedSale) => ({ ...returnBody(s, { lines: [0], refund: "1" }), refundTenders: [{ method: "card_external", amount: "1" }] })],
    ["a blank reason", (s: CapturedSale) => zeroReturn(s, { reason: "   " })],
    ["a reason holding NUL", (s: CapturedSale) => zeroReturn(s, { reason: "bad\u0000reason" })],
    ["no reason", (s: CapturedSale) => { const { reason: _r, ...b } = returnBody(s, { lines: [0] }); return b; }],
    ["an unknown field", (s: CapturedSale) => zeroReturn(s, { tenantId: TENANT_A })],
    ["a sourceSystem holding NUL", (s: CapturedSale) => zeroReturn(s, { sourceSystem: "pos\u00001" })],
    ["an externalId holding NUL", (s: CapturedSale) => zeroReturn(s, { externalId: "ret\u00001" })],
    ["an approval policyVersion holding NUL", (s: CapturedSale) => ({
      ...returnBody(s, { lines: [0], refund: "1" }),
      approval: approval(s, { amount: "1", policyVersion: "v\u00001" }),
    })],
  ])("refuses %s with 400 and writes nothing", async (_name, build) => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "val-1" });
    const before = await written(sale);
    expect((await post(sale, build(sale))).status).toBe(400);
    expect(await written(sale)).toEqual(before);
  });

  it("answers 404 for an unknown sale and for a credit return while POS_RETURNS_ENABLED is off", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "val-2" });
    const ghost: CapturedSale = { saleRef: "0a000000-0000-7000-8000-0000005771fe", lineRefs: sale.lineRefs };
    expect((await post(ghost, returnBody(ghost, { lines: [0] }))).status).toBe(404);
    disableReturns();
    expect((await post(sale, returnBody(sale, { lines: [0] }))).status).toBe(404);
  });

  it("over-returns are 409 over_return, and a foreign line is 400", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "val-3" });
    const over = zeroReturn(sale, { lines: [{ lineRef: sale.lineRefs[0], quantity: "2" }] });
    await expectRefusedWithoutWrites(sale, () => post(sale, over), OVER_RETURN);
    const other = await captureSale({ externalId: "val-3b" });
    const foreign = zeroReturn(sale, { lines: [{ lineRef: other.lineRefs[0], quantity: "1" }] });
    expect((await post(sale, foreign)).status).toBe(400);
  });
});

describe("RT-577 credit reversal — replay and idempotency", () => {
  it("replays the same provenance and payload with 200 and the identical body, writing nothing", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "rep-1" });
    const body = returnBody(sale, { lines: [0], refund: "1" });
    const first = await post(sale, body);
    expect(first.status).toBe(201);
    const before = await written(sale);
    const again = await post(sale, body);
    expect({ status: again.status, replayed: again.headers["idempotent-replayed"] }).toEqual({ status: 200, replayed: "true" });
    expect(again.body).toEqual(first.body);
    expect(await written(sale)).toEqual(before);
  });

  it("replays a same-key retry with the stored 201", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "rep-2" });
    const body = await voidBody(sale);
    const key = nextKey();
    const first = await post(sale, body, { key });
    const retry = await post(sale, body, { key });
    expect({ status: retry.status, replayed: retry.headers["idempotent-replayed"] }).toEqual({ status: 201, replayed: "true" });
    expect(retry.body).toEqual(first.body);
  });

  it("refuses the same provenance with a different payload or on another sale: 409 conflict", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "rep-3" });
    const body = returnBody(sale, { lines: [0], refund: "1" });
    expect((await post(sale, body)).status).toBe(201);
    expectRefusal(await post(sale, { ...body, reason: "changed" }), CONFLICT);
    const other = await captureSale({ externalId: "rep-3b" });
    expectRefusal(await post(other, { ...body, lines: [{ lineRef: other.lineRefs[0], quantity: "1" }] }), CONFLICT);
  });

  it("a replay never re-checks: a stored result survives the payer's suspension", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "rep-4" });
    const body = returnBody(sale, { lines: [0], refund: "1" });
    expect((await post(sale, body)).status).toBe(201);
    await h.harness!.env.admin.query(`UPDATE payer_account SET status = 'suspended' WHERE id = $1`, [PAYER]);
    expect((await post(sale, body)).status).toBe(200);
  });
});

describe("RT-577 credit reversal — audit trail and posting", () => {
  it("emits one sale.credit_reversed audit event with the decision's evidence, and one posting reversal", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "audit-1" });
    const body = returnBody(sale, { lines: [0], refund: "1" });
    const res = await post(sale, body);
    expect(res.status).toBe(201);
    const events = spy.calls.filter((c) => c.action === "sale.credit_reversed");
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toMatchObject({ actor_user_id: APPROVER_TENANT_ADMIN, tenant_id: TENANT_A, store_id: STORE_A_X });
    expect(e.metadata).toMatchObject({
      sale_ref: sale.saleRef,
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
    expect(typeof (e.metadata as Body)["recorded_at"]).toBe("string");
    const outbox = await h.harness!.env.admin.query(
      `SELECT payload->>'kind' AS kind FROM outbox_events WHERE payload->>'sale_id' = $1 AND payload->>'kind' = 'reversal'`,
      [sale.saleRef],
    );
    expect(outbox.rows).toEqual([{ kind: "reversal" }]);
  });
});

describe("RT-577 credit reversal — Opus review hardening (#806)", () => {
  it("a zero refund takes an empty list: [{cash, 0}] is 422 credit_reversal_refund_mismatch and writes no tender", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "zero-tender", ...FULL_CREDIT });
    const body = { ...returnBody(sale, { lines: [0] }), refundTenders: [{ method: "cash", amount: "0" }] };
    await expectRefusedWithoutWrites(sale, () => post(sale, body), REFUND_MISMATCH);
  });

  it.each([
    ["another store of the tenant", { tenantId: TENANT_A, storeId: STORE_A_Y }],
    ["another tenant", { tenantId: TENANT_B, storeId: STORE_B_X }],
  ])("is a non-disclosing 404 from %s, writing nothing", async (_name, scope) => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "scope-1" });
    const body = returnBody(sale, { lines: [0], refund: "1" });
    const before = await written(sale);
    Object.assign(h.harness!.contextGuard, scope);
    expect((await post(sale, body)).status).toBe(404);
    Object.assign(h.harness!.contextGuard, { tenantId: TENANT_A, storeId: STORE_A_X });
    expect(await written(sale)).toEqual(before);
  });

  it("serializes concurrent partial returns on the sale lock: the later one allocates from the earlier one's X0", async () => {
    if (skip()) return;
    const one = { unitPrice: "1.0000", lineAmount: "1.0000" };
    const sale = await captureSale({
      externalId: "concurrent-1",
      posTotal: "3.0000",
      tenders: [{ method: "cash", amount: "1" }],
      credit: "2",
      lines: [{ lineName: "A", ...one }, { lineName: "B", ...one }, { lineName: "C", ...one }],
    });
    expect((await post(sale, returnBody(sale, { lines: [0], refund: "0.33" }))).status).toBe(201);
    // B and C race. Serialized, the second sees X0 = 1.00 (0.33) and the third
    // X0 = 2.00 (0.34): only the one that commits second matches a 0.33
    // approval. A race on X0 would accept both at 0.33 and lose a minor unit.
    const [b, c] = await Promise.all([
      post(sale, returnBody(sale, { lines: [1], refund: "0.33" })),
      post(sale, returnBody(sale, { lines: [2], refund: "0.33" })),
    ]);
    expect([b.status, c.status].sort()).toEqual([201, 403]);
    const refusedLine = b.status === 403 ? 1 : 2;
    expectRefusal((b.status === 403 ? b : c) as Res, APPROVAL_REFUSED);
    expect((await post(sale, returnBody(sale, { lines: [refusedLine], refund: "0.34" }))).status).toBe(201);
    const totals = await h.harness!.env.admin.query<{ refunded: string; adjusted: string; n: number }>(
      `SELECT SUM(refundable_amount)::numeric(19,4)::text AS refunded,
              SUM(adjustment_amount)::numeric(19,4)::text AS adjusted, count(*)::int AS n
         FROM sale_credit_reversals WHERE sale_id = $1`,
      [sale.saleRef],
    );
    expect(totals.rows[0]).toEqual({ refunded: "1.0000", adjusted: "2.0000", n: 3 });
  });
});

describe("RT-787 — a credit sale stays outside RT-490 refund executions (RT-577)", () => {
  async function creditReturnRef(sale: CapturedSale): Promise<string> {
    const r = await h.harness!.env.admin.query<{ id: string }>(
      `SELECT id::text AS id FROM sale_returns WHERE sale_id = $1`,
      [sale.saleRef],
    );
    return r.rows[0]!.id;
  }

  async function executionsAndPostings(sale: CapturedSale): Promise<{ executions: string; postings: string }> {
    const r = await h.harness!.env.admin.query<{ executions: string; postings: string }>(
      `SELECT (SELECT count(*) FROM refund_executions WHERE sale_id = $1::uuid)::text AS executions,
              (SELECT count(*) FROM outbox_events WHERE payload->>'sale_id' = $1::text)::text AS postings`,
      [sale.saleRef],
    );
    return r.rows[0]!;
  }

  it("a refund execution against a credit return is the non-disclosing 404 and writes nothing", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "rt787-credit-exec" });
    expect((await post(sale, returnBody(sale, { lines: [0], refund: "1" }))).status).toBe(201);
    const returnRef = await creditReturnRef(sale);
    const before = await executionsAndPostings(sale);
    // Even naming an allocation id cannot pay out uncollected credit.
    const res = await postExecution(h, { saleRef: sale.saleRef, returnRef: returnRef }, executionBody("rt787-credit-e1", uuidFor("credit"), "1"), "rt787cx");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
    expect(await executionsAndPostings(sale)).toEqual(before);
    expect(before.executions).toBe("0");
  });

  it("the return reads do not list or resolve a credit return", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "rt787-credit-read" });
    const body = returnBody(sale, { lines: [0], refund: "1" });
    expect((await post(sale, body)).status).toBe(201);
    const list = await h.harness!.http().get(`/api/pos/v1/sales/${sale.saleRef}/returns`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ saleRef: sale.saleRef, returns: [] });
    const read = await h
      .harness!.http()
      .get(`/api/pos/v1/sales/${sale.saleRef}/returns/by-provenance`)
      .query({ sourceSystem: "pos-1", externalId: body["externalId"] as string });
    expect(read.status).toBe(404);
  });

  it("an ordinary return of a credit sale carrying allocation fields is still 403 credit_sale_reversal_restricted", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "rt787-credit-ordinary" });
    const res = await h
      .harness!.http()
      .post(`/api/pos/v1/sales/${sale.saleRef}/returns`)
      .set("Idempotency-Key", nextKey())
      .send({
        sourceSystem: "pos-1",
        externalId: "rt787-ordinary-1",
        lines: [{ lineRef: sale.lineRefs[0], quantity: "1" }],
        refundTenders: [{ method: "cash", amount: "5.0000", allocationRef: uuidFor("rt787-ordinary") }],
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("credit_sale_reversal_restricted");
    expect((await written(sale)).returns).toBe(0);
  });
});
