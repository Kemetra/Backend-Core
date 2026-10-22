/**
 * InventoryModule — 009-SETUP (T002 skeleton).
 *
 * Scaffolds the Inventory source-of-truth domain that 009 introduces (an
 * append-only `stock_movements` ledger + a derived, compute-on-read on-hand
 * balance). This slice creates an EMPTY module only — no controller, no
 * service, no routes. Subsequent slices fill it in incrementally:
 *   - 009-CONTRACT  ([GATED]) — the OpenAPI inventory contract.
 *   - 009-SCHEMA    ([GATED]) — the 0014_inventory migration + Drizzle schema.
 *   - 009-US1-ONHAND 🎯 MVP   — adds inventory.controller.ts +
 *                               inventory.service.ts and the first on-hand
 *                               read + movement-list routes.
 *
 * NOTE on root wiring:
 *   Unlike the 008-SETUP precedent (which deferred app-level registration to
 *   its first route slice), 009-SETUP registers this module in
 *   `apps/api/src/app.module.ts` now. The slice's `allowed_files` includes
 *   app.module.ts by design (review finding F-01): an empty module exposes no
 *   routes, so early registration is behaviourally inert, but it means the
 *   US1 slice never has to touch the root wiring (avoiding a later
 *   allowed-files stop). The module stays bare until 009-US1-ONHAND adds the
 *   first controller + service.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { RolesGuard } from "../auth/roles.guard";
import { ContextModule } from "../context/context.module";
import { IdempotencyModule } from "../idempotency/idempotency.module";
import { InventoryController } from "./inventory.controller";
import { InventoryService } from "./inventory.service";
import { InventoryPositionEventsController } from "./position-events/position-events.controller";
import { InventoryPositionEventsService } from "./position-events/position-events.service";
import { IdentityExpiryService } from "./safety/identity-expiry.service";
import { InventoryRecallsService } from "./safety/inventory-recalls.service";
import { InventorySafetyController } from "./safety/inventory-safety.controller";
import { TrackingHoldsService } from "./safety/tracking-holds.service";
import { TrackingIdentitiesController } from "./tracking-identities.controller";

/**
 * InventoryModule — populated by 009-US1-ONHAND (T033).
 *
 * Imports (mirror ReconciliationModule):
 *   - AuthModule    — provides PG_POOL (shared pool) + DashboardAuthGuard.
 *   - ContextModule — provides TenantContextGuard (publishes request.context).
 *
 * No AuditModule yet — the US1 READ routes are not audited; the US2 write
 * routes (createStockMovement etc.) will add it. Store-scoped routes use
 * inline object-level store authz, not @Roles. RT-448: the tenant-wide
 * tracking-identity read (`TrackingIdentitiesController`) uses `RolesGuard`
 * (a plain class provider; MembershipRepository reachable via ContextModule).
 */
@Module({
  // IdempotencyModule (009-US3): registers the global IdempotencyInterceptor
  // that honors @Idempotent("required") on the createStockMovement POST route —
  // manual replay returns the same movement, a divergent body under the same
  // key 409s. Reuses the existing 001/005 primitive; no new machinery.
  imports: [AuthModule, ContextModule, IdempotencyModule],
  // RT-435: status moves, relocations and the return landing policy
  // (RolesGuard; the service reads the caller's role for sensitive moves).
  // RT-449: tracking holds, recall and identity expiry correction
  // (tenant-level, RolesGuard; each command steps the Safety Revision).
  controllers: [
    InventoryController,
    TrackingIdentitiesController,
    InventoryPositionEventsController,
    InventorySafetyController,
  ],
  providers: [
    InventoryService,
    InventoryPositionEventsService,
    TrackingHoldsService,
    InventoryRecallsService,
    IdentityExpiryService,
    RolesGuard,
  ],
  exports: [InventoryService],
})
export class InventoryModule {}
