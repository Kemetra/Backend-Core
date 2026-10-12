/**
 * ShiftClosesModule — RT-383: the admin read of recorded RT-17 shift closes
 * (`shift-closes.openapi.yaml`) for Admin-Console RT-18. Read only.
 *
 * Imports:
 *   - `AuthModule`    — `PG_POOL` + the session/token repositories the
 *                       session-only `SessionOnlyAdminGuard` uses.
 *   - `ContextModule` — `TenantContextGuard` (publishes `request.context`) and
 *                       `MembershipRepository` (the caller's role → store scope).
 *   - `AuditModule`   — the global `AuditEmitterInterceptor` the `@Auditable`
 *                       decorators trigger.
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { ShiftClosesController } from "./shift-closes.controller";
import { ShiftClosesReadService } from "./shift-closes.service";

@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [ShiftClosesController],
  providers: [ShiftClosesReadService],
})
export class ShiftClosesModule {}
