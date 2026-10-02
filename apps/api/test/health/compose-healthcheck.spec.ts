/**
 * RT-144 — the production compose api healthcheck probes the readiness
 * route, not the metrics listener.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("production api healthcheck", () => {
  it("probes GET /api/v1/health/ready on the API port", () => {
    const compose = readFileSync(
      resolve(__dirname, "..", "..", "..", "..", "docker-compose.prod.yml"),
      "utf8",
    );
    const api = compose.slice(compose.indexOf("  api:"), compose.indexOf("  worker:"));

    expect(api).toContain("http://127.0.0.1:3000/api/v1/health/ready");
    expect(api).not.toContain("9464/metrics");
    expect(api).not.toMatch(/console\.|process\.(stdout|stderr)/);
  });
});
