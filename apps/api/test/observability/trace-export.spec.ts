/**
 * RT-631 (OBS-2) — the api exports traces under the contract identity.
 *
 * A child Node process loads the production `src/instrumentation.ts` (as
 * `main.ts` does) with OTLP pointed at a local sink, records one span and
 * flushes. The exported batch must carry `service.name=backend-api` and
 * `service.version=<release SHA12>` (OBS-1 §1). Docker-free.
 */
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { describeTraceExport } = require("../../../../tools/test-support/otlp-export-probe.cjs");

describeTraceExport({
  appDir: path.resolve(__dirname, "../.."),
  label: "api",
  serviceName: "backend-api",
  metricsPortVar: "METRICS_PORT",
});
