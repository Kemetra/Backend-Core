/**
 * PosOperatorsModule — Wave 1 sign-in surface.
 *
 * Wires:
 *
 *   PosOperatorsController
 *     └─ PosOperatorsService
 *          ├─ Pool                (PG_POOL — shared with AuthModule)
 *          ├─ OperatorTokenVerifier (OPERATOR_TOKEN_VERIFIER token — env-driven factory)
 *          ├─ DeviceRepository
 *          └─ Logger              (ROOT_LOGGER — shared with the rest of api)
 *
 * AuthModule is imported solely so PG_POOL and ROOT_LOGGER are reused
 * (single connection pool / single logger). No POS-side code mutates
 * AuthModule providers; the existing argon2id / cookie auth path is
 * untouched (ADR D6, FR-POS-AUTH-9).
 *
 * Tests substitute the verifier seam via
 * `Test.createTestingModule(...).overrideProvider(OPERATOR_TOKEN_VERIFIER)` so
 * sign-in specs do not require a real provider JWKS endpoint.
 */
import { Module } from "@nestjs/common";
import type { Logger } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../auth/auth.module";

import { operatorTokenVerifierFactory } from "../auth/identity-provider.factory";
import {
  OPERATOR_TOKEN_VERIFIER,
  type OperatorTokenVerifier,
} from "../auth/operator-token-verifier";
import { createApiLogger } from "../common/api-logger";
import { DeviceRepository } from "./device.repository";
import { PosOperatorsController } from "./pos-operators.controller";
import { PosOperatorsService } from "./pos-operators.service";

export const POS_OPERATORS_LOGGER = "POS_OPERATORS_LOGGER";

@Module({
  imports: [AuthModule],
  controllers: [PosOperatorsController],
  providers: [
    {
      provide: OPERATOR_TOKEN_VERIFIER,
      useFactory: operatorTokenVerifierFactory,
    },
    {
      provide: POS_OPERATORS_LOGGER,
      useFactory: (): Logger =>
        createApiLogger("pos-operators"),
    },
    {
      provide: DeviceRepository,
      useFactory: (lookupPool: Pool, domainPool: Pool): DeviceRepository =>
        new DeviceRepository(lookupPool, domainPool),
      inject: [AUTH_LOOKUP_POOL, PG_POOL],
    },
    {
      provide: PosOperatorsService,
      useFactory: (
        pool: Pool,
        verifier: OperatorTokenVerifier,
        devices: DeviceRepository,
        logger: Logger,
        lookupPool: Pool,
      ): PosOperatorsService =>
        new PosOperatorsService(pool, verifier, devices, logger, lookupPool),
      inject: [
        PG_POOL,
        OPERATOR_TOKEN_VERIFIER,
        DeviceRepository,
        POS_OPERATORS_LOGGER,
        AUTH_LOOKUP_POOL,
      ],
    },
  ],
})
export class PosOperatorsModule {}
