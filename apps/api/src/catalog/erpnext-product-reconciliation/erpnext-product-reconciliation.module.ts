/**
 * ErpnextProductReconciliationModule — 021.
 *
 * Wires the ERPNext arc's PRODUCT-MASTER reconciliation surface (run → report →
 * repair) over the 013 `erpnext_item_map` mapping — the inverse of 017's stock
 * reconciliation (021 : 013 :: 017 : 014/009). It makes the unmapped-product
 * backlog VISIBLE (US1 — a live read-projection over 003 ⟕ 013), exposes an
 * IDEMPOTENT repair that DRIVES 013's existing suggest/confirm/re-point lifecycle
 * under 013's `version` guard (US2 — 021 owns no new mapping write), and runs a
 * two-sided product-master reconciliation against the connector ERPNext-item view
 * (US3 — stub-tolerant; the live read gated on 021-ITEM-VIEW-CONTRACT).
 *
 * Authentication is the HUMAN `cookieAuth` / `DashboardAuthGuard` scheme (the
 * 007/013/014/017 dashboard convention) — NOT the machine `connectorBearer` and
 * NOT the POS operator-identity device scheme (FR-019): the connector never calls 021.
 *
 * Imports:
 *   - `AuthModule`           — provides `PG_POOL` + the `DashboardAuthGuard`.
 *   - `AuditModule`          — the global interceptor; 021 ALSO writes a NEW
 *                              in-transaction `INSERT INTO audit_events` for
 *                              run/repair atomicity (FR-015).
 *   - `ContextModule`        — `TenantContextGuard` (publishes `request.context`).
 *   - `ErpnextItemMapModule` — provides `ErpnextItemMapService`, whose
 *                              client-accepting `*OnClient` variants 021's repair
 *                              calls on its OWN transaction so the 013 transition +
 *                              the `repair_attempt` + the audit row are atomic.
 *
 * 021 adds one new `[GATED]` state table family (`erpnext_product_reconciliation_*`,
 * migration 0023) + one `[GATED]` operator OpenAPI (`product-reconciliation.yaml`)
 * + one outbox event-type (`erpnext.product_reconciliation.requested`) consumed by
 * the worker run processor; all owner-authorized.
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { AuthModule } from "../../auth/auth.module";
import { ContextModule } from "../../context/context.module";
import { ErpnextItemMapModule } from "../erpnext-item-map/erpnext-item-map.module";
import { ErpnextProductReconciliationController } from "./erpnext-product-reconciliation.controller";
import { ErpnextProductReconciliationService } from "./erpnext-product-reconciliation.service";

@Module({
  imports: [AuthModule, AuditModule, ContextModule, ErpnextItemMapModule],
  controllers: [ErpnextProductReconciliationController],
  providers: [ErpnextProductReconciliationService],
  exports: [ErpnextProductReconciliationService],
})
export class ErpnextProductReconciliationModule {}
