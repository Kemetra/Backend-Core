/**
 * return-lifecycle.spec.ts — Jira RT-73: line-aware returns (RT-14 D1–D3),
 * void/return exclusivity (D2), the POS_RETURNS_ENABLED gate (AC4) and the
 * reversal business date (RT-63 P2), against a real RLS-forced Postgres.
 *
 * Pricing is the owner-approved cumulative-difference rule (RT-73 comment
 * 10406): a return of q on a line (Q sold, amount A, c already returned) is
 * round4(A×(c+q)/Q) − round4(A×c/Q). The specs prove it sums to A exactly
 * and that a client can recompute every amount from cumulative quantities.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  idempKey,
  STORE_A_X,
  type HarnessHandle,
} from "../capture/__capture-harness";
import {
  captureOneLine,
  cleanReturnsFixtures,
  disableReturns,
  enableReturns,
  postReturn,
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
});
afterEach(async () => {
  await cleanReturnsFixtures(h);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

// ---------------------------------------------------------------------------
// Client-side recomputation (what a POS does): exact integer arithmetic.
// ---------------------------------------------------------------------------
function units(value: string, scale: number): bigint {
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole! + frac.padEnd(scale, "0").slice(0, scale));
}
function roundDiv(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d); // half-up, non-negative operands
}
function fmt4(v: bigint): string {
  const s = v.toString().padStart(5, "0");
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
}
interface PriceQuery {
  /** Line amount A. */
  readonly amount: string;
  /** Quantity sold Q. */
  readonly sold: string;
  /** Quantity already returned c. */
  readonly returned: string;
  /** Quantity being returned q. */
  readonly quantity: string;
}

/** round4(A×(c+q)/Q) − round4(A×c/Q), from cumulative quantities only. */
function clientPrice(p: PriceQuery): string {
  const a4 = units(p.amount, 4);
  const q6 = units(p.sold, 6);
  const before = units(p.returned, 6);
  const after = before + units(p.quantity, 6);
  return fmt4(roundDiv(a4 * after, q6) - roundDiv(a4 * before, q6));
}

// ===========================================================================
// AC4 — deployment gate
// ===========================================================================
describe("RT-73 AC4 — POS_RETURNS_ENABLED gate", () => {
  it("answers 404 not_found and records nothing while the gate is off", async () => {
    if (skip()) return;
    const sale = await captureOneLine(h, { externalId: "ret-gate", quantity: "1", lineAmount: "5.0000" });
    disableReturns();
    const res = await postReturn(
      h,
      sale.saleRef,
      returnBody("ret-gate-1", [{ lineRef: sale.lineRef, quantity: "1" }], "5.0000"),
      "rgate",
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
    const n = await h.harness!.env.admin.query("SELECT 1 FROM sale_returns");
    expect(n.rowCount).toBe(0);
  });
});

// ===========================================================================
// Happy path + read-side returnability
// ===========================================================================
describe("RT-73 — recording a return", () => {
  it("prices a partial return server-side and returns the SaleReturn projection", async () => {
    if (skip()) return;
    const sale = await captureOneLine(h, { externalId: "ret-happy", quantity: "3", lineAmount: "10.0000" });
    const res = await postReturn(
      h,
      sale.saleRef,
      returnBody("ret-happy-1", [{ lineRef: sale.lineRef, quantity: "2" }], "6.6667", {
        reason: "damaged box",
      }),
      "rhappy",
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      saleRef: sale.saleRef,
      sourceSystem: "pos-1",
      externalId: "ret-happy-1",
      currencyCode: "USD",
      returnTotal: "6.6667",
      reason: "damaged box",
      refundTenders: [{ method: "cash", amount: "6.6667" }],
      lines: [
        {
          lineRef: sale.lineRef,
          quantity: "2.000000",
          lineAmount: "6.6667",
          taxAmount: null,
          returnedQuantity: "2.000000",
          returnableQuantity: "1.000000",
        },
      ],
    });
    expect(res.body.returnRef).toEqual(expect.any(String));
    expect(res.body.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(res.body.recordedAt))).toBe(false);
  });

  it("emits erpnext.posting.requested (kind reversal, source_ref_id = the return) in the same transaction", async () => {
    if (skip()) return;
    const sale = await captureOneLine(h, { externalId: "ret-outbox", quantity: "1", lineAmount: "5.0000" });
    const res = await postReturn(
      h,
      sale.saleRef,
      returnBody("ret-outbox-1", [{ lineRef: sale.lineRef, quantity: "1" }], "5.0000"),
      "routbox",
    );
    expect(res.status).toBe(201);
    const ev = await h.harness!.env.admin.query<{ payload: Record<string, string> }>(
      `SELECT payload FROM outbox_events
        WHERE event_type = 'erpnext.posting.requested'
          AND payload->>'source_ref_id' = $1`,
      [res.body.returnRef],
    );
    expect(ev.rowCount).toBe(1);
    expect(ev.rows[0]?.payload).toMatchObject({ sale_id: sale.saleRef, kind: "reversal" });
  });

  it("readSale exposes lineRef, returnedQuantity, returnableQuantity and voided", async () => {
    if (skip()) return;
    const sale = await captureOneLine(h, { externalId: "ret-read", quantity: "3", lineAmount: "9.0000" });
    await postReturn(
      h,
      sale.saleRef,
      returnBody("ret-read-1", [{ lineRef: sale.lineRef, quantity: "1" }], "3.0000"),
      "rread",
    );
    const read = await h.harness!.http().get(`/api/pos/v1/sales/${sale.saleRef}`);
    expect(read.status).toBe(200);
    expect(read.body.voided).toBe(false);
    expect(read.body.lines[0]).toMatchObject({
      lineRef: sale.lineRef,
      returnedQuantity: "1.000000",
      returnableQuantity: "2.000000",
    });
  });

  it("a void makes every line's returnableQuantity 0 and voided true", async () => {
    if (skip()) return;
    const sale = await captureOneLine(h, { externalId: "ret-voidread", quantity: "2", lineAmount: "4.0000" });
    const v = await h
      .harness!.http()
      .post(`/api/pos/v1/sales/${sale.saleRef}/void`)
      .set("Idempotency-Key", idempKey("rvoidread"))
      .send({ sourceSystem: "pos-1", externalId: "void-voidread" });
    expect(v.status).toBe(201);
    const read = await h.harness!.http().get(`/api/pos/v1/sales/${sale.saleRef}`);
    expect(read.body.voided).toBe(true);
    expect(read.body.lines[0].returnableQuantity).toBe("0.000000");
  });
});

// ===========================================================================
// Pricing — cumulative-difference rule (option (a))
// ===========================================================================
describe("RT-73 — cumulative-difference pricing", () => {
  interface SequencePlan {
    readonly externalId: string;
    readonly split: readonly string[];
    readonly taxAmount?: string;
  }
  async function returnSequence({
    externalId,
    split,
    taxAmount,
  }: SequencePlan): Promise<Array<{ lineAmount: string; taxAmount: string | null }>> {
    const sale = await captureOneLine(h, {
      externalId,
      quantity: "3",
      lineAmount: "10.0000",
      ...(taxAmount === undefined ? {} : { taxAmount }),
    });
    const out: Array<{ lineAmount: string; taxAmount: string | null }> = [];
    let cumulative = "0";
    for (const [i, q] of split.entries()) {
      const expected = clientPrice({ amount: "10.0000", sold: "3", returned: cumulative, quantity: q });
      const res = await postReturn(
        h,
        sale.saleRef,
        returnBody(`${externalId}-${i}`, [{ lineRef: sale.lineRef, quantity: q }], expected),
        `${externalId}${i}`,
      );
      expect(res.status).toBe(201);
      // The client's recomputation from cumulative quantities matches exactly.
      expect(res.body.lines[0].lineAmount).toBe(expected);
      out.push({ lineAmount: res.body.lines[0].lineAmount, taxAmount: res.body.lines[0].taxAmount });
      cumulative = res.body.lines[0].returnedQuantity;
    }
    return out;
  }
  const sum4 = (xs: Array<string | null>): string =>
    fmt4(xs.reduce<bigint>((acc, x) => acc + units(x ?? "0", 4), 0n));

  it("3 × 10.0000 returned as 2 + 1 sums to exactly 10.0000", async () => {
    if (skip()) return;
    const parts = await returnSequence({ externalId: "ret-p21", split: ["2", "1"] });
    expect(parts.map((p) => p.lineAmount)).toEqual(["6.6667", "3.3333"]);
    expect(sum4(parts.map((p) => p.lineAmount))).toBe("10.0000");
  });

  it("3 × 10.0000 returned as 1 + 1 + 1 sums to exactly 10.0000", async () => {
    if (skip()) return;
    const parts = await returnSequence({ externalId: "ret-p111", split: ["1", "1", "1"] });
    expect(parts.map((p) => p.lineAmount)).toEqual(["3.3333", "3.3334", "3.3333"]);
    expect(sum4(parts.map((p) => p.lineAmount))).toBe("10.0000");
  });

  it("splits the line tax by the same rule, summing to the line tax", async () => {
    if (skip()) return;
    const parts = await returnSequence({ externalId: "ret-ptax", split: ["1", "1", "1"], taxAmount: "1.0000" });
    expect(parts.map((p) => p.taxAmount)).toEqual(["0.3333", "0.3334", "0.3333"]);
    expect(sum4(parts.map((p) => p.taxAmount))).toBe("1.0000");
  });
});

// ===========================================================================
// Invariants + error vocabulary
// ===========================================================================
describe("RT-73 — invariants", () => {
  it("over-return → 409 over_return, nothing recorded", async () => {
    if (skip()) return;
    const sale = await captureOneLine(h, { externalId: "ret-over", quantity: "3", lineAmount: "9.0000" });
    const ok = await postReturn(h, sale.saleRef, returnBody("ret-over-1", [{ lineRef: sale.lineRef, quantity: "2" }], "6.0000"), "rover1");
    expect(ok.status).toBe(201);
    const over = await postReturn(h, sale.saleRef, returnBody("ret-over-2", [{ lineRef: sale.lineRef, quantity: "2" }], "6.0000"), "rover2");
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("over_return");
    const n = await h.harness!.env.admin.query("SELECT 1 FROM sale_returns WHERE external_id = 'ret-over-2'");
    expect(n.rowCount).toBe(0);
  });

  it("an over-return past the numeric(19,6) bound is still 409 over_return, never a 500", async () => {
    if (skip()) return;
    // sold 9999999999999 (13 integer digits), 1 already returned, then another
    // 9999999999999: c + q has 14 integer digits and must not be cast.
    const s = await captureOneLine(h, { externalId: "ret-bound", quantity: "9999999999999", lineAmount: "1.0000" });
    const one = await postReturn(h, s.saleRef, returnBody("ret-bound-1", [{ lineRef: s.lineRef, quantity: "1" }], "0"), "rbound1");
    expect(one.status).toBe(201);
    const big = await postReturn(h, s.saleRef, returnBody("ret-bound-2", [{ lineRef: s.lineRef, quantity: "9999999999999" }], "1.0000"), "rbound2");
    expect(big.status).toBe(409);
    expect(big.body.error.code).toBe("over_return");
  });

  it("tender sum ≠ server total → 422 return_tender_mismatch; a numerically equal tender is accepted", async () => {
    if (skip()) return;
    const sale = await captureOneLine(h, { externalId: "ret-tender", quantity: "2", lineAmount: "10.0000" });
    const bad = await postReturn(h, sale.saleRef, returnBody("ret-tender-1", [{ lineRef: sale.lineRef, quantity: "1" }], "4.9999"), "rtend1");
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("return_tender_mismatch");
    const good = await postReturn(h, sale.saleRef, returnBody("ret-tender-2", [{ lineRef: sale.lineRef, quantity: "1" }], "5"), "rtend2");
    expect(good.status).toBe(201);
    expect(good.body.refundTenders).toEqual([{ method: "cash", amount: "5.0000" }]);
  });

  it("a lineRef that is not a line of this sale → 400", async () => {
    if (skip()) return;
    const a = await captureOneLine(h, { externalId: "ret-lineA", quantity: "1", lineAmount: "5.0000" });
    const b = await captureOneLine(h, { externalId: "ret-lineB", quantity: "1", lineAmount: "5.0000" });
    const res = await postReturn(h, a.saleRef, returnBody("ret-line-1", [{ lineRef: b.lineRef, quantity: "1" }], "5.0000"), "rline");
    expect(res.status).toBe(400);
  });

  it("a duplicated lineRef or a zero quantity → 400 at the boundary", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "ret-dup", quantity: "3", lineAmount: "9.0000" });
    const dup = await postReturn(
      h,
      s.saleRef,
      returnBody("ret-dup-1", [{ lineRef: s.lineRef, quantity: "1" }, { lineRef: s.lineRef, quantity: "1" }], "6.0000"),
      "rdup",
    );
    expect(dup.status).toBe(400);
    const zero = await postReturn(h, s.saleRef, returnBody("ret-zero-1", [{ lineRef: s.lineRef, quantity: "0" }], "0"), "rzero");
    expect(zero.status).toBe(400);
  });

  it("return after void → 409 already_reversed", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "ret-aftervoid", quantity: "1", lineAmount: "5.0000" });
    const v = await h.harness!.http().post(`/api/pos/v1/sales/${s.saleRef}/void`).set("Idempotency-Key", idempKey("rav")).send({ sourceSystem: "pos-1", externalId: "void-av" });
    expect(v.status).toBe(201);
    const r = await postReturn(h, s.saleRef, returnBody("ret-av-1", [{ lineRef: s.lineRef, quantity: "1" }], "5.0000"), "rav1");
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("already_reversed");
  });

  it("void after return → 409 already_reversed", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "ret-voidafter", quantity: "2", lineAmount: "4.0000" });
    const r = await postReturn(h, s.saleRef, returnBody("ret-va-1", [{ lineRef: s.lineRef, quantity: "1" }], "2.0000"), "rva1");
    expect(r.status).toBe(201);
    const v = await h.harness!.http().post(`/api/pos/v1/sales/${s.saleRef}/void`).set("Idempotency-Key", idempKey("rva")).send({ sourceSystem: "pos-1", externalId: "void-va" });
    expect(v.status).toBe(409);
    expect(v.body.error.code).toBe("already_reversed");
  });

  it("a second, different void → 409 already_reversed; re-delivering the first void still replays 200", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "ret-2void", quantity: "1", lineAmount: "5.0000" });
    const post = (v: { externalId: string; key: string }) =>
      h.harness!.http().post(`/api/pos/v1/sales/${s.saleRef}/void`).set("Idempotency-Key", idempKey(v.key)).send({ sourceSystem: "pos-1", externalId: v.externalId });
    expect((await post({ externalId: "void-2v-a", key: "r2va" })).status).toBe(201);
    const second = await post({ externalId: "void-2v-b", key: "r2vb" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("already_reversed");
    const replay = await post({ externalId: "void-2v-a", key: "r2vc" });
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
  });
});

// ===========================================================================
// Idempotency — provenance replay is byte-identical
// ===========================================================================
describe("RT-73 — replay and provenance", () => {
  it("a replay returns the identical body even after a later return used up the line", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "ret-replay", quantity: "3", lineAmount: "10.0000" });
    const body = returnBody("ret-replay-1", [{ lineRef: s.lineRef, quantity: "1" }], "3.3333");
    const first = await postReturn(h, s.saleRef, body, "rrep1");
    expect(first.status).toBe(201);
    const later = await postReturn(h, s.saleRef, returnBody("ret-replay-2", [{ lineRef: s.lineRef, quantity: "2" }], "6.6667"), "rrep2");
    expect(later.status).toBe(201);
    const replay = await postReturn(h, s.saleRef, body, "rrep3");
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
  });

  it("the same provenance with a different payload → 409 conflict", async () => {
    if (skip()) return;
    const s = await captureOneLine(h, { externalId: "ret-prov", quantity: "3", lineAmount: "9.0000" });
    expect((await postReturn(h, s.saleRef, returnBody("ret-prov-1", [{ lineRef: s.lineRef, quantity: "1" }], "3.0000"), "rprov1")).status).toBe(201);
    const res = await postReturn(h, s.saleRef, returnBody("ret-prov-1", [{ lineRef: s.lineRef, quantity: "2" }], "6.0000"), "rprov2");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
  });

  it("the same provenance against a different sale → 409, nothing recorded for that sale", async () => {
    if (skip()) return;
    const a = await captureOneLine(h, { externalId: "ret-xsA", quantity: "1", lineAmount: "5.0000" });
    const b = await captureOneLine(h, { externalId: "ret-xsB", quantity: "1", lineAmount: "5.0000" });
    expect((await postReturn(h, a.saleRef, returnBody("ret-xs-1", [{ lineRef: a.lineRef, quantity: "1" }], "5.0000"), "rxs1")).status).toBe(201);
    const res = await postReturn(h, b.saleRef, returnBody("ret-xs-1", [{ lineRef: b.lineRef, quantity: "1" }], "5.0000"), "rxs2");
    expect(res.status).toBe(409);
    const rows = await h.harness!.env.admin.query("SELECT 1 FROM sale_returns WHERE sale_id = $1", [b.saleRef]);
    expect(rows.rowCount).toBe(0);
  });
});

// ===========================================================================
// RT-63 P2 — the reversal's own business date, persisted at insert
// ===========================================================================
describe("RT-63 P2 — reversal business date", () => {
  let originalTz = "UTC";
  beforeEach(async () => {
    if (skip()) return;
    const r = await h.harness!.env.admin.query<{ timezone: string }>("SELECT timezone FROM stores WHERE id = $1", [STORE_A_X]);
    originalTz = r.rows[0]!.timezone;
    await h.harness!.env.admin.query("UPDATE stores SET timezone = 'Africa/Cairo' WHERE id = $1", [STORE_A_X]);
  });
  afterEach(async () => {
    if (skip()) return;
    await h.harness!.env.admin.query("UPDATE stores SET timezone = $2 WHERE id = $1", [STORE_A_X, originalTz]);
  });

  it("stores the void's and the return's business date in the store timezone; a later timezone change does not move them", async () => {
    if (skip()) return;
    const admin = h.harness!.env.admin;
    const s1 = await captureOneLine(h, { externalId: "ret-bd-v", quantity: "1", lineAmount: "5.0000" });
    const v = await h.harness!.http().post(`/api/pos/v1/sales/${s1.saleRef}/void`).set("Idempotency-Key", idempKey("rbdv")).send({ sourceSystem: "pos-1", externalId: "void-bd" });
    expect(v.status).toBe(201);
    const s2 = await captureOneLine(h, { externalId: "ret-bd-r", quantity: "1", lineAmount: "5.0000" });
    const r = await postReturn(h, s2.saleRef, returnBody("ret-bd-1", [{ lineRef: s2.lineRef, quantity: "1" }], "5.0000"), "rbdr");
    expect(r.status).toBe(201);

    const cairo = async () =>
      admin.query<{ v_bd: string; v_exp: string; r_bd: string; r_exp: string }>(
        `SELECT v.business_date::text AS v_bd,
                (v.voided_at AT TIME ZONE 'Africa/Cairo')::date::text AS v_exp,
                r.business_date::text AS r_bd,
                (r.returned_at AT TIME ZONE 'Africa/Cairo')::date::text AS r_exp
           FROM sale_voids v, sale_returns r
          WHERE v.sale_id = $1 AND r.sale_id = $2`,
        [s1.saleRef, s2.saleRef],
      );
    const before = (await cairo()).rows[0]!;
    expect(before.v_bd).toBe(before.v_exp);
    expect(before.r_bd).toBe(before.r_exp);
    expect(r.body.businessDate).toBe(before.r_bd);

    await admin.query("UPDATE stores SET timezone = 'Pacific/Kiritimati' WHERE id = $1", [STORE_A_X]);
    const after = (await cairo()).rows[0]!;
    expect(after.v_bd).toBe(before.v_bd);
    expect(after.r_bd).toBe(before.r_bd);
  });
});
