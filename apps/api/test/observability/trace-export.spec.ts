/**
 * RT-631 (OBS-2) — the api exports traces under the contract identity.
 *
 * A child Node process loads the production `src/instrumentation.ts` (as
 * `main.ts` does) with OTLP pointed at a local sink, records one span and
 * flushes. The exported batch must carry `service.name=backend-api` and
 * `service.version=<release SHA12>` (OBS-1 §1). Docker-free.
 */
import * as path from "path";

type Probe = (opts: {
  appDir: string;
  spanName: string;
  env?: Record<string, string>;
}) => Promise<Record<string, string | undefined>>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { probeExportedResource } = require("../../../../tools/test-support/otlp-export-probe.cjs") as {
  probeExportedResource: Probe;
};

const SHA40 = "36bb0c7e1f2a3b4c5d6e7f8091a2b3c4d5e6f708";
const APP_DIR = path.resolve(__dirname, "../..");

describe("RT-631 — api trace export", () => {
  it("exports spans as backend-api with the release SHA12 as service.version", async () => {
    const resource = await probeExportedResource({
      appDir: APP_DIR,
      spanName: "api.rt631.probe",
      env: { SENTRY_RELEASE: SHA40, METRICS_PORT: "0" },
    });
    expect(resource["service.name"]).toBe("backend-api");
    expect(resource["service.version"]).toBe(SHA40.slice(0, 12));
  }, 30_000);

  it("omits service.version when the release is not a commit SHA", async () => {
    const resource = await probeExportedResource({
      appDir: APP_DIR,
      spanName: "api.rt631.unversioned",
      env: { SENTRY_RELEASE: "backend-core-36bb0c7e1f2a", METRICS_PORT: "0" },
    });
    expect(resource["service.name"]).toBe("backend-api");
    expect(resource["service.version"]).toBeUndefined();
  }, 30_000);
});
