/**
 * Span URL redaction and HTTP trace filters (RT-609 finding F1).
 *
 * The Sentry channel is allowlist-scrubbed (see `./sentry`), but OTel spans go
 * straight to the OTLP exporter (Datadog Agent on the lab). HTTP
 * instrumentation records the full request URL, so a token, email or
 * `sentry_key` in a query string, or credentials in URL userinfo, would leave
 * the process. This module closes that gap at the export boundary:
 *
 *  - `RedactingSpanExporter` wraps the real exporter and rewrites URL
 *    attributes on every span (any instrumentation, old or new semconv) to
 *    scheme + host + path. `url.query` is dropped. The live span is not mutated.
 *  - `isSentryIngestRequest` keeps Sentry's own envelope POSTs out of traces.
 *  - `createMetricsScrapeFilter` keeps Prometheus scrapes of the metrics
 *    listener out of traces.
 *
 * Same masking rule as the Sentry message scrubber (scheme + host + path,
 * unparsable -> `[url]`), so both egress channels agree. Pure; no SDK runtime
 * imports (type-only), so it is unit-testable without starting NodeSDK.
 */
import type { IncomingMessage, RequestOptions } from "node:http";

import type { Attributes } from "@opentelemetry/api";
import type { core, tracing } from "@opentelemetry/sdk-node";

/** Attributes holding a full or relative request URL (old + stable semconv). */
const URL_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(["http.url", "http.target", "url.full"]);

/** Attributes holding only the query string; removed outright. */
const QUERY_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(["url.query"]);

/** Cut a relative target (`/path?query#fragment`) at the first `?` or `#`. */
function pathOnly(target: string): string {
  const cut = [target.indexOf("?"), target.indexOf("#")].filter((at) => at !== -1);
  return cut.length === 0 ? target : target.slice(0, Math.min(...cut));
}

/**
 * Keep scheme + host + path; drop userinfo, query and fragment. A relative
 * target keeps its path only. An unparsable absolute value becomes `[url]`.
 */
export function redactUrlValue(value: string): string {
  if (value.startsWith("/")) return pathOnly(value);
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "[url]";
  }
}

/** Return a copy of `attributes` with URL values redacted and query attributes removed. */
export function redactSpanAttributes(attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (QUERY_ATTRIBUTE_KEYS.has(key)) continue;
    out[key] =
      URL_ATTRIBUTE_KEYS.has(key) && typeof value === "string"
        ? redactUrlValue(value)
        : value;
  }
  return out;
}

/**
 * A view of `span` with redacted attributes. `Object.create` keeps the SDK
 * span as the prototype, so methods such as `spanContext()` (called by the
 * OTLP transformer) and every other field still resolve; only `attributes`
 * is shadowed.
 */
function redactSpan(span: tracing.ReadableSpan): tracing.ReadableSpan {
  return Object.create(span, {
    attributes: { value: redactSpanAttributes(span.attributes), enumerable: true },
  }) as tracing.ReadableSpan;
}

/** Span exporter decorator that redacts URL attributes before delegating. */
export class RedactingSpanExporter implements tracing.SpanExporter {
  private readonly inner: tracing.SpanExporter;

  constructor(inner: tracing.SpanExporter) {
    this.inner = inner;
  }

  export(
    spans: tracing.ReadableSpan[],
    resultCallback: (result: core.ExportResult) => void,
  ): void {
    this.inner.export(spans.map(redactSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/** Lower-cased host name without port or trailing dot. */
function hostnameOf(options: RequestOptions): string {
  const raw = options.hostname ?? options.host?.split(":")[0] ?? "";
  return raw.toLowerCase().replace(/\.$/, "");
}

/**
 * `ignoreOutgoingRequestHook`: true for Sentry ingest hosts
 * (`oNNN.ingest.sentry.io`, `oNNN.ingest.<region>.sentry.io`). The envelope
 * URL carries `sentry_key`, and tracing the error reporter is noise.
 */
export function isSentryIngestRequest(options: RequestOptions): boolean {
  const labels = hostnameOf(options).split(".");
  if (labels.length < 3 || labels.slice(-2).join(".") !== "sentry.io") return false;
  return labels.slice(0, -2).includes("ingest");
}

export interface MetricsScrapeTarget {
  /** Port the Prometheus listener binds to. */
  port: number;
  /** Scrape path, e.g. `/metrics`. */
  endpoint: string;
}

/**
 * `ignoreIncomingRequestHook` factory: true only for the scrape path on the
 * metrics listener's own port, so app routes (including any `/metrics` on the
 * API port) are still traced.
 */
export function createMetricsScrapeFilter(
  target: MetricsScrapeTarget,
): (request: IncomingMessage) => boolean {
  return (request) =>
    request.socket?.localPort === target.port &&
    typeof request.url === "string" &&
    pathOnly(request.url) === target.endpoint;
}
