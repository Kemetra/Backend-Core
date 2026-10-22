/**
 * AiEntitlementsModule — RT-664 (RT-644 ENT-BC3, AD-AI-ENT-001 D-2): the
 * Backend-Core `ai-entitlements` authority on the 0055 storage (RT-663).
 *
 *   - `AiEntitlementsController` — the RT-662 Console read and owner opt-out.
 *   - `AiEntitlementChecker`     — the internal `check` (layers 1, 4, 6, 7)
 *                                  and the reservation's commit / release.
 *   - `AiEntitlementGrants`      — platform-admin revisions and dispute
 *                                  adjustments (service API; no route yet).
 *   - `AiGatewayEntitlementPort` — the checker bound to the AI gateway's
 *                                  entitlement port (replaces the RT-655
 *                                  deny-all stub in `AiModule`).
 *
 * Imports `AuthModule` (`PG_POOL`, the session guard's repositories) and
 * `ContextModule` (`TenantContextGuard`, `MembershipRepository`).
 */
import { Module } from "@nestjs/common";
import type { Pool } from "pg";

import type { Logger } from "@data-pulse-2/shared";

import { AuthModule, PG_POOL } from "../auth/auth.module";
import { ROOT_LOGGER } from "../common/logging.interceptor";
import { ContextModule } from "../context/context.module";
import { readAiGatewayRuntime } from "../ai/gateway/ai-gateway.runtime";
import { AiEntitlementsController } from "./ai-entitlements.controller";
import { AiEntitlementsService } from "./ai-entitlements.service";
import { AI_ENTITLEMENTS_RUNTIME, resolveAiReservationTtlSeconds } from "./ai-entitlements.tokens";
import { AiEntitlementChecker } from "./entitlement-checker";
import { unavailableLogger } from "./unavailable-log";
import { AiEntitlementGrants } from "./entitlement-grants";
import { AiGatewayEntitlementPort } from "./gateway-entitlement.port";
import { AiOwnerMembershipGuard } from "./owner-membership.guard";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [AiEntitlementsController],
  providers: [
    AiEntitlementsService,
    AiEntitlementGrants,
    AiOwnerMembershipGuard,
    { provide: AI_ENTITLEMENTS_RUNTIME, useFactory: () => readAiGatewayRuntime() },
    {
      provide: AiEntitlementChecker,
      useFactory: (pool: Pool, logger?: Pick<Logger, "warn">): AiEntitlementChecker =>
        new AiEntitlementChecker(pool, {
          reservationTtlSeconds: resolveAiReservationTtlSeconds(),
          onUnavailable: unavailableLogger(logger, "check"),
        }),
      inject: [PG_POOL, { token: ROOT_LOGGER, optional: true }],
    },
    AiGatewayEntitlementPort,
  ],
  exports: [AiEntitlementChecker, AiEntitlementGrants, AiGatewayEntitlementPort],
})
export class AiEntitlementsModule {}
