/**
 * Force-sampled liveness spans (RT-684, OBS-9 finding F-B).
 *
 * Once the worker's idle poll is untraced, an idle worker sends no spans, so
 * "no traces" no longer means "worker down". The worker therefore records a
 * small root liveness span every few minutes, and the Datadog no-data monitor
 * watches that. It has to arrive every time, so it bypasses ratio sampling:
 *
 *   - `createForceSampleSampler` wraps the sampler the env asks for
 *     (`OTEL_TRACES_SAMPLER` / `_ARG`, same names and defaults as the SDK) and
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

/** The sampler `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` select, as the SDK reads them. */
export function samplerFromEnv(env: NodeJS.ProcessEnv = process.env): tracing.Sampler {
  const ratio = (): tracing.Sampler => {
    const arg = Number(env["OTEL_TRACES_SAMPLER_ARG"]?.trim() || Number.NaN);
    return new tracing.TraceIdRatioBasedSampler(arg >= 0 && arg <= 1 ? arg : 1);
  };
  switch (env["OTEL_TRACES_SAMPLER"]?.trim().toLowerCase()) {
    case "always_on":
      return new tracing.AlwaysOnSampler();
    case "always_off":
      return new tracing.AlwaysOffSampler();
    case "traceidratio":
      return ratio();
    case "parentbased_always_off":
      return new tracing.ParentBasedSampler({ root: new tracing.AlwaysOffSampler() });
    case "parentbased_traceidratio":
      return new tracing.ParentBasedSampler({ root: ratio() });
    default:
      return new tracing.ParentBasedSampler({ root: new tracing.AlwaysOnSampler() });
  }
}

class ForceSampleSampler implements tracing.Sampler {
  constructor(private readonly delegate: tracing.Sampler) {}

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): tracing.SamplingResult {
    if (attributes[FORCE_SAMPLE_ATTRIBUTE] === true) {
      return { decision: tracing.SamplingDecision.RECORD_AND_SAMPLED };
    }
    return this.delegate.shouldSample(context, traceId, spanName, spanKind, attributes, links);
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
