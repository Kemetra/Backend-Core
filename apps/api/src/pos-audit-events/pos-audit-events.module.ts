/**
 * PosAuditEventsModule — Wave 2 audit-event sync surface.
 *
 * Wires:
 *
 *   PosAuditEventsController
 *     └─ PosAuditEventsService
 *          ├─ Pool            (PG_POOL — shared with AuthModule)
 *          ├─ DeviceRepository
 *          └─ Logger          (ROOT_LOGGER — shared with the rest of api)
 *
 * The ClerkVerifier is injected into the controller (not the service)
 * because JWT verification is optional here and is a presentation-layer
 * concern: the controller verifies when the header is present and proceeds
 * without it when absent.
 *
 * AuthModule is imported so PG_POOL and ROOT_LOGGER are reused.
 */
import { Module } from "@nestjs/common";
import { createLogger, type Logger } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../auth/auth.module";
import {
  CLERK_VERIFIER,
  clerkVerifierFactory,
} from "../pos-operators/clerk-verifier";
import { DeviceRepository } from "../pos-operators/device.repository";
import { PosAuditEventsController } from "./pos-audit-events.controller";
import { PosAuditEventsService } from "./pos-audit-events.service";

export const POS_AUDIT_EVENTS_LOGGER = "POS_AUDIT_EVENTS_LOGGER";

@Module({
  imports: [AuthModule],
  controllers: [PosAuditEventsController],
  providers: [
    {
      provide: CLERK_VERIFIER,
      useFactory: clerkVerifierFactory,
    },
    {
      provide: POS_AUDIT_EVENTS_LOGGER,
      useFactory: (): Logger =>
        createLogger({
          service: "api.pos-audit-events",
          level: process.env["LOG_LEVEL"] ?? "info",
        }),
    },
    {
      provide: DeviceRepository,
      useFactory: (pool: Pool): DeviceRepository => new DeviceRepository(pool),
      inject: [AUTH_LOOKUP_POOL],
    },
    {
      provide: PosAuditEventsService,
      useFactory: (
        pool: Pool,
        devices: DeviceRepository,
        logger: Logger,
      ): PosAuditEventsService => new PosAuditEventsService(pool, devices, logger),
      inject: [PG_POOL, DeviceRepository, POS_AUDIT_EVENTS_LOGGER],
    },
  ],
})
export class PosAuditEventsModule {}
