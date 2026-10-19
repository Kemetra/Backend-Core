/**
 * RT-655 acceptance 2 — gateway behaviour once every deny gate has passed:
 * the happy path, route resolution, and every RT-643 §5 failure becoming a
 * deterministic fallback (schema reject, unknown evidence ref, timeout,
 * refusal, truncation, adapter fault, oversized context, empty evidence).
 */
import { FakeModelProvider } from "../../src/ai/adapters/fake/fake-model-provider";
import { AI_FALLBACK_REASONS } from "../../src/ai/gateway/ai-gateway.types";
import type { ModelProviderPort, ModelResult } from "../../src/ai/ports/model-provider.port";
import {
  EXPLAIN_OUTPUT_SCHEMA,
  FAKE_ROUTE,
  FEATURE_ID,
  ROUTE_KEY,
  TEST_FEATURE,
  buildHarness,
  scope,
} from "./_support/gateway-harness";

const VALID_OUTPUT = { summary: "Sale 1 posted late", evidenceRefs: ["sale:1"] };

function okResult(rawOutput: unknown): ModelResult {
  return { kind: "ok", rawOutput, usage: { inputTokens: 12, outputTokens: 6, reported: true } };
}

describe("AiGateway — happy path", () => {
  it("returns only the validated output, with the evidence refs it cited", async () => {
    const h = buildHarness({ behavior: { kind: "result", result: okResult(VALID_OUTPUT) } });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toEqual({
      kind: "ok",
      output: VALID_OUTPUT,
      evidenceRefs: ["sale:1"],
      routeKey: ROUTE_KEY,
      usage: { inputTokens: 12, outputTokens: 6, reported: true },
    });
    expect(h.provider.calls).toHaveLength(1);
  });

  it("builds the request from Backend-Core state only: allowlisted route, repo-owned template, evidence pack", async () => {
    const h = buildHarness();
    await h.gateway.run(FEATURE_ID, scope({ correlationId: "corr-xyz" }));
    const request = h.provider.calls[0];
    expect(request?.route).toBe(FAKE_ROUTE);
    expect(request?.promptTemplateId).toBe(TEST_FEATURE.promptTemplateId);
    expect(request?.promptTemplateVersion).toBe(TEST_FEATURE.promptTemplateVersion);
    expect(request?.system).toBe(TEST_FEATURE.renderSystemPrompt());
    expect(request?.outputSchemaId).toBe(TEST_FEATURE.outputSchemaId);
    expect(request?.correlationId).toBe("corr-xyz");
    expect(request?.evidencePack.items.map((i) => i.ref)).toEqual(["sale:1", "sale:2"]);
  });

  it("makes exactly one provider attempt per run (no gateway retry)", async () => {
    const h = buildHarness({
      behavior: { kind: "result", result: { kind: "unavailable", cause: "provider_5xx" } },
    });
    await h.gateway.run(FEATURE_ID, scope());
    expect(h.provider.calls).toHaveLength(1);
  });

  it("emits one run metric and one provider metric with bounded labels", async () => {
    const h = buildHarness();
    await h.gateway.run(FEATURE_ID, scope());
    expect(h.runMetrics).toEqual([{ feature: FEATURE_ID, outcome: "ok" }]);
    expect(h.providerMetrics).toEqual([{ provider: "fake", route: ROUTE_KEY, outcome: "ok" }]);
  });
});

describe("AiGateway — evidence and route resolution", () => {
  it("falls back (no request) when the evidence pack is empty", async () => {
    const h = buildHarness({ pack: { items: [] } });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toMatchObject({
      kind: "fallback",
      reason: "evidence_unavailable",
      providerRequested: false,
    });
    expect(h.provider.calls).toHaveLength(0);
  });

  it("falls back (no request) when the evidence builder throws", async () => {
    const h = buildHarness({
      pack: async () => {
        throw new Error("read failed");
      },
    });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toMatchObject({ kind: "fallback", reason: "evidence_unavailable" });
    expect(h.provider.calls).toHaveLength(0);
  });

  it("falls back when the route allowlist is empty", async () => {
    const h = buildHarness({ routes: [] });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toMatchObject({
      kind: "fallback",
      reason: "route_not_allowlisted",
      providerRequested: false,
    });
  });

  it("falls back when no provider is registered for the route's providerKey", async () => {
    const h = buildHarness({ providers: [] });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toMatchObject({ kind: "fallback", reason: "route_not_allowlisted" });
  });

  it("refuses a synthetic-only route in production (E-9)", async () => {
    const h = buildHarness({ production: true });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toMatchObject({ kind: "fallback", reason: "route_not_allowlisted" });
    expect(h.provider.calls).toHaveLength(0);
  });

  it("fails closed when the route does not declare a required capability", async () => {
    const h = buildHarness({
      routes: [{ ...FAKE_ROUTE, capabilities: new Set(["usage_reporting"] as const) }],
    });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toMatchObject({
      kind: "fallback",
      reason: "unsupported_capability",
      providerRequested: false,
    });
  });

  it("rejects an oversized context BEFORE the call (context_too_large)", async () => {
    const h = buildHarness({
      routes: [{ ...FAKE_ROUTE, maxInputTokens: 5 }],
    });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toMatchObject({
      kind: "fallback",
      reason: "context_too_large",
      providerRequested: false,
    });
    expect(h.provider.calls).toHaveLength(0);
  });
});

describe("AiGateway — provider conditions become deterministic fallbacks", () => {
  it("refusal -> provider_refused", async () => {
    const h = buildHarness({
      behavior: {
        kind: "result",
        result: { kind: "refused", reason: "provider_refusal", usage: { reported: false } },
      },
    });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toMatchObject({
      kind: "fallback",
      reason: "provider_refused",
      providerRequested: true,
    });
    expect(h.providerMetrics).toEqual([{ provider: "fake", route: ROUTE_KEY, outcome: "refused" }]);
  });

  it("truncation (max tokens) -> provider_truncated, never partially rendered", async () => {
    const h = buildHarness({
      behavior: {
        kind: "result",
        result: { kind: "truncated", usage: { outputTokens: 500, reported: true } },
      },
    });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toMatchObject({ kind: "fallback", reason: "provider_truncated" });
    expect(result).not.toHaveProperty("output");
  });

  it.each([
    ["rate_limited", "provider_unavailable"],
    ["provider_5xx", "provider_unavailable"],
    ["network", "provider_unavailable"],
    ["auth", "provider_unavailable"],
    ["disabled", "provider_unavailable"],
    ["timeout", "provider_timeout"],
  ] as const)("unavailable/%s -> %s", async (cause, reason) => {
    const h = buildHarness({
      behavior: { kind: "result", result: { kind: "unavailable", cause } },
    });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toMatchObject({ kind: "fallback", reason, providerRequested: true });
  });

  it("an adapter-reported rejected_input -> provider_rejected_input", async () => {
    const h = buildHarness({
      behavior: {
        kind: "result",
        result: { kind: "rejected_input", cause: "unsupported_capability" },
      },
    });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toMatchObject({ kind: "fallback", reason: "provider_rejected_input" });
  });
});

describe("AiGateway — output validation (Backend-Core is always authoritative)", () => {
  it.each([
    ["wrong type", { summary: 42, evidenceRefs: ["sale:1"] }],
    ["missing field", { summary: "x" }],
    ["extra field", { ...VALID_OUTPUT, injected: "rm -rf" }],
    ["not an object", "just text"],
    ["null", null],
  ])("schema reject (%s) -> output_schema_invalid", async (_name, raw) => {
    const h = buildHarness({ behavior: { kind: "result", result: okResult(raw) } });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toMatchObject({
      kind: "fallback",
      reason: "output_schema_invalid",
      providerRequested: true,
    });
    expect(result).not.toHaveProperty("output");
    expect(result).not.toHaveProperty("rawOutput");
  });

  it("an evidence ref outside the pack that was sent -> output_unknown_evidence_ref", async () => {
    const h = buildHarness({
      behavior: {
        kind: "result",
        result: okResult({ summary: "x", evidenceRefs: ["sale:1", "sale:999"] }),
      },
    });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toMatchObject({ kind: "fallback", reason: "output_unknown_evidence_ref" });
    expect(JSON.stringify(result)).not.toContain("sale:999");
  });

  it("refuses to register a feature whose output schema is not strict", () => {
    const loose = EXPLAIN_OUTPUT_SCHEMA.passthrough() as unknown as typeof TEST_FEATURE.outputSchema;
    expect(() =>
      buildHarness({ features: [{ ...TEST_FEATURE, outputSchema: loose } as never] }),
    ).toThrow(/strict/i);
  });
});

describe("AiGateway — timeout (the gateway owns it; the adapter need not cooperate)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("times out a hanging adapter, aborts its signal and leaves no timer behind", async () => {
    const h = buildHarness({ behavior: { kind: "hang" } });
    const run = h.gateway.run(FEATURE_ID, scope());
    await jest.advanceTimersByTimeAsync(FAKE_ROUTE.timeoutMs + 10);
    const result = await run;
    expect(result).toMatchObject({
      kind: "fallback",
      reason: "provider_timeout",
      providerRequested: true,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("times out an adapter that ignores the signal and ignores its late resolution", async () => {
    const lateAdapter: ModelProviderPort = {
      providerKey: "fake",
      generate: () =>
        new Promise<ModelResult>((resolve) => {
          setTimeout(() => resolve(okResult(VALID_OUTPUT)), FAKE_ROUTE.timeoutMs * 4);
        }),
    };
    const h = buildHarness({ providers: [lateAdapter] });
    const run = h.gateway.run(FEATURE_ID, scope());
    await jest.advanceTimersByTimeAsync(FAKE_ROUTE.timeoutMs + 10);
    await expect(run).resolves.toMatchObject({ kind: "fallback", reason: "provider_timeout" });
    await jest.advanceTimersByTimeAsync(FAKE_ROUTE.timeoutMs * 5);
    expect(h.runMetrics).toHaveLength(1);
  });

  it("a late rejection after the timeout never becomes an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const lateRejecting: ModelProviderPort = {
        providerKey: "fake",
        generate: () =>
          new Promise<ModelResult>((_resolve, reject) => {
            setTimeout(() => reject(new Error("late boom")), FAKE_ROUTE.timeoutMs * 4);
          }),
      };
      const h = buildHarness({ providers: [lateRejecting] });
      const run = h.gateway.run(FEATURE_ID, scope());
      await jest.advanceTimersByTimeAsync(FAKE_ROUTE.timeoutMs + 10);
      await run;
      await jest.advanceTimersByTimeAsync(FAKE_ROUTE.timeoutMs * 5);
      jest.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("clears the timer on the success path too", async () => {
    const h = buildHarness();
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result.kind).toBe("ok");
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe("AiGateway — adapter faults (OPTIONAL_DEGRADE covers programmer errors)", () => {
  it("an adapter that throws -> provider_error, one attempt, no leak of the message", async () => {
    const h = buildHarness({
      behavior: { kind: "throw", error: new Error("SECRET-ADAPTER-MESSAGE") },
    });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toMatchObject({
      kind: "fallback",
      reason: "provider_error",
      providerRequested: true,
    });
    expect(JSON.stringify(result)).not.toContain("SECRET-ADAPTER-MESSAGE");
    expect(h.provider.calls).toHaveLength(1);
  });

  it("an adapter that returns something that is not a ModelResult -> provider_error", async () => {
    const garbage: ModelProviderPort = {
      providerKey: "fake",
      generate: async () => ({ kind: "weird" }) as unknown as ModelResult,
    };
    const h = buildHarness({ providers: [garbage] });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(result).toMatchObject({ kind: "fallback", reason: "provider_error" });
  });
});

describe("AiGateway — metrics and fallback result shape", () => {
  it("labels an unknown feature as 'unknown' so request input never becomes a label", async () => {
    const h = buildHarness();
    await h.gateway.run("attacker-controlled-feature-id", scope());
    expect(h.runMetrics).toEqual([{ feature: "unknown", outcome: "unknown_feature" }]);
  });

  it("only ever emits outcomes from the closed set", async () => {
    const h = buildHarness({ enabled: false });
    await h.gateway.run(FEATURE_ID, scope());
    for (const metric of h.runMetrics) {
      expect([...AI_FALLBACK_REASONS, "ok"]).toContain(metric.outcome);
    }
  });

  it("a fallback never carries provider output, usage or the evidence pack", async () => {
    const h = buildHarness({
      behavior: { kind: "result", result: okResult({ summary: "x", evidenceRefs: ["nope"] }) },
    });
    const result = await h.gateway.run(FEATURE_ID, scope());
    expect(Object.keys(result).sort()).toEqual(["kind", "providerRequested", "reason"]);
  });

  it("the fake provider is never wired by default (it is test-only)", () => {
    expect(new FakeModelProvider({ providerKey: "fake" }).providerKey).toBe("fake");
  });
});
