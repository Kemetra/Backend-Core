/**
 * line-discount.spec.ts — RT-740 (sales.yaml 1.14.0-draft; RT-699 doc 28
 * DEP-1 / DEP-4, option C-A), against a real RLS-forced Postgres.
 *
 * DEP-1: captureSale accepts a line `discount` whose `lineAmount` is the NET
 * (`unitPrice × quantity − discount.amount`), refuses broken arithmetic with
 * 422 `sale_line_pricing_invalid` recording nothing, and accepts a zero-total
 * sale. The discount is hashed (the same Idempotency-Key with a changed
 * discount is 409) but not stored.
 * DEP-4: readSale and returns work from the stored net: a full return refunds
 * exactly the net. A partial return of a net that does not divide by quantity
 * prices below the minor unit; that case is pinned here as the current
 * behaviour, an open owner decision (see the RT-740 report).
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  type HarnessHandle,
} from "./__capture-harness";
import {
  cleanReturnsFixtures,
  disableReturns,
  enableReturns,
  postReturn,
  returnBody,
} from "../terminal/__returns-support";

const TENDERS_FLAG = "POS_SALE_TENDERS_ENABLED";
const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  disableReturns();
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));
afterEach(async () => {
  delete process.env[TENDERS_FLAG];
  disableReturns();
  await cleanReturnsFixtures(h);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

function discount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "percent",
    value: "10",
    amount: "9.00",
    reasonCode: "promotion",
    authoritySource: "cashier_approval",
    approverRole: "manager",
    ...overrides,
  };
}

interface DiscountedLine {
  readonly unitPrice: string;
  readonly quantity: string;
  readonly lineAmount: string;
  readonly discount?: Record<string, unknown>;
}

function sale(externalId: string, lines: ReadonlyArray<DiscountedLine>, posTotal: string, extra: Record<string, unknown> = {}) {
  return captureBody({
    externalId,
    currencyCode: "EGP",
    posTotal,
    lines: lines.map((l, i) => ({ lineName: `Item ${i + 1}`, currencyCode: "EGP", unit: "box", ...l })),
    ...extra,
  });
}

function post(body: Record<string, unknown>, key: string) {
  return h.harness!.http().post("/api/pos/v1/sales").set("Idempotency-Key", idempKey(key)).send(body);
}

async function salesRecorded(externalId: string): Promise<number> {
  const r = await h.harness!.env.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sales WHERE external_id = $1`,
    [externalId],
  );
  return Number(r.rows[0]!.n);
}

/** doc 28 §5: 2 × 45.00 at 10% → 9.00 off, net 81.00. */
const TEN_PERCENT: DiscountedLine = { unitPrice: "45.00", quantity: "2", lineAmount: "81.00", discount: discount() };

describe("RT-740 DEP-1 — a discounted line is captured with its net", () => {
  it("captures the net lineAmount and posTotal = Σ net; the discount is not echoed", async () => {
    if (skip()) return;
    const body = sale("ld-ok", [TEN_PERCENT, { unitPrice: "12.50", quantity: "1", lineAmount: "12.50" }], "93.50");
    const res = await post(body, "ldok");
    expect(res.status).toBe(201);
    expect(res.body.posTotal).toBe("93.5000");
    expect(res.body.lines.map((l: { lineAmount: string }) => l.lineAmount)).toEqual(["81.0000", "12.5000"]);
    expect(res.body.lines[0]).not.toHaveProperty("discount");

    const read = await h.harness!.http().get(`/api/pos/v1/sales/${res.body.saleRef}`);
    expect(read.status).toBe(200);
    expect(read.body.lines[0]).toMatchObject({ unitPrice: "45.0000", quantity: "2.000000", lineAmount: "81.0000" });
  });

  it("an amount discount: 5.00 off 90.00 is net 85.00", async () => {
    if (skip()) return;
    const line = { ...TEN_PERCENT, lineAmount: "85.00", discount: discount({ kind: "amount", value: "5.00", amount: "5.00" }) };
    const res = await post(sale("ld-amt", [line], "85.00"), "ldamt");
    expect(res.status).toBe(201);
  });

  it("a zero-total sale (every line 100%) without tenders is a 201", async () => {
    if (skip()) return;
    const free = { ...TEN_PERCENT, lineAmount: "0", discount: discount({ value: "100", amount: "90.00" }) };
    const res = await post(sale("ld-zero", [free], "0"), "ldzero");
    expect(res.status).toBe(201);
    expect(res.body.posTotal).toBe("0.0000");
  });

  it("a zero-total sale with one zero cash tender is a 201", async () => {
    if (skip()) return;
    process.env[TENDERS_FLAG] = "true";
    const free = { ...TEN_PERCENT, lineAmount: "0.00", discount: discount({ value: "100", amount: "90.00" }) };
    const res = await post(sale("ld-zero-t", [free], "0.00", { tenders: [{ method: "cash", amount: "0" }] }), "ldzerot");
    expect(res.status).toBe(201);
  });
});

describe("RT-740 DEP-1 — broken discount arithmetic is 422 and nothing is recorded", () => {
  it.each([
    ["lineAmount is the gross", "ld-gross", { ...TEN_PERCENT, lineAmount: "90.00" }, "90.00"],
    ["lineAmount is not gross − amount", "ld-net", { ...TEN_PERCENT, lineAmount: "80.00" }, "80.00"],
    ["the percent amount does not match its value", "ld-pct", { ...TEN_PERCENT, lineAmount: "72.00", discount: discount({ amount: "18.00" }) }, "72.00"],
    ["the amount discount's value differs from its amount", "ld-val", {
      ...TEN_PERCENT, lineAmount: "85.00", discount: discount({ kind: "amount", value: "4.00", amount: "5.00" }),
    }, "85.00"],
  ])("%s", async (_name, externalId, line, posTotal) => {
    if (skip()) return;
    const res = await post(sale(externalId, [line], posTotal), externalId.replace(/-/g, ""));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("sale_line_pricing_invalid");
    expect(await salesRecorded(externalId)).toBe(0);
  });

  it("a free-text reason is a 400 before any pricing check", async () => {
    if (skip()) return;
    const line = { ...TEN_PERCENT, discount: discount({ reasonCode: "customer is a friend" }) };
    const res = await post(sale("ld-reason", [line], "81.00"), "ldreason");
    expect(res.status).toBe(400);
    expect(await salesRecorded("ld-reason")).toBe(0);
  });
});

describe("RT-740 — idempotency", () => {
  it("the same Idempotency-Key re-sent with a changed discount is 409 idempotency_key_conflict", async () => {
    if (skip()) return;
    const first = await post(sale("ld-idem", [TEN_PERCENT], "81.00"), "ldidem");
    expect(first.status).toBe(201);
    const changed = { ...TEN_PERCENT, discount: discount({ reasonCode: "price_correction" }) };
    const second = await post(sale("ld-idem", [changed], "81.00"), "ldidem");
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("idempotency_key_conflict");
    expect(await salesRecorded("ld-idem")).toBe(1);
  });

  it("a provenance replay under another key is not compared: 200 with the stored sale and its net", async () => {
    if (skip()) return;
    const first = await post(sale("ld-prov", [TEN_PERCENT], "81.00"), "ldprov1");
    expect(first.status).toBe(201);
    const changed = { ...TEN_PERCENT, discount: discount({ reasonCode: "price_correction", approverRole: "admin" }) };
    const replay = await post(sale("ld-prov", [changed], "81.00"), "ldprov2");
    expect(replay.status).toBe(200);
    expect(replay.body.saleRef).toBe(first.body.saleRef);
    expect(replay.body.lines[0].lineAmount).toBe("81.0000");
    expect(await salesRecorded("ld-prov")).toBe(1);
  });
});

describe("RT-740 DEP-4 — returns refund the net", () => {
  beforeEach(() => enableReturns());

  it("a full return of a discounted line refunds exactly its net", async () => {
    if (skip()) return;
    const cap = await post(sale("ld-ret-full", [TEN_PERCENT], "81.00"), "ldretfull");
    expect(cap.status).toBe(201);
    const lineRef = cap.body.lines[0].lineRef as string;
    const res = await postReturn(h, cap.body.saleRef, returnBody("ld-ret-full-r", [{ lineRef, quantity: "2" }], "81.00"), "ldretfullr");
    expect(res.status).toBe(201);
    expect(res.body.returnTotal).toBe("81.0000");
  });

  it("a partial return of an evenly divisible net prices at the minor unit (81.00 / 2)", async () => {
    if (skip()) return;
    const cap = await post(sale("ld-ret-half", [TEN_PERCENT], "81.00"), "ldrethalf");
    const lineRef = cap.body.lines[0].lineRef as string;
    const res = await postReturn(h, cap.body.saleRef, returnBody("ld-ret-half-r", [{ lineRef, quantity: "1" }], "40.50"), "ldrethalfr");
    expect(res.status).toBe(201);
    expect(res.body.returnTotal).toBe("40.5000");
  });

  it("a free (100%) line is returned with one zero cash refund tender; an empty list is a 400", async () => {
    if (skip()) return;
    const free = { ...TEN_PERCENT, lineAmount: "0", discount: discount({ value: "100", amount: "90.00" }) };
    const cap = await post(sale("ld-ret-zero", [free], "0"), "ldretzero");
    expect(cap.status).toBe(201);
    const lineRef = cap.body.lines[0].lineRef as string;
    const lines = [{ lineRef, quantity: "1" }];
    const empty = await postReturn(h, cap.body.saleRef, { ...returnBody("ld-ret-zero-a", lines, "0"), refundTenders: [] }, "ldretzeroa");
    expect(empty.status).toBe(400);
    const zeroCash = await postReturn(h, cap.body.saleRef, returnBody("ld-ret-zero-b", lines, "0"), "ldretzerob");
    expect(zeroCash.status).toBe(201);
    expect(zeroCash.body.returnTotal).toBe("0.0000");
    expect(zeroCash.body.refundTenders).toEqual([{ method: "cash", amount: "0.0000" }]);
  });

  it("KNOWN LIMIT (owner decision pending): a net that does not divide prices a partial return below the minor unit", async () => {
    if (skip()) return;
    const line = { unitPrice: "1.00", quantity: "3", lineAmount: "2.99", discount: discount({ kind: "amount", value: "0.01", amount: "0.01" }) };
    const cap = await post(sale("ld-ret-odd", [line], "2.99"), "ldretodd");
    expect(cap.status).toBe(201);
    const lineRef = cap.body.lines[0].lineRef as string;
    // round4(2.99 × 1 / 3) = 0.9967: not payable in EGP (2 minor digits).
    const res = await postReturn(h, cap.body.saleRef, returnBody("ld-ret-odd-r", [{ lineRef, quantity: "1" }], "0.9967"), "ldretoddr");
    expect(res.status).toBe(201);
    expect(res.body.returnTotal).toBe("0.9967");
  });
});
