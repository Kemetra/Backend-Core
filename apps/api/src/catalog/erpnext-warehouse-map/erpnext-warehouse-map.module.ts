/**
 * ErpnextWarehouseMapModule — 014-SETUP (T003) scaffold + 014-CRUD wiring.
 *
 * Wires the tenant-admin store↔ERPNext-Warehouse mapping set/list/retire surface
 * (014 branch-inventory-reconciliation-and-warehouse-mapping). It links a DP2
 * `stores` row to an ERPNext **Warehouse** reference (`erpnext_warehouse_map`,
 * migration 0018) so ERPNext can VALUE the same physical stock the store holds —
 * a MAPPING / RECONCILIATION layer, NOT a stock-authority handover (OQ-1, §IX,
 * the SIGNED stock-impact decision). NO Bin mirror; the reconciliation RUN is
 * 017.
 *
 * Authentication is the HUMAN Tenant-Admin cookie session
 * (`packages/contracts/openapi/catalog/erpnext-warehouse-map.yaml` →
 * `cookieAuth`, the httpOnly `dp2_session`), resolved by `DashboardAuthGuard` —
 * NOT the 012 `connectorBearer` machine scheme and NOT the POS operator-identity device
 * scheme.
 *
 * Imports mirror `erpnext-item-map.module.ts` (the proven 013 sibling):
 *   - `AuthModule`    — provides `PG_POOL` + `DashboardAuthGuard`.
 *   - `AuditModule`   — the global `AuditEmitterInterceptor` the
 *                       `@Auditable(...)` route decorators trigger.
 *   - `ContextModule` — `TenantContextGuard` (publishes `request.context`) and
 *                       the `MembershipRepository` that `RolesGuard` needs.
 *
 * 014 adds NO worker and NO outbox event (the §8 carve): set/retire are
 * synchronous human actions; the reconciliation run belongs to 017.
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { AuthModule } from "../../auth/auth.module";
import { RolesGuard } from "../../auth/roles.guard";
import { ContextModule } from "../../context/context.module";
import { ErpnextWarehouseMapController } from "./erpnext-warehouse-map.controller";
import { ErpnextWarehouseMapService } from "./erpnext-warehouse-map.service";

/**
 * Wires the tenant-admin ERPNext Warehouse-mapping set/list/retire surface.
 * `RolesGuard` is a plain class provider (Reflector auto-provided by
 * @nestjs/core; MembershipRepository reachable via ContextModule) — mirrors
 * erpnext-item-map.module.ts.
 */
@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [ErpnextWarehouseMapController],
  providers: [ErpnextWarehouseMapService, RolesGuard],
  exports: [ErpnextWarehouseMapService],
})
export class ErpnextWarehouseMapModule {}
