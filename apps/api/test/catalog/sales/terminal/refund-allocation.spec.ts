/**
 * refund-allocation.spec.ts — Jira RT-787 (RT-271 F-2): the RT-490 refund
 * allocation rules on `recordReturn`, against a real RLS-forced Postgres.
 *
 *   - rule 1: `allocationRef` on every allocation or none, unique within the
 *     return; an `originalTenderRef` must be a tender of THIS sale (400,
 *     checked with the line checks, before 409 `over_return`);
 *   - rule 2 (R-12): a sale carrying a non-cash tender → 422
 *     `refund_instrument_not_allowed`, after `return_tender_mismatch`;
 *   - rule 3 (R-5): the refundable balance of a referenced tender, and the
 *     sale's cash pool (every allocation plus legacy refunds), counted under
 *     the `sales` row lock → 422 `refund_allocation_exceeds_tender`;
 *   - rule 4 (R-6): a tender-unknown sale is capped by the line cap only;
 *   - R-3: the allocation fields are part of the replayed payload;
 *   - R-7: with the settle-before-post flag on, a settleable return is not
 *     emitted at acceptance.
 * Every refusal records nothing.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  type HarnessHandle,
} from "../capture/__capture-harness";
import {
  allocatedReturnBody,
  captureCashSale,
  captureOneLine,
  captureWithTenders,
  postLegacyRefund,
  postReturnWithRef,
  cleanReturnsFixtures,
  disableReturns,
  enableReturns,
  postingEventsFor,
  postReturn,
  returnBody,
  disableLegacyRefund,
  enableLegacyRefund,
  disableSettleBeforePost,
  enableSettleBeforePost,
  uuidFor,
} from "./__returns-support";

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  disableReturns();
  disableSettleBeforePost();
  disableLegacyRefund();
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  enableReturns();
  disableSettleBeforePost();
  disableLegacyRefund();
});
afterEach(async () => {
  await cleanReturnsFixtures(h);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

const T1 = uuidFor("tender-1");
const T2 = uuidFor("tender-2");

async function returnsOf(saleRef: string): Promise<number> {
  const r = await h.harness!.env.admin.query("SELECT 1 FROM sale_returns WHERE sale_id = $1", [saleRef]);
  return r.rowCount ?? 0;
}

/** A sale of 2 × 5.0000 paid by two cash tenders T1 = 6, T2 = 4. */
function twoCashTenderSale(externalId: string) {
  return captureWithTenders(h, {
    externalId,
    quantity: "2",
    lineAmount: "10.0000",
    tenders: [
      { method: "cash", amount: "6.0000", tenderRef: T1 },
      { method: "cash", amount: "4.0000", tenderRef: T2 },
    ],
  });
}

describe("RT-787 rule 1 — allocation fields", () => {
  it("records and echoes allocationRef, originalTenderRef and instrument", async () => {
    if (skip()) return;
    const s = await twoCashTenderSale("alloc-echo");
    const a1 = uuidFor("alloc-echo-1");
    const res = await postReturn(
      h,
      s.saleRef,
      allocatedReturnBody("alloc-echo-r", [{ lineRef: s.lineRef, quantity: "1" }], [
        { amount: "5.0000", allocationRef: a1, originalTenderRef: T1, instrument: "cash" },
      ]),
      "aecho",
    );
    expect(res.status).toBe(201);
    expect(res.body.refundTenders).toEqual([
      { method: "cash", amount: "5.0000", allocationRef: a1, originalTenderRef: T1, instrument: "cash" },
    ]);
  });

  it("a ref-less allocation is projected without the RT-490 fields (never null)", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "alloc-plain", quantity: "1", lineAmount: "5.0000" });
    const res = await postReturn(
      h,
      s.saleRef,
      returnBody("alloc-plain-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"),
      "aplain",
    );
    expect(res.status).toBe(201);
    expect(res.body.refundTenders).toEqual([{ method: "cash", amount: "5.0000" }]);
  });

  it.each([
    [
      "allocationRef on some allocations only",
      [{ amount: "2.0000", allocationRef: uuidFor("some-1") }, { amount: "3.0000" }],
    ],
    [
      "the same allocationRef twice",
      [
        { amount: "2.0000", allocationRef: uuidFor("dup") },
        { amount: "3.0000", allocationRef: uuidFor("dup") },
      ],
    ],
    ["an instrument other than cash", [{ amount: "5.0000", instrument: "card_external" }]],
  ])("%s → 400 validation_error, nothing recorded", async (_name, allocations) => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: `alloc-400-${_name.length}`, quantity: "1", lineAmount: "5.0000" });
    const res = await postReturn(
      h,
      s.saleRef,
      allocatedReturnBody(`alloc-400-r-${_name.length}`, [{ lineRef: s.lineRef, quantity: "1" }], allocations as never),
      `a400${_name.length}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(await returnsOf(s.saleRef)).toBe(0);
  });

  it("an originalTenderRef that is not a tender of this sale → 400, before 409 over_return", async () => {
    if (skip()) return;
    const s = await twoCashTenderSale("alloc-foreign");
    const res = await postReturn(
      h,
      s.saleRef,
      // q = 3 > sold 2 would be 409 over_return; the tender 400 wins.
      allocatedReturnBody("alloc-foreign-r", [{ lineRef: s.lineRef, quantity: "3" }], [
        { amount: "15.0000", originalTenderRef: uuidFor("not-a-tender") },
      ]),
      "aforeign",
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(await returnsOf(s.saleRef)).toBe(0);
  });

  it("R-6: an originalTenderRef on a tender-unknown sale → 400", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "alloc-unknown-ref", quantity: "1", lineAmount: "5.0000" });
    const res = await postReturn(
      h,
      s.saleRef,
      allocatedReturnBody("alloc-unknown-ref-r", [{ lineRef: s.lineRef, quantity: "1" }], [
        { amount: "5.0000", originalTenderRef: T1 },
      ]),
      "aunkref",
    );
    expect(res.status).toBe(400);
    expect(await returnsOf(s.saleRef)).toBe(0);
  });
});

describe("RT-787 rule 2 — instrument (R-12)", () => {
  async function mixedSale(externalId: string) {
    return captureWithTenders(h, {
      externalId,
      quantity: "2",
      lineAmount: "10.0000",
      tenders: [
        { method: "cash", amount: "5.0000" },
        { method: "card_external", amount: "5.0000", reference: "AB12" },
      ],
    });
  }

  it("a sale carrying a card tender → 422 refund_instrument_not_allowed, nothing recorded", async () => {
    if (skip()) return;
    const s = await mixedSale("instr-mixed");
    const res = await postReturn(
      h,
      s.saleRef,
      returnBody("instr-mixed-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"),
      "imixed",
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("refund_instrument_not_allowed");
    expect(await returnsOf(s.saleRef)).toBe(0);
  });

  it("return_tender_mismatch is checked before the instrument rule", async () => {
    if (skip()) return;
    const s = await mixedSale("instr-order");
    const res = await postReturn(
      h,
      s.saleRef,
      returnBody("instr-order-r", [{ lineRef: s.lineRef, quantity: "1" }], "4.0000"),
      "iorder",
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("return_tender_mismatch");
  });
});

describe("RT-787 rule 3 — refundable balance (R-5)", () => {
  it("an allocation above its referenced tender's balance → 422 refund_allocation_exceeds_tender", async () => {
    if (skip()) return;
    const s = await twoCashTenderSale("bal-ref");
    const res = await postReturn(
      h,
      s.saleRef,
      allocatedReturnBody("bal-ref-r", [{ lineRef: s.lineRef, quantity: "1" }], [
        { amount: "5.0000", originalTenderRef: T2 },
      ]),
      "balref",
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("refund_allocation_exceeds_tender");
    expect(await returnsOf(s.saleRef)).toBe(0);
  });

  it("allocations count across returns: T2 used up by the first return refuses the second", async () => {
    if (skip()) return;
    const s = await twoCashTenderSale("bal-cum");
    const first = await postReturn(
      h,
      s.saleRef,
      allocatedReturnBody("bal-cum-1", [{ lineRef: s.lineRef, quantity: "1" }], [
        { amount: "4.0000", originalTenderRef: T2 },
        { amount: "1.0000", originalTenderRef: T1 },
      ]),
      "balcum1",
    );
    expect(first.status).toBe(201);
    const refused = await postReturn(
      h,
      s.saleRef,
      allocatedReturnBody("bal-cum-2", [{ lineRef: s.lineRef, quantity: "1" }], [
        { amount: "5.0000", originalTenderRef: T2 },
      ]),
      "balcum2",
    );
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("refund_allocation_exceeds_tender");
    const accepted = await postReturn(
      h,
      s.saleRef,
      allocatedReturnBody("bal-cum-3", [{ lineRef: s.lineRef, quantity: "1" }], [
        { amount: "5.0000", originalTenderRef: T1 },
      ]),
      "balcum3",
    );
    expect(accepted.status).toBe(201);
  });

  it("legacy recordRefund amounts count against the cash pool", async () => {
    if (skip()) return;
    const s = await captureCashSale(h, "bal-legacy");
    enableLegacyRefund();
    expect((await postLegacyRefund(h, s.saleRef, "bal-legacy-rf", "4.0000")).status).toBe(201);
    const res = await postReturn(
      h,
      s.saleRef,
      returnBody("bal-legacy-r", [{ lineRef: s.lineRef, quantity: "2" }], "10.0000"),
      "ballegacy",
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("refund_allocation_exceeds_tender");
    const partial = await postReturn(
      h,
      s.saleRef,
      returnBody("bal-legacy-r2", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"),
      "ballegacy2",
    );
    expect(partial.status).toBe(201);
  });

  it("two concurrent returns cannot over-allocate the cash pool: exactly one is refused", async () => {
    if (skip()) return;
    const s = await captureCashSale(h, "bal-conc");
    enableLegacyRefund();
    expect((await postLegacyRefund(h, s.saleRef, "bal-conc-rf", "5.0000")).status).toBe(201);
    const results = await Promise.all(
      [0, 1].map((i) =>
        postReturn(
          h,
          s.saleRef,
          returnBody(`bal-conc-${i}`, [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"),
          `balconc${i}`,
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(results.find((r) => r.status === 422)!.body.error.code).toBe("refund_allocation_exceeds_tender");
    expect(await returnsOf(s.saleRef)).toBe(1);
  });
});

describe("RT-787 rule 3 — a legacy refund racing a return (both under the sales lock)", () => {
  it("cannot over-allocate the cash pool: whichever commits second sees the first", async () => {
    if (skip()) return;
    const s = await captureCashSale(h, "bal-race");
    enableLegacyRefund();
    // The return takes the whole pool; a concurrent refund of 1 races it.
    const [ret, refund] = await Promise.all([
      postReturn(h, s.saleRef, returnBody("bal-race-r", [{ lineRef: s.lineRef, quantity: "2" }], "10.0000"), "balrace"),
      postLegacyRefund(h, s.saleRef, "bal-race-rf", "1.0000"),
    ]);
    // The legacy refund is not capped by the rule (it only counts against it),
    // so it always records. Refund first → the return sees it and is refused;
    // return first → it is accepted. Never a deadlock or a 500.
    expect(refund.status).toBe(201);
    expect([201, 422]).toContain(ret.status);
    if (ret.status === 422) {
      expect(ret.body.error.code).toBe("refund_allocation_exceeds_tender");
    }
    expect(await returnsOf(s.saleRef)).toBe(ret.status === 201 ? 1 : 0);
  });
});

describe("RT-787 rule 4 — tender-unknown sale (R-6)", () => {
  it("a ref-less cash allocation is capped by the line cap only", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "unknown-cap", quantity: "2", lineAmount: "10.0000" });
    const res = await postReturnWithRef(h, s, { quantity: "2", amount: "10.0000" }, "unknown-cap");
    expect(res.status).toBe(201);
  });
});

describe("RT-787 R-3 — the allocation fields are part of the replayed payload", () => {
  it("re-sending with an allocationRef added → 409 conflict; the original bytes replay 200", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "alloc-replay", quantity: "1", lineAmount: "5.0000" });
    const body = returnBody("alloc-replay-r", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000");
    expect((await postReturn(h, s.saleRef, body, "areplay1")).status).toBe(201);
    const changed = await postReturn(
      h,
      s.saleRef,
      allocatedReturnBody("alloc-replay-r", [{ lineRef: s.lineRef, quantity: "1" }], [
        { amount: "5.0000", allocationRef: uuidFor("added") },
      ]),
      "areplay2",
    );
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("conflict");
    const same = await postReturn(h, s.saleRef, body, "areplay3");
    expect(same.status).toBe(200);
    expect(same.headers["idempotent-replayed"]).toBe("true");
  });
});

describe("RT-787 R-7 — the emit moment is decided at acceptance", () => {
  it("flag on + allocationRef + non-zero total: not emitted at acceptance", async () => {
    if (skip()) return;
    enableSettleBeforePost();
    const s = await captureOneLine(h, { externalId: "r7-deferred", quantity: "1", lineAmount: "5.0000" });
    const res = await postReturn(
      h,
      s.saleRef,
      allocatedReturnBody("r7-deferred-r", [{ lineRef: s.lineRef, quantity: "1" }], [
        { amount: "5.0000", allocationRef: uuidFor("r7-deferred-a") },
      ]),
      "r7def",
    );
    expect(res.status).toBe(201);
    expect(await postingEventsFor(h, res.body.returnRef)).toBe(0);
  });

  it.each([
    ["the flag is off", false, true],
    ["the allocations carry no allocationRef", true, false],
  ])("emitted at acceptance when %s", async (_name, flag, withRef) => {
    if (skip()) return;
    if (flag) enableSettleBeforePost();
    else disableSettleBeforePost();
    const s = await captureOneLine(h, { externalId: `r7-now-${String(flag)}`, quantity: "1", lineAmount: "5.0000" });
    const res = await postReturn(
      h,
      s.saleRef,
      allocatedReturnBody(`r7-now-r-${String(flag)}`, [{ lineRef: s.lineRef, quantity: "1" }], [
        { amount: "5.0000", ...(withRef ? { allocationRef: uuidFor(`r7-now-${String(flag)}`) } : {}) },
      ]),
      `r7now${String(flag)}`,
    );
    expect(res.status).toBe(201);
    expect(await postingEventsFor(h, res.body.returnRef)).toBe(1);
  });
});
