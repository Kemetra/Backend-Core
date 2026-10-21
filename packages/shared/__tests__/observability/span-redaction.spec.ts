/**
 * Unit tests for span-redaction.ts (RT-609 finding F1).
 *
 * Exported OTel spans must not carry query strings or URL userinfo, Sentry
 * ingest calls must not be traced, and the Prometheus `/metrics` listener must
 * not trace its own scrapes. Normal routes and hosts must still be traced.
 *
 * The exporter tests use a real BasicTracerProvider + InMemorySpanExporter
 * (no sdk-node mock) so the wrapped span still goes through the SDK's own
 * ReadableSpan shape, including the prototype `spanContext()` method that the
 * OTLP transformer calls.
 */
import type { IncomingMessage, RequestOptions } from "node:http";

import { tracing } from "@opentelemetry/sdk-node";

import {
  RedactingSpanExporter,
  createMetricsScrapeFilter,
  isSentryIngestRequest,
  redactSpanAttributes,
  redactUrlValue,
} from "../../src/observability/span-redaction";

// ---------------------------------------------------------------------------
// redactUrlValue
// ---------------------------------------------------------------------------

describe("redactUrlValue", () => {
  it("drops the query string from an absolute URL", () => {
    expect(
      redactUrlValue("https://o1.ingest.us.sentry.io/api/2/envelope/?sentry_key=abc&sentry_version=7"),
    ).toBe("https://o1.ingest.us.sentry.io/api/2/envelope/");
  });

  it("drops userinfo from an absolute URL", () => {
    expect(redactUrlValue("http://user:s3cret@connector:8000/api/method/x")).toBe(
      "http://connector:8000/api/method/x",
    );
  });

  it("drops the fragment from an absolute URL", () => {
    expect(redactUrlValue("https://host/path#token=abc")).toBe("https://host/path");
  });

  it("keeps scheme, host, port and path of a clean URL unchanged", () => {
    expect(redactUrlValue("http://localhost:3000/api/v1/sales")).toBe(
      "http://localhost:3000/api/v1/sales",
    );
  });

  it("drops the query string and fragment from a relative target", () => {
    expect(redactUrlValue("/api/v1/sales?token=abc#x")).toBe("/api/v1/sales");
    expect(redactUrlValue("/api/v1/sales#x?y")).toBe("/api/v1/sales");
  });

  it("keeps a clean relative target unchanged", () => {
    expect(redactUrlValue("/api/v1/health/live")).toBe("/api/v1/health/live");
  });

  it("masks an unparsable absolute value", () => {
    expect(redactUrlValue("not a url ?token=abc")).toBe("[url]");
  });
});

// ---------------------------------------------------------------------------
// redactSpanAttributes
// ---------------------------------------------------------------------------

describe("redactSpanAttributes", () => {
  it("redacts old-semconv http.url and http.target", () => {
    const out = redactSpanAttributes({
      "http.url": "http://u:p@api:3000/api/v1/x?email=a@b.c",
      "http.target": "/api/v1/x?email=a@b.c",
      "http.method": "GET",
    });
    expect(out).toEqual({
      "http.url": "http://api:3000/api/v1/x",
      "http.target": "/api/v1/x",
      "http.method": "GET",
    });
  });

  it("redacts new-semconv url.full and removes url.query", () => {
    const out = redactSpanAttributes({
      "url.full": "https://h/p?sentry_key=abc",
      "url.query": "sentry_key=abc",
      "url.path": "/p",
    });
    expect(out).toEqual({ "url.full": "https://h/p", "url.path": "/p" });
    expect(out).not.toHaveProperty("url.query");
  });

  it("leaves non-string URL values and unrelated attributes alone", () => {
    const out = redactSpanAttributes({ "http.url": 42, "db.system": "postgresql" });
    expect(out).toEqual({ "http.url": 42, "db.system": "postgresql" });
  });

  it("does not mutate its input", () => {
    const input = { "http.target": "/x?y=1", "url.query": "y=1" };
    redactSpanAttributes(input);
    expect(input).toEqual({ "http.target": "/x?y=1", "url.query": "y=1" });
  });
});

// ---------------------------------------------------------------------------
// isSentryIngestRequest
// ---------------------------------------------------------------------------

describe("isSentryIngestRequest", () => {
  it.each([
    "o4500000000000000.ingest.us.sentry.io",
    "o4500000000000000.ingest.de.sentry.io",
    "o4500000000000000.ingest.sentry.io",
    "O1.INGEST.US.SENTRY.IO",
    "o1.ingest.us.sentry.io.",
  ])("ignores Sentry ingest host %s", (hostname) => {
    expect(isSentryIngestRequest({ hostname })).toBe(true);
  });

  it("falls back to `host` and strips its port", () => {
    expect(isSentryIngestRequest({ host: "o1.ingest.us.sentry.io:443" })).toBe(true);
  });

  it.each([
    "sentry.io.example.com",
    "ingest.example.com",
    "sentry.io",
    "o1.sentry.io",
    "connector",
    "api.datadoghq.com",
    "localhost",
  ])("still traces non-ingest host %s", (hostname) => {
    expect(isSentryIngestRequest({ hostname })).toBe(false);
  });

  it("still traces a request with no host information", () => {
    expect(isSentryIngestRequest({} as RequestOptions)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createMetricsScrapeFilter
// ---------------------------------------------------------------------------

function incoming(url: string | undefined, localPort: number | undefined): IncomingMessage {
  return { url, socket: { localPort } } as unknown as IncomingMessage;
}

describe("createMetricsScrapeFilter", () => {
  const ignore = createMetricsScrapeFilter({ port: 9464, endpoint: "/metrics" });

  it("ignores /metrics on the metrics port", () => {
    expect(ignore(incoming("/metrics", 9464))).toBe(true);
  });

  it("ignores /metrics with a query string on the metrics port", () => {
    expect(ignore(incoming("/metrics?name[]=x", 9464))).toBe(true);
  });

  it("still traces normal routes on the API port", () => {
    expect(ignore(incoming("/api/v1/sales", 3000))).toBe(false);
    expect(ignore(incoming("/api/v1/health/live", 3000))).toBe(false);
  });

  it("still traces /metrics on a port other than the metrics port", () => {
    expect(ignore(incoming("/metrics", 3000))).toBe(false);
  });

  it("still traces other paths on the metrics port", () => {
    expect(ignore(incoming("/metricsx", 9464))).toBe(false);
    expect(ignore(incoming("/", 9464))).toBe(false);
  });

  it("still traces a request with no url or socket", () => {
    expect(ignore(incoming(undefined, 9464))).toBe(false);
    expect(ignore({ url: "/metrics" } as unknown as IncomingMessage)).toBe(false);
  });

  it("honours a custom endpoint and port (worker on 9091)", () => {
    const worker = createMetricsScrapeFilter({ port: 9091, endpoint: "/prom" });
    expect(worker(incoming("/prom", 9091))).toBe(true);
    expect(worker(incoming("/metrics", 9091))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RedactingSpanExporter
// ---------------------------------------------------------------------------

describe("RedactingSpanExporter", () => {
  function setup(): {
    memory: tracing.InMemorySpanExporter;
    provider: tracing.BasicTracerProvider;
  } {
    const memory = new tracing.InMemorySpanExporter();
    const provider = new tracing.BasicTracerProvider({
      spanProcessors: [new tracing.SimpleSpanProcessor(new RedactingSpanExporter(memory))],
    });
    return { memory, provider };
  }

  it("exports spans with redacted URL attributes and a working spanContext()", async () => {
    const { memory, provider } = setup();
    const span = provider.getTracer("t").startSpan("POST", {
      attributes: {
        "http.url": "https://o1.ingest.us.sentry.io/api/2/envelope/?sentry_key=abc",
        "http.target": "/api/2/envelope/?sentry_key=abc",
        "url.full": "https://o1.ingest.us.sentry.io/api/2/envelope/?sentry_key=abc",
        "url.query": "sentry_key=abc",
        "http.method": "POST",
      },
    });
    const { traceId, spanId } = span.spanContext();
    span.end();
    await provider.forceFlush();

    const [exported] = memory.getFinishedSpans();
    expect(exported).toBeDefined();
    expect(exported?.attributes).toEqual({
      "http.url": "https://o1.ingest.us.sentry.io/api/2/envelope/",
      "http.target": "/api/2/envelope/",
      "url.full": "https://o1.ingest.us.sentry.io/api/2/envelope/",
      "http.method": "POST",
    });
    expect(exported?.spanContext().traceId).toBe(traceId);
    expect(exported?.spanContext().spanId).toBe(spanId);
    expect(exported?.name).toBe("POST");
    expect(exported?.ended).toBe(true);
    expect(JSON.stringify(exported?.attributes)).not.toContain("sentry_key");
  });

  it("leaves the original span's attributes untouched", async () => {
    const { provider } = setup();
    const span = provider.getTracer("t").startSpan("GET", {
      attributes: { "http.target": "/x?token=abc" },
    });
    span.end();
    await provider.forceFlush();
    expect((span as unknown as tracing.ReadableSpan).attributes["http.target"]).toBe(
      "/x?token=abc",
    );
  });

  it("passes the export result through to the caller", () => {
    const inner = {
      export: jest.fn((_spans: tracing.ReadableSpan[], cb: (r: { code: number }) => void) =>
        cb({ code: 0 }),
      ),
      shutdown: jest.fn().mockResolvedValue(undefined),
    };
    const exporter = new RedactingSpanExporter(inner);
    const cb = jest.fn();
    exporter.export([], cb);
    expect(inner.export).toHaveBeenCalledWith([], cb);
    expect(cb).toHaveBeenCalledWith({ code: 0 });
  });

  it("delegates shutdown and forceFlush", async () => {
    const inner = {
      export: jest.fn(),
      shutdown: jest.fn().mockResolvedValue(undefined),
      forceFlush: jest.fn().mockResolvedValue(undefined),
    };
    const exporter = new RedactingSpanExporter(inner);
    await exporter.shutdown();
    await exporter.forceFlush();
    expect(inner.shutdown).toHaveBeenCalledTimes(1);
    expect(inner.forceFlush).toHaveBeenCalledTimes(1);
  });

  it("resolves forceFlush when the inner exporter has none", async () => {
    const exporter = new RedactingSpanExporter({
      export: jest.fn(),
      shutdown: jest.fn().mockResolvedValue(undefined),
    });
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DB connection string (RT-762)
// ---------------------------------------------------------------------------

describe("RedactingSpanExporter - db.connection_string (RT-762)", () => {
  const DSN = "postgresql://app@db.internal.example:5432/dp2_prod?sslmode=require";

  it("exports no span attribute value containing both '://' and '?'", async () => {
    const memory = new tracing.InMemorySpanExporter();
    const provider = new tracing.BasicTracerProvider({
      spanProcessors: [new tracing.SimpleSpanProcessor(new RedactingSpanExporter(memory))],
    });
    // Attribute set mirrors what @opentelemetry/instrumentation-pg emits.
    const span = provider.getTracer("t").startSpan("pg.query:SELECT", {
      attributes: {
        "db.system": "postgresql",
        "db.connection_string": DSN,
        "http.url": "https://example.test/a?token=abc",
      },
    });
    const { traceId, spanId } = span.spanContext();
    span.end();
    await provider.forceFlush();

    const [exported] = memory.getFinishedSpans();
    const leaking = Object.entries(exported?.attributes ?? {}).filter(
      ([, value]) => typeof value === "string" && value.includes("://") && value.includes("?"),
    );
    expect(leaking).toEqual([]);
    expect(exported?.attributes).not.toHaveProperty("db.connection_string");
    expect(exported?.attributes["db.system"]).toBe("postgresql");
    expect(exported?.spanContext().traceId).toBe(traceId);
    expect(exported?.spanContext().spanId).toBe(spanId);
  });

  it("drops DB host, database and user identity from DB spans only", () => {
    const dbSpan = {
      "db.system": "postgresql",
      "db.operation": "SELECT",
      "db.name": "dp2_prod",
      "db.user": "app",
      "db.namespace": "dp2_prod",
      "net.peer.name": "db.internal.example",
      "net.peer.port": 5432,
      "server.address": "db.internal.example",
      "server.port": 5432,
    };
    expect(redactSpanAttributes(dbSpan)).toEqual({
      "db.system": "postgresql",
      "db.operation": "SELECT",
    });
    const httpSpan = { "net.peer.name": "api.example.test", "server.address": "api.example.test" };
    expect(redactSpanAttributes(httpSpan)).toEqual(httpSpan);
  });

  it("drops db.connection_string in redactSpanAttributes", () => {
    expect(
      redactSpanAttributes({ "db.connection_string": DSN, "db.system": "postgresql" }),
    ).toEqual({ "db.system": "postgresql" });
  });
});

// ---------------------------------------------------------------------------
// GenAI prompt / completion attributes (RT-655 acceptance 3)
// ---------------------------------------------------------------------------

describe("redactSpanAttributes — GenAI prompt and completion content", () => {
  const PROMPT = "canary-prompt-text-7f3a";
  const COMPLETION = "canary-completion-text-91bc";

  it("drops prompt, completion, message and system-instruction attributes", () => {
    const redacted = redactSpanAttributes({
      "gen_ai.prompt": PROMPT,
      "gen_ai.prompt.0.content": PROMPT,
      "gen_ai.completion": COMPLETION,
      "gen_ai.completion.0.content": COMPLETION,
      "gen_ai.input.messages": PROMPT,
      "gen_ai.output.messages": COMPLETION,
      "gen_ai.system_instructions": PROMPT,
      "ai.prompt": PROMPT,
      "ai.completion": COMPLETION,
      "ai.evidence_pack": PROMPT,
    });
    expect(redacted).toEqual({});
  });

  it("keeps non-content GenAI attributes (model, token counts, output type)", () => {
    const redacted = redactSpanAttributes({
      "gen_ai.request.model": "fake-model-2026-01-01",
      "gen_ai.usage.input_tokens": 12,
      "gen_ai.output.type": "json",
      "gen_ai.prompt.0.content": PROMPT,
    });
    expect(redacted).toEqual({
      "gen_ai.request.model": "fake-model-2026-01-01",
      "gen_ai.usage.input_tokens": 12,
      "gen_ai.output.type": "json",
    });
  });

  it("drops the same content through the exporter wrapper", () => {
    const memory = new tracing.InMemorySpanExporter();
    const provider = new tracing.BasicTracerProvider({
      spanProcessors: [new tracing.SimpleSpanProcessor(new RedactingSpanExporter(memory))],
    });
    const span = provider.getTracer("t").startSpan("gen_ai.chat");
    span.setAttribute("gen_ai.prompt.0.content", PROMPT);
    span.setAttribute("gen_ai.completion.0.content", COMPLETION);
    span.setAttribute("gen_ai.request.model", "fake-model-2026-01-01");
    span.end();
    const [exported] = memory.getFinishedSpans();
    expect(JSON.stringify(exported?.attributes)).not.toContain(PROMPT);
    expect(JSON.stringify(exported?.attributes)).not.toContain(COMPLETION);
    expect(exported?.attributes["gen_ai.request.model"]).toBe("fake-model-2026-01-01");
  });
});
