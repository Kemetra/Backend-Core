/**
 * DeviceRotationModule — RT-369: the device token rotation
 * (`posRotateTerminalToken`). Separate from PairingModule, whose controller is
 * `@Public()`: this route is device-authenticated.
 *
 * Imports `AuthModule` for `PG_POOL` (the rotation writes, on the domain pool
 * under the device's tenant) and `AUTH_LOOKUP_POOL` (the guard's lookup, as
 * every device route). No grant change: the domain role already holds
 * SELECT / UPDATE on `devices` and INSERT on `audit_events`
 * (`DOMAIN_REQUIRED_GRANTS`); the lookup role keeps SELECT only.
 */
import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../auth/auth.module";
import { DeviceRepository } from "../pos-operators/device.repository";
import { DeviceRotationAuthGuard } from "./device-rotation-auth.guard";
import { RotationController } from "./rotation.controller";
import { RotationService } from "./rotation.service";

@Module({
  imports: [AuthModule],
  controllers: [RotationController],
  providers: [
    RotationService,
    {
      provide: DeviceRepository,
      useFactory: (lookupPool: Pool, domainPool: Pool): DeviceRepository => new DeviceRepository(lookupPool, domainPool),
      inject: [AUTH_LOOKUP_POOL, PG_POOL],
    },
    DeviceRotationAuthGuard,
  ],
})
export class DeviceRotationModule {}
