/**
 * ErpnextItemMapController — 013-CRUD (T031, T033) + 013-REPOINT (T041).
 *
 * Tenant-admin ERPNext Item-mapping suggest/confirm/retire review surface
 * (packages/contracts/openapi/catalog/erpnext-item-map.yaml). Authenticated by
 * the HUMAN Tenant-Admin cookie session (`cookieAuth` → `DashboardAuthGuard`),
 * NOT the 012 `connectorBearer` machine scheme nor the POS operator-identity device
 * scheme. `TenantContextGuard` publishes `request.context`; per-method
 * `RolesGuard` + `@Roles` gate writes (default denyAs: 404 — a wrong-role caller
 * cannot distinguish "exists but forbidden" from "absent", §II/§XII).
 *
 * Routes:
 *   GET  /api/v1/catalog/erpnext-item-mappings[?state=]    tenantAdminListErpnextItemMappings
 *   POST /api/v1/catalog/erpnext-item-mappings            tenantAdminSuggestErpnextItemMapping
 *   POST /api/v1/catalog/erpnext-item-mappings/:id/confirm tenantAdminConfirmErpnextItemMapping
 *
 * `tenant_id` + actor are resolved server-side from `request.context`, never
 * the body (§XII; strict Zod DTOs reject smuggled fields with 400). Every
 * response is the `toErpnextItemMapping` projection (no raw DB entity, §IV).
 * Conflicts (409) carry `error.code = "conflict"`; absent / out-of-scope ids
 * are non-disclosing 404s. Happy-path audit subjects are emitted by the
 * `@Auditable` decorator + AuditEmitterInterceptor.
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
  Post,
  Query,
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
  toErpnextItemMapping,
  type ErpnextItemMappingBody,
} from "./dto/erpnext-item-mapping.dto";
import {
  SuggestErpnextItemMappingRequestSchema,
  type SuggestErpnextItemMappingRequestDto,
} from "./dto/suggest-request.dto";
import {
  VersionedMutationRequestSchema,
  type VersionedMutationRequestDto,
} from "./dto/versioned-mutation-request.dto";
import { ErpnextItemMapService } from "./erpnext-item-map.service";

/** Optional `state` list filter (mirrors the OpenAPI enum). */
const ListQuerySchema = z
  .object({
    state: z.enum(["suggested", "confirmed"]).optional(),
  })
  .strict();
type ListQueryDto = z.infer<typeof ListQuerySchema>;

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class ErpnextItemMapController {
  constructor(private readonly service: ErpnextItemMapService) {}

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

  /** GET — list the tenant's active mappings (optionally the review queue). */
  @Get("api/v1/catalog/erpnext-item-mappings")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async list(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ListQuerySchema)) query: ListQueryDto,
  ): Promise<{ items: ErpnextItemMappingBody[] }> {
    const { tenantId } = this.requireContext(request);
    const rows = await this.service.list(
      query.state ? { tenantId, state: query.state } : { tenantId },
    );
    return { items: rows.map(toErpnextItemMapping) };
  }

  /** POST — record a manual suggested mapping. */
  @Post("api/v1/catalog/erpnext-item-mappings")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("erpnext_item_map.suggested")
  async suggest(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(SuggestErpnextItemMappingRequestSchema))
    body: SuggestErpnextItemMappingRequestDto,
  ): Promise<ErpnextItemMappingBody> {
    const { tenantId, userId } = this.requireContext(request);
    const result = await this.service.suggest({
      tenantId,
      tenantProductId: body.tenant_product_id,
      erpnextItemRef: body.erpnext_item_ref,
      actorUserId: userId,
    });
    if (result.kind === "ok") {
      return toErpnextItemMapping(result.row);
    }
    if (result.kind === "conflict") {
      throw new ConflictException({
        code: "conflict",
        message:
          "An active mapping already exists for this product (1:1, OQ-2).",
      });
    }
    // Non-disclosing 404 — absent OR cross-tenant product (§II/§XII).
    throw new NotFoundException("Not Found");
  }

  /** POST :id/confirm — confirm a suggested mapping (optimistic version). */
  @Post("api/v1/catalog/erpnext-item-mappings/:id/confirm")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("erpnext_item_map.confirmed")
  async confirm(
    @Req() request: TenantContextRequest,
    @Param("id", new ZodValidationPipe(z.string().uuid())) id: string,
    @Body(new ZodValidationPipe(VersionedMutationRequestSchema))
    body: VersionedMutationRequestDto,
  ): Promise<ErpnextItemMappingBody> {
    const { tenantId, userId } = this.requireContext(request);
    const result = await this.service.confirm({
      tenantId,
      id,
      version: body.version,
      actorUserId: userId,
    });
    if (result.kind === "ok") {
      return toErpnextItemMapping(result.row);
    }
    if (result.kind === "conflict") {
      throw new ConflictException({
        code: "conflict",
        message:
          "Optimistic-concurrency conflict (stale version) or the mapping is " +
          "not in a confirmable state (§III).",
      });
    }
    throw new NotFoundException("Not Found");
  }

  /**
   * POST :id/retire — retire a mapping (append-only soft-delete; optimistic
   * version). A re-point is this retire followed by a fresh suggest — never an
   * in-place identity rewrite (data-model §6).
   */
  @Post("api/v1/catalog/erpnext-item-mappings/:id/retire")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("erpnext_item_map.retired")
  async retire(
    @Req() request: TenantContextRequest,
    @Param("id", new ZodValidationPipe(z.string().uuid())) id: string,
    @Body(new ZodValidationPipe(VersionedMutationRequestSchema))
    body: VersionedMutationRequestDto,
  ): Promise<ErpnextItemMappingBody> {
    const { tenantId } = this.requireContext(request);
    const result = await this.service.retire({
      tenantId,
      id,
      version: body.version,
    });
    if (result.kind === "ok") {
      return toErpnextItemMapping(result.row);
    }
    if (result.kind === "conflict") {
      throw new ConflictException({
        code: "conflict",
        message:
          "Optimistic-concurrency conflict (stale version) or the mapping is " +
          "already retired (§III).",
      });
    }
    throw new NotFoundException("Not Found");
  }
}
