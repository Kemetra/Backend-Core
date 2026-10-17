/**
 * RT-387 — the pure shift variance policy core (AD-CASH-001 D-1 / D-2 / D-7):
 * the close-time derivation, stricter-wins comparison and resolution. No DB.
 */
import {
  approvalRequiredBy,
  compareStrictness,
  deriveCloseApproval,
  renderPolicyValue,
  SYSTEM_DEFAULT,
  type PolicyValue,
} from "../../src/cash-variance-policy/policy-value";
import {
  activeOverrideAt,
  resolveEffective,
  revisionState,
  tenantLevelAt,
  type PolicyRevision,
} from "../../src/cash-variance-policy/policy-resolution";

const limit = (limitAmount: string, currencyCode = "EGP"): PolicyValue => ({ mode: "limit", limitAmount, currencyCode });
const NONE: PolicyValue = { mode: "none" };

describe("approvalRequiredBy (D-1: yes exactly when |variance| > limit)", () => {
  it.each([
    ["none, any variance", NONE, "-999.99", false],
    ["limit 10, variance 10 (equal closes alone)", limit("10.00"), "10.00", false],
    ["limit 10, variance 10.01", limit("10.00"), "10.01", true],
    ["limit 10, variance -10.01 (absolute value)", limit("10.00"), "-10.01", true],
    ["limit 10, variance -10", limit("10.00"), "-10", false],
    ["limit 0, variance 0", limit("0"), "0.00", false],
    ["limit 0, variance 0.01", limit("0"), "0.01", true],
    ["limit 0.0001 (stored scale), variance 0.0001", limit("0.0001"), "0.0001", false],
    ["limit in another currency is compared as frozen", limit("5.00", "USD"), "6.00", true],
    ["huge values stay exact", limit("999999999999999.9998"), "999999999999999.9999", true],
  ])("%s", (_label, value, variance, expected) => {
    expect(approvalRequiredBy(value, variance)).toBe(expected);
  });
});

describe("deriveCloseApproval (D-7, the 0050 close guard's rule)", () => {
  it("is unknown/unknown when the shift froze no policy", () => {
    expect(deriveCloseApproval({ frozen: null, variance: "50.00", approverUserId: null })).toEqual({
      approvalRequiredByPolicy: "unknown",
      approvalMissing: "unknown",
    });
  });
  it("is no/no under none", () => {
    expect(deriveCloseApproval({ frozen: NONE, variance: "50.00", approverUserId: null })).toEqual({
      approvalRequiredByPolicy: "no",
      approvalMissing: "no",
    });
  });
  it("is yes/yes when required and no approver was recorded", () => {
    expect(deriveCloseApproval({ frozen: limit("10"), variance: "-11", approverUserId: null })).toEqual({
      approvalRequiredByPolicy: "yes",
      approvalMissing: "yes",
    });
  });
  it("is yes/no when required and an approver was recorded", () => {
    expect(deriveCloseApproval({ frozen: limit("10"), variance: "11", approverUserId: "u" })).toEqual({
      approvalRequiredByPolicy: "yes",
      approvalMissing: "no",
    });
  });
  it("is no/no under a limit that is not exceeded, approver or not", () => {
    expect(deriveCloseApproval({ frozen: limit("10"), variance: "1", approverUserId: "u" })).toEqual({
      approvalRequiredByPolicy: "no",
      approvalMissing: "no",
    });
  });
});

describe("compareStrictness (D-2 stricter wins)", () => {
  it("orders none loosest, a lower limit stricter, equal limits tie", () => {
    expect(compareStrictness(NONE, NONE)).toBe(0);
    expect(compareStrictness(limit("100"), NONE)).toBeGreaterThan(0);
    expect(compareStrictness(NONE, limit("0"))).toBeLessThan(0);
    expect(compareStrictness(limit("5.00"), limit("10"))).toBeGreaterThan(0);
    expect(compareStrictness(limit("10.00"), limit("10"))).toBe(0);
  });
});

describe("renderPolicyValue", () => {
  it("renders a stored numeric(19,4) limit at the currency's minor unit", () => {
    expect(renderPolicyValue({ mode: "limit", limitAmount: "10.5000", currencyCode: "EGP" })).toEqual(limit("10.50"));
  });
  it("renders a currency with no minor unit, or a finer amount, without trailing zeros", () => {
    expect(renderPolicyValue({ mode: "limit", limitAmount: "10.5000", currencyCode: "XXX" })).toEqual(limit("10.5", "XXX"));
    expect(renderPolicyValue({ mode: "limit", limitAmount: "10.1234", currencyCode: "EGP" })).toEqual(limit("10.1234"));
    expect(renderPolicyValue({ mode: "limit", limitAmount: "7.0000", currencyCode: "XXX" })).toEqual(limit("7", "XXX"));
  });
  it("renders none without amount or currency", () => {
    expect(renderPolicyValue({ mode: "none", limitAmount: null, currencyCode: null })).toEqual(NONE);
  });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const T0 = new Date("2026-10-01T00:00:00Z");
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000);
let seq = 0;
function rev(partial: Partial<PolicyRevision> & Pick<PolicyRevision, "scope" | "createdAt">): PolicyRevision {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    storeId: partial.scope === "store" ? "store-1" : null,
    kind: "set",
    value: limit("10.00"),
    reason: "r",
    effectiveUntil: null,
    permanent: false,
    approvedByUserId: null,
    supersedesRevisionId: null,
    createdByUserId: "user-1",
    ...partial,
  };
}

describe("tenantLevelAt", () => {
  it("is the System default before any tenant revision", () => {
    expect(tenantLevelAt([], at(0))).toEqual({ policySource: "system", policyRevisionId: null, policyValue: SYSTEM_DEFAULT });
  });
  it("is the latest tenant revision created at or before the instant", () => {
    const r1 = rev({ scope: "tenant", createdAt: at(0), value: limit("50") });
    const r2 = rev({ scope: "tenant", createdAt: at(10), value: NONE });
    expect(tenantLevelAt([r1, r2], at(5)).policyRevisionId).toBe(r1.id);
    expect(tenantLevelAt([r1, r2], at(10)).policyRevisionId).toBe(r2.id);
    expect(tenantLevelAt([r1, r2], at(-1)).policySource).toBe("system");
  });
});

describe("activeOverrideAt", () => {
  it("is the latest store set that has not expired", () => {
    const s1 = rev({ scope: "store", createdAt: at(0), effectiveUntil: at(60) });
    expect(activeOverrideAt([s1], at(59))?.id).toBe(s1.id);
    expect(activeOverrideAt([s1], at(60))).toBeNull();
  });
  it("is null after a clear, and before the first revision", () => {
    const s1 = rev({ scope: "store", createdAt: at(0) });
    const c1 = rev({ scope: "store", createdAt: at(5), kind: "clear", value: null });
    expect(activeOverrideAt([s1, c1], at(4))?.id).toBe(s1.id);
    expect(activeOverrideAt([s1, c1], at(5))).toBeNull();
    expect(activeOverrideAt([s1, c1], at(-1))).toBeNull();
  });
});

describe("resolveEffective (stricter wins, tie to the store)", () => {
  const tenantLimit = { policySource: "tenant", policyRevisionId: "t1", policyValue: limit("20") } as const;
  it("is the tenant level without an override", () => {
    expect(resolveEffective(tenantLimit, null)).toEqual(tenantLimit);
  });
  it("is the store override when it is stricter", () => {
    const o = rev({ scope: "store", createdAt: at(0), value: limit("5") });
    expect(resolveEffective(tenantLimit, o)).toEqual({ policySource: "store", policyRevisionId: o.id, policyValue: limit("5") });
  });
  it("goes to the store on a tie", () => {
    const o = rev({ scope: "store", createdAt: at(0), value: limit("20.00") });
    expect(resolveEffective(tenantLimit, o).policySource).toBe("store");
  });
  it("keeps a tenant default tightened below an older override", () => {
    const o = rev({ scope: "store", createdAt: at(0), value: limit("30") });
    expect(resolveEffective(tenantLimit, o)).toEqual(tenantLimit);
  });
});

describe("revisionState", () => {
  it("is current for the scope's latest, superseded otherwise, expired for a passed store expiry", () => {
    const s1 = rev({ scope: "store", createdAt: at(0), effectiveUntil: at(60) });
    expect(revisionState(s1, { latestId: s1.id, now: at(30) })).toBe("current");
    expect(revisionState(s1, { latestId: s1.id, now: at(60) })).toBe("expired");
    expect(revisionState(s1, { latestId: "other", now: at(30) })).toBe("superseded");
  });
});
