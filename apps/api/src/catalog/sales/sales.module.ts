/**
 * SalesModule — 008-SETUP (T002 skeleton).
 *
 * Scaffolds the new sale-fact surface that 008 introduces (the first sale
 * fact the SaaS owns: `sales` + `sale_lines` + void/refund terminal events).
 * This slice creates an EMPTY module only — no controller, no service, no
 * routes. Subsequent slices fill it in incrementally:
 *   - 008-CONTRACT  ([GATED]) — the OpenAPI sale contract.
 *   - 008-SCHEMA    ([GATED]) — the 0012_sales migration + Drizzle schema.
 *   - 008-US1-CAPTURE 🎯 MVP  — adds sales.controller.ts + sales.service.ts
 *                               and the first POS capture route.
 *
 * 008-US1-CAPTURE wires the first route surface (captureSale + readSale) and
 * registers this module in `apps/api/src/app.module.ts` (the root-wiring step
 * SETUP deferred to "the slice that adds a real route surface").
 *
 * Imports (mirror UnknownItemsModule):
 *   - AuthModule        — provides PG_POOL (shared pool) + PosOperatorAuthGuard.
 *   - IdempotencyModule — registers the global IdempotencyInterceptor that the
 *                         `@Idempotent("required")` decorator on captureSale
 *                         engages (FR-051).
 *   - AuditModule       — registers the global AuditEmitterInterceptor that the
 *                         `@Auditable("sale.captured")` decorator triggers.
 *   - ContextModule     — provides TenantContextGuard.
 */
import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import { AuditModule } from "../../audit/audit.module";
import { AUTH_LOOKUP_POOL, AuthModule, PG_POOL } from "../../auth/auth.module";
import { ContextModule } from "../../context/context.module";
import { IdempotencyModule } from "../../idempotency/idempotency.module";
import { SalesController } from "./sales.controller";
import { SalesService } from "./sales.service";
import { DeviceRepository } from "../../pos-operators/device.repository";
import {
  OPERATOR_CONTEXT_RESOLVER,
  PgOperatorContextResolver,
} from "../../auth/operator-context-resolver";
import {
  IDENTITY_PROVIDER_PORT,
  type IdentityProviderPort,
} from "../../auth/identity-provider.port";
import { clerkIdentityProviderFactory } from "../../auth/clerk-identity-provider.adapter";
import { PosOperatorEnvelopeSaleGuard } from "../../auth/pos-operator-envelope-sale.guard";
import { PosWriteRateLimitGuard } from "../../auth/pos-write-rate-limit.guard";
import { SessionRepository } from "../../auth/session.repository";
import { AuthTokenRepository } from "../../auth/auth-token.repository";

/**
 * 008 Option Y wiring, 029 D3 re-pointed: the sale routes authenticate via a
 * provider token + device attestation through PosOperatorSaleAuthGuard →
 * PgOperatorContextResolver, which now verifies the token via the
 * provider-neutral IdentityProviderPort (v1 Clerk adapter, constructed against
 * the shared PG_POOL; `@clerk/backend` stays contained behind the adapter) and
 * resolves the operator via the external_identity_links join. The guard
 * publishes req.context, so TenantContextGuard is not needed on the write routes.
 */
@Module({
  imports: [AuthModule, IdempotencyModule, AuditModule, ContextModule],
  controllers: [SalesController],
  providers: [
    SalesService,
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
    // 031 (D1+D2, Option B): the sale-write routes are guarded by
    // PosOperatorEnvelopeSaleGuard — canonical envelope auth (bearer →
    // pos_operator principal) PLUS live per-request re-verification of
    // membership/device/store-access (G-4). The reverifier is the same
    // PgOperatorContextResolver registered above (it implements both
    // OperatorContextResolver and OperatorReverifier). Option-Y's
    // PosOperatorSaleAuthGuard is retired (no parallel path).
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
    // ADR 0009 (audit M-2): per-device write rate limit, layered AFTER the
    // envelope guard. A class-referenced @UseGuards enhancer is reflection-
    // instantiated, so it must use plain reflectable DI (no factory): RateLimiter
    // resolves by type (exported from AuthModule), OPERATOR_CONTEXT_RESOLVER and
    // @Optional ROOT_LOGGER by token, Reflector is built-in. Per-route bucket
    // comes from the @PosWriteRateLimitBucket route decorator, not construction.
    PosWriteRateLimitGuard,
  ],
  exports: [SalesService],
})
export class SalesModule {}
