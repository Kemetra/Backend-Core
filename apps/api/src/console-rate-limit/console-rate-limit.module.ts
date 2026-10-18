/**
 * ConsoleRateLimitModule — RT-619.
 *
 * Provides the boot-time console rate-limit config. The guard itself is
 * registered in AppModule as an APP_GUARD immediately after
 * FailClosedAuthGuard (RT-574 D1/L9), so it resolves `RateLimiter` from the
 * AuthModule export (the one shared Redis-backed limiter) and this config
 * from here. With the default mode `off` the guard never touches Redis.
 */
import { Module } from "@nestjs/common";

import { CONSOLE_RATE_LIMIT_CONFIG, readConsoleRateLimitConfig } from "./console-rate-limit.config";

@Module({
  providers: [{ provide: CONSOLE_RATE_LIMIT_CONFIG, useFactory: () => readConsoleRateLimitConfig() }],
  exports: [CONSOLE_RATE_LIMIT_CONFIG],
})
export class ConsoleRateLimitModule {}
