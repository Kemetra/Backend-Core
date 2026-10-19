/**
 * RT-655 acceptance 3 — no prompt, completion or credential text reaches logs
 * or spans.
 *
 * Span-attribute redaction (gen_ai.* prompt/completion) is tested beside the
 * exporter in packages/shared/__tests__/observability/span-redaction.spec.ts.
 *
 * Behavioural canary: the gateway is given the REAL pino logger (so both the
 * "never logged by design" and the "redacted at the boundary" layers are
 * under test), with canaries planted in the evidence pack, the completion and
 * a thrown adapter error. Every outcome path is driven, then the rendered log
 * output is searched. A non-vacuity check proves the logger did receive lines.
 */
import { Writable } from "node:stream";

import { DEFAULT_REDACT_PATHS, createLogger } from "@data-pulse-2/shared";

import type { FakeModelBehavior } from "../../src/ai/adapters/fake/fake-model-provider";
import type { ModelResult } from "../../src/ai/ports/model-provider.port";
import {
  FEATURE_ID,
  buildHarness,
  scope,
  sessionCtx,
} from "./_support/gateway-harness";

const PROMPT_CANARY = "canary-prompt-text-7f3a";
const COMPLETION_CANARY = "canary-completion-text-91bc";
const CREDENTIAL_CANARY = "canary-credential-5d2e";
const CANARIES = [PROMPT_CANARY, COMPLETION_CANARY, CREDENTIAL_CANARY];

function capture(): { destination: Writable; rendered: () => string } {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { destination, rendered: () => chunks.join("") };
}

const CANARY_PACK = {
  items: [
    { ref: "sale:1", fields: { note: PROMPT_CANARY, customerText: PROMPT_CANARY } },
    { ref: "sale:2", fields: { total: 250 } },
  ],
};

const COMPLETION_OK: ModelResult = {
  kind: "ok",
  rawOutput: { summary: COMPLETION_CANARY, evidenceRefs: ["sale:1"] },
  usage: { reported: true, inputTokens: 1, outputTokens: 1 },
};

const BEHAVIORS: readonly [string, FakeModelBehavior][] = [
  ["ok", { kind: "result", result: COMPLETION_OK }],
  [
    "schema reject",
    {
      kind: "result",
      result: { kind: "ok", rawOutput: { summary: COMPLETION_CANARY, extra: CREDENTIAL_CANARY }, usage: { reported: false } },
    },
  ],
  [
    "unknown evidence ref",
    {
      kind: "result",
      result: {
        kind: "ok",
        rawOutput: { summary: COMPLETION_CANARY, evidenceRefs: [CREDENTIAL_CANARY] },
        usage: { reported: false },
      },
    },
  ],
  ["refusal", { kind: "result", result: { kind: "refused", reason: "provider_refusal" } }],
  ["truncation", { kind: "result", result: { kind: "truncated", usage: { reported: false } } }],
  ["unavailable", { kind: "result", result: { kind: "unavailable", cause: "auth" } }],
  [
    "adapter throws with a credential in the message",
    { kind: "throw", error: new Error(`401 invalid key ${CREDENTIAL_CANARY} for ${PROMPT_CANARY}`) },
  ],
];

describe("AiGateway — log redaction canary", () => {
  it.each(BEHAVIORS)("never logs prompt, completion or credential text (%s)", async (_name, behavior) => {
    const cap = capture();
    const logger = createLogger({ service: "ai-gateway-test", destination: cap.destination });
    const h = buildHarness({ behavior, pack: CANARY_PACK, logger });
    await h.gateway.run(FEATURE_ID, scope());
    const out = cap.rendered();
    expect(out.length).toBeGreaterThan(0);
    for (const canary of CANARIES) expect(out).not.toContain(canary);
  });

  it("never logs canaries on the deny and evidence paths either", async () => {
    const cap = capture();
    const logger = createLogger({ service: "ai-gateway-test", destination: cap.destination });
    const denied = buildHarness({ enabled: false, pack: CANARY_PACK, logger });
    await denied.gateway.run(FEATURE_ID, scope());
    const failedRead = buildHarness({
      pack: async () => {
        throw new Error(`read failed ${PROMPT_CANARY}`);
      },
      logger,
    });
    await failedRead.gateway.run(FEATURE_ID, scope());
    const out = cap.rendered();
    expect(out.length).toBeGreaterThan(0);
    for (const canary of CANARIES) expect(out).not.toContain(canary);
  });

  it("logs the error class only, never the error message", async () => {
    const h = buildHarness({
      behavior: { kind: "throw", error: new TypeError(`boom ${CREDENTIAL_CANARY}`) },
    });
    await h.gateway.run(FEATURE_ID, scope());
    const faultLine = h.logs.find((l) => l.obj["reason"] === "provider_error");
    expect(faultLine).toBeDefined();
    expect(faultLine?.obj["err_class"]).toBe("TypeError");
    expect(JSON.stringify(h.logs)).not.toContain(CREDENTIAL_CANARY);
  });

  it("logs only business-class fields: correlation, feature, route, outcome, flags", async () => {
    const h = buildHarness();
    await h.gateway.run(FEATURE_ID, scope({ correlationId: "corr-business" }));
    expect(h.logs).toHaveLength(1);
    expect(Object.keys(h.logs[0]?.obj ?? {}).sort()).toEqual(
      ["correlation_id", "event", "feature", "outcome", "provider_requested", "route"].sort(),
    );
  });

  it("does not log the caller's tenant, user or store ids", async () => {
    const h = buildHarness({ enabled: false });
    const ctx = sessionCtx();
    await h.gateway.run(FEATURE_ID, scope({ ctx }));
    const rendered = JSON.stringify(h.logs);
    expect(rendered).not.toContain(ctx.userId ?? "missing");
    expect(rendered).not.toContain(ctx.tenantId ?? "missing");
  });
});

describe("pino boundary — prompt / completion / credential fields are redacted wholesale", () => {
  it.each([
    "prompt",
    "completion",
    "system",
    "evidencePack",
    "evidence_pack",
    "rawOutput",
    "raw_output",
    "*.prompt",
    "*.completion",
    "*.system",
    "*.evidencePack",
    "*.evidence_pack",
    "*.rawOutput",
    "*.raw_output",
    "provider_api_key",
    "providerApiKey",
  ])("DEFAULT_REDACT_PATHS contains %s", (path) => {
    expect(DEFAULT_REDACT_PATHS).toContain(path);
  });

  it("redacts a prompt/completion/pack even when a call site logs them by mistake", () => {
    const cap = capture();
    const logger = createLogger({ service: "ai-gateway-test", destination: cap.destination });
    logger.info({
      prompt: PROMPT_CANARY,
      completion: COMPLETION_CANARY,
      system: PROMPT_CANARY,
      evidencePack: { items: [{ ref: "sale:1", fields: { note: PROMPT_CANARY } }] },
      rawOutput: { summary: COMPLETION_CANARY },
      request: { prompt: PROMPT_CANARY, evidencePack: CANARY_PACK },
      providerApiKey: CREDENTIAL_CANARY,
    }, "mistaken log");
    const out = cap.rendered();
    for (const canary of CANARIES) expect(out).not.toContain(canary);
    expect(out).toContain("[REDACTED]");
  });
});

describe("harness sanity", () => {
  it("the canary pack really reaches the provider (the test is not vacuous)", async () => {
    const h = buildHarness({ pack: CANARY_PACK });
    await h.gateway.run(FEATURE_ID, scope());
    expect(JSON.stringify(h.provider.calls[0]?.evidencePack)).toContain(PROMPT_CANARY);
  });
});
