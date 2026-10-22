/**
 * TenantsModule — slice 12 (T131).
 *
 * Wires the tenant-CRUD surface:
 *
 *   TenantsController
 *     ├─ AuthGuard            (from AuthModule, class-level)
 *     ├─ RolesGuard           (per-method on POST/PATCH/DELETE)
 *     │     ├─ Reflector         (auto-provided by @nestjs/core)
 *     │     └─ MembershipRepository (from ContextModule)
 *     └─ TenantsService
 *          ├─ PG_POOL          (from AuthModule)
 *          ├─ TenantsRepository (provided here)
 *          └─ MembershipRepository (from ContextModule)
 *
 * Imports `AuthModule` for `AuthGuard` and the `PG_POOL` token,
 * and `ContextModule` for `MembershipRepository.isPlatformAdmin` /
 * `findRoleCodeForUserInTenant` — used by both `TenantsService` and
 * `RolesGuard`.
 *
 * `RolesGuard` is registered as a plain class provider; Nest resolves
 * `Reflector` automatically and `MembershipRepository` is exported by
 * the imported `ContextModule`. No `useFactory` needed.
 *
 * `TenantContextGuard` is intentionally NOT applied — see
 * `tenants.controller.ts` header for the path-as-context rationale.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { RolesGuard } from "../auth/roles.guard";
import { ContextModule } from "../context/context.module";
import { PathTenantSupportSessionGuard } from "../platform-support-sessions/path-tenant-support-session.guard";
import { TenantsController } from "./tenants.controller";
import { TenantsRepository } from "./tenants.repository";
import { TenantsService } from "./tenants.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [TenantsController],
  providers: [TenantsRepository, TenantsService, RolesGuard, PathTenantSupportSessionGuard],
  exports: [TenantsService, TenantsRepository],
})
export class TenantsModule {}
