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
import type { Logger } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import { AuditModule } from "../audit/audit.module";
import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../auth/auth.module";
import { AuthTokenRepository } from "../auth/auth-token.repository";
import { identityProviderFactory, operatorTokenVerifierFactory } from "../auth/identity-provider.factory";
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
import { createApiLogger } from "../common/api-logger";
import { IdempotencyModule } from "../idempotency/idempotency.module";
import { OPERATOR_TOKEN_VERIFIER, type OperatorTokenVerifier } from "../auth/operator-token-verifier";
import { CashierEligibilityRepository } from "../pos-cashier-admissions/cashier-eligibility";
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
      provide: OPERATOR_TOKEN_VERIFIER,
      useFactory: operatorTokenVerifierFactory,
    },
    {
      provide: POS_SHIFTS_LOGGER,
      useFactory: (): Logger =>
        createApiLogger("pos-shifts"),
    },
    {
      provide: PosShiftsService,
      useFactory: (
        pool: Pool,
        verifier: OperatorTokenVerifier,
        logger: Logger,
        lookupPool: Pool,
      ): PosShiftsService => new PosShiftsService(pool, verifier, logger, undefined, lookupPool),
      inject: [PG_POOL, OPERATOR_TOKEN_VERIFIER, POS_SHIFTS_LOGGER, AUTH_LOOKUP_POOL],
    },
    // RT-17 slice 2b: the cash-up writes. The logger receives the close
    // approver warning (RT-17 comment 10955, option A).
    {
      provide: ShiftCashUpService,
      useFactory: (pool: Pool, logger: Logger): ShiftCashUpService =>
        new ShiftCashUpService(pool, undefined, undefined, logger),
      inject: [PG_POOL, POS_SHIFTS_LOGGER],
    },
    {
      provide: IDENTITY_PROVIDER_PORT,
      useFactory: (pool: Pool): IdentityProviderPort => identityProviderFactory(pool),
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
      useFactory: (pool: Pool, lookupPool: Pool): OperatorAttributionVerifier =>
        new PgOperatorAttributionVerifier(pool, new CashierEligibilityRepository(lookupPool)),
      inject: [PG_POOL, AUTH_LOOKUP_POOL],
    },
    // Class-referenced in @UseGuards, so reflection-instantiated from the
    // tokens above (no factory), like PosWriteRateLimitGuard (ADR 0009).
    ShiftCashUpAuthGuard,
    PosWriteRateLimitGuard,
  ],
})
export class PosShiftsModule {}
