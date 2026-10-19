/**
 * RT-649 — the pure parts of the console sales summary: the exact decimal
 * sums, the assembly of the aggregated groups, the request schema and the
 * store-page cursor. No DB, no HTTP (the HTTP suite is
 * `console-sales-summary.http.integration.spec.ts`).
 */
import {
  assembleSummary,
  formatDecimal4,
  parseDecimal4,
  type AssembleSummaryInput,
  type SummaryFactRow,
} from "../../src/console-sales/console-sales-summary.projections";
import {
  businessDatesOf,
  ConsoleSalesSummaryQuerySchema,
  decodeSalesSummaryCursor,
  encodeSalesSummaryCursor,
  InvalidSalesSummaryCursorError,
  type SummaryCursorBinding,
} from "../../src/console-sales/console-sales-summary.query";

const S1 = "0a000000-0000-7000-8000-000000000001";
const S2 = "0a000000-0000-7000-8000-000000000002";
const S3 = "0a000000-0000-7000-8000-000000000003";
const TENANT = "0a000000-0000-7000-8000-0000000000aa";

function fact(partial: Partial<SummaryFactRow> & Pick<SummaryFactRow, "kind" | "store_id" | "business_date">): SummaryFactRow {
  return { currency_code: null, k1: null, k2: null, k3: null, n: 1, amount: null, ...partial };
}

function input(overrides: Partial<AssembleSummaryInput> = {}): AssembleSummaryInput {
  return {
    scope: "all_in_scope",
    storeRef: null,
    from: "2026-10-01",
    to: "2026-10-02",
    dates: ["2026-10-01", "2026-10-02"],
    asOf: "2026-10-02T10:00:00.000Z",
    stores: [
      { store_id: S2, timezone: "UTC", current_business_date: "2026-10-02" },
      { store_id: S1, timezone: "Africa/Cairo", current_business_date: "2026-10-02" },
    ],
    facts: [],
    after: null,
    pageSize: 50,
    ...overrides,
  };
}

describe("RT-649 summary — exact decimals", () => {
  it.each([
    ["0.0000", 0n],
    ["12.5000", 125000n],
    ["12.5", 125000n],
    ["7", 70000n],
    ["999999999999999.9999", 9999999999999999999n],
    ["-1.0000", -10000n],
  ])("parses %s", (text, value) => {
    expect(parseDecimal4(text)).toBe(value);
  });

  it.each(["", "1.23456", "1e3", "NaN", "1,00", " 1"])("refuses %j", (text) => {
    expect(() => parseDecimal4(text)).toThrow();
  });

  it("formats with four digits and adds beyond the float range exactly", () => {
    expect(formatDecimal4(0n)).toBe("0.0000");
    expect(formatDecimal4(125000n)).toBe("12.5000");
    expect(formatDecimal4(-5n)).toBe("-0.0005");
    const big = parseDecimal4("999999999999999.9999") + parseDecimal4("0.0001");
    expect(formatDecimal4(big)).toBe("1000000000000000.0000");
    // 0.1 + 0.2 in floating point is 0.30000000000000004.
    expect(formatDecimal4(parseDecimal4("0.1000") + parseDecimal4("0.2000"))).toBe("0.3000");
  });
});

describe("RT-649 summary — assembly", () => {
  it("zero-fills every store and date, orders stores by id and states completeness", () => {
    const out = assembleSummary(input()).body;
    expect(out.completeness).toBe("received_only");
    expect(out.stores.map((s) => s.storeRef)).toEqual([S1, S2]);
    expect(out.stores[0]!.days.map((d) => d.businessDate)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(out.stores[0]!.rangeTotals.receivedSales).toEqual({ count: 0, byCurrency: [] });
    expect(out.scopeTotals.storeCount).toBe(2);
  });

  it("rolls sale groups into days, store ranges and scope totals, per currency", () => {
    const facts = [
      fact({ kind: "sale", store_id: S1, business_date: "2026-10-01", currency_code: "EGP", k1: "synced", k2: "posted", n: 2, amount: "25.0000" }),
      fact({ kind: "sale", store_id: S1, business_date: "2026-10-01", currency_code: "EGP", k1: "captured", k2: null, n: 1, amount: "0.1000" }),
      fact({ kind: "sale", store_id: S1, business_date: "2026-10-02", currency_code: "USD", k1: "failed-retryable", k2: "failed_transient", n: 1, amount: "3.0000" }),
      fact({ kind: "sale", store_id: S2, business_date: "2026-10-02", currency_code: "EGP", k1: "failed-needs-repair", k2: "permanently_rejected", n: 1, amount: "0.2000" }),
    ];
    const out = assembleSummary(input({ facts })).body;
    const s1 = out.stores[0]!;
    expect(s1.days[0]!.kpis.receivedSales).toEqual({ count: 3, byCurrency: [{ currencyCode: "EGP", count: 3, total: "25.1000" }] });
    expect(s1.rangeTotals.receivedSales.byCurrency.map((c) => c.currencyCode)).toEqual(["EGP", "USD"]);
    expect(s1.rangeTotals.erpPosting).toEqual({ posted: 2, pending: 1, failed: 0, unknown: 1 });
    expect(s1.rangeTotals.syncStatus).toEqual({ captured: 1, synced: 2, failedRetryable: 1, failedNeedsRepair: 0 });
    expect(out.scopeTotals.rangeTotals.receivedSales).toEqual({
      count: 5,
      byCurrency: [
        { currencyCode: "EGP", count: 4, total: "25.3000" },
        { currencyCode: "USD", count: 1, total: "3.0000" },
      ],
    });
    expect(out.scopeTotals.days[1]!.kpis.erpPosting).toEqual({ posted: 0, pending: 1, failed: 1, unknown: 0 });
  });

  it("counts closes by kind, variance and the approvalMissing tri-state", () => {
    const facts = [
      fact({ kind: "close", store_id: S1, business_date: "2026-10-01", k1: "forced", k2: "unknown", k3: "true", n: 2 }),
      fact({ kind: "close", store_id: S1, business_date: "2026-10-01", k1: "normal", k2: "yes", k3: "false", n: 1 }),
    ];
    const kpis = assembleSummary(input({ facts })).body.stores[0]!.days[0]!.kpis;
    expect(kpis.shiftCloses).toEqual({ count: 3, normal: 1, forced: 2, withVariance: 2, approvalMissing: { yes: 1, no: 0, unknown: 2 } });
  });

  it("keeps voids, returns and legacy refunds apart", () => {
    const facts = [
      fact({ kind: "void", store_id: S1, business_date: "2026-10-01", currency_code: "EGP", amount: "1.0000" }),
      fact({ kind: "return", store_id: S1, business_date: "2026-10-01", currency_code: "EGP", amount: "2.0000" }),
      fact({ kind: "refund", store_id: S1, business_date: "2026-10-01", currency_code: "EGP", amount: "3.0000" }),
    ];
    const kpis = assembleSummary(input({ facts })).body.stores[0]!.rangeTotals;
    expect(kpis.voids.byCurrency[0]!.total).toBe("1.0000");
    expect(kpis.returns.byCurrency[0]!.total).toBe("2.0000");
    expect(kpis.legacyRefunds.byCurrency[0]!.total).toBe("3.0000");
    expect(kpis.receivedSales.count).toBe(0);
  });

  it("refuses a group outside the scoped stores or the range, or with an unknown state", () => {
    const outside = fact({ kind: "void", store_id: S3, business_date: "2026-10-01", currency_code: "EGP", amount: "1.0000" });
    expect(() => assembleSummary(input({ facts: [outside] }))).toThrow(/outside/);
    const late = fact({ kind: "void", store_id: S1, business_date: "2026-10-03", currency_code: "EGP", amount: "1.0000" });
    expect(() => assembleSummary(input({ facts: [late] }))).toThrow(/outside/);
    const odd = fact({ kind: "sale", store_id: S1, business_date: "2026-10-01", currency_code: "EGP", k1: "weird", amount: "1.0000" });
    expect(() => assembleSummary(input({ facts: [odd] }))).toThrow(/sync status/);
  });

  it("pages stores after the cursor and keeps the scope totals of every store", () => {
    const facts = [
      fact({ kind: "sale", store_id: S2, business_date: "2026-10-01", currency_code: "EGP", k1: "synced", amount: "1.0000" }),
    ];
    const stores = [
      { store_id: S3, timezone: "UTC", current_business_date: "2026-10-02" },
      ...input().stores,
    ];
    const first = assembleSummary(input({ stores, facts, pageSize: 2 }));
    expect(first.body.stores.map((s) => s.storeRef)).toEqual([S1, S2]);
    expect(first.resumeAfter).toBe(S2);
    const last = assembleSummary(input({ stores, facts, pageSize: 2, after: S2 }));
    expect(last.body.stores.map((s) => s.storeRef)).toEqual([S3]);
    expect(last.resumeAfter).toBeNull();
    expect(last.body.scopeTotals).toEqual(first.body.scopeTotals);
    expect(last.body.scopeTotals.storeCount).toBe(3);
  });
});

describe("RT-649 summary — query and cursor", () => {
  const parse = (q: Record<string, unknown>) => ConsoleSalesSummaryQuerySchema.safeParse(q);

  it("accepts 1 to 31 business days and lower-cases the store", () => {
    expect(parse({ from: "2026-10-01", to: "2026-10-31" }).success).toBe(true);
    const r = parse({ store_id: S1.toUpperCase(), from: "2026-10-01", to: "2026-10-01", page_size: "50" });
    expect(r.success && r.data.store_id).toBe(S1);
  });

  it.each([
    [{ from: "2026-10-01", to: "2026-11-01" }],
    [{ from: "2026-10-02", to: "2026-10-01" }],
    [{ from: "2026-02-30", to: "2026-03-01" }],
    [{ from: "2026-10-01", to: "2026-10-02", page_size: "51" }],
    [{ from: "2026-10-01", to: "2026-10-02", page_size: ["5"] }],
    [{ from: ["2026-10-01", "2026-10-02"], to: "2026-10-02" }],
    [{ from: "2026-10-01", to: "2026-10-02", tenant_id: TENANT }],
  ])("refuses %j", (q) => {
    expect(parse(q).success).toBe(false);
  });

  it("lists every date of a range across a month end", () => {
    expect(businessDatesOf("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    expect(businessDatesOf("2026-03-08", "2026-03-08")).toEqual(["2026-03-08"]);
  });

  const binding: SummaryCursorBinding = { tenantId: TENANT, storeId: null, from: "2026-10-01", to: "2026-10-31", pageSize: 2 };

  it("round-trips the last store id under its binding only", () => {
    const cursor = encodeSalesSummaryCursor(binding, S1);
    expect(decodeSalesSummaryCursor(binding, cursor)).toBe(S1);
    for (const other of [
      { ...binding, tenantId: S3 },
      { ...binding, storeId: S1 },
      { ...binding, from: "2026-10-02" },
      { ...binding, to: "2026-10-30" },
      { ...binding, pageSize: 3 },
    ]) {
      expect(() => decodeSalesSummaryCursor(other, cursor)).toThrow(InvalidSalesSummaryCursorError);
    }
  });

  it("refuses a token it did not issue", () => {
    const foreign = Buffer.from(JSON.stringify({ op: "console_sales", tenant: TENANT })).toString("base64url");
    expect(() => decodeSalesSummaryCursor(binding, foreign)).toThrow(InvalidSalesSummaryCursorError);
    expect(() => decodeSalesSummaryCursor(binding, "%%%")).toThrow(InvalidSalesSummaryCursorError);
  });
});
