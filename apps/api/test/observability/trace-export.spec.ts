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
const { traceExportCases } = require("../../../../tools/test-support/otlp-export-probe.cjs");

type TraceExportCase = [string, (appDir: string, metricsPortVar: string) => Promise<void>];

describe("RT-631 — api trace export", () => {
  it.each(traceExportCases("backend-api") as TraceExportCase[])("%s", async (_title, run) => {
    await run(path.resolve(__dirname, "../.."), "METRICS_PORT");
  }, 30_000);
});
