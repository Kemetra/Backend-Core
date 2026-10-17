/**
 * ConsoleTelemetryModule — the Console Sentry tunnel (RT-632, OBS-3).
 * Imports AuthModule for the shared Redis-backed RateLimiter. The network
 * call goes through CONSOLE_TELEMETRY_FETCH (global `fetch`), so tests
 * replace it.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ConsoleTelemetryController } from "./console-telemetry.controller";
import {
  CONSOLE_TELEMETRY_FETCH,
  ConsoleTelemetryForwarder,
  type TelemetryFetch,
} from "./console-telemetry.forwarder";

const globalFetch: TelemetryFetch = (url, init) => fetch(url, init);

@Module({
  imports: [AuthModule],
  controllers: [ConsoleTelemetryController],
  providers: [
    ConsoleTelemetryForwarder,
    { provide: CONSOLE_TELEMETRY_FETCH, useValue: globalFetch },
  ],
})
export class ConsoleTelemetryModule {}
