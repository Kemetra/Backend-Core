/**
 * PosShiftsModule — POS shift lifecycle.
 *
 *   - `GET /api/pos/v1/shifts/stuck` (PosShiftsController, operator-identity).
 *   - RT-17 slices 2b-1 / 2b-2: the cash-up writes `openShift`,
 *     `recordCashMovement` and `closeShift` (ShiftCashUpController), with the
 *     captureSale credential model (RT-224): the operator envelope OR the
 *     device bearer plus a verified `operatorUserId`.
 *
 * Cash-up guard wiring mirrors SalesModule / SettlementModule: the envelope
 * path is PosOperatorEnvelopeSaleGuard (live operator re-check through the
 * shared PgOperatorContextResolver), the device path PosDeviceAuthGuard
 * (DeviceRepository on AUTH_LOOKUP_POOL) plus PgOperatorAttributionVerifier
 * on PG_POOL under the device's tenant. Imports IdempotencyModule and
 * AuditModule for the global interceptors that `@Idempotent` / `@Auditable`
 * engage.
 */
import { Module } from "@nestjs/common";
import { createLogger, type Logger } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import { AuditModule } from "../audit/audit.module";
import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../auth/auth.module";
import { AuthTokenRepository } from "../auth/auth-token.repository";
import { clerkIdentityProviderFactory } from "../auth/clerk-identity-provider.adapter";
import { IDENTITY_PROVIDER_PORT, type IdentityProviderPort } from "../auth/identity-provider.port";
import { OPERATOR_CONTEXT_RESOLVER, PgOperatorContextResolver } from "../auth/operator-context-resolver";
import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { PosOperatorEnvelopeSaleGuard } from "../auth/pos-operator-envelope-sale.guard";
import { PosWriteRateLimitGuard } from "../auth/pos-write-rate-limit.guard";
import { SessionRepository } from "../auth/session.repository";
import {
  OPERATOR_ATTRIBUTION_VERIFIER,
  PgOperatorAttributionVerifier,
  type OperatorAttributionVerifier,
} from "../catalog/sales/operator-attribution";
import { IdempotencyModule } from "../idempotency/idempotency.module";
import {
  CLERK_VERIFIER,
  type ClerkVerifier,
  clerkVerifierFactory,
} from "../pos-operators/clerk-verifier";
import { DeviceRepository } from "../pos-operators/device.repository";
import { PosShiftsController } from "./pos-shifts.controller";
import { PosShiftsService } from "./pos-shifts.service";
import { ShiftCashUpAuthGuard } from "./shift-cash-up-auth.guard";
import { ShiftCashUpController } from "./shift-cash-up.controller";
import { ShiftCashUpService } from "./shift-cash-up.service";

export const POS_SHIFTS_LOGGER = "POS_SHIFTS_LOGGER";

@Module({
  imports: [AuthModule, IdempotencyModule, AuditModule],
  controllers: [PosShiftsController, ShiftCashUpController],
  providers: [
    {
      provide: CLERK_VERIFIER,
      useFactory: clerkVerifierFactory,
    },
    {
      provide: POS_SHIFTS_LOGGER,
      useFactory: (): Logger =>
        createLogger({
          service: "api.pos-shifts",
          level: process.env["LOG_LEVEL"] ?? "info",
        }),
    },
    {
      provide: PosShiftsService,
      useFactory: (pool: Pool, verifier: ClerkVerifier, logger: Logger): PosShiftsService =>
        new PosShiftsService(pool, verifier, logger),
      inject: [PG_POOL, CLERK_VERIFIER, POS_SHIFTS_LOGGER],
    },
    // RT-17 slice 2b: the cash-up writes.
    {
      provide: ShiftCashUpService,
      useFactory: (pool: Pool): ShiftCashUpService => new ShiftCashUpService(pool),
      inject: [PG_POOL],
    },
    {
      provide: IDENTITY_PROVIDER_PORT,
      useFactory: (pool: Pool): IdentityProviderPort => clerkIdentityProviderFactory(pool),
      inject: [AUTH_LOOKUP_POOL],
    },
    {
      provide: DeviceRepository,
      useFactory: (lookupPool: Pool, domainPool: Pool): DeviceRepository =>
        new DeviceRepository(lookupPool, domainPool),
      inject: [AUTH_LOOKUP_POOL, PG_POOL],
    },
    {
      provide: OPERATOR_CONTEXT_RESOLVER,
      useFactory: (
        pool: Pool,
        identityProvider: IdentityProviderPort,
        devices: DeviceRepository,
        lookupPool: Pool,
      ): PgOperatorContextResolver =>
        new PgOperatorContextResolver(pool, identityProvider, devices, undefined, lookupPool),
      inject: [PG_POOL, IDENTITY_PROVIDER_PORT, DeviceRepository, AUTH_LOOKUP_POOL],
    },
    {
      provide: PosOperatorEnvelopeSaleGuard,
      useFactory: (
        sessions: SessionRepository,
        authTokens: AuthTokenRepository,
        reverifier: PgOperatorContextResolver,
      ): PosOperatorEnvelopeSaleGuard => new PosOperatorEnvelopeSaleGuard(sessions, authTokens, reverifier),
      inject: [SessionRepository, AuthTokenRepository, OPERATOR_CONTEXT_RESOLVER],
    },
    PosDeviceAuthGuard,
    {
      provide: OPERATOR_ATTRIBUTION_VERIFIER,
      useFactory: (pool: Pool): OperatorAttributionVerifier => new PgOperatorAttributionVerifier(pool),
      inject: [PG_POOL],
    },
    // Class-referenced in @UseGuards, so reflection-instantiated from the
    // tokens above (no factory), like PosWriteRateLimitGuard (ADR 0009).
    ShiftCashUpAuthGuard,
    PosWriteRateLimitGuard,
  ],
})
export class PosShiftsModule {}
