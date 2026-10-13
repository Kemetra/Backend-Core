/**
 * TrackingProfileController — RT-448 (RT-50 Inventory Gate 7, rule G7-1).
 *
 * Tenant-admin read/set of a product's Tracking Profile
 * (packages/contracts/openapi/catalog/tracking-profile.yaml). Authenticated by
 * the HUMAN Tenant-Admin cookie session (`cookieAuth` → `DashboardAuthGuard`);
 * `TenantContextGuard` publishes `request.context`; `RolesGuard` + `@Roles`
 * gate both routes (denyAs 404: a wrong-role caller cannot tell "forbidden"
 * from "absent", §II/§XII).
 *
 * Routes:
 *   GET /api/v1/catalog/products/:productId/tracking-profile  tenantAdminGetTrackingProfile
 *   PUT /api/v1/catalog/products/:productId/tracking-profile  tenantAdminSetTrackingProfile
 *
 * `tenant_id` + actor come from `request.context`, never the body (§XII; the
 * strict Zod DTO rejects smuggled fields with 400). A locked profile (387) is
 * `409 tracking_profile_locked`; an absent or cross-tenant product is a
 * non-disclosing 404. The happy-path audit subject is emitted by `@Auditable`.
 */
import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import { Auditable } from "../../audit/auditable.decorator";
import { DashboardAuthGuard } from "../../auth/dashboard-auth.guard";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import {
  SetTrackingProfileRequestSchema,
  toTrackingProfile,
  type SetTrackingProfileRequestDto,
  type TrackingProfileBody,
} from "./tracking-profile.dto";
import { TrackingProfileService } from "./tracking-profile.service";

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class TrackingProfileController {
  constructor(private readonly service: TrackingProfileService) {}

  private requireContext(request: TenantContextRequest): {
    tenantId: string;
    userId: string;
  } {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    return { tenantId: ctx.tenantId, userId: ctx.userId };
  }

  /** GET — read a product's Tracking Profile. */
  @Get("api/v1/catalog/products/:productId/tracking-profile")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async get(
    @Req() request: TenantContextRequest,
    @Param("productId", new ZodValidationPipe(z.string().uuid())) productId: string,
  ): Promise<TrackingProfileBody> {
    const { tenantId } = this.requireContext(request);
    const result = await this.service.get({ tenantId, productId });
    if (result.kind === "ok") return toTrackingProfile(result.row);
    throw new NotFoundException("Not Found");
  }

  /** PUT — set a product's Tracking Profile (full replacement). */
  @Put("api/v1/catalog/products/:productId/tracking-profile")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("catalog.tracking_profile.set")
  async set(
    @Req() request: TenantContextRequest,
    @Param("productId", new ZodValidationPipe(z.string().uuid())) productId: string,
    @Body(new ZodValidationPipe(SetTrackingProfileRequestSchema))
    body: SetTrackingProfileRequestDto,
  ): Promise<TrackingProfileBody> {
    const { tenantId, userId } = this.requireContext(request);
    const result = await this.service.set({
      tenantId,
      productId,
      trackingMode: body.tracking_mode,
      expiryRequired: body.expiry_required,
      actorUserId: userId,
    });
    if (result.kind === "ok") return toTrackingProfile(result.row);
    if (result.kind === "locked") {
      throw new ConflictException({
        code: "tracking_profile_locked",
        message:
          "The product has inventory or sale history, so its tracking profile can no longer change.",
      });
    }
    // Non-disclosing 404 — absent OR cross-tenant product (§II/§XII).
    throw new NotFoundException("Not Found");
  }
}
