/**
 * W3C TraceContext carrier helpers for BullMQ job payloads.
 *
 * BullMQ has no built-in OTel instrumentation. This module provides a
 * lightweight inject/extract pair that lets a producer stamp a job payload
 * with the active W3C trace context and lets a worker handler restore it
 * before the job is processed.
 *
 * Usage pattern
 * -------------
 * Producer side (before Queue.add):
 *
 *   const traceContext: TraceCarrier = {};
 *   injectTraceContext(traceContext);
 *   await queue.add("job-name", { ...payload, traceContext });
 *
 * Worker side (before Zod safeParse or any business logic):
 *
 *   const ctx = extractTraceContext(job.data.traceContext ?? {});
 *   context.with(ctx, () => {
 *     // spans created here will be children of the producer's span
 *   });
 *
 * Why a plain-object carrier and not BullMQ job options?
 * -------------------------------------------------------
 * BullMQ's `JobsOptions` is not a reliable propagation channel — it is
 * partially serialised, partially stripped, and not guaranteed to reach the
 * worker handler intact across versions. A plain object at a well-known key
 * (`job.data.traceContext`) is always present and always round-trips verbatim
 * through JSON serialisation.
 *
 * The carrier is read BEFORE Zod's `safeParse` on `job.data`. If someone
 * passes the entire `job.data` to `safeParse` first, Zod will strip
 * `traceContext` (unknown key). Extract first, parse second.
 */

import { context, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import type { Context } from "@opentelemetry/api";
export type { Context as OtelContext };

// Re-export OTel API singletons so consumers that cannot resolve
// `@opentelemetry/api` directly (e.g. apps/worker tests) can import
// them through the shared observability surface.
export { context, propagation, ROOT_CONTEXT };
export { trace } from "@opentelemetry/api";

/** Minimal string-keyed record that satisfies the OTel TextMapGetter/Setter interface. */
export type TraceCarrier = Record<string, string>;

/**
 * Inject the active OTel context into a plain-object carrier.
 *
 * The carrier is mutated in-place and also returned for convenience.
 * Typically the caller stores the result at `job.data.traceContext`.
 *
 * If no active span is present (e.g., in tests without a tracer), the
 * carrier will be empty and `extractTraceContext` will return `ROOT_CONTEXT`.
 */
export function injectTraceContext(carrier: TraceCarrier = {}): TraceCarrier {
  propagation.inject(context.active(), carrier);
  return carrier;
}

/**
 * Extract an OTel context from a plain-object carrier.
 *
 * Returns `ROOT_CONTEXT` when the carrier is empty or missing a valid
 * `traceparent` header — so callers never receive a rejected promise or
 * null context.
 */
export function extractTraceContext(carrier: TraceCarrier = {}): Context {
  return propagation.extract(ROOT_CONTEXT, carrier);
}

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

/**
 * An in-memory span exporter that captures finished spans for assertions.
 * Intentionally opaque — callers use `getFinishedSpans()` and `reset()`.
 */
export interface TestSpanExporter {
  getFinishedSpans(): ReadonlyArray<{ name: string; spanContext(): { traceId: string; spanId: string; isRemote?: boolean } }>;
  reset(): void;
}

/** Handle returned by `createTestTracerProvider`. */
export interface TestTracerHandle {
  exporter: TestSpanExporter;
  teardown(): Promise<void>;
}

/**
 * Bootstrap an in-memory NodeTracerProvider with the W3CTraceContextPropagator
 * registered as the global propagator.
 *
 * Intended for use in `beforeEach` blocks. Always call `handle.teardown()` in
 * `afterEach` — it shuts down the provider and calls `propagation.disable()`
 * to restore the no-op global state.
 *
 * Only available in test environments; uses dynamic `require` to pull OTel
 * test utilities from `@opentelemetry/sdk-node`'s namespace re-exports so
 * callers (e.g. `apps/worker`) don't need `@opentelemetry/sdk-node` in their
 * own `node_modules`.
 */
export function createTestTracerProvider(): TestTracerHandle {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const sdk = require("@opentelemetry/sdk-node") as any;
  const { InMemorySpanExporter, SimpleSpanProcessor } = sdk.tracing as {
    InMemorySpanExporter: new () => TestSpanExporter;
    SimpleSpanProcessor: new (e: TestSpanExporter) => unknown;
  };
  const { W3CTraceContextPropagator } = sdk.core as {
    W3CTraceContextPropagator: new () => unknown;
  };
  const { NodeTracerProvider } = sdk.node as {
    NodeTracerProvider: new (opts: { spanProcessors: unknown[] }) => {
      register(opts: { propagator: unknown }): void;
      shutdown(): Promise<void>;
    };
  };

  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  provider.register({ propagator: new W3CTraceContextPropagator() });

  return {
    exporter,
    async teardown() {
      await provider.shutdown();
      propagation.disable();
    },
  };
}
