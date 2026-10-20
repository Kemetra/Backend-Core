/**
 * RT-664 — the gateway's quota reservation and its settlement (AD-AI-ENT-001
 * D-3, D-8; RT-644 §4.6 / T10 / T13).
 *
 *   - The reservation is taken after authorize, the kill switch, the
 *     entitlement check and the budget pre-check, and before any evidence is
 *     read or request built. A refused, failed or closed reservation ends the
 *     run with ZERO provider calls.
 *   - Every run that reserved settles exactly once: `ok` commits (charged);
 *     every fallback after the reservation releases it with its ledger
 *     outcome (never charged), including fallbacks before the provider call
 *     (`not_attempted`).
 *   - A settle failure never changes the result (the TTL sweeper is the
 *     backstop), and every allowlisted route times out before the TTL.
 */
import { FakeModelProvider } from "../../src/ai/adapters/fake/fake-model-provider";
import type { AiFeatureDefinition } from "../../src/ai/gateway/ai-feature";
import type { ModelResult } from "../../src/ai/ports/model-provider.port";
import { FAKE_ROUTE, FEATURE_ID, ROUTE_KEY, STORE_A, TENANT_ID, TEST_FEATURE, USER_ID, buildHarness, scope, type HarnessOptions } from "./_support/gateway-harness";

const RESERVATION = "0191a000-0000-7000-8000-0000000000c1";

const result = (r: ModelResult): HarnessOptions => ({ behavior: { kind: "result", result: r } });

describe("AiGateway — the quota reservation (layer 7)", () => {
  it("reserves one request unit under the run's key and context, then commits an ok run once with its metadata", async () => {
    const h = buildHarness();
    const out = await h.gateway.run(FEATURE_ID, scope({ idempotencyKey: "rt664-run-key-000001", correlationId: "corr-9" }));
    expect(out.kind).toBe("ok");
    expect(h.reserves).toHaveLength(1);
    expect(h.reserves[0]).toMatchObject({
      tenantId: TENANT_ID,
      userId: USER_ID,
      featureId: FEATURE_ID,
      storeIds: [STORE_A],
      idempotencyKey: "rt664-run-key-000001",
      units: 1,
      correlationId: "corr-9",
    });
    expect(h.reserves[0]!.ctx.userId).toBe(USER_ID);
    expect(h.settlements).toEqual([
      {
        tenantId: TENANT_ID,
        reservationId: RESERVATION,
        outcome: "ok",
        telemetry: expect.objectContaining({
          requestId: "corr-9",
          routeKey: ROUTE_KEY,
          providerKey: "fake",
          modelId: FAKE_ROUTE.modelId,
          promptTemplateId: TEST_FEATURE.promptTemplateId,
          promptTemplateVersion: TEST_FEATURE.promptTemplateVersion,
          outputSchemaId: TEST_FEATURE.outputSchemaId,
          evidenceRefIds: ["sale:1", "sale:2"],
          outputTokens: 8,
          tokenCountSource: "reported",
        }),
      },
    ]);
  });

  it.each([
    ["quota_exhausted", { allowed: false, reason: "quota_exhausted" } as const],
    ["not_entitled (state changed since the check)", { allowed: false, reason: "not_entitled" } as const],
  ])("a refused reservation (%s) ends the run with zero provider calls and no evidence read", async (_n, reservation) => {
    const h = buildHarness({ reservation });
    const out = await h.gateway.run(FEATURE_ID, scope());
    expect(out).toMatchObject({ kind: "fallback", reason: reservation.reason, providerRequested: false });
    expect(h.provider.calls).toHaveLength(0);
    expect(h.calls.evidence).toBe(0);
    expect(h.settlements).toEqual([]);
  });

  it("a run without an Idempotency-Key cannot reserve and fails closed", async () => {
    const h = buildHarness();
    const { idempotencyKey: _dropped, ...withoutKey } = scope();
    const out = await h.gateway.run(FEATURE_ID, withoutKey);
    expect(out).toMatchObject({ kind: "fallback", reason: "entitlement_unavailable" });
    expect(h.calls.reserve).toBe(0);
    expect(h.provider.calls).toHaveLength(0);
  });

  it("a throwing reservation fails closed (entitlement_unavailable)", async () => {
    const h = buildHarness({ reservation: () => Promise.reject(new Error("ledger unreachable")) });
    expect(await h.gateway.run(FEATURE_ID, scope())).toMatchObject({ kind: "fallback", reason: "entitlement_unavailable" });
    expect(h.provider.calls).toHaveLength(0);
  });

  it("T13: a replay of the key (a reservation another call took) never reaches the provider", async () => {
    const h = buildHarness({ reservation: { allowed: true, reservationId: RESERVATION, entitlementVersion: 1, runnable: false } });
    expect(await h.gateway.run(FEATURE_ID, scope())).toMatchObject({ kind: "fallback", reason: "entitlement_unavailable" });
    expect(h.provider.calls).toHaveLength(0);
    expect(h.settlements).toEqual([]);
  });
});

describe("AiGateway — every fallback after the reservation releases it (D-8, T10)", () => {
  const cases: ReadonlyArray<readonly [string, string, string, HarnessOptions]> = [
    ["an empty evidence pack", "evidence_unavailable", "not_attempted", { pack: { items: [] } }],
    ["a throwing evidence builder", "evidence_unavailable", "not_attempted", { pack: () => Promise.reject(new Error("x")) }],
    ["no allowlisted route", "route_not_allowlisted", "not_attempted", { routes: [] }],
    ["an oversized context", "context_too_large", "not_attempted", { routes: [{ ...FAKE_ROUTE, maxInputTokens: 1 }] }],
    ["a provider timeout", "provider_timeout", "provider_unavailable", { behavior: { kind: "hang" } }],
    ["a provider outage", "provider_unavailable", "provider_unavailable", result({ kind: "unavailable", cause: "provider_5xx" })],
    ["a provider fault (throw)", "provider_error", "provider_unavailable", { behavior: { kind: "throw", error: new Error("bug") } }],
    ["a refusal", "provider_refused", "provider_refused", result({ kind: "refused", reason: "safety_filter" })],
    ["a truncation", "provider_truncated", "output_truncated", result({ kind: "truncated", usage: { reported: true } })],
    ["a rejected input", "provider_rejected_input", "input_rejected", result({ kind: "rejected_input", cause: "context_too_large" })],
    ["an output failing the schema", "output_schema_invalid", "output_invalid", result({ kind: "ok", rawOutput: { nope: 1 }, usage: { reported: true } })],
    [
      "an output citing unknown evidence",
      "output_unknown_evidence_ref",
      "output_invalid",
      result({ kind: "ok", rawOutput: { summary: "s", evidenceRefs: ["sale:999"] }, usage: { reported: true } }),
    ],
  ];

  it.each(cases)("%s → %s, released as %s, never committed", async (_name, reason, outcome, options) => {
    const h = buildHarness(options);
    const out = await h.gateway.run(FEATURE_ID, scope());
    expect(out).toMatchObject({ kind: "fallback", reason });
    expect(h.settlements).toHaveLength(1);
    expect(h.settlements[0]).toMatchObject({ tenantId: TENANT_ID, reservationId: RESERVATION, outcome });
  });

  it("an unexpected throw after the reservation is internal_error and still releases (not_attempted)", async () => {
    const broken: AiFeatureDefinition = {
      ...(TEST_FEATURE as AiFeatureDefinition),
      renderSystemPrompt: () => {
        throw new Error("template bug");
      },
    };
    const h = buildHarness({ features: [broken] });
    expect(await h.gateway.run(FEATURE_ID, scope())).toMatchObject({ kind: "fallback", reason: "internal_error" });
    expect(h.settlements.map((s) => s.outcome)).toEqual(["not_attempted"]);
  });

  it("a failing settle never changes the result; it is logged by class only (the sweeper is the backstop)", async () => {
    const h = buildHarness({ settleFails: true });
    expect((await h.gateway.run(FEATURE_ID, scope())).kind).toBe("ok");
    const warn = h.logs.find((l) => l.obj["event"] === "ai.gateway.settle_failed");
    expect(warn?.obj).toMatchObject({ err_class: "Error", feature: FEATURE_ID });
    expect(JSON.stringify(warn)).not.toContain("ledger unreachable");
  });
});

describe("AiGateway — the reservation TTL outlives every route", () => {
  it("refuses at construction a route whose timeout is not shorter than the reservation TTL", () => {
    expect(() => buildHarness({ reservationTtlMs: FAKE_ROUTE.timeoutMs })).toThrow(/reservation TTL/);
    expect(() => buildHarness({ reservationTtlMs: FAKE_ROUTE.timeoutMs + 1 })).not.toThrow();
  });

  it("the fake provider is never reached by a denied run (sanity: the double counts calls)", () => {
    expect(new FakeModelProvider({ providerKey: "fake" }).calls).toHaveLength(0);
  });
});
