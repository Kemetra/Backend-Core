/**
 * TrackingProfileModule — RT-448 (RT-50 Inventory Gate 7, rule G7-1).
 *
 * Wires the tenant-admin Tracking Profile read/set surface
 * (`packages/contracts/openapi/catalog/tracking-profile.yaml`). Authentication
 * is the HUMAN Tenant-Admin cookie session (`cookieAuth`, the httpOnly
 * `dp2_session`), resolved by `DashboardAuthGuard`.
 *
 * Imports mirror `erpnext-warehouse-map.module.ts`:
 *   - `AuthModule`    — provides `PG_POOL` + `DashboardAuthGuard`.
 *   - `AuditModule`   — the global `AuditEmitterInterceptor` the
 *                       `@Auditable(...)` route decorator triggers.
 *   - `ContextModule` — `TenantContextGuard` and the `MembershipRepository`
 *                       that `RolesGuard` needs.
 */
import { Module } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module";
import { AuthModule } from "../../auth/auth.module";
import { RolesGuard } from "../../auth/roles.guard";
import { ContextModule } from "../../context/context.module";
import { TrackingProfileController } from "./tracking-profile.controller";
import { TrackingProfileService } from "./tracking-profile.service";

@Module({
  imports: [AuthModule, AuditModule, ContextModule],
  controllers: [TrackingProfileController],
  providers: [TrackingProfileService, RolesGuard],
  exports: [TrackingProfileService],
})
export class TrackingProfileModule {}
