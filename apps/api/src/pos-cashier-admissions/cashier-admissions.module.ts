/**
 * CashierAdmissionsModule — RT-113 BC2 (`[GATED]` approval: RT-113 comment
 * 10832).
 *
 * Wires:
 *
 *   CashierAdmissionsController   (@DeviceBearer + PosDeviceAuthGuard)
 *     └─ CashierAdmissionsService
 *          ├─ tx            runWithTenantContext on PG_POOL (the NOBYPASSRLS
 *          │                domain pool): every admission, eligibility,
 *          │                roster and audit statement runs under RLS
 *          ├─ admissions    CashierAdmissionsRepository (0035 tables)
 *          ├─ eligibility   CashierEligibilityRepository
 *          ├─ takeoverLimit TakeoverRateLimit over the shared RateLimiter
 *          ├─ audit         AdmissionAuditRepository (in-transaction)
 *          └─ policy        readCashierAdmissionPolicy (env, per request)
 *
 *   PosDeviceAuthGuard ← DeviceRepository on AUTH_LOOKUP_POOL (the pre-tenant
 *   device lookup, as in ReadDownModule).
 *
 * AuthModule supplies PG_POOL, AUTH_LOOKUP_POOL and RateLimiter. The existing
 * `/api/pos/v1/operators/*` routes and their module are untouched.
 */
import { Module } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { createLogger, type Logger } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../auth/auth.module";
import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { RateLimiter } from "../auth/rate-limit";
import { DeviceRepository } from "../pos-operators/device.repository";
import { AdmissionAuditRepository } from "./cashier-admissions.audit";
import { readCashierAdmissionPolicy } from "./cashier-admissions.config";
import { CashierAdmissionsController } from "./cashier-admissions.controller";
import { CashierAdmissionsRepository } from "./cashier-admissions.repository";
import { CashierAdmissionsService, type TenantTransaction } from "./cashier-admissions.service";
import { CashierEligibilityRepository } from "./cashier-eligibility";
import { TakeoverRateLimit } from "./takeover-rate-limit";

export const CASHIER_ADMISSIONS_LOGGER = "CASHIER_ADMISSIONS_LOGGER";

function tenantTransaction(pool: Pool): TenantTransaction {
  return <T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> =>
    runWithTenantContext(pool, { tenantId, isPlatformAdmin: false }, work);
}

@Module({
  imports: [AuthModule],
  controllers: [CashierAdmissionsController],
  providers: [
    {
      provide: CASHIER_ADMISSIONS_LOGGER,
      useFactory: (): Logger =>
        createLogger({
          service: "api.pos-cashier-admissions",
          level: process.env["LOG_LEVEL"] ?? "info",
        }),
    },
    {
      provide: DeviceRepository,
      useFactory: (pool: Pool): DeviceRepository => new DeviceRepository(pool),
      inject: [AUTH_LOOKUP_POOL],
    },
    PosDeviceAuthGuard,
    {
      provide: CashierAdmissionsService,
      useFactory: (pool: Pool, limiter: RateLimiter, logger: Logger): CashierAdmissionsService =>
        new CashierAdmissionsService({
          tx: tenantTransaction(pool),
          admissions: new CashierAdmissionsRepository(),
          eligibility: new CashierEligibilityRepository(),
          takeoverLimit: new TakeoverRateLimit(limiter, logger),
          audit: new AdmissionAuditRepository(),
          logger,
          policy: () => readCashierAdmissionPolicy(),
        }),
      inject: [PG_POOL, RateLimiter, CASHIER_ADMISSIONS_LOGGER],
    },
  ],
})
export class CashierAdmissionsModule {}
