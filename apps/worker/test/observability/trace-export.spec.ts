/**
 * RT-631 (OBS-2) — the worker exports traces under the contract identity.
 *
 * A child Node process loads the production `src/instrumentation.ts` (as
 * `main.ts` does) with OTLP pointed at a local sink, records one span and
 * flushes. The exported batch must carry `service.name=backend-worker` and
 * `service.version=<release SHA12>` (OBS-1 §1). Docker-free.
 *
 * Only a manual span is asserted. The SDK also instruments `pg`; its Redis
 * instrumentation targets node-redis, while BullMQ uses ioredis.
 */
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { traceExportCases } = require("../../../../tools/test-support/otlp-export-probe.cjs");

type TraceExportCase = [string, (appDir: string, metricsPortVar: string) => Promise<void>];

describe("RT-631 — worker trace export", () => {
  it.each(traceExportCases("backend-worker") as TraceExportCase[])("%s", async (_title, run) => {
    await run(path.resolve(__dirname, "../.."), "WORKER_METRICS_PORT");
  }, 30_000);
});
