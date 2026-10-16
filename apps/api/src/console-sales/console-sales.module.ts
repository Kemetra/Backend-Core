/**
 * ConsoleSalesModule — RT-562 (RT-556 F2): the console read of received sales
 * (`console-sales.openapi.yaml`) for Admin-Console spec 012. Read only.
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
import { ConsoleSalesController } from "./console-sales.controller";
import { SCAN_LIMIT_DEFAULT } from "./console-sales.query";
import { CONSOLE_SALES_SCAN_LIMIT, ConsoleSalesReadService } from "./console-sales.service";

@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [ConsoleSalesController],
  providers: [ConsoleSalesReadService, { provide: CONSOLE_SALES_SCAN_LIMIT, useValue: SCAN_LIMIT_DEFAULT }],
})
export class ConsoleSalesModule {}
