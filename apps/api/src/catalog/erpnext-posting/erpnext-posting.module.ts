/**
 * ErpnextPostingModule — 015-SETUP (T004) scaffold.
 *
 * Wires the DP2 side of the **fixed 012 posting-feed contract**
 * (`packages/contracts/openapi/erpnext-connector/posting-feed.yaml`): DP2 exposes
 * the cursor feed of pending posting work-items (`connectorPullPostings`) and
 * ingests outcomes (`connectorAckOutcome`). It turns a PROCESSED 008 sale (and its
 * void/refund terminal events) into ERPNext accounting truth — a posting
 * pipeline, NOT a catalog-authority handover (§IX). DP2 makes NO outbound HTTP
 * calls; the connector (separate repo, ADR 0008) is the only ERPNext-calling
 * component.
 *
 * Authentication is the **machine** `connectorBearer` scheme (opaque-revocable,
 * tenant-scoped) per the 012 contract — NOT the human `cookieAuth`/`DashboardAuthGuard`
 * (013/014) and NOT the POS operator-identity/device scheme (010). The connector-auth
 * guard + the feed/ack routes land in 015-US1-FEED / 015-US2-ACK; this slice ships
 * the empty, registered module (no routes yet) so the DI graph + build stay green.
 *
 * Imports mirror the tenant-scoped catalog siblings:
 *   - `AuthModule`    — provides `PG_POOL` (and the auth primitives the future
 *                       connector guard will build on).
 *   - `AuditModule`   — the global `AuditEmitterInterceptor` the future
 *                       `@Auditable(...)` route decorators trigger.
 *   - `ContextModule` — `TenantContextGuard` (publishes `request.context`).
 *
 * 015 adds one new `[GATED]` state table (`erpnext_posting_status`, migration
 * 0019) and one `[GATED]` outbox event type (`erpnext.posting.requested`); both
 * are owner-authorized and land in their own slices. The controller / service /
 * work-item projection / worker consumer land in 015-US1-FEED.
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { AuthModule } from "../../auth/auth.module";
import { ContextModule } from "../../context/context.module";
import { ErpnextPostingController } from "./erpnext-posting.controller";
import { ErpnextPostingService } from "./erpnext-posting.service";

/**
 * Wires the DP2 side of the 012 posting-feed contract. 015-US1-FEED adds the
 * `connectorPullPostings` GET feed (controller + service + work-item projection);
 * the outcome ack (015-US2-ACK) and reversals/resolve-failures (US3/US4) extend
 * the same controller/service. `AuthModule` provides `PG_POOL` + the base
 * `AuthGuard` the `ConnectorAuthGuard` extends.
 */
@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [ErpnextPostingController],
  providers: [ErpnextPostingService],
  exports: [ErpnextPostingService],
})
export class ErpnextPostingModule {}
