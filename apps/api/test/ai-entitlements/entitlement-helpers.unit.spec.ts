/**
 * RT-664 — pure helpers of the AI entitlements runtime: the reservation TTL
 * configuration, the canonical revision content hash and the ledger bounds of
 * the run metadata. No database.
 */
import {
  AI_RESERVATION_TTL_ENV,
  DEFAULT_AI_RESERVATION_TTL_SECONDS,
  resolveAiReservationTtlSeconds,
} from "../../src/ai-entitlements/ai-entitlements.tokens";
import { AiEntitlementChecker } from "../../src/ai-entitlements/entitlement-checker";
import { ledgerTelemetry } from "../../src/ai-entitlements/gateway-entitlement.port";
import { canonicalJson, revisionContentHash, toOverrideJson } from "../../src/ai-entitlements/revision-content";
import { unavailableLogger } from "../../src/ai-entitlements/unavailable-log";
import { usageOutcome, usageTelemetry } from "../../src/ai/gateway/ai-gateway.settlement";

describe("reservation TTL configuration", () => {
  it("defaults to 15 minutes and accepts a whole number of seconds >= 60", () => {
    expect(resolveAiReservationTtlSeconds({})).toBe(DEFAULT_AI_RESERVATION_TTL_SECONDS);
    expect(resolveAiReservationTtlSeconds({ [AI_RESERVATION_TTL_ENV]: " 120 " })).toBe(120);
  });

  it.each(["59", "abc", "1.5", "-5"])("refuses %j rather than defaulting", (raw) => {
    expect(() => resolveAiReservationTtlSeconds({ [AI_RESERVATION_TTL_ENV]: raw })).toThrow(AI_RESERVATION_TTL_ENV);
  });

  it("the checker refuses a non-positive TTL", () => {
    expect(() => new AiEntitlementChecker({} as never, { reservationTtlSeconds: 0 })).toThrow(/reservationTtlSeconds/);
  });
});

describe("canonical revision content", () => {
  it("sorts keys at every level and keeps array order", () => {
    expect(canonicalJson({ b: [{ z: 1, a: null }], a: "x", c: true })).toBe('{"a":"x","b":[{"a":null,"z":1}],"c":true}');
  });

  it("normalises an override's instants and omits its absent optionals", () => {
    expect(toOverrideJson({ featureId: "ai.ask", action: "disable", reason: "r", expiresAt: "2026-10-20T00:00:00Z" })).toEqual({
      feature_id: "ai.ask",
      action: "disable",
      reason: "r",
      expires_at: "2026-10-20T00:00:00.000Z",
    });
  });

  it("hashes to 32 bytes, and any content change changes the hash", () => {
    const base = { state: "active", planCode: "p", catalogVersion: 1, effectiveFrom: "2026-10-01T00:00:00.000Z", effectiveUntil: null, overrides: [], reason: "r" };
    const h = revisionContentHash(base);
    expect(h).toHaveLength(32);
    expect(revisionContentHash({ ...base, reason: "s" }).equals(h)).toBe(false);
    expect(revisionContentHash({ ...base }).equals(h)).toBe(true);
  });
});

describe("the fail-closed log line", () => {
  it("carries the error class and SQLSTATE only, never the message", () => {
    const lines: Array<Record<string, unknown>> = [];
    const log = unavailableLogger({ warn: (obj: Record<string, unknown>) => void lines.push(obj) } as never, "check");
    log(Object.assign(new Error("permission denied for table ai_usage_ledger"), { code: "42501" }));
    log("weird");
    log(Object.assign(new TypeError("x"), { code: "not a sqlstate" }));
    expect(lines).toEqual([
      { event: "ai.entitlements.unavailable", surface: "check", err_class: "Error", err_code: "42501" },
      { event: "ai.entitlements.unavailable", surface: "check", err_class: "non_error_throw" },
      { event: "ai.entitlements.unavailable", surface: "check", err_class: "TypeError" },
    ]);
    expect(() => unavailableLogger(undefined, "console")(new Error("x"))).not.toThrow();
  });
});

describe("ledger run metadata", () => {
  it("drops a value outside the ledger's column bounds instead of failing the settle", () => {
    const t = ledgerTelemetry({
      requestId: "r".repeat(129),
      routeKey: "route@v1",
      modelId: "",
      evidenceRefIds: Array.from({ length: 257 }, (_, i) => `ref:${i}`),
      inputTokens: 4,
    });
    expect(t).toMatchObject({ requestId: null, routeKey: "route@v1", modelId: null, evidenceRefIds: null, inputTokens: 4, outputTokens: null });
    expect(ledgerTelemetry({ evidenceRefIds: ["x".repeat(40_000)] }).evidenceRefIds).toBeNull();
    expect(ledgerTelemetry({ evidenceRefIds: ["sale:1"] }).evidenceRefIds).toEqual(["sale:1"]);
    expect(ledgerTelemetry({ inputTokens: -1, outputTokens: 2.5, cachedInputTokens: 0 })).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: 0,
    });
  });

  it("maps every run end to its ledger outcome", () => {
    expect(usageOutcome({ kind: "fallback", reason: "internal_error", providerRequested: true })).toBe("provider_unavailable");
    expect(usageOutcome({ kind: "fallback", reason: "internal_error", providerRequested: false })).toBe("not_attempted");
  });

  it("records token counts only when the provider reported or estimated some", () => {
    expect(usageTelemetry(undefined)).toEqual({});
    expect(usageTelemetry({ reported: true })).toEqual({});
    expect(usageTelemetry({ cachedInputTokens: 2, reported: false })).toEqual({ cachedInputTokens: 2, tokenCountSource: "estimated" });
  });
});
