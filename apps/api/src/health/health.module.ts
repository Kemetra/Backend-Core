/**
 * HealthModule — liveness and readiness for deployment checks (RT-144).
 * Imports AuthModule for the shared PG_POOL, AUTH_LOOKUP_POOL and
 * REDIS_CLIENT, so the checks probe the same clients that serve traffic.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

@Module({
  imports: [AuthModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
