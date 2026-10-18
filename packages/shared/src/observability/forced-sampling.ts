/**
 * Force-sampled liveness spans (RT-684, OBS-9 finding F-B).
 *
 * Once the worker's idle poll is untraced, an idle worker sends no spans, so
 * "no traces" no longer means "worker down". The worker therefore records a
 * small root liveness span every few minutes, and the Datadog no-data monitor
 * watches that. It has to arrive every time, so it bypasses ratio sampling:
 *
 *   - `createForceSampleSampler` wraps the sampler the env asks for
 *     (`OTEL_TRACES_SAMPLER` / `_ARG`: the SDK's names, defaults and ratio
 *     rules; see `samplerFromEnv`) and
 *     samples any span carrying `FORCE_SAMPLE_ATTRIBUTE: true`. Every other
 *     span gets the env sampler's decision, unchanged.
 *   - `recordLivenessSpan` starts and ends such a span as a new root. The
 *     `operation.name` attribute makes Datadog name it after the operation, so
 *     its trace metric is `trace.<operation>.hits`.
 *
 * Only liveness spans may carry the attribute: each one is always exported.
 */
import { trace, type Attributes, type Context, type Link, type SpanKind } from "@opentelemetry/api";
import { tracing } from "@opentelemetry/sdk-node";

export const FORCE_SAMPLE_ATTRIBUTE = "rt.force_sample";

const LIVENESS_TRACER = "@data-pulse-2/shared/liveness";

/** `OTEL_TRACES_SAMPLER_ARG` as the SDK reads it: a ratio in [0, 1], else 1. */
function ratioSampler(arg: string | undefined): tracing.Sampler {
  const ratio = Number(arg?.trim() || Number.NaN);
  return new tracing.TraceIdRatioBasedSampler(ratio >= 0 && ratio <= 1 ? ratio : 1);
}

type SamplerFactory = (ratio: () => tracing.Sampler) => tracing.Sampler;

const parentBased = (root: tracing.Sampler): tracing.Sampler => new tracing.ParentBasedSampler({ root });

// The SDK's `OTEL_TRACES_SAMPLER` values. Anything else falls back to the
// SDK default, parentbased_always_on.
const SAMPLER_FACTORIES = new Map<string, SamplerFactory>([
  ["always_on", () => new tracing.AlwaysOnSampler()],
  ["always_off", () => new tracing.AlwaysOffSampler()],
  ["traceidratio", (ratio) => ratio()],
  ["parentbased_always_on", () => parentBased(new tracing.AlwaysOnSampler())],
  ["parentbased_always_off", () => parentBased(new tracing.AlwaysOffSampler())],
  ["parentbased_traceidratio", (ratio) => parentBased(ratio())],
]);

/**
 * The sampler `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` select: the
 * SDK's names, its parentbased_always_on fallback and its ratio rules. Unlike
 * the SDK it trims and lowercases the name (the OTel spec's case-insensitive
 * reading) and does not log a diag error for an unknown name or bad ratio.
 */
export function samplerFromEnv(env: NodeJS.ProcessEnv = process.env): tracing.Sampler {
  const name = env["OTEL_TRACES_SAMPLER"]?.trim().toLowerCase() ?? "";
  const factory = SAMPLER_FACTORIES.get(name) ?? SAMPLER_FACTORIES.get("parentbased_always_on")!;
  return factory(() => ratioSampler(env["OTEL_TRACES_SAMPLER_ARG"]));
}

type ShouldSampleArgs = [Context, string, string, SpanKind, Attributes, Link[]];

class ForceSampleSampler implements tracing.Sampler {
  constructor(private readonly delegate: tracing.Sampler) {}

  // The OTel `Sampler` signature: (context, traceId, spanName, spanKind,
  // attributes, links). Only `attributes` is read here.
  shouldSample(...args: ShouldSampleArgs): tracing.SamplingResult {
    if (args[4][FORCE_SAMPLE_ATTRIBUTE] === true) {
      return { decision: tracing.SamplingDecision.RECORD_AND_SAMPLED };
    }
    return this.delegate.shouldSample(...args);
  }

  toString(): string {
    return `ForceSampleSampler{${this.delegate.toString()}}`;
  }
}

export function createForceSampleSampler(env: NodeJS.ProcessEnv = process.env): tracing.Sampler {
  return new ForceSampleSampler(samplerFromEnv(env));
}

/** Record one force-sampled root span named `operation` (no children). */
export function recordLivenessSpan(operation: string): void {
  trace
    .getTracer(LIVENESS_TRACER)
    .startSpan(operation, {
      root: true,
      attributes: { [FORCE_SAMPLE_ATTRIBUTE]: true, "operation.name": operation },
    })
    .end();
}
