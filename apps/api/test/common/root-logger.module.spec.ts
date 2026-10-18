/**
 * RT-124 — RootLoggerModule registers ROOT_LOGGER app-wide, so every
 * `@Optional() @Inject(ROOT_LOGGER)` site (e.g. the audit emitter's
 * enqueue-failure log) resolves a real logger, the same instance main.ts
 * hands the global LoggingInterceptor.
 */
import "reflect-metadata";

// RT-684 (OBS-9 F-D): capture what the root logger writes, so the emitted
// `service` field is asserted, not just the option passed in.
const loggedLines: string[] = [];
jest.mock("@data-pulse-2/shared", () => {
  const actual = jest.requireActual<typeof import("@data-pulse-2/shared")>("@data-pulse-2/shared");
  return {
    ...actual,
    createLogger: (opts: Parameters<typeof actual.createLogger>[0]) =>
      actual.createLogger({ ...opts, destination: { write: (line: string) => void loggedLines.push(line) } }),
  };
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Injectable, Module, Inject, Optional } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import { ROOT_LOGGER } from "../../src/common/logging.interceptor";
import { getRootLogger, RootLoggerModule } from "../../src/common/root-logger.module";

@Injectable()
class NeedsLogger {
  constructor(@Optional() @Inject(ROOT_LOGGER) readonly logger?: unknown) {}
}

// A feature module that does NOT import RootLoggerModule — @Global() must
// still make ROOT_LOGGER visible to it.
@Module({ providers: [NeedsLogger] })
class FeatureModule {}

describe("RootLoggerModule (RT-124)", () => {
  it("resolves ROOT_LOGGER in a feature module that does not import it", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RootLoggerModule, FeatureModule],
    }).compile();

    const logger = moduleRef.get(NeedsLogger).logger;
    expect(logger).toBeDefined();
    expect(logger).toBe(getRootLogger());
    await moduleRef.close();
  });

  it("getRootLogger is memoized — one pino instance per process", () => {
    expect(getRootLogger()).toBe(getRootLogger());
  });

  it("writes the OBS-1 service name backend-api on every line (RT-684)", () => {
    loggedLines.length = 0;
    getRootLogger().warn("rt684 probe");

    expect(loggedLines).toHaveLength(1);
    expect(JSON.parse(loggedLines[0] ?? "{}")).toMatchObject({ service: "backend-api", message: "rt684 probe" });
  });
});

describe("api logger service names (RT-684, OBS-1 D4)", () => {
  it("every literal service name in apps/api/src is backend-api", () => {
    const root = join(__dirname, "..", "..", "src");
    const names = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) =>
        [...readFileSync(join(root, file), "utf8").matchAll(/\bservice:\s*"([^"]+)"/g)].map((m) => `${file}: ${m[1]}`),
      );

    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((entry) => !entry.endsWith(": backend-api"))).toEqual([]);
  });
});
