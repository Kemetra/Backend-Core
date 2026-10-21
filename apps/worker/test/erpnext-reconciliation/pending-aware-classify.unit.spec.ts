/**
 * RT-428 (RT-289 DC-7) — the pending-aware class of one (store, product) line
 * of an activated tenant. Docker-free: the exact-decimal sums come from SQL,
 * the classifier only orders the checks and compares canonical strings.
 */
import {
  classifyPendingAware,
  type PendingAwareLine,
} from "../../src/erpnext-reconciliation/pending-aware-classify";

/** A line whose expected ERP book equals the Bin, with nothing pending. */
function line(overrides: Partial<PendingAwareLine> = {}): PendingAwareLine {
  return {
    operationalPosition: "10",
    pendingErp: "0",
    pendingRetail: "0",
    expectedErpBook: "10",
    binQty: "10.000000",
    hasConfirmedMap: true,
    uomMismatch: false,
    snapshotStale: false,
    ...overrides,
  };
}

describe("classifyPendingAware — DC-7 classes (926–930)", () => {
  it("926 in sync: the expected ERP book equals the Bin and nothing is pending", () => {
    expect(classifyPendingAware(line())).toBe("match");
  });

  it("927 a pending sale explains the gap: expected_pending_erp", () => {
    // Operational 8 after a 2-unit sale the ERP has not booked; Bin still 10.
    const cls = classifyPendingAware(
      line({ operationalPosition: "8", pendingErp: "-2", expectedErpBook: "10", binQty: "10" }),
    );
    expect(cls).toBe("expected_pending_erp");
  });

  it("927 a rejected sale is still an ERP-side term: expected_pending_erp", () => {
    const cls = classifyPendingAware(
      line({ operationalPosition: "7", pendingErp: "-3", expectedErpBook: "10", binQty: "10" }),
    );
    expect(cls).toBe("expected_pending_erp");
  });

  it("928 a not-posted manual adjustment explains the gap: expected_pending_retail", () => {
    const cls = classifyPendingAware(
      line({ operationalPosition: "15", pendingRetail: "5", expectedErpBook: "10", binQty: "10" }),
    );
    expect(cls).toBe("expected_pending_retail");
  });

  it("929 a Bin read before the latest confirmation is a stale snapshot, not a divergence", () => {
    const cls = classifyPendingAware(line({ expectedErpBook: "8", binQty: "10", snapshotStale: true }));
    expect(cls).toBe("erp_snapshot_stale");
  });

  it("929 a stale snapshot that still agrees is in sync", () => {
    expect(classifyPendingAware(line({ snapshotStale: true }))).toBe("match");
  });

  it("930 a residual the pending terms do not explain is a divergence", () => {
    const cls = classifyPendingAware(
      line({ operationalPosition: "8", pendingErp: "-2", expectedErpBook: "10", binQty: "9" }),
    );
    expect(cls).toBe("quantity_divergence");
  });
});

describe("classifyPendingAware — precedence", () => {
  it("a negative operational position wins over every quantity class", () => {
    expect(classifyPendingAware(line({ operationalPosition: "-1", binQty: "99" }))).toBe(
      "negative_balance_flagged",
    );
  });

  it("a product with no confirmed item map is unmapped_item", () => {
    expect(classifyPendingAware(line({ hasConfirmedMap: false }))).toBe("unmapped_item");
  });

  it("no Bin entry is dp2_only", () => {
    expect(classifyPendingAware(line({ binQty: undefined }))).toBe("dp2_only");
  });

  it("a unit that differs from the Bin stock UOM is uom_mismatch, never a divergence", () => {
    expect(classifyPendingAware(line({ uomMismatch: true, binQty: "3" }))).toBe("uom_mismatch");
  });

  it("both pending terms explaining the gap report the ERP side first", () => {
    const cls = classifyPendingAware(
      line({ operationalPosition: "13", pendingErp: "-2", pendingRetail: "5", expectedErpBook: "10" }),
    );
    expect(cls).toBe("expected_pending_erp");
  });

  it("pending terms that cancel to zero still name the explanation", () => {
    const cls = classifyPendingAware(
      line({ operationalPosition: "10", pendingErp: "-2", pendingRetail: "2", expectedErpBook: "10" }),
    );
    expect(cls).toBe("expected_pending_erp");
  });
});
