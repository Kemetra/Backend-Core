/**
 * line-pricing.spec.ts — RT-105 (RT-87 decision D).
 *
 * captureSale rejects a first capture whose line breaks the price invariant
 * (`lineAmount = unitPrice × quantity`, minor-unit money, whole quantity) with
 * 422 `sale_line_pricing_invalid`, recording nothing. A replay of a sale
 * captured before RT-105 is never re-checked: it still returns 200. The tender
 * rule (RT-77) is checked first.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  seedPreInvariantSale,
  type HarnessHandle,
} from "./__capture-harness";

const TENDERS_FLAG = "POS_SALE_TENDERS_ENABLED";
const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));
afterEach(async () => {
  delete process.env[TENDERS_FLAG];
  if (!h.harness) return;
  const q = (sql: string) => h.harness!.env.admin.query(sql);
  const sales = "SELECT id FROM sales WHERE source_system = 'pos-1'";
  await q(`DELETE FROM sale_tenders WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sale_lines WHERE sale_id IN (${sales})`);
  await q(`DELETE FROM sales WHERE source_system = 'pos-1'`);
});

const skip = (): boolean => h.dockerSkipped || !h.harness;

function oneLine(
  externalId: string,
  l: { unitPrice: string; quantity: string; lineAmount: string; currencyCode?: string },
) {
  const currencyCode = l.currencyCode ?? "USD";
  return captureBody({
    externalId,
    currencyCode,
    posTotal: l.lineAmount,
    lines: [{ lineName: "Widget", unit: "ea", ...l, currencyCode }],
  });
}

function post(body: Record<string, unknown>, key: string) {
  return h.harness!.http().post("/api/pos/v1/sales").set("Idempotency-Key", idempKey(key)).send(body);
}

async function recorded(externalId: string): Promise<{ sales: number; captured: number }> {
  const r = await h.harness!.env.admin.query<{ sales: string; captured: string }>(
    `SELECT (SELECT count(*) FROM sales WHERE external_id = $1)::text AS sales,
            (SELECT count(*) FROM outbox_events e JOIN sales s ON s.id::text = e.payload->>'sale_id'
              WHERE s.external_id = $1)::text AS captured`,
    [externalId],
  );
  return { sales: Number(r.rows[0]!.sales), captured: Number(r.rows[0]!.captured) };
}

describe("RT-105 — conforming lines are captured as before", () => {
  it("3.33 × 3 = 9.99 is a 201", async () => {
    if (skip()) return;
    const res = await post(oneLine("lp-ok", { unitPrice: "3.33", quantity: "3", lineAmount: "9.99" }), "lpok");
    expect(res.status).toBe(201);
  });

  it("OMR at its 3 ISO-4217 minor digits: 1.234 × 2 = 2.468 is a 201 (comment 10537 gap 2)", async () => {
    if (skip()) return;
    const res = await post(
      oneLine("lp-omr", { currencyCode: "OMR", unitPrice: "1.234", quantity: "2", lineAmount: "2.468" }),
      "lpomr",
    );
    expect(res.status).toBe(201);
  });

  it("trailing zeros compare numerically: 3.3300 × 3.000000 = 9.9900 is a 201", async () => {
    if (skip()) return;
    const res = await post(
      oneLine("lp-zeros", { unitPrice: "3.3300", quantity: "3.000000", lineAmount: "9.9900" }),
      "lpzeros",
    );
    expect(res.status).toBe(201);
  });
});

describe("RT-105 — a line that cannot be returned exactly is 422 and nothing is recorded", () => {
  it.each([
    ["lineAmount ≠ unitPrice × quantity", "lp-prod", { unitPrice: "3.33", quantity: "3", lineAmount: "10.00" }],
    ["unitPrice beyond the minor unit", "lp-up", { unitPrice: "3.3333", quantity: "3", lineAmount: "9.9999" }],
    ["lineAmount beyond the minor unit", "lp-la", { unitPrice: "1.00", quantity: "1", lineAmount: "1.005" }],
    ["fractional quantity", "lp-qty", { unitPrice: "2.00", quantity: "0.5", lineAmount: "1.00" }],
    // Comment 10537 gap 2: the minor unit is the ISO-4217 exponent, never an assumed 2.
    ["KRW (0 minor) with a fractional price", "lp-krw", { currencyCode: "KRW", unitPrice: "1.5", quantity: "2", lineAmount: "3" }],
    ["a currency with no ISO-4217 minor unit (XAU)", "lp-xau", { currencyCode: "XAU", unitPrice: "3", quantity: "3", lineAmount: "9" }],
  ])("%s", async (_name, externalId, l) => {
    if (skip()) return;
    const res = await post(oneLine(externalId, l), externalId.replace(/-/g, ""));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("sale_line_pricing_invalid");
    expect(await recorded(externalId)).toEqual({ sales: 0, captured: 0 });
  });

  it("a later bad line rejects the whole sale", async () => {
    if (skip()) return;
    const body = captureBody({
      externalId: "lp-multi",
      posTotal: "12.5000",
      lines: [
        { lineName: "A", unitPrice: "5.00", currencyCode: "USD", quantity: "1", lineAmount: "5.00", unit: "ea" },
        // 2.50 × 3 = 7.50, not 7.49.
        { lineName: "B", unitPrice: "2.50", currencyCode: "USD", quantity: "3", lineAmount: "7.49", unit: "ea" },
      ],
    });
    const res = await post(body, "lpmulti");
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("sale_line_pricing_invalid");
    expect(await recorded("lp-multi")).toEqual({ sales: 0, captured: 0 });
  });
});

describe("RT-105 — ordering", () => {
  it("a replay of a sale captured before RT-105 is not re-checked: 200 with the stored sale", async () => {
    if (skip()) return;
    const legacy = await seedPreInvariantSale(h, {
      externalId: "lp-legacy",
      unitPrice: "3.3333",
      quantity: "3",
      lineAmount: "10.0000",
    });
    const res = await post(
      oneLine("lp-legacy", { unitPrice: "3.3333", quantity: "3", lineAmount: "10.0000" }),
      "lplegacy",
    );
    expect(res.status).toBe(200);
    expect(res.body.saleRef).toBe(legacy.saleRef);
    expect(res.body.lines[0].lineAmount).toBe("10.0000");
    expect(await recorded("lp-legacy")).toEqual({ sales: 1, captured: 0 });
  });

  it("the tender rule is checked first: a body breaking both answers sale_tender_mismatch", async () => {
    if (skip()) return;
    process.env[TENDERS_FLAG] = "true";
    const body = {
      ...oneLine("lp-both", { unitPrice: "3.33", quantity: "3", lineAmount: "10.00" }),
      tenders: [{ method: "cash", amount: "1.00" }],
    };
    const res = await post(body, "lpboth");
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("sale_tender_mismatch");
  });
});
