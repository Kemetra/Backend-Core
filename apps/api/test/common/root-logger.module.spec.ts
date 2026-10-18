/**
 * RT-124 — RootLoggerModule registers ROOT_LOGGER app-wide, so every
 * `@Optional() @Inject(ROOT_LOGGER)` site (e.g. the audit emitter's
 * enqueue-failure log) resolves a real logger, the same instance main.ts
 * hands the global LoggingInterceptor.
 */
import "reflect-metadata";

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
});
