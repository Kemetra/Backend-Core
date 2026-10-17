/**
 * CashVariancePolicyModule — RT-387 (AD-CASH-001 F3): the shift variance
 * policy runtime (`cash-variance-policy.openapi.yaml` 1.0.0-draft): the POS
 * device read and the Console tenant default / store override operations.
 *
 * Imports:
 *   - `AuthModule`      — `PG_POOL` and the session/token repositories of the
 *                         session-only `SessionOnlyAdminGuard`.
 *   - `ContextModule`   — `TenantContextGuard` and `MembershipRepository` (the
 *                         caller's role → store scope and the owner rule).
 *   - `AuditModule`     — the `AuditEmitterInterceptor` the read decorators use.
 *
 * `DeviceRepository` (for `PosDeviceAuthGuard`) is built as in ReadDownModule:
 * the device on the pre-tenant lookup pool, its tenant status on the domain pool.
 */
import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import { AuditModule } from "../audit/audit.module";
import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { DeviceRepository } from "../pos-operators/device.repository";
import { CashVariancePolicyConsoleController } from "./policy-console.controller";
import { CashVariancePolicyDeviceController } from "./policy-device.controller";
import { CashVariancePolicyService } from "./policy.service";

@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [CashVariancePolicyConsoleController, CashVariancePolicyDeviceController],
  providers: [
    CashVariancePolicyService,
    {
      provide: DeviceRepository,
      useFactory: (lookupPool: Pool, domainPool: Pool): DeviceRepository => new DeviceRepository(lookupPool, domainPool),
      inject: [AUTH_LOOKUP_POOL, PG_POOL],
    },
    PosDeviceAuthGuard,
  ],
})
export class CashVariancePolicyModule {}
