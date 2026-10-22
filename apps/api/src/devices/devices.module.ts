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
 *                       `pos.device.revoked` row in its transaction, as the
 *                       pairing-code issue and cancel write theirs (RT-367).
 *   - `IdempotencyModule` — the global `IdempotencyInterceptor` behind the
 *                       pairing-code issue's non-replayable `Idempotency-Key`.
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import { IdempotencyModule } from "../idempotency/idempotency.module";
import { DeviceBuildsController } from "./device-builds.controller";
import { DeviceBuildsService } from "./device-builds.service";
import { DevicesController } from "./devices.controller";
import { DevicesService } from "./devices.service";
import { PairingCodesController } from "./pairing-codes.controller";
import { PairingCodesService } from "./pairing-codes.service";

@Module({
  imports: [AuthModule, AuditModule, ContextModule, IdempotencyModule],
  controllers: [DevicesController, PairingCodesController, DeviceBuildsController],
  providers: [DevicesService, PairingCodesService, DeviceBuildsService],
})
export class DevicesModule {}
