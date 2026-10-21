/**
 * PosApproversModule — RT-788 (RT-114 MA-BC2; `[GATED]` authorization:
 * RT-788 comment 13275).
 *
 * Wires:
 *
 *   PosApproversController        (@DeviceBearer + PosDeviceAuthGuard)
 *     └─ ApproverEligibilityService
 *          ├─ tx      runWithTenantContext on PG_POOL (the NOBYPASSRLS domain
 *          │          pool): the eligibility read runs under RLS
 *          ├─ reader  ApproverEligibilityRepository (existing users,
 *          │          memberships, roles and store_access tables; no migration)
 *          └─ logger  the per-user cause, keyed by request_id
 *
 *   PosDeviceAuthGuard ← DeviceRepository on AUTH_LOOKUP_POOL (the pre-tenant
 *   device lookup, as in CashierAdmissionsModule).
 */
import { Module } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Logger } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../auth/auth.module";
import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { createApiLogger } from "../common/api-logger";
import { DeviceRepository } from "../pos-operators/device.repository";
import { ApproverEligibilityRepository } from "./approver-eligibility";
import { ApproverEligibilityService } from "./approver-eligibility.service";
import { PosApproversController } from "./pos-approvers.controller";

export const POS_APPROVERS_LOGGER = "POS_APPROVERS_LOGGER";

@Module({
  imports: [AuthModule],
  controllers: [PosApproversController],
  providers: [
    {
      provide: POS_APPROVERS_LOGGER,
      useFactory: (): Logger => createApiLogger("pos-approvers"),
    },
    {
      provide: DeviceRepository,
      useFactory: (lookupPool: Pool, domainPool: Pool): DeviceRepository =>
        new DeviceRepository(lookupPool, domainPool),
      inject: [AUTH_LOOKUP_POOL, PG_POOL],
    },
    PosDeviceAuthGuard,
    {
      provide: ApproverEligibilityService,
      useFactory: (pool: Pool, logger: Logger): ApproverEligibilityService =>
        new ApproverEligibilityService({
          tx: (tenantId, work) => runWithTenantContext(pool, { tenantId, isPlatformAdmin: false }, work),
          reader: new ApproverEligibilityRepository(),
          logger,
        }),
      inject: [PG_POOL, POS_APPROVERS_LOGGER],
    },
  ],
})
export class PosApproversModule {}
