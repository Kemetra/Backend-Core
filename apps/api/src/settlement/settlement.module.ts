/**
 * SettlementModule — 035 T030.
 *
 * The sale-settlement & receivables surface (settlement.yaml). This slice wires
 * three routes (POS settlement-intent capture + Console receivable read/list)
 * over the merged 0027 schema. Later slices (T031 cash-application, T032
 * claims/remittance) extend this module.
 *
 * Imports:
 *   - `AuthModule`        — provides `PG_POOL` + the human `DashboardAuthGuard`
 *                           and the auth repos the envelope guard composes.
 *   - `ContextModule`     — `TenantContextGuard` (publishes `request.context`
 *                           on the Console routes).
 *   - `AuditModule`       — the global `AuditEmitterInterceptor` the `@Auditable`
 *                           decorators trigger.
 *   - `IdempotencyModule` — the global IdempotencyInterceptor the POS intent
 *                           route's `@Idempotent("required")` engages (FR-020).
 *
 * POS guard wiring (031 D1+D2, mirrors SalesModule): the settlement-intent route
 * is guarded by `PosOperatorEnvelopeSaleGuard` — canonical envelope bearer auth
 * PLUS live per-request operator re-verification (G-4). The reverifier is the
 * shared `PgOperatorContextResolver` (it implements both OperatorContextResolver
 * and OperatorReverifier), constructed against the shared PG_POOL with the v1
 * Clerk identity adapter behind `IdentityProviderPort`.
 */
import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import { AuditModule } from "../audit/audit.module";
import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../auth/auth.module";
import { AuthTokenRepository } from "../auth/auth-token.repository";
import { clerkIdentityProviderFactory } from "../auth/clerk-identity-provider.adapter";
import {
  IDENTITY_PROVIDER_PORT,
  type IdentityProviderPort,
} from "../auth/identity-provider.port";
import {
  OPERATOR_CONTEXT_RESOLVER,
  PgOperatorContextResolver,
} from "../auth/operator-context-resolver";
import { PosOperatorEnvelopeSaleGuard } from "../auth/pos-operator-envelope-sale.guard";
import { PosWriteRateLimitGuard } from "../auth/pos-write-rate-limit.guard";
import { SessionRepository } from "../auth/session.repository";
import { ContextModule } from "../context/context.module";
import { IdempotencyModule } from "../idempotency/idempotency.module";
import { DeviceRepository } from "../pos-operators/device.repository";
import { ClaimService } from "./claim.service";
import { ReceivableService } from "./receivable.service";
import { SettlementController } from "./settlement.controller";

@Module({
  imports: [AuthModule, ContextModule, AuditModule, IdempotencyModule],
  controllers: [SettlementController],
  providers: [
    ReceivableService,
    ClaimService,
    {
      provide: IDENTITY_PROVIDER_PORT,
      useFactory: (pool: Pool): IdentityProviderPort =>
        clerkIdentityProviderFactory(pool),
      inject: [AUTH_LOOKUP_POOL],
    },
    {
      provide: DeviceRepository,
      useFactory: (pool: Pool): DeviceRepository => new DeviceRepository(pool),
      inject: [AUTH_LOOKUP_POOL],
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
      ): PosOperatorEnvelopeSaleGuard =>
        new PosOperatorEnvelopeSaleGuard(sessions, authTokens, reverifier),
      inject: [SessionRepository, AuthTokenRepository, OPERATOR_CONTEXT_RESOLVER],
    },
    // ADR 0009 (audit M-2): per-device write rate limit on settlement-intent.
    // Plain reflectable DI (reflection-instantiated enhancer); per-route bucket
    // (posWriteSettlementIntent) comes from the @PosWriteRateLimitBucket decorator.
    PosWriteRateLimitGuard,
  ],
  exports: [ReceivableService],
})
export class SettlementModule {}
