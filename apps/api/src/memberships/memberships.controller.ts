/**
 * MembershipsController — slice US4 (T173/T174).
 *
 * Implements the revoke and update endpoints from
 * `specs/001-foundation-auth-tenant-store/contracts/memberships.openapi.yaml`:
 *
 *     DELETE /api/v1/memberships/:membership_id   revokeMembership
 *     PATCH  /api/v1/memberships/:membership_id   updateMembership
 *
 * Authorization model (active-tenant context, same as StoresController)
 * -----------------------------------------------------------------------
 * Class-level `@UseGuards(AuthGuard, TenantContextGuard)`:
 *   - `AuthGuard`          — authenticates the caller.
 *   - `TenantContextGuard` — requires an active tenant (→ 401 on miss)
 *                            and populates `request.context`.
 *
 * Method-level `@UseGuards(RolesGuard) @Roles("owner","tenant_admin",{denyAs:403})`:
 *   - Caller must be `owner` or `tenant_admin` within the active tenant.
 *   - `denyAs: 403` (not 404): the caller is already inside their
 *     active tenant, so denying existence would be misleading.
 */
import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  ParseUUIDPipe,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { DashboardAuthGuard } from "../auth/dashboard-auth.guard";
import { TenantContextGuard } from "../context/tenant-context.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import type { TenantContextRequest } from "../context/types";
import { MembershipsService } from "./memberships.service";
import { MembershipUpdateSchema, type MembershipUpdateDto } from "./dto";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";

@Controller("api/v1/memberships")
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class MembershipsController {
  constructor(private readonly membershipsService: MembershipsService) {}

  @Delete(":membership_id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  // RT-619 (RT-574 D3): revokeMembership.
  @ConsoleRateLimit("incidentControl")
  async revoke(
    @Req() request: TenantContextRequest,
    @Param("membership_id", new ParseUUIDPipe()) membershipId: string,
  ): Promise<void> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    await this.membershipsService.revoke(ctx, membershipId);
  }

  @Patch(":membership_id")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  async update(
    @Req() request: TenantContextRequest,
    @Param("membership_id", new ParseUUIDPipe()) membershipId: string,
    @Body(new ZodValidationPipe(MembershipUpdateSchema)) dto: MembershipUpdateDto,
  ): Promise<object> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    const detail = await this.membershipsService.update(ctx, membershipId, dto);
    return {
      id: detail.membershipId,
      tenant_id: ctx.tenantId,
      user_id: detail.user.id,
      role_code: detail.roleCode,
      store_access_kind: detail.storeAccessKind,
      accessible_store_ids: detail.accessibleStoreIds,
      revoked_at: detail.revokedAt ? detail.revokedAt.toISOString() : null,
    };
  }
}
