/**
 * PayerAccountsModule — RT-418: the Console payer-account facade
 * (`settlement/settlement.yaml` 2.0.0). Separate from `SettlementModule`
 * (the 035 receivable runtime RT-422 removes).
 *
 * Imports:
 *   - `AuthModule`    — `PG_POOL` + the repositories `DashboardAuthGuard` uses.
 *   - `ContextModule` — `TenantContextGuard` and `MembershipRepository`
 *                       (`RolesGuard`, the caller's store access).
 *   - `AuditModule`   — the global `AuditEmitterInterceptor` behind `@Auditable`.
 * The `IdempotencyInterceptor` the create's `@Idempotent("required")` engages
 * is global (APP_INTERCEPTOR, registered by `IdempotencyModule`).
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { PayerAccountsController } from "./payer-accounts.controller";
import { PayerAccountsService } from "./payer-accounts.service";

@Module({
  imports: [AuthModule, ContextModule, AuditModule],
  controllers: [PayerAccountsController],
  providers: [PayerAccountsService],
})
export class PayerAccountsModule {}
