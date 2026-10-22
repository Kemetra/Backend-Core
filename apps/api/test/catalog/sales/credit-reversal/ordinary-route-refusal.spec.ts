/**
 * RT-577 — the ordinary reversal routes refuse a sale with payer
 * responsibilities (`pos-sales/sales.yaml` 1.11.0-draft
 * `CreditSaleReversalRestricted`; owner-approved V1 decision 2026-10-17),
 * end to end against a real RLS-forced Postgres (the capture harness).
 *
 * Covered:
 *   - recordVoid / recordReturn / recordRefund on a credit sale → 403
 *     `credit_sale_reversal_restricted` for a cashier AND for a manager, even
 *     with a valid manager approval; zero writes (reversal rows, outbox,
 *     approval-use ledger) and no stored idempotency entry, so a retry answers
 *     the same 403;
 *   - precedence: after the sale (404) and a provenance replay, before
 *     reversal exclusivity (409), the RT-530 checks and the return checks;
 *   - a void / return / refund recorded before the RT-577 runtime still
 *     replays its stored result;
 *   - a row a credit reversal created is never replayed through an ordinary
 *     route (the ordinary call is refused instead);
 *   - a sale without responsibilities is unchanged.
 */
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
  APPROVER_MANAGER,
  APPROVER_OWNER,
  APPROVER_TENANT_ADMIN,
  HARNESS_REQUESTER,
  approvedVoidBody,
} from "../__support__/void-approval-fixture";
import { disableReturns, enableReturns } from "../terminal/__returns-support";

const TENDERS_FLAG = "POS_SALE_TENDERS_ENABLED";
const h: HarnessHandle = { harness: null, dockerSkipped: false };
const PAYER = "0a000000-0000-7000-8000-0000005770a1";

beforeAll(async () => {
  // RT-787 (RT-271 R-11): the legacy refund route is gated off by default.
  process.env["POS_LEGACY_REFUND_ENABLED"] = "true";
  Object.assign(h, await startCaptureHarness());
  if (!h.harness) return;
  await h.harness.env.admin.query(
    `INSERT INTO payer_account (id, tenant_id, store_id, category, display_name, external_ref, status)
     VALUES ($1, $2, $3, 'corporate', 'RT-577 corp', 'CUST-577', 'active')`,
    [PAYER, TENANT_A, STORE_A_X],
  );
}, 180_000);
afterAll(async () => {
  delete process.env["POS_LEGACY_REFUND_ENABLED"];
  delete process.env[TENDERS_FLAG];
  disableReturns();
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  process.env[TENDERS_FLAG] = "true";
  enableReturns();
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
];
afterEach(async () => {
  if (!h.harness) return;
  for (const sql of CLEANUP) await h.harness.env.admin.query(sql);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

let keySeq = 0;
const nextKey = (): string => idempKey(`rt577o${(keySeq += 1)}`);

type Body = Record<string, unknown>;

interface Sale {
  readonly saleRef: string;
  /** The 5.00 line. */
  readonly lineRef: string;
}

interface SaleSpec {
  readonly externalId: string;
  /** cash 2.5 + credit 10 (posTotal 12.5) when true, else cash 12.5. */
  readonly credit: boolean;
}

/** Capture a sale as the store manager. */
async function captureSale(spec: SaleSpec): Promise<Sale> {
  const harness = h.harness!;
  harness.contextGuard.userId = APPROVER_MANAGER;
  const body = captureBody({
    externalId: spec.externalId,
    tenders: [{ method: "cash", amount: spec.credit ? "2.5" : "12.5" }],
    ...(spec.credit ? { responsibilities: [{ payerRef: PAYER, amount: "10", sequence: 1 }] } : {}),
  });
  const res = await harness.http().post("/api/pos/v1/sales").set("Idempotency-Key", nextKey()).send(body);
  if (res.status !== 201) throw new Error(`capture failed: ${res.status} ${JSON.stringify(res.body)}`);
  const widget = (res.body.lines as Array<{ lineRef: string; lineAmount: string }>).find((l) => Number(l.lineAmount) === 5);
  return { saleRef: res.body.saleRef, lineRef: widget!.lineRef };
}

const creditSale = (externalId: string): Promise<Sale> => captureSale({ externalId, credit: true });

interface Written {
  voids: number;
  returns: number;
  refunds: number;
  outbox: number;
  approvalUses: number;
}

/** What the sale has written (capture itself enqueues its posting, so compare against a baseline). */
async function written(sale: Sale): Promise<Written> {
  const r = await h.harness!.env.admin.query<Record<keyof Written, string>>(
    `SELECT (SELECT count(*) FROM sale_voids WHERE sale_id = $1)::text AS voids,
            (SELECT count(*) FROM sale_returns WHERE sale_id = $1)::text AS returns,
            (SELECT count(*) FROM sale_refunds WHERE sale_id = $1)::text AS refunds,
            (SELECT count(*) FROM outbox_events WHERE payload->>'sale_id' = $1::text)::text AS outbox,
            (SELECT count(*) FROM sale_approval_uses)::text AS "approvalUses"`,
    [sale.saleRef],
  );
  return Object.fromEntries(Object.entries(r.rows[0]!).map(([k, v]) => [k, Number(v)])) as unknown as Written;
}

interface ReversalRequest {
  readonly route: "void" | "returns" | "refund";
  readonly body: Body;
  readonly key?: string;
}

function postReversal(sale: Sale, req: ReversalRequest) {
  return h.harness!.http()
    .post(`/api/pos/v1/sales/${sale.saleRef}/${req.route}`)
    .set("Idempotency-Key", req.key ?? nextKey())
    .send(req.body);
}

const returnBody = (sale: Sale, extra: Body = {}): Body => ({
  sourceSystem: "pos-1",
  externalId: "ret-577",
  lines: [{ lineRef: sale.lineRef, quantity: "1" }],
  refundTenders: [{ method: "cash", amount: "5" }],
  ...extra,
});

const REFUND_BODY: Body = {
  sourceSystem: "pos-1",
  externalId: "ref-577",
  posRefundAmount: "12.5",
  currencyCode: "USD",
};

/** A valid manager-approved void body requested by `requester`, approved by the tenant admin. */
async function voidBodyFor(sale: Sale, requester: { readonly userId: string }): Promise<Body> {
  return approvedVoidBody(h.harness!.env.admin, sale.saleRef, {
    approval: { requesterUserId: requester.userId, approverUserId: APPROVER_TENANT_ADMIN },
    body: { externalId: "void-577" },
  });
}

/** Act as `actor` from now on. */
function actAs(actor: { readonly userId: string }): void {
  h.harness!.contextGuard.userId = actor.userId;
}

const CASHIER = { userId: HARNESS_REQUESTER };
const MANAGER = { userId: APPROVER_MANAGER };

function expectRestricted(res: { status: number; body: { error?: { code?: string } } }): void {
  expect({ status: res.status, code: res.body.error?.code }).toEqual({ status: 403, code: "credit_sale_reversal_restricted" });
}

describe("RT-577 — a credit sale is refused on every ordinary reversal route", () => {
  it.each([
    ["a cashier", CASHIER],
    ["a store manager", MANAGER],
    ["the owner", { userId: APPROVER_OWNER }],
  ])("recordVoid refuses %s, even with a valid manager approval, and writes nothing", async (_who, actor) => {
    if (skip()) return;
    const sale = await creditSale("cred-void");
    const before = await written(sale);
    actAs(actor);
    expectRestricted(await postReversal(sale, { route: "void", body: await voidBodyFor(sale, actor) }));
    expect(await written(sale)).toEqual(before);
  });

  it.each([
    ["a cashier", CASHIER],
    ["a store manager", MANAGER],
  ])("recordReturn refuses %s and writes nothing", async (_who, actor) => {
    if (skip()) return;
    const sale = await creditSale("cred-ret");
    const before = await written(sale);
    actAs(actor);
    expectRestricted(await postReversal(sale, { route: "returns", body: returnBody(sale) }));
    expect(await written(sale)).toEqual(before);
  });

  it.each([
    ["a cashier", CASHIER],
    ["a store manager", MANAGER],
  ])("recordRefund refuses %s and writes nothing", async (_who, actor) => {
    if (skip()) return;
    const sale = await creditSale("cred-ref");
    const before = await written(sale);
    actAs(actor);
    expectRestricted(await postReversal(sale, { route: "refund", body: REFUND_BODY }));
    expect(await written(sale)).toEqual(before);
  });

  it("stores no idempotency entry: the same request with the same key answers the same 403", async () => {
    if (skip()) return;
    const sale = await creditSale("cred-retry");
    const before = await written(sale);
    actAs(CASHIER);
    const req: ReversalRequest = { route: "void", body: await voidBodyFor(sale, CASHIER), key: nextKey() };
    expectRestricted(await postReversal(sale, req));
    const again = await postReversal(sale, req);
    expectRestricted(again);
    expect(again.headers["idempotent-replayed"]).toBeUndefined();
    expect(await written(sale)).toEqual(before);
  });
});

describe("RT-577 — precedence", () => {
  it("a malformed body is still 400, and an unknown sale still 404", async () => {
    if (skip()) return;
    const sale = await creditSale("cred-prec");
    actAs(CASHIER);
    expect((await postReversal(sale, { route: "void", body: { sourceSystem: "pos-1" } })).status).toBe(400);
    const ghost: Sale = { saleRef: "0a000000-0000-7000-8000-0000005770ff", lineRef: sale.lineRef };
    expect((await postReversal(ghost, { route: "void", body: await voidBodyFor(sale, CASHIER) })).status).toBe(404);
  });

  it("refuses before reversal exclusivity: a second void of a voided credit sale is 403, not 409", async () => {
    if (skip()) return;
    const sale = await creditSale("cred-excl");
    await seedVoid(sale, { externalId: "pre-void", creditLinked: false });
    actAs(CASHIER);
    expectRestricted(await postReversal(sale, { route: "void", body: await voidBodyFor(sale, CASHIER) }));
  });

  it("refuses before the RT-530 checks: a void without any approval is 403 restricted, not void_approval_required", async () => {
    if (skip()) return;
    const sale = await creditSale("cred-noappr");
    actAs(CASHIER);
    const body = await approvedVoidBody(h.harness!.env.admin, sale.saleRef, { omitApproval: true, body: { externalId: "void-577" } });
    expectRestricted(await postReversal(sale, { route: "void", body }));
  });

  it("refuses before the return checks: an over-return and a tender mismatch are both 403", async () => {
    if (skip()) return;
    const sale = await creditSale("cred-retchk");
    actAs(MANAGER);
    const over = returnBody(sale, { lines: [{ lineRef: sale.lineRef, quantity: "9" }] });
    expectRestricted(await postReversal(sale, { route: "returns", body: over }));
    const mismatch = returnBody(sale, { refundTenders: [{ method: "cash", amount: "1" }] });
    expectRestricted(await postReversal(sale, { route: "returns", body: mismatch }));
  });

  it("the returns gate still answers first: with POS_RETURNS_ENABLED off a credit return is 404", async () => {
    if (skip()) return;
    const sale = await creditSale("cred-gate");
    disableReturns();
    actAs(MANAGER);
    expect((await postReversal(sale, { route: "returns", body: returnBody(sale) })).status).toBe(404);
  });
});

/** Seed an ordinary void directly (a row recorded before the RT-577 runtime), optionally credit-linked. */
async function seedVoid(sale: Sale, seed: { readonly externalId: string; readonly creditLinked: boolean }): Promise<string> {
  const admin = h.harness!.env.admin;
  const v = await admin.query<{ id: string }>(
    `INSERT INTO sale_voids (sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE, 'pos-1', $4, $5, $6) RETURNING id::text AS id`,
    [sale.saleRef, TENANT_A, STORE_A_X, seed.externalId, "a".repeat(64), APPROVER_MANAGER],
  );
  const voidId = v.rows[0]!.id;
  if (seed.creditLinked) {
    await admin.query(
      `INSERT INTO sale_credit_reversals
         (tenant_id, store_id, sale_id, kind, void_id, source_system, external_id, payload_hash,
          business_date, currency_code, reversal_total, refundable_amount, adjustment_amount,
          payer_id, adjustment_ref, actor_user_id, actor_role, reason)
       VALUES ($1, $2, $3, 'void', $4, 'pos-1', $5, $6, CURRENT_DATE, 'USD', 12.5, 2.5, 10,
               $7, gen_random_uuid(), $8, 'store_manager', 'seeded')`,
      [TENANT_A, STORE_A_X, sale.saleRef, voidId, seed.externalId, "b".repeat(64), PAYER, APPROVER_MANAGER],
    );
  }
  return voidId;
}

describe("RT-577 — replay semantics", () => {
  it("a void recorded before the RT-577 runtime still replays its stored result (same provenance)", async () => {
    if (skip()) return;
    const sale = await creditSale("cred-replay");
    const voidId = await seedVoid(sale, { externalId: "void-577", creditLinked: false });
    actAs(CASHIER);
    const res = await postReversal(sale, { route: "void", body: await voidBodyFor(sale, CASHIER) });
    expect({ status: res.status, eventRef: res.body.eventRef }).toEqual({ status: 200, eventRef: voidId });
    expect(res.headers["idempotent-replayed"]).toBe("true");
  });

  it("a void a credit reversal created is never replayed through recordVoid: the ordinary call is refused", async () => {
    if (skip()) return;
    const sale = await creditSale("cred-linked");
    await seedVoid(sale, { externalId: "void-577", creditLinked: true });
    actAs(CASHIER);
    expectRestricted(await postReversal(sale, { route: "void", body: await voidBodyFor(sale, CASHIER) }));
  });

  it("a refund recorded before the RT-577 runtime still replays its stored result", async () => {
    if (skip()) return;
    const sale = await creditSale("cred-refreplay");
    const r = await h.harness!.env.admin.query<{ id: string }>(
      `INSERT INTO sale_refunds (sale_id, tenant_id, store_id, pos_refund_amount, currency_code, source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, 12.5, 'USD', 'pos-1', 'ref-577', $4, $5) RETURNING id::text AS id`,
      [sale.saleRef, TENANT_A, STORE_A_X, "c".repeat(64), APPROVER_MANAGER],
    );
    actAs(CASHIER);
    const res = await postReversal(sale, { route: "refund", body: REFUND_BODY });
    expect({ status: res.status, eventRef: res.body.eventRef }).toEqual({ status: 200, eventRef: r.rows[0]!.id });
  });
});

describe("RT-577 — a sale without responsibilities is unchanged", () => {
  it("a cash sale is voided with a manager approval (201) and the ledger records its approval id", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "cash-void", credit: false });
    const before = await written(sale);
    actAs(CASHIER);
    const res = await postReversal(sale, { route: "void", body: await voidBodyFor(sale, CASHIER) });
    expect(res.status).toBe(201);
    expect(await written(sale)).toEqual({ ...before, voids: 1, outbox: before.outbox + 1, approvalUses: 1 });
  });

  it("a cash sale is returned (201) and refunded (201)", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "cash-ret", credit: false });
    actAs(CASHIER);
    expect((await postReversal(sale, { route: "returns", body: returnBody(sale) })).status).toBe(201);
    const other = await captureSale({ externalId: "cash-ref", credit: false });
    expect((await postReversal(other, { route: "refund", body: REFUND_BODY })).status).toBe(201);
  });

  it("a cash void reusing an approval id a credit return consumed is 422 void_approval_invalid (shared ledger)", async () => {
    if (skip()) return;
    const sale = await captureSale({ externalId: "cash-reuse", credit: false });
    const body = await voidBodyFor(sale, CASHIER);
    const approvalId = (body["approval"] as { approvalId: string }).approvalId;
    await h.harness!.env.admin.query(
      `INSERT INTO sale_approval_uses (tenant_id, approval_id, source) VALUES ($1, $2, 'credit_return')`,
      [TENANT_A, approvalId],
    );
    actAs(CASHIER);
    const res = await postReversal(sale, { route: "void", body });
    expect({ status: res.status, code: res.body.error?.code }).toEqual({ status: 422, code: "void_approval_invalid" });
    expect((await written(sale)).voids).toBe(0);
  });
});
