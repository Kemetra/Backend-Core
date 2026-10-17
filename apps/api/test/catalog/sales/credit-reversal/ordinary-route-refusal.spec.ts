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
  Object.assign(h, await startCaptureHarness());
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
  process.env[TENDERS_FLAG] = "true";
  enableReturns();
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
  await q(`DELETE FROM sale_refunds WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_responsibilities WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_tenders WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_lines WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sales WHERE source_system = 'pos-1'`);
  await q(`DELETE FROM outbox_events`);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

let keySeq = 0;
const nextKey = (): string => idempKey(`rt577o${(keySeq += 1)}`);

/** Capture a sale as the store manager: cash 2.5 + credit 10 (posTotal 12.5), or cash only. */
async function captureSale(externalId: string, credit: boolean): Promise<{ saleRef: string; lineRef: string }> {
  const harness = h.harness!;
  harness.contextGuard.userId = APPROVER_MANAGER;
  const body = captureBody({
    externalId,
    tenders: [{ method: "cash", amount: credit ? "2.5" : "12.5" }],
    ...(credit ? { responsibilities: [{ payerRef: PAYER, amount: "10", sequence: 1 }] } : {}),
  });
  const res = await harness.http().post("/api/pos/v1/sales").set("Idempotency-Key", nextKey()).send(body);
  if (res.status !== 201) throw new Error(`capture failed: ${res.status} ${JSON.stringify(res.body)}`);
  const widget = (res.body.lines as Array<{ lineRef: string; lineAmount: string }>).find((l) => Number(l.lineAmount) === 5);
  return { saleRef: res.body.saleRef, lineRef: widget!.lineRef };
}

interface Written {
  voids: number;
  returns: number;
  refunds: number;
  outbox: number;
  approvalUses: number;
}

async function written(saleRef: string): Promise<Written> {
  const r = await h.harness!.env.admin.query<Record<keyof Written, string>>(
    `SELECT (SELECT count(*) FROM sale_voids WHERE sale_id = $1)::text AS voids,
            (SELECT count(*) FROM sale_returns WHERE sale_id = $1)::text AS returns,
            (SELECT count(*) FROM sale_refunds WHERE sale_id = $1)::text AS refunds,
            (SELECT count(*) FROM outbox_events WHERE payload->>'sale_id' = $1::text)::text AS outbox,
            (SELECT count(*) FROM sale_approval_uses)::text AS "approvalUses"`,
    [saleRef],
  );
  const row = r.rows[0]!;
  return {
    voids: Number(row.voids),
    returns: Number(row.returns),
    refunds: Number(row.refunds),
    outbox: Number(row.outbox),
    approvalUses: Number(row.approvalUses),
  };
}

/** What the sale has right after capture (capture itself enqueues its posting). */
const baseline = (saleRef: string): Promise<Written> => written(saleRef);

async function postVoid(saleRef: string, body: Record<string, unknown>, key = nextKey()) {
  return h.harness!.http().post(`/api/pos/v1/sales/${saleRef}/void`).set("Idempotency-Key", key).send(body);
}

async function postReturn(saleRef: string, body: Record<string, unknown>, key = nextKey()) {
  return h.harness!.http().post(`/api/pos/v1/sales/${saleRef}/returns`).set("Idempotency-Key", key).send(body);
}

async function postRefund(saleRef: string, body: Record<string, unknown>, key = nextKey()) {
  return h.harness!.http().post(`/api/pos/v1/sales/${saleRef}/refund`).set("Idempotency-Key", key).send(body);
}

const returnBody = (lineRef: string, extra: Record<string, unknown> = {}) => ({
  sourceSystem: "pos-1",
  externalId: "ret-577",
  lines: [{ lineRef, quantity: "1" }],
  refundTenders: [{ method: "cash", amount: "5" }],
  ...extra,
});

const refundBody = (extra: Record<string, unknown> = {}) => ({
  sourceSystem: "pos-1",
  externalId: "ref-577",
  posRefundAmount: "12.5",
  currencyCode: "USD",
  ...extra,
});

/** A valid manager-approved void body requested by `requester`, approved by the tenant admin. */
async function voidBodyFor(saleRef: string, requester: string): Promise<Record<string, unknown>> {
  return approvedVoidBody(h.harness!.env.admin, saleRef, {
    approval: { requesterUserId: requester, approverUserId: APPROVER_TENANT_ADMIN },
    body: { externalId: "void-577" },
  });
}

function expectRestricted(res: { status: number; body: { error?: { code?: string } } }): void {
  expect({ status: res.status, code: res.body.error?.code }).toEqual({ status: 403, code: "credit_sale_reversal_restricted" });
}

describe("RT-577 — a credit sale is refused on every ordinary reversal route", () => {
  it.each([
    ["a cashier", HARNESS_REQUESTER],
    ["a store manager", APPROVER_MANAGER],
    ["the owner", APPROVER_OWNER],
  ])("recordVoid refuses %s, even with a valid manager approval, and writes nothing", async (_who, actor) => {
    if (skip()) return;
    const { saleRef } = await captureSale("cred-void", true);
    const before = await baseline(saleRef);
    h.harness!.contextGuard.userId = actor;
    const res = await postVoid(saleRef, await voidBodyFor(saleRef, actor));
    expectRestricted(res);
    expect(await written(saleRef)).toEqual(before);
  });

  it.each([
    ["a cashier", HARNESS_REQUESTER],
    ["a store manager", APPROVER_MANAGER],
  ])("recordReturn refuses %s and writes nothing", async (_who, actor) => {
    if (skip()) return;
    const { saleRef, lineRef } = await captureSale("cred-ret", true);
    const before = await baseline(saleRef);
    h.harness!.contextGuard.userId = actor;
    expectRestricted(await postReturn(saleRef, returnBody(lineRef)));
    expect(await written(saleRef)).toEqual(before);
  });

  it.each([
    ["a cashier", HARNESS_REQUESTER],
    ["a store manager", APPROVER_MANAGER],
  ])("recordRefund refuses %s and writes nothing", async (_who, actor) => {
    if (skip()) return;
    const { saleRef } = await captureSale("cred-ref", true);
    const before = await baseline(saleRef);
    h.harness!.contextGuard.userId = actor;
    expectRestricted(await postRefund(saleRef, refundBody()));
    expect(await written(saleRef)).toEqual(before);
  });

  it("stores no idempotency entry: the same request with the same key answers the same 403", async () => {
    if (skip()) return;
    const { saleRef } = await captureSale("cred-retry", true);
    const before = await baseline(saleRef);
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    const body = await voidBodyFor(saleRef, HARNESS_REQUESTER);
    const key = nextKey();
    expectRestricted(await postVoid(saleRef, body, key));
    const again = await postVoid(saleRef, body, key);
    expectRestricted(again);
    expect(again.headers["idempotent-replayed"]).toBeUndefined();
    expect(await written(saleRef)).toEqual(before);
  });
});

describe("RT-577 — precedence", () => {
  it("a malformed body is still 400, and an unknown sale still 404", async () => {
    if (skip()) return;
    const { saleRef } = await captureSale("cred-prec", true);
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    expect((await postVoid(saleRef, { sourceSystem: "pos-1" })).status).toBe(400);
    expect((await postVoid("0a000000-0000-7000-8000-0000005770ff", await voidBodyFor(saleRef, HARNESS_REQUESTER))).status).toBe(404);
  });

  it("refuses before reversal exclusivity: a second void of a voided credit sale is 403, not 409", async () => {
    if (skip()) return;
    const { saleRef } = await captureSale("cred-excl", true);
    await seedVoid(saleRef, "pre-void", false);
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    expectRestricted(await postVoid(saleRef, await voidBodyFor(saleRef, HARNESS_REQUESTER)));
  });

  it("refuses before the RT-530 checks: a void without any approval is 403 restricted, not void_approval_required", async () => {
    if (skip()) return;
    const { saleRef } = await captureSale("cred-noappr", true);
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    const body = await approvedVoidBody(h.harness!.env.admin, saleRef, { omitApproval: true, body: { externalId: "void-577" } });
    expectRestricted(await postVoid(saleRef, body));
  });

  it("refuses before the return checks: an over-return and a tender mismatch are both 403", async () => {
    if (skip()) return;
    const { saleRef, lineRef } = await captureSale("cred-retchk", true);
    h.harness!.contextGuard.userId = APPROVER_MANAGER;
    expectRestricted(await postReturn(saleRef, returnBody(lineRef, { lines: [{ lineRef, quantity: "9" }] })));
    expectRestricted(await postReturn(saleRef, returnBody(lineRef, { refundTenders: [{ method: "cash", amount: "1" }] })));
  });

  it("the returns gate still answers first: with POS_RETURNS_ENABLED off a credit return is 404", async () => {
    if (skip()) return;
    const { saleRef, lineRef } = await captureSale("cred-gate", true);
    disableReturns();
    h.harness!.contextGuard.userId = APPROVER_MANAGER;
    expect((await postReturn(saleRef, returnBody(lineRef))).status).toBe(404);
  });
});

/** Seed an ordinary void directly (a row recorded before the RT-577 runtime). */
async function seedVoid(saleRef: string, externalId: string, creditLinked: boolean): Promise<string> {
  const admin = h.harness!.env.admin;
  const v = await admin.query<{ id: string }>(
    `INSERT INTO sale_voids (sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, CURRENT_DATE, 'pos-1', $4, $5, $6) RETURNING id::text AS id`,
    [saleRef, TENANT_A, STORE_A_X, externalId, "a".repeat(64), APPROVER_MANAGER],
  );
  const voidId = v.rows[0]!.id;
  if (creditLinked) {
    await admin.query(
      `INSERT INTO sale_credit_reversals
         (tenant_id, store_id, sale_id, kind, void_id, source_system, external_id, payload_hash,
          business_date, currency_code, reversal_total, refundable_amount, adjustment_amount,
          payer_id, adjustment_ref, actor_user_id, actor_role, reason)
       VALUES ($1, $2, $3, 'void', $4, 'pos-1', $5, $6, CURRENT_DATE, 'USD', 12.5, 2.5, 10,
               $7, gen_random_uuid(), $8, 'store_manager', 'seeded')`,
      [TENANT_A, STORE_A_X, saleRef, voidId, externalId, "b".repeat(64), PAYER, APPROVER_MANAGER],
    );
  }
  return voidId;
}

describe("RT-577 — replay semantics", () => {
  it("a void recorded before the RT-577 runtime still replays its stored result (same provenance)", async () => {
    if (skip()) return;
    const { saleRef } = await captureSale("cred-replay", true);
    const voidId = await seedVoid(saleRef, "void-577", false);
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    const res = await postVoid(saleRef, await voidBodyFor(saleRef, HARNESS_REQUESTER));
    expect({ status: res.status, eventRef: res.body.eventRef }).toEqual({ status: 200, eventRef: voidId });
    expect(res.headers["idempotent-replayed"]).toBe("true");
  });

  it("a void a credit reversal created is never replayed through recordVoid: the ordinary call is refused", async () => {
    if (skip()) return;
    const { saleRef } = await captureSale("cred-linked", true);
    await seedVoid(saleRef, "void-577", true);
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    expectRestricted(await postVoid(saleRef, await voidBodyFor(saleRef, HARNESS_REQUESTER)));
  });

  it("a refund recorded before the RT-577 runtime still replays its stored result", async () => {
    if (skip()) return;
    const { saleRef } = await captureSale("cred-refreplay", true);
    const r = await h.harness!.env.admin.query<{ id: string }>(
      `INSERT INTO sale_refunds (sale_id, tenant_id, store_id, pos_refund_amount, currency_code, source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, 12.5, 'USD', 'pos-1', 'ref-577', $4, $5) RETURNING id::text AS id`,
      [saleRef, TENANT_A, STORE_A_X, "c".repeat(64), APPROVER_MANAGER],
    );
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    const res = await postRefund(saleRef, refundBody());
    expect({ status: res.status, eventRef: res.body.eventRef }).toEqual({ status: 200, eventRef: r.rows[0]!.id });
  });
});

describe("RT-577 — a sale without responsibilities is unchanged", () => {
  it("a cash sale is voided with a manager approval (201) and the ledger records its approval id", async () => {
    if (skip()) return;
    const { saleRef } = await captureSale("cash-void", false);
    const before = await baseline(saleRef);
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    const res = await postVoid(saleRef, await voidBodyFor(saleRef, HARNESS_REQUESTER));
    expect(res.status).toBe(201);
    expect(await written(saleRef)).toEqual({ ...before, voids: 1, outbox: before.outbox + 1, approvalUses: 1 });
  });

  it("a cash sale is returned (201) and refunded (201)", async () => {
    if (skip()) return;
    const { saleRef, lineRef } = await captureSale("cash-ret", false);
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    expect((await postReturn(saleRef, returnBody(lineRef))).status).toBe(201);
    const other = await captureSale("cash-ref", false);
    expect((await postRefund(other.saleRef, refundBody())).status).toBe(201);
  });

  it("a cash void reusing an approval id a credit return consumed is 422 void_approval_invalid (shared ledger)", async () => {
    if (skip()) return;
    const { saleRef } = await captureSale("cash-reuse", false);
    const body = await voidBodyFor(saleRef, HARNESS_REQUESTER);
    const approvalId = (body["approval"] as { approvalId: string }).approvalId;
    await h.harness!.env.admin.query(
      `INSERT INTO sale_approval_uses (tenant_id, approval_id, source) VALUES ($1, $2, 'credit_return')`,
      [TENANT_A, approvalId],
    );
    h.harness!.contextGuard.userId = HARNESS_REQUESTER;
    const res = await postVoid(saleRef, body);
    expect({ status: res.status, code: res.body.error?.code }).toEqual({ status: 422, code: "void_approval_invalid" });
    expect((await written(saleRef)).voids).toBe(0);
  });
});
