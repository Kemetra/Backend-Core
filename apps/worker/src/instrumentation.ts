/**
 * OTel SDK bootstrap — imported FIRST in main.ts (before any module that
 * creates OTel instruments at load time).
 *
 * Why this file exists
 * --------------------
 * ES/CommonJS imports are hoisted: every `import` at the top of `main.ts`
 * is evaluated before the first line of `bootstrap()` runs. This means
 * `worker.metrics.ts` and any other module that creates OTel instruments at
 * load time would create ProxyCounters/ProxyHistograms against the global
 * no-op default MeterProvider BEFORE `startOtel()` could be called inside
 * bootstrap().
 *
 * ProxyCounters do NOT retroactively forward data to a MeterProvider set
 * after they were created. The scrape endpoint would always return
 * "# no registered metrics" even though workers appear to be emitting.
 *
 * Fix: call `startOtel()` at module-evaluation time before every other
 * import in main.ts. `import "./instrumentation"` must be the FIRST import.
 *
 * `shouldStartOtel()` is read before `startOtel()`. `DP2_OTEL_DISABLED=1|true`
 * or `OTEL_SDK_DISABLED=true` skips SDK construction and the metrics listener.
 * When neither is set, `startOtel()` still runs at module evaluation.
 *
 * Worker-specific defaults
 * ------------------------
 * The metrics listener binds to `127.0.0.1` by default. Workers have no
 * public HTTP server; binding to loopback prevents external exposure.
 * Override with `WORKER_METRICS_BIND_HOST` if needed (e.g., within a
 * container network where a Prometheus scraper runs on a different host).
 *
 * Constitution §VII / T483.
 */
import { shouldStartOtel, startOtel } from "@data-pulse-2/shared";

// Read env vars at module-evaluation time. Node.js has already populated
// `process.env` from the OS environment by this point, so these reads are safe.
// The guard is before startOtel so a disable flag never constructs the SDK.
if (shouldStartOtel(process.env)) {
  startOtel({
    serviceName: "worker",
    metrics: {
      port: Number(process.env["WORKER_METRICS_PORT"] ?? 9091),
      host: process.env["WORKER_METRICS_BIND_HOST"] ?? "127.0.0.1",
    },
  });
}
