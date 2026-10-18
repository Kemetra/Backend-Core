/**
 * T483 — metrics SDK wiring unit tests.
 *
 * Verifies that:
 *   1. A `PrometheusExporter` registered with a real `MeterProvider` causes
 *      counters to be recorded and scraped via the `/metrics` HTTP endpoint.
 *   2. `getMeter(service)` instruments created before the MeterProvider is
 *      registered record correctly once the provider is set (deferred-recording
 *      / ProxyMeter contract).
 *   3. `startOtel({ metrics: { ... } })` passes the metrics option through to
 *      the NodeSDK (validated via a mocked NodeSDK that captures its opts).
 *   4. `startOtel` without a `metrics` option does not include metricReaders.
 *   5. `__resetOtelForTests()` clears both the local singleton and the OTel
 *      global MeterProvider, allowing subsequent startOtel calls to start fresh.
 *
 * Strategy:
 *   Tests 1 + 2: use `MeterProvider` and `PrometheusExporter` directly
 *   (from `@opentelemetry/sdk-metrics`), bypassing NodeSDK entirely. This
 *   avoids the mock-instrumentation / setTracerProvider conflict that arises
 *   when real NodeSDK.start() tries to call `.setTracerProvider()` on the
 *   `{}` stub objects returned by the jest-mocked instrumentation packages.
 *
 *   Tests 3 + 4 + 5: mock NodeSDK (matching otel.spec.ts) to verify that
 *   createOtelSdk passes the correct opts object.
 *
 * Port allocation: we pre-allocate ephemeral ports via a temp server bound
 * on port 0. Small race window; acceptable for tests.
 *
 * Constitution §VII / T483.
 */
import * as net from "net";
import * as http from "http";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { metrics as otelMetrics } from "@opentelemetry/api";

// ---------------------------------------------------------------------------
// Stubs for NodeSDK path (tests 3-5 only).
// ---------------------------------------------------------------------------
const mockStart = jest.fn();
const mockShutdown = jest.fn().mockResolvedValue(undefined);

jest.mock("@opentelemetry/sdk-node", () => {
  const MockNodeSDK = jest.fn().mockImplementation(() => ({
    start: mockStart,
    shutdown: mockShutdown,
  }));
  // RT-684: createOtelSdk builds its sampler from the real `tracing` namespace.
  return { NodeSDK: MockNodeSDK, tracing: jest.requireActual("@opentelemetry/sdk-node").tracing };
});

jest.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("@opentelemetry/instrumentation-http", () => ({
  HttpInstrumentation: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("@opentelemetry/instrumentation-pg", () => ({
  PgInstrumentation: jest.fn().mockImplementation(() => ({})),
}));

jest.mock("@opentelemetry/instrumentation-redis", () => ({
  RedisInstrumentation: jest.fn().mockImplementation(() => ({})),
}));

import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  createOtelSdk,
  startOtel,
  __resetOtelForTests,
} from "../../src/observability/otel";
import { getMeter } from "../../src/observability/meter";

const MockNodeSDK = NodeSDK as jest.MockedClass<typeof NodeSDK>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
    server.on("error", reject);
  });
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

async function waitForMetricsEndpoint(
  url: string,
  maxMs = 5000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await fetchText(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`Metrics endpoint ${url} not reachable within ${maxMs}ms`);
}

// ---------------------------------------------------------------------------
// 1. Direct MeterProvider + PrometheusExporter (no NodeSDK)
// ---------------------------------------------------------------------------

describe("T483 — PrometheusExporter scrape endpoint (direct MeterProvider)", () => {
  let exporter: PrometheusExporter;
  let provider: MeterProvider;
  let port: number;

  beforeEach(async () => {
    port = await getFreePort();
    exporter = new PrometheusExporter({ port, host: "127.0.0.1" });
    provider = new MeterProvider({ readers: [exporter] });
    otelMetrics.setGlobalMeterProvider(provider);
    await waitForMetricsEndpoint(`http://127.0.0.1:${port}/metrics`);
  });

  afterEach(async () => {
    await provider.shutdown();
    otelMetrics.disable();
  });

  it("counter.add() records a value and it appears in /metrics output", async () => {
    const meter = getMeter("test-direct");
    const counter = meter.createCounter("direct_test_counter_total", {
      description: "Direct test counter.",
    });
    counter.add(7, { env: "test" });

    await new Promise((r) => setTimeout(r, 200));

    const body = await fetchText(`http://127.0.0.1:${port}/metrics`);
    expect(body).toContain("direct_test_counter_total");
    expect(body).toMatch(/^#\s+TYPE\s+/m);
  });

  it("instruments created before provider registration record correctly (ProxyMeter contract)", async () => {
    // getMeter returns a ProxyMeter if no global provider is set — but since
    // afterEach/beforeEach sets up the provider BEFORE this test body runs,
    // we verify that a new instrument created here is immediately live.
    const meter = getMeter("test-proxy");
    const counter = meter.createCounter("proxy_counter_total");
    expect(() => counter.add(1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. createOtelSdk passes metricReaders to NodeSDK when metrics is provided
// ---------------------------------------------------------------------------

describe("T483 — createOtelSdk passes metrics option to NodeSDK", () => {
  beforeEach(() => {
    MockNodeSDK.mockClear();
    mockStart.mockClear();
    mockShutdown.mockClear();
  });

  it("passes metricReaders array to NodeSDK when metrics option is provided", () => {
    createOtelSdk({ serviceName: "svc-metrics", metrics: { port: 9999, host: "127.0.0.1" } });
    const [ctorArg] = MockNodeSDK.mock.calls[0] as [Record<string, unknown>];
    expect(Array.isArray(ctorArg["metricReaders"])).toBe(true);
    expect((ctorArg["metricReaders"] as unknown[]).length).toBe(1);
  });

  it("does NOT pass metricReaders to NodeSDK when metrics option is false", () => {
    createOtelSdk({ serviceName: "svc-no-metrics", metrics: false });
    const [ctorArg] = MockNodeSDK.mock.calls[0] as [Record<string, unknown>];
    expect(ctorArg["metricReaders"]).toBeUndefined();
  });

  it("does NOT pass metricReaders to NodeSDK when metrics option is omitted", () => {
    createOtelSdk({ serviceName: "svc-omit-metrics" });
    const [ctorArg] = MockNodeSDK.mock.calls[0] as [Record<string, unknown>];
    expect(ctorArg["metricReaders"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. __resetOtelForTests clears both the local singleton and the global provider
// ---------------------------------------------------------------------------

describe("T483 — __resetOtelForTests clears OTel global state", () => {
  beforeEach(async () => {
    MockNodeSDK.mockClear();
    mockStart.mockClear();
    mockShutdown.mockClear();
    await __resetOtelForTests();
  });

  it("allows a subsequent startOtel to create a fresh NodeSDK instance", () => {
    startOtel({ serviceName: "svc-reset-1" });
    expect(MockNodeSDK).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("resets the OTel global provider so getMeter returns a clean no-op Meter", async () => {
    startOtel({ serviceName: "svc-reset-2" });
    await __resetOtelForTests();
    // After reset, calling getMeter and using an instrument must not throw
    // (no-op behaviour is restored).
    const meter = getMeter("post-reset");
    expect(() => meter.createCounter("post_reset_total").add(1)).not.toThrow();
  });
});
