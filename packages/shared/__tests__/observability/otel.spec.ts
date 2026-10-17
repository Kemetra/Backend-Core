/**
 * Unit tests for otel.ts SDK helpers.
 *
 * Strategy: jest.mock replaces @opentelemetry/sdk-node and the instrumentation
 * packages with lightweight stubs so that NodeSDK.start() / .shutdown() never
 * open real sockets, register real HTTP interceptors, or connect to an OTLP
 * collector. All tests are pure in-process.
 */

// Shared mock functions — defined outside jest.mock so tests can inspect them.
const mockStart = jest.fn();
const mockShutdown = jest.fn().mockResolvedValue(undefined);

jest.mock("@opentelemetry/sdk-node", () => {
  const MockNodeSDK = jest.fn().mockImplementation(() => ({
    start: mockStart,
    shutdown: mockShutdown,
  }));
  return { NodeSDK: MockNodeSDK };
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

// Import after mocks are hoisted.
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  createOtelSdk,
  startOtel,
  shutdownOtel,
} from "../../src/observability/otel";

const MockNodeSDK = NodeSDK as jest.MockedClass<typeof NodeSDK>;

// Only NodeSDK is stubbed: give the module the real `resources` namespace so
// the service.version resource under test is a real Resource.
type SdkNodeModule = typeof import("@opentelemetry/sdk-node");
jest.requireMock<SdkNodeModule>("@opentelemetry/sdk-node").resources =
  jest.requireActual<SdkNodeModule>("@opentelemetry/sdk-node").resources;

// ---------------------------------------------------------------------------
// createOtelSdk
// ---------------------------------------------------------------------------

describe("createOtelSdk", () => {
  beforeEach(() => {
    MockNodeSDK.mockClear();
    mockStart.mockClear();
    mockShutdown.mockClear();
  });

  it("constructs a NodeSDK with the given serviceName", () => {
    createOtelSdk({ serviceName: "my-service" });
    expect(MockNodeSDK).toHaveBeenCalledTimes(1);
    const [ctorArg] = MockNodeSDK.mock.calls[0] as [Record<string, unknown>];
    expect(ctorArg["serviceName"]).toBe("my-service");
  });

  // NodeSDK has no `serviceVersion` option: it must arrive as a resource
  // attribute, or it is silently dropped (RT-631).
  it("sets service.version as a resource attribute when provided", () => {
    createOtelSdk({ serviceName: "svc", serviceVersion: "36bb0c7e1f2a" });
    const [ctorArg] = MockNodeSDK.mock.calls[0] as [Record<string, unknown>];
    expect(ctorArg).not.toHaveProperty("serviceVersion");
    const resource = ctorArg["resource"] as { attributes: Record<string, unknown> };
    expect(resource.attributes["service.version"]).toBe("36bb0c7e1f2a");
    // A custom resource replaces sdk-node's default; keep its SDK attributes.
    expect(resource.attributes["telemetry.sdk.language"]).toBe("nodejs");
  });

  it("passes no resource when serviceVersion is not provided", () => {
    createOtelSdk({ serviceName: "svc" });
    const [ctorArg] = MockNodeSDK.mock.calls[0] as [Record<string, unknown>];
    expect(ctorArg).not.toHaveProperty("serviceVersion");
    expect(ctorArg).not.toHaveProperty("resource");
  });

  it("passes an OTLP exporter to NodeSDK", () => {
    createOtelSdk({ serviceName: "svc" });
    const [ctorArg] = MockNodeSDK.mock.calls[0] as [Record<string, unknown>];
    expect(ctorArg["traceExporter"]).toBeDefined();
  });

  it("passes instrumentations array to NodeSDK", () => {
    createOtelSdk({ serviceName: "svc" });
    const [ctorArg] = MockNodeSDK.mock.calls[0] as [Record<string, unknown>];
    expect(Array.isArray(ctorArg["instrumentations"])).toBe(true);
    expect((ctorArg["instrumentations"] as unknown[]).length).toBeGreaterThan(
      0,
    );
  });

  it("enables diag logging when debug is true without throwing", () => {
    expect(() =>
      createOtelSdk({ serviceName: "svc", debug: true }),
    ).not.toThrow();
  });

  it("accepts a custom otlpEndpoint without throwing", () => {
    expect(() =>
      createOtelSdk({
        serviceName: "svc",
        otlpEndpoint: "http://localhost:4318/v1/traces",
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// startOtel
// ---------------------------------------------------------------------------

describe("startOtel", () => {
  beforeEach(async () => {
    MockNodeSDK.mockClear();
    mockStart.mockClear();
    mockShutdown.mockClear();
    // Reset singleton between tests
    await shutdownOtel();
  });

  it("creates and starts a NodeSDK instance", () => {
    startOtel({ serviceName: "svc" });
    expect(MockNodeSDK).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  it("returns the same instance on a second call (idempotent)", () => {
    const first = startOtel({ serviceName: "svc" });
    const second = startOtel({ serviceName: "svc" });
    expect(second).toBe(first);
    // NodeSDK constructor must only have been called once
    expect(MockNodeSDK).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// shutdownOtel
// ---------------------------------------------------------------------------

describe("shutdownOtel", () => {
  beforeEach(async () => {
    MockNodeSDK.mockClear();
    mockStart.mockClear();
    mockShutdown.mockClear();
    await shutdownOtel();
  });

  it("resolves immediately when no SDK has been started (no-op)", async () => {
    await expect(shutdownOtel()).resolves.toBeUndefined();
  });

  it("calls shutdown on the running SDK and then resolves", async () => {
    startOtel({ serviceName: "svc" });
    await shutdownOtel();
    expect(mockShutdown).toHaveBeenCalledTimes(1);
  });

  it("clears the singleton so a subsequent startOtel creates a fresh SDK", async () => {
    startOtel({ serviceName: "svc" });
    await shutdownOtel();
    MockNodeSDK.mockClear();
    mockStart.mockClear();
    startOtel({ serviceName: "svc-2" });
    expect(MockNodeSDK).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
  });
});
