/**
 * RT-655 — run the ModelProviderPort conformance suite against the fake and
 * recorded adapters (RT-643 §9.1). No network; no vendor adapter exists yet.
 */
import { FakeModelProvider } from "../../src/ai/adapters/fake/fake-model-provider";
import { RecordedModelProvider } from "../../src/ai/adapters/recorded/recorded-model-provider";
import type { ModelResult } from "../../src/ai/ports/model-provider.port";
import {
  conformanceRequest,
  runModelProviderConformance,
  type ConformanceScenario,
} from "../_helpers/model-provider-conformance";

const OK_OUTPUT = { summary: "recorded summary", evidenceRefs: ["sale:1"] };

function resultFor(scenario: ConformanceScenario): ModelResult {
  switch (scenario) {
    case "ok":
      return {
        kind: "ok",
        rawOutput: OK_OUTPUT,
        usage: { inputTokens: 10, outputTokens: 5, reported: true },
      };
    case "ok_without_usage":
      return { kind: "ok", rawOutput: OK_OUTPUT, usage: { reported: false } };
    case "refused":
      return { kind: "refused", reason: "provider_refusal", usage: { reported: false } };
    case "truncated":
      return { kind: "truncated", usage: { inputTokens: 10, outputTokens: 500, reported: true } };
    case "rate_limited":
    case "provider_5xx":
    case "network":
    case "auth":
      return { kind: "unavailable", cause: scenario };
  }
}

runModelProviderConformance("FakeModelProvider", (scenario) => {
  const fake = new FakeModelProvider({
    providerKey: "conformance",
    behavior: { kind: "result", result: resultFor(scenario) },
  });
  return { adapter: fake, providerConsultations: () => fake.behaviorConsultations };
});

runModelProviderConformance("RecordedModelProvider", (scenario) => {
  const request = conformanceRequest();
  const recorded = new RecordedModelProvider({
    providerKey: "conformance",
    fixtures: {
      [`${request.promptTemplateId}@${request.promptTemplateVersion}`]: resultFor(scenario),
    },
  });
  return { adapter: recorded, providerConsultations: () => recorded.fixtureConsultations };
});

describe("FakeModelProvider — determinism and scripting", () => {
  it("default behavior is deterministic: cites every evidence ref, sorted", async () => {
    const fake = new FakeModelProvider({ providerKey: "fake" });
    const request = conformanceRequest({
      evidencePack: {
        items: [
          { ref: "sale:2", fields: {} },
          { ref: "sale:1", fields: {} },
        ],
      },
    });
    const first = await fake.generate(request, new AbortController().signal);
    const second = await fake.generate(request, new AbortController().signal);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: "ok",
      rawOutput: { evidenceRefs: ["sale:1", "sale:2"] },
    });
  });

  it("records every request it receives", async () => {
    const fake = new FakeModelProvider({ providerKey: "fake" });
    await fake.generate(conformanceRequest(), new AbortController().signal);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.promptTemplateId).toBe("conformance.explain");
  });

  it("a 'hang' behavior resolves unavailable/timeout once the signal aborts", async () => {
    const fake = new FakeModelProvider({ providerKey: "fake", behavior: { kind: "hang" } });
    const controller = new AbortController();
    const pending = fake.generate(conformanceRequest(), controller.signal);
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: "unavailable", cause: "timeout" });
  });

  it("a 'throw' behavior models a programmer error (the only case that throws)", async () => {
    const fake = new FakeModelProvider({
      providerKey: "fake",
      behavior: { kind: "throw", error: new Error("boom") },
    });
    await expect(fake.generate(conformanceRequest(), new AbortController().signal)).rejects.toThrow(
      "boom",
    );
  });
});

describe("RecordedModelProvider — fixtures", () => {
  it("fails loudly when no fixture is recorded for the request (programmer error)", async () => {
    const recorded = new RecordedModelProvider({ providerKey: "recorded", fixtures: {} });
    await expect(
      recorded.generate(conformanceRequest(), new AbortController().signal),
    ).rejects.toThrow(/no recorded fixture/i);
  });
});
