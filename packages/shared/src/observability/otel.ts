/**
 * OpenTelemetry SDK setup for Backend-Core.
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
 * Span redaction (RT-609 F1): the OTLP exporter is wrapped in
 * `RedactingSpanExporter`, so exported URL attributes keep scheme + host + path
 * only (no query, userinfo or fragment). Sentry ingest requests and scrapes of
 * the metrics listener are not traced at all. See `./span-redaction`.
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
import { NodeSDK, resources } from "@opentelemetry/sdk-node";

import {
  RedactingSpanExporter,
  createMetricsScrapeFilter,
  isSentryIngestRequest,
  type MetricsScrapeTarget,
} from "./span-redaction";

/**
 * Re-export the classes and API objects that test files need to construct
 * a standalone MeterProvider + PrometheusExporter setup for scrape-endpoint
 * integration tests. Importing from `@data-pulse-2/shared` avoids apps
 * needing `@opentelemetry/*` as direct devDependencies (T483).
 */
export { MeterProvider as __internal_MeterProvider } from "@opentelemetry/sdk-metrics";
export {
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
  /** Service version (the release SHA12); omitted from spans when unset. */
  serviceVersion?: string | undefined;
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

/** Port + path of the Prometheus listener, or `null` when metrics are off. */
function resolveMetricsTarget(metrics: OtelOptions["metrics"]): MetricsScrapeTarget | null {
  if (!metrics) return null;
  return {
    port: metrics.port ?? Number(process.env["METRICS_PORT"] ?? 9464),
    endpoint: metrics.endpoint ?? "/metrics",
  };
}

function createHttpInstrumentation(metricsTarget: MetricsScrapeTarget | null): HttpInstrumentation {
  const isMetricsScrape = metricsTarget ? createMetricsScrapeFilter(metricsTarget) : null;
  return new HttpInstrumentation({
    ignoreOutgoingRequestHook: isSentryIngestRequest,
    ignoreIncomingRequestHook: (request) => isMetricsScrape?.(request) ?? false,
  });
}

export function createOtelSdk(opts: OtelOptions): NodeSDK {
  if (opts.debug) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const traceExporter = new RedactingSpanExporter(
    new OTLPTraceExporter(opts.otlpEndpoint ? { url: opts.otlpEndpoint } : {}),
  );

  const metricsTarget = resolveMetricsTarget(opts.metrics);
  const instrumentations = [
    createHttpInstrumentation(metricsTarget),
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
  const metricReaders = opts.metrics && metricsTarget
    ? [
        new PrometheusExporter({
          port: metricsTarget.port,
          endpoint: metricsTarget.endpoint,
          ...(opts.metrics.host !== undefined
            ? { host: opts.metrics.host }
            : {}),
        }),
      ]
    : undefined;

  return new NodeSDK({
    serviceName: opts.serviceName,
    // NodeSDK has no `serviceVersion` option; the version must be a resource
    // attribute or it is silently dropped (RT-631).
    ...(opts.serviceVersion
      ? { resource: resources.resourceFromAttributes({ "service.version": opts.serviceVersion }) }
      : {}),
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
