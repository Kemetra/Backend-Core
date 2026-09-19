import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("production worker healthcheck", () => {
  it("authenticates through REDIS_URL and requires PING without printing secrets", () => {
    const compose = readFileSync(
      resolve(__dirname, "..", "..", "..", "docker-compose.prod.yml"),
      "utf8",
    );
    const worker = compose.slice(
      compose.indexOf("  worker:"),
      compose.indexOf("  caddy:"),
    );

    expect(worker).toContain("require('ioredis')");
    expect(worker).toContain("process.env.REDIS_URL");
    expect(worker).toContain("r.ping()");
    expect(worker).not.toContain("require('net')");
    expect(worker).not.toMatch(/console\.|process\.(stdout|stderr)/);
  });
});
