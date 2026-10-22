/**
 * PlatformSupportSessionsModule — RT-414's support-session surface.
 *
 * The enforcement point (`SupportSessionGate`) is not here: it is built from
 * the domain pool by `TenantContextGuard`, `ContextService` and the path-tenant
 * guard on `TenantsController`, so those keep their existing wiring.
 */
import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import { AuthModule, PG_POOL } from "../auth/auth.module";
import { SessionRepository } from "../auth/session.repository";
import { ContextModule } from "../context/context.module";
import { MembershipRepository } from "../context/membership.repository";
import { PlatformSupportSessionsController } from "./platform-support-sessions.controller";
import { PlatformSupportSessionsService } from "./platform-support-sessions.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [PlatformSupportSessionsController],
  providers: [
    {
      provide: PlatformSupportSessionsService,
      useFactory: (
        pool: Pool,
        sessions: SessionRepository,
        memberships: MembershipRepository,
      ): PlatformSupportSessionsService =>
        new PlatformSupportSessionsService(pool, sessions, memberships),
      inject: [PG_POOL, SessionRepository, MembershipRepository],
    },
  ],
})
export class PlatformSupportSessionsModule {}
