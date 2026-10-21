/**
 * SaleSyncOpsModule — 032 §9 Console sale-sync read/repair surface.
 *
 * The server-authoritative sale-sync READ + server-mediated REPAIR surface the
 * later Retail Tower Console consumes
 * (packages/contracts/openapi/sale-sync-ops/sale-sync-ops.yaml). Reads the 0012
 * `sales.sync_status` + the 0025 `sale_sync_deadletters` quarantine in place,
 * tenant-scoped under RLS (fail-closed). The ONLY write is the server-mediated
 * repair — audited, Idempotency-Key-required, no sale-fact rewrite, no
 * POS-local override (DP3 / §13 item 3).
 *
 * Authentication is the HUMAN `cookieAuth` / `DashboardAuthGuard` scheme (the
 * 025 console convention) — NOT the POS operator-identity device scheme, NOT a machine
 * bearer. `RolesGuard` + `@Roles` gate the surface (default deny).
 *
 * Imports:
 *   - `AuthModule`        — provides `PG_POOL` + the human `DashboardAuthGuard`.
 *   - `ContextModule`     — `TenantContextGuard` (publishes `request.context`).
 *   - `AuditModule`       — the global `AuditEmitterInterceptor` the `@Auditable`
 *                           decorators trigger.
 *   - `IdempotencyModule` — registers the IdempotencyInterceptor the repair
 *                           route's `@Idempotent("required")` engages (the
 *                           SalesModule precedent for the write path).
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { AuthModule } from "../../auth/auth.module";
import { ContextModule } from "../../context/context.module";
import { IdempotencyModule } from "../../idempotency/idempotency.module";
import { SaleSyncOpsController } from "./sale-sync-ops.controller";
import { SaleSyncOpsReadModelService } from "./sale-sync-ops.read-model.service";

@Module({
  imports: [AuthModule, AuditModule, ContextModule, IdempotencyModule],
  controllers: [SaleSyncOpsController],
  providers: [SaleSyncOpsReadModelService],
  exports: [SaleSyncOpsReadModelService],
})
export class SaleSyncOpsModule {}
