/**
 * ErpnextReconciliationModule — 017-SETUP (T004) scaffold.
 *
 * Wires the ERPNext arc's **operational reconciliation surface** (011→017):
 * run → report → repair. It is the home the 015 `015-DLQ-DRAIN` traceability stub
 * and the 014 §8 carve pointed to — it makes the 015 posting dead-letter backlog
 * VISIBLE (US1), exposes an IDEMPOTENT repair that re-uses the 015 O-3 state
 * machine (re-head a `permanently_rejected` row to `pending`; the connector
 * re-posts via the EXISTING 012 feed/ack — never a 2nd document_ref, never a
 * silent rewrite) (US2), and runs STOCK reconciliation comparing DP2 on-hand
 * (009) against the connector's ERPNext-Bin view per the 014 mapping, persisting
 * mismatch reports in 014's vocabulary (US3).
 *
 * Authentication is the **human** `cookieAuth` / `DashboardAuthGuard` scheme
 * (the 007/013/014 dashboard convention) — NOT the machine `connectorBearer`
 * (015) and NOT the POS `clerkJwt` device scheme (010). 017 is human-operator-only
 * in v1 (FR-018): the connector never calls 017; a posting repair simply re-makes
 * a 015 work-item eligible and the connector re-posts via the existing feed/ack.
 * The controller / service / projection land in 017-US1-BACKLOG; the worker
 * reconciliation-run processor lands in 017-US3-STOCK; this slice ships the empty,
 * registered module (no routes yet) so the DI graph + build stay green.
 *
 * Imports mirror the tenant-scoped catalog siblings:
 *   - `AuthModule`    — provides `PG_POOL` (+ the auth primitives) and is the
 *                       module the human `DashboardAuthGuard` resolves from.
 *   - `AuditModule`   — the global `AuditEmitterInterceptor`; 017 ALSO writes a
 *                       NEW in-transaction `INSERT INTO audit_events` for run/repair
 *                       atomicity (FR-014) — NOT the async `@Auditable` path.
 *   - `ContextModule` — `TenantContextGuard` (publishes `request.context`).
 *
 * 017 adds one new `[GATED]` state table family (`erpnext_reconciliation_*`,
 * migration 0020) + one `[GATED]` operator OpenAPI (`reconciliation.yaml`); both
 * are owner-authorized and land in their own slices. NO new outbox event-type and
 * NO 012 contract change — repair re-uses the 015 state machine.
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { AuthModule } from "../../auth/auth.module";
import { RolesGuard } from "../../auth/roles.guard";
import { ContextModule } from "../../context/context.module";
import { ErpnextReconciliationController } from "./erpnext-reconciliation.controller";
import { ErpnextReconciliationService } from "./erpnext-reconciliation.service";
import { NegativeOnHandController } from "./negative-on-hand.controller";
import { ErpnextPostingReResolutionService } from "./posting-re-resolution.service";
import { NegativeOnHandService } from "./negative-on-hand.service";

/**
 * Wires the DP2-side reconciliation/repair surface. 017-US1-BACKLOG adds the
 * `listPostingBacklog` read-projection (controller + service + projection);
 * 017-US2-REPAIR + 017-US3-STOCK extend the same controller/service and add the
 * worker reconciliation-run processor. `AuthModule` provides `PG_POOL` + the
 * `DashboardAuthGuard` the human operator routes use. RT-177 adds the read-only
 * ERPNext negative on-hand view (`NegativeOnHandController` + service), computed
 * on read from the latest recorded Connector Bin snapshot per store.
 */
@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [ErpnextReconciliationController, NegativeOnHandController],
  // RolesGuard is listed explicitly (the erpnext-item-map / erpnext-warehouse-map
  // / unknown-items pattern) so both controllers' `@UseGuards(RolesGuard)`
  // resolve it from this module's own providers; its deps (MembershipRepository
  // via ContextModule, PG_POOL via AuthModule, Reflector from core) are in scope.
  providers: [
    ErpnextReconciliationService,
    ErpnextPostingReResolutionService,
    NegativeOnHandService,
    RolesGuard,
  ],
  exports: [ErpnextReconciliationService],
})
export class ErpnextReconciliationModule {}
