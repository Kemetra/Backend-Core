/**
 * ErpnextBinViewModule — 019-T040.
 *
 * Wires the DP2 side of the shipped 019 stock-view contract
 * (`packages/contracts/openapi/erpnext-connector/stock-view.yaml`): DP2 EXPOSES
 * the cursor feed of wanted Bin-view reads (`binViewPullRequests`) and ingests the
 * connector's point-in-time Bin snapshot (`binViewReportSnapshot`). The connector
 * (separate repo, ADR 0008) is the only ERPNext-calling component; DP2 makes NO
 * outbound HTTP (§IX).
 *
 * Auth is the **machine** `connectorBearer` scheme (opaque-revocable, tenant-scoped)
 * via `ConnectorAuthGuard` — NOT the human `cookieAuth` and NOT the POS operator-identity scheme.
 * Mirrors `ErpnextPostingModule` (015): imports `AuthModule` (PG_POOL + the base
 * guard the connector guard extends), `AuditModule` (the `@Auditable` interceptor),
 * `ContextModule` (`TenantContextGuard`).
 *
 * 019 adds NO new table and NO migration (FR-009 — no standing Bin mirror): the
 * reported snapshot is recorded run-scoped in `erpnext_reconciliation_run.summary`.
 * The 017-rewire that consumes it (replacing EMPTY_BIN_VIEW) is the separate T041
 * slice.
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { AuthModule } from "../../auth/auth.module";
import { ContextModule } from "../../context/context.module";
import { ErpnextBinViewController } from "./erpnext-bin-view.controller";
import { ErpnextBinViewService } from "./erpnext-bin-view.service";

@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [ErpnextBinViewController],
  providers: [ErpnextBinViewService],
  exports: [ErpnextBinViewService],
})
export class ErpnextBinViewModule {}
