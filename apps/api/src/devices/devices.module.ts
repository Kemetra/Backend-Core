/**
 * DevicesModule — RT-365 (RT-287 F2): the Console device registry
 * (`devices.openapi.yaml`): list, detail and revoke.
 *
 * Imports:
 *   - `AuthModule`    — `PG_POOL` + the session/token repositories the
 *                       session-only `SessionOnlyAdminGuard` uses.
 *   - `ContextModule` — `TenantContextGuard` (publishes `request.context`) and
 *                       `MembershipRepository` (the caller's role → store scope).
 *   - `AuditModule`   — the global `AuditEmitterInterceptor` the `@Auditable`
 *                       read decorators trigger. The revoke writes its own
 *                       `pos.device.revoked` row in its transaction.
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { DevicesController } from "./devices.controller";
import { DevicesService } from "./devices.service";

@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [DevicesController],
  providers: [DevicesService],
})
export class DevicesModule {}
