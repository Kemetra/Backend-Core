/**
 * DeviceHealthModule: RT-327 (AD-DEVICE-001; `pos-device-health.openapi.yaml`).
 *
 * Three controllers, three principals, one read-model:
 *
 *   DeviceHeartbeatController      (@DeviceBearer + PosDeviceAuthGuard)
 *     └─ DeviceHeartbeatService    store + reply, under the device's tenant context
 *   DeviceHealthController         (SessionOnlyAdminGuard → TenantContextGuard → RolesGuard)
 *     └─ DeviceHealthService       the tenant's devices joined with their health + policy
 *   PosVersionPolicyController     (SessionOnlyAdminGuard → PlatformAdminGuard)
 *     └─ PosVersionPolicyService   the global per-channel policy, audited change
 *
 * Imports:
 *   - `AuthModule`    — `PG_POOL`, `AUTH_LOOKUP_POOL` and the session guards.
 *   - `ContextModule` — `TenantContextGuard` and `MembershipRepository` (the
 *                       caller's role → store scope; `PlatformAdminGuard`'s
 *                       `isPlatformAdmin` read).
 *
 * `PosDeviceAuthGuard` ← `DeviceRepository` on `AUTH_LOOKUP_POOL` (the
 * pre-tenant device lookup), as in `PosApproversModule`. No `AuditModule`:
 * the heartbeat and the reads write no audit row, and the policy change
 * writes its own row in its transaction.
 */
import { Module } from "@nestjs/common";
import type { Logger } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import { PlatformAdminGuard } from "../audit/platform-admin.guard";
import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../auth/auth.module";
import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { createApiLogger } from "../common/api-logger";
import { ContextModule } from "../context/context.module";
import { DeviceRepository } from "../pos-operators/device.repository";
import { DeviceHealthController } from "./device-health.controller";
import { DeviceHealthService } from "./device-health.service";
import { DeviceHeartbeatController } from "./heartbeat.controller";
import { DEVICE_HEALTH_LOGGER, DeviceHeartbeatService } from "./heartbeat.service";
import { PosVersionPolicyController } from "./version-policy.controller";
import { PosVersionPolicyService } from "./version-policy.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [DeviceHeartbeatController, DeviceHealthController, PosVersionPolicyController],
  providers: [
    {
      provide: DEVICE_HEALTH_LOGGER,
      useFactory: (): Logger => createApiLogger("device-health"),
    },
    {
      provide: DeviceRepository,
      useFactory: (lookupPool: Pool, domainPool: Pool): DeviceRepository => new DeviceRepository(lookupPool, domainPool),
      inject: [AUTH_LOOKUP_POOL, PG_POOL],
    },
    PosDeviceAuthGuard,
    PlatformAdminGuard,
    DeviceHeartbeatService,
    DeviceHealthService,
    PosVersionPolicyService,
  ],
})
export class DeviceHealthModule {}
