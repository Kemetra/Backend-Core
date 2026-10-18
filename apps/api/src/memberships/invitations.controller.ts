import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { DashboardAuthGuard } from "../auth/dashboard-auth.guard";
import { TenantContextGuard } from "../context/tenant-context.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import type { TenantContextRequest } from "../context/types";
import { InvitationsService } from "./invitations.service";
import { InvitationCreateSchema, type InvitationCreateDto } from "./invitation.dto";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { Idempotent } from "../idempotency/idempotent.decorator";
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";

@Controller("api/v1/memberships")
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post("invite")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", { denyAs: 403 })
  @Idempotent("required")
  // RT-619 (RT-574 D3): createInvitation.
  @ConsoleRateLimit("onboarding")
  async invite(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(InvitationCreateSchema)) dto: InvitationCreateDto,
  ): Promise<object> {
    const ctx = request.context;
    if (!ctx) throw new UnauthorizedException("Unauthorized");
    const { row, roleCode } = await this.invitationsService.invite(ctx, dto);
    return {
      id: row.id,
      tenant_id: row.tenantId,
      email: row.email,
      role_code: roleCode,
      store_access_kind: row.storeAccessKind,
      invited_store_ids: row.invitedStoreIds,
      status: row.status,
      expires_at: row.expiresAt,
    };
  }
}
