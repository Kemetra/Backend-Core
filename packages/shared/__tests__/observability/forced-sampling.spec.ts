/**
 * Unit tests for forced-sampling.ts (RT-684, OBS-9 finding F-B).
 *
 * The sampler keeps the env-configured decision for ordinary spans and always
 * samples liveness spans; `recordLivenessSpan` emits one such root span.
 */
import { context, ROOT_CONTEXT, SpanKind, trace } from "@opentelemetry/api";
import { tracing } from "@opentelemetry/sdk-node";

import { createTestTracerProvider } from "../../src/observability/bullmq-propagation";
import {
  createForceSampleSampler,
  FORCE_SAMPLE_ATTRIBUTE,
  recordLivenessSpan,
  samplerFromEnv,
} from "../../src/observability/forced-sampling";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const { RECORD_AND_SAMPLED, NOT_RECORD } = tracing.SamplingDecision;

function decide(sampler: tracing.Sampler, attributes: Record<string, unknown> = {}): tracing.SamplingDecision {
  return sampler.shouldSample(ROOT_CONTEXT, TRACE_ID, "span", SpanKind.INTERNAL, attributes as never, []).decision;
}

describe("samplerFromEnv", () => {
  it.each([
    [undefined, undefined, "ParentBased{root=AlwaysOnSampler"],
    ["always_on", undefined, "AlwaysOnSampler"],
    ["always_off", undefined, "AlwaysOffSampler"],
    ["traceidratio", "0.25", "TraceIdRatioBased{0.25}"],
    ["parentbased_always_off", undefined, "ParentBased{root=AlwaysOffSampler"],
    ["parentbased_traceidratio", "0.1", "ParentBased{root=TraceIdRatioBased{0.1}"],
    ["parentbased_traceidratio", "7", "ParentBased{root=TraceIdRatioBased{1}"],
    ["parentbased_traceidratio", "", "ParentBased{root=TraceIdRatioBased{1}"],
    ["no_such_sampler", undefined, "ParentBased{root=AlwaysOnSampler"],
  ])("OTEL_TRACES_SAMPLER=%s ARG=%s selects %s", (name, arg, expected) => {
    const env: NodeJS.ProcessEnv = {};
    if (name !== undefined) env["OTEL_TRACES_SAMPLER"] = name;
    if (arg !== undefined) env["OTEL_TRACES_SAMPLER_ARG"] = arg;

    expect(samplerFromEnv(env).toString()).toContain(expected);
  });
});

describe("createForceSampleSampler", () => {
  const dropEverything = { OTEL_TRACES_SAMPLER: "parentbased_traceidratio", OTEL_TRACES_SAMPLER_ARG: "0" };

  it("keeps the env sampler's decision for ordinary spans", () => {
    expect(decide(createForceSampleSampler(dropEverything))).toBe(NOT_RECORD);
    expect(decide(createForceSampleSampler({ OTEL_TRACES_SAMPLER: "always_on" }))).toBe(RECORD_AND_SAMPLED);
  });

  it("always samples a span carrying the force-sample attribute", () => {
    expect(decide(createForceSampleSampler(dropEverything), { [FORCE_SAMPLE_ATTRIBUTE]: true })).toBe(
      RECORD_AND_SAMPLED,
    );
  });

  it("samples a marked span and drops an unmarked one in a real tracer provider", async () => {
    const provider = new tracing.BasicTracerProvider({ sampler: createForceSampleSampler(dropEverything) });
    try {
      const tracer = provider.getTracer("rt-684-test");
      const marked = tracer.startSpan("marked", { root: true, attributes: { [FORCE_SAMPLE_ATTRIBUTE]: true } });
      const unmarked = tracer.startSpan("unmarked", { root: true });

      expect(marked.isRecording()).toBe(true);
      expect(unmarked.isRecording()).toBe(false);
      marked.end();
      unmarked.end();
    } finally {
      await provider.shutdown();
    }
  });

  it("ignores a force-sample attribute that is not exactly true", () => {
    expect(decide(createForceSampleSampler(dropEverything), { [FORCE_SAMPLE_ATTRIBUTE]: "true" })).toBe(NOT_RECORD);
  });
});

describe("recordLivenessSpan", () => {
  it("exports one root span named after the operation, marked for Datadog and forced sampling", async () => {
    const handle = createTestTracerProvider();
    try {
      const parent = trace.getTracer("rt-684-test").startSpan("parent");
      context.with(trace.setSpan(context.active(), parent), () => recordLivenessSpan("worker.heartbeat"));
      parent.end();

      const spans = handle.exporter.getFinishedSpans() as unknown as tracing.ReadableSpan[];
      const heartbeat = spans.find((span) => span.name === "worker.heartbeat");
      expect(heartbeat?.attributes).toEqual({
        [FORCE_SAMPLE_ATTRIBUTE]: true,
        "operation.name": "worker.heartbeat",
      });
      // A new root even when another span is active.
      expect(heartbeat?.parentSpanContext).toBeUndefined();
      expect(heartbeat?.spanContext().traceId).not.toBe(parent.spanContext().traceId);
    } finally {
      await handle.teardown();
    }
  });
});
