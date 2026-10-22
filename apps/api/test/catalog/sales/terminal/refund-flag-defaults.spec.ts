/**
 * refund-flag-defaults.spec.ts — Jira RT-787: the behaviour with both new
 * deploy flags at their defaults (`POS_REFUND_SETTLE_BEFORE_POST_ENABLED`
 * and `POS_LEGACY_REFUND_ENABLED` unset).
 *
 * Unchanged from before RT-787: a ref-less return records and answers the
 * same projection (no allocation key at all), and every return posts at
 * acceptance, `allocationRef` or not (R-7 is off).
 *
 * Behaviour changes at default flags, each normative in the merged contract
 * (`pos-sales/sales.yaml` 1.13.0-draft) and pinned here:
 *   - `recordRefund` answers 404 `not_found` and records nothing (RT-271 R-11,
 *     owner ratification c11886); no POS caller exists;
 *   - `recordReturn` refuses a sale carrying a non-cash tender with 422
 *     `refund_instrument_not_allowed` (R-12), and a return that would exceed
 *     the sale's cash pool (legacy refunds included) with 422
 *     `refund_allocation_exceeds_tender` (R-5), "from the F-2 runtime".
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  STORE_A_X,
  TENANT_A,
  DEVICE_USER_ID,
  type HarnessHandle,
} from "../capture/__capture-harness";
import {
  captureCashSale,
  captureOneLine,
  captureWithTenders,
  cleanReturnsFixtures,
  disableReturns,
  enableReturns,
  postingEventsFor,
  postLegacyRefund,
  postReturn,
  postReturnWithRef,
  returnBody,
} from "./__returns-support";

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  disableReturns();
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  enableReturns();
  delete process.env["POS_REFUND_SETTLE_BEFORE_POST_ENABLED"];
  delete process.env["POS_LEGACY_REFUND_ENABLED"];
});
afterEach(async () => {
  await cleanReturnsFixtures(h);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

/** The `SaleReturn` keys before RT-787, and the `RefundTender` keys of a ref-less allocation. */
const SALE_RETURN_KEYS = [
  "businessDate",
  "currencyCode",
  "externalId",
  "lines",
  "reason",
  "recordedAt",
  "refundTenders",
  "returnRef",
  "returnTotal",
  "saleRef",
  "sourceSystem",
];
const byName = (a: string, b: string): number => a.localeCompare(b);

describe("RT-787 defaults — unchanged", () => {
  it.each([
    ["a tender-unknown sale", false],
    ["an all-cash tendered sale", true],
  ])("a ref-less return of %s: 201, the pre-RT-787 projection, one posting at acceptance", async (_name, tendered) => {
    if (skip()) return;
    const tag = tendered ? "cash" : "unknown";
    const s = tendered
      ? await captureCashSale(h, `def-${tag}`)
      : await captureOneLine(h, { externalId: `def-${tag}`, quantity: "2", lineAmount: "10.0000" });
    const res = await postReturn(
      h,
      s.saleRef,
      returnBody(`def-${tag}-r`, [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"),
      `def${tag}`,
    );
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort(byName)).toEqual(SALE_RETURN_KEYS);
    expect(res.body.refundTenders).toEqual([{ method: "cash", amount: "5.0000" }]);
    expect(await postingEventsFor(h, res.body.returnRef)).toBe(1);
  });

  it("R-7 is off: a return with allocationRef still posts at acceptance", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "def-ref", quantity: "1", lineAmount: "5.0000" });
    const res = await postReturnWithRef(h, s, { quantity: "1", amount: "5.0000" }, "def-ref");
    expect(res.status).toBe(201);
    expect(await postingEventsFor(h, res.body.returnRef)).toBe(1);
  });
});

describe("RT-787 defaults — behaviour changes (contract-normative)", () => {
  it("R-11: recordRefund answers 404 not_found and records nothing", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "def-refund", quantity: "1", lineAmount: "5.0000" });
    const res = await postLegacyRefund(h, s.saleRef, "def-refund-rf", "1.0000");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
    const rows = await h.harness!.env.admin.query("SELECT 1 FROM sale_refunds WHERE sale_id = $1", [s.saleRef]);
    expect(rows.rowCount).toBe(0);
  });

  it("R-12: a return of a sale carrying a card tender → 422 refund_instrument_not_allowed", async () => {
    if (skip()) return;
    const s = await captureWithTenders(h, {
      externalId: "def-card",
      quantity: "2",
      lineAmount: "10.0000",
      tenders: [
        { method: "cash", amount: "5.0000" },
        { method: "card_external", amount: "5.0000", reference: "AB12" },
      ],
    });
    const res = await postReturn(
      h,
      s.saleRef,
      returnBody("def-card-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"),
      "defcard",
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("refund_instrument_not_allowed");
  });

  it("R-5: a return past the cash pool left by an earlier legacy refund → 422 refund_allocation_exceeds_tender", async () => {
    if (skip()) return;
    const s = await captureCashSale(h, "def-pool");
    // A legacy refund recorded before the gate (the route is 404 at defaults).
    await h.harness!.env.admin.query(
      `INSERT INTO sale_refunds (sale_id, tenant_id, store_id, pos_refund_amount, currency_code,
                                 source_system, external_id, payload_hash, created_by)
       VALUES ($1, $2, $3, 4, 'USD', 'pos-1', 'def-pool-rf', $4, $5)`,
      [s.saleRef, TENANT_A, STORE_A_X, "b".repeat(64), DEVICE_USER_ID],
    );
    const res = await postReturn(
      h,
      s.saleRef,
      returnBody("def-pool-r", [{ lineRef: s.lineRef, quantity: "2" }], "10.0000"),
      "defpool",
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("refund_allocation_exceeds_tender");
  });
});
