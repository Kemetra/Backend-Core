/**
 * OpenTelemetry SDK setup for Data-Pulse-2.
 *
 * Instruments HTTP, Postgres (`pg`), and Redis (`node-redis`, v4+) via the
 * official `@opentelemetry/instrumentation-*` packages, and exports traces
 * over OTLP/HTTP.
 *
 * Metrics support (T483): when `opts.metrics` is provided, a
 * `PrometheusExporter` is registered as the `metricReader` of the NodeSDK.
 * The exporter manages its own HTTP listener on the configured port/host and
 * exposes `/metrics` in Prometheus text format. The default port is 9464
 * (standard Prometheus OTel port allocation); the worker should override with
 * `WORKER_METRICS_PORT` / 9091 and bind to `127.0.0.1`.
 *
 * BullMQ instrumentation is INTENTIONALLY DEFERRED.
 *
 *   The OpenTelemetry contrib org does not publish
 *   `@opentelemetry/instrumentation-bullmq`. Available third-party options
 *   (`bullmq-otel` from the BullMQ authors, `@appsignal/...`, and others)
 *   each have different integration models and trade-offs. The BullMQ tracing
 *   decision will be made when `apps/worker` actually introduces BullMQ
 *   (Phase 2 worker bootstrap and Phase 3 email/audit processors). This
 *   module must NOT import or reference any BullMQ-related package today.
 *
 * Constitution VII (observable systems) and plan §1.1 (vendor-neutral OTel).
 */
import { diag, DiagConsoleLogger, DiagLogLevel, metrics } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { RedisInstrumentation } from "@opentelemetry/instrumentation-redis";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

/**
 * Re-export the classes and API objects that test files need to construct
 * a standalone MeterProvider + PrometheusExporter setup for scrape-endpoint
 * integration tests. Importing from `@data-pulse-2/shared` avoids apps
 * needing `@opentelemetry/*` as direct devDependencies (T483).
 */
export {
  MeterProvider as __internal_MeterProvider,
  PrometheusExporter as __internal_PrometheusExporter,
  metrics as __internal_otelMetricsApi,
};

export { shouldStartOtel } from "./should-start-otel";

/** Configuration for the Prometheus metrics HTTP endpoint. */
export interface MetricsOptions {
  /**
   * Port for the Prometheus scrape endpoint.
   * Defaults to `METRICS_PORT` env var, then 9464 (standard OTel allocation).
   */
  port?: number;
  /**
   * Host/interface to bind the metrics HTTP listener.
   * Defaults to `METRICS_BIND_HOST` env var, then `undefined` (all interfaces).
   * Workers SHOULD pass `'127.0.0.1'` to avoid external exposure.
   */
  host?: string;
  /**
   * Prometheus scrape path.
   * @default '/metrics'
   */
  endpoint?: string;
}

export interface OtelOptions {
  /** Service name written into every span's `service.name` resource attr. */
  serviceName: string;
  /** Service version (e.g., git SHA or semver). */
  serviceVersion?: string;
  /**
   * Override the default OTLP/HTTP traces endpoint.
   * Defaults to `OTEL_EXPORTER_OTLP_ENDPOINT` env var, then the SDK default.
   */
  otlpEndpoint?: string;
  /** Enable internal OTel debug logging. */
  debug?: boolean;
  /**
   * When provided, registers a `PrometheusExporter` as the metrics reader and
   * starts a Prometheus scrape endpoint on the specified port/host.
   * Set to `false` (or omit) to disable metrics entirely (traces only).
   *
   * @example
   *   // API — sidecar on METRICS_PORT (default 9464)
   *   startOtel({ serviceName: 'api', metrics: { port: 9464 } });
   *
   *   // Worker — loopback only, different port
   *   startOtel({ serviceName: 'worker', metrics: { port: 9091, host: '127.0.0.1' } });
   */
  metrics?: MetricsOptions | false;
}

let sdk: NodeSDK | null = null;

export function createOtelSdk(opts: OtelOptions): NodeSDK {
  if (opts.debug) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const traceExporter = new OTLPTraceExporter(
    opts.otlpEndpoint ? { url: opts.otlpEndpoint } : {},
  );

  const instrumentations = [
    new HttpInstrumentation(),
    new PgInstrumentation(),
    new RedisInstrumentation(),
    // BullMQ instrumentation deferred — see file header.
  ];

  // When `metrics` is truthy, wire a PrometheusExporter as the metricReader.
  // The exporter manages its own HTTP listener on the configured port/host;
  // no additional HTTP server code is needed in the calling app.
  //
  // `host` is omitted from the config object when undefined so that
  // `exactOptionalPropertyTypes` strict mode is satisfied — the ExporterConfig
  // interface marks `host` as `string | undefined` but the TS compiler with
  // `exactOptionalPropertyTypes: true` treats explicit `undefined` as a type
  // error on a property that doesn't declare `undefined` in its union.
  const metricReaders = opts.metrics
    ? [
        new PrometheusExporter({
          port: opts.metrics.port ?? Number(process.env["METRICS_PORT"] ?? 9464),
          endpoint: opts.metrics.endpoint ?? "/metrics",
          ...(opts.metrics.host !== undefined
            ? { host: opts.metrics.host }
            : {}),
        }),
      ]
    : undefined;

  return new NodeSDK({
    serviceName: opts.serviceName,
    ...(opts.serviceVersion ? { serviceVersion: opts.serviceVersion } : {}),
    traceExporter,
    instrumentations,
    ...(metricReaders ? { metricReaders } : {}),
  });
}

/**
 * Start the singleton OTel SDK. Idempotent: a second call returns the
 * already-running instance.
 */
export function startOtel(opts: OtelOptions): NodeSDK {
  if (sdk) return sdk;
  sdk = createOtelSdk(opts);
  sdk.start();
  return sdk;
}

/**
 * Flush and shut down the singleton OTel SDK. Safe to call without a prior
 * `startOtel`; resolves immediately if no SDK is running.
 */
export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  const current = sdk;
  sdk = null;
  await current.shutdown();
}

/**
 * **TEST USE ONLY** — resets the OTel SDK singleton and the global
 * MeterProvider so that subsequent `startOtel` calls start fresh.
 *
 * The OTel API global state (`metrics.getMeter(...)`) is module-level;
 * `shutdownOtel()` alone only clears our local `sdk` reference. Calling
 * `metrics.disable()` resets the global provider to the no-op default,
 * preventing stale provider references across test cases.
 *
 * Never call this in production code.
 */
export async function __resetOtelForTests(): Promise<void> {
  await shutdownOtel();
  metrics.disable();
}

export * from "./bullmq-propagation";
