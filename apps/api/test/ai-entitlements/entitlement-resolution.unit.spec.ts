/**
 * RT-664 — layer 6 (entitlement, incl. the D-5 owner opt-out) as a pure
 * function: RT-644 §4.3 lifecycle states, the revision's overrides and the
 * effective meter limits. No database.
 */
import {
  resolveFeature,
  type CatalogMeter,
  type EntitlementRevision,
} from "../../src/ai-entitlements/entitlement-resolution";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const FEATURE = "ai.briefing.daily";
const OTHER = "ai.ask";

const METER: CatalogMeter = { meter: "briefings", unit: "request", window: "day", scope: "tenant", limit: 10 };

function revision(overrides: Partial<EntitlementRevision> = {}): EntitlementRevision {
  return {
    version: 3,
    state: "active",
    planCode: "ai_assist",
    catalogVersion: 1,
    effectiveFrom: new Date("2026-10-01T00:00:00.000Z"),
    effectiveUntil: null,
    overrides: [],
    ...overrides,
  };
}

const plan = new Map<string, readonly CatalogMeter[]>([[FEATURE, [METER]]]);
const notOptedOut = { optedOut: false, changedAt: null };

function resolve(input: { revision?: EntitlementRevision | null; featureId?: string; optedOut?: boolean; now?: Date }) {
  return resolveFeature({
    revision: input.revision === undefined ? revision() : input.revision,
    planFeatures: plan,
    featureId: input.featureId ?? FEATURE,
    optOut: input.optedOut === true ? { optedOut: true, changedAt: NOW } : notOptedOut,
    now: input.now ?? NOW,
  });
}

describe("resolveFeature (layer 6)", () => {
  it("allows an active plan feature with its catalogue meter", () => {
    expect(resolve({})).toEqual({ entitled: true, verdict: { allow: true }, meters: [METER] });
  });

  it("denies not_entitled when the tenant has no revision (state none, default deny)", () => {
    expect(resolve({ revision: null })).toEqual({ entitled: false, verdict: { allow: false, reason: "not_entitled" }, meters: [] });
  });

  it("denies not_entitled for state none, a feature outside the plan, expired and cancelled", () => {
    for (const r of [
      resolve({ revision: revision({ state: "none", planCode: null, catalogVersion: null }) }),
      resolve({ featureId: OTHER }),
      resolve({ revision: revision({ state: "expired" }) }),
      resolve({ revision: revision({ state: "cancelled" }) }),
    ]) {
      expect(r.verdict).toEqual({ allow: false, reason: "not_entitled" });
    }
  });

  it("reports an expired or cancelled plan feature as not entitled (no meters)", () => {
    expect(resolve({ revision: revision({ state: "expired" }) })).toMatchObject({ entitled: false, meters: [] });
  });

  it("denies trial_expired once a trial is past effectiveUntil, and allows it before", () => {
    const trial = (until: string) => revision({ state: "trial", effectiveUntil: new Date(until) });
    expect(resolve({ revision: trial("2026-10-19T12:00:00.000Z") }).verdict).toEqual({ allow: false, reason: "trial_expired" });
    expect(resolve({ revision: trial("2026-10-20T00:00:00.000Z") }).verdict).toEqual({ allow: true });
  });

  it("denies an active revision past its effectiveUntil as not_entitled", () => {
    const r = resolve({ revision: revision({ effectiveUntil: new Date("2026-10-19T11:59:59.000Z") }) });
    expect(r.verdict).toEqual({ allow: false, reason: "not_entitled" });
  });

  it("denies grace_read_only in grace (D-7) while the feature stays entitled", () => {
    expect(resolve({ revision: revision({ state: "grace" }) })).toMatchObject({
      entitled: true,
      verdict: { allow: false, reason: "grace_read_only" },
    });
  });

  it("denies feature_disabled_tenant for an entitled feature the owner opted out (D-5)", () => {
    expect(resolve({ optedOut: true })).toMatchObject({ entitled: true, verdict: { allow: false, reason: "feature_disabled_tenant" } });
  });

  it("an opt-out of a feature outside the plan stays not_entitled (an opt-out only subtracts)", () => {
    expect(resolve({ featureId: OTHER, optedOut: true })).toMatchObject({ entitled: false, verdict: { reason: "not_entitled" } });
  });

  it("a disable override turns a plan feature off until it expires", () => {
    const disable = (expiresAt?: string) =>
      revision({ overrides: [{ featureId: FEATURE, action: "disable", reason: "support", ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}) }] });
    expect(resolve({ revision: disable() })).toMatchObject({ entitled: false, verdict: { reason: "not_entitled" } });
    expect(resolve({ revision: disable("2026-10-19T11:00:00.000Z") }).verdict).toEqual({ allow: true });
  });

  it("an enable override adjusts a plan meter's limit, never below zero, and only while it lasts", () => {
    const delta = (meterLimitDelta: number, expiresAt?: string) =>
      revision({
        overrides: [
          { featureId: FEATURE, action: "enable", meter: "briefings", meterLimitDelta, reason: "support", ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}) },
        ],
      });
    expect(resolve({ revision: delta(5) }).meters).toEqual([{ ...METER, limit: 15 }]);
    expect(resolve({ revision: delta(-50) }).meters).toEqual([{ ...METER, limit: 0 }]);
    expect(resolve({ revision: delta(5, "2026-10-19T00:00:00.000Z") }).meters).toEqual([METER]);
  });

  it("an enable override never adds a feature the plan lacks (the catalogue is code-owned)", () => {
    const r = resolve({ featureId: OTHER, revision: revision({ overrides: [{ featureId: OTHER, action: "enable", reason: "x" }] }) });
    expect(r).toMatchObject({ entitled: false, verdict: { reason: "not_entitled" } });
  });
});
