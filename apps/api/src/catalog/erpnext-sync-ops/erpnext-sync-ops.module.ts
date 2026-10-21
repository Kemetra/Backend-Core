/**
 * ErpnextSyncOpsModule — 025 Console Sync-Ops Read-Model.
 *
 * A **read-only consolidation** surface for the Retail Tower Console: it
 * aggregates the ERPNext sync-ops state the operator needs to see — 015
 * `erpnext_posting_status` posting health + dead-letter backlog, and 017
 * `erpnext_reconciliation_run`/`_result` reconciliation health + run history —
 * into a single console-facing read API. The 020 (connector health) and 021
 * (product-master reconciliation) domains are **present but `not_available`** in
 * v1 (forward-compat stub), until those specs ship.
 *
 * It is a **compute-on-read projection** — NO new table, NO migration, NO worker,
 * NO write/repair surface (write/repair stay in 017). It READS the 015/017 rows
 * in place (READ-NOT-MIRROR), tenant-scoped under `runWithTenantContext`
 * (RLS fail-closed).
 *
 * Authentication is the **human** `cookieAuth` / `DashboardAuthGuard` scheme (the
 * 007/013/014/017 dashboard convention) — NOT the machine `connectorBearer`
 * (012/015), NOT the `dashboard_api` bearer, NOT the POS operator-identity device scheme.
 * A machine credential MUST be rejected. `RolesGuard` + `@Roles` gate the surface
 * (default deny). The console is a sibling SPA repo (Retail-Tower-Console)
 * consuming this contract; 025 exposes only reads.
 *
 * Imports mirror the tenant-scoped catalog read siblings (017):
 *   - `AuthModule`    — provides `PG_POOL` + the human `DashboardAuthGuard`.
 *   - `ContextModule` — `TenantContextGuard` (publishes `request.context`).
 *   - `AuditModule`   — the global `AuditEmitterInterceptor` (the read routes use
 *                       the async `@Auditable` path; there is NO in-transaction
 *                       write here — 025 is read-only, unlike 017's repair paths).
 *
 * The controller / read-model service / projections land in the US1/US2/US3
 * slices; this scaffold ships the registered module (no routes yet) so the DI
 * graph + build stay green.
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { AuthModule } from "../../auth/auth.module";
import { ContextModule } from "../../context/context.module";
import { ErpnextSyncOpsController } from "./erpnext-sync-ops.controller";
import { ErpnextSyncOpsReadModelService } from "./erpnext-sync-ops.read-model.service";

@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [ErpnextSyncOpsController],
  providers: [ErpnextSyncOpsReadModelService],
  exports: [ErpnextSyncOpsReadModelService],
})
export class ErpnextSyncOpsModule {}
