/**
 * ErpnextWarehouseMapController — 014-CRUD (T031, T033).
 *
 * Tenant-admin store↔ERPNext-Warehouse mapping set/list/retire review surface
 * (packages/contracts/openapi/catalog/erpnext-warehouse-map.yaml). Authenticated
 * by the HUMAN Tenant-Admin cookie session (`cookieAuth` → `DashboardAuthGuard`),
 * NOT the 012 `connectorBearer` machine scheme nor the POS operator-identity device
 * scheme. `TenantContextGuard` publishes `request.context`; per-method
 * `RolesGuard` + `@Roles` gate writes (default denyAs: 404 — a wrong-role caller
 * cannot distinguish "exists but forbidden" from "absent", §II/§XII).
 *
 * Routes:
 *   GET  /api/v1/catalog/erpnext-warehouse-mappings            tenantAdminListErpnextWarehouseMappings
 *   POST /api/v1/catalog/erpnext-warehouse-mappings            tenantAdminSetErpnextWarehouseMapping
 *   POST /api/v1/catalog/erpnext-warehouse-mappings/:id/retire tenantAdminRetireErpnextWarehouseMapping
 *
 * `tenant_id` + actor are resolved server-side from `request.context`, never
 * the body (§XII; strict Zod DTOs reject smuggled fields with 400). Every
 * response is the `toErpnextWarehouseMapping` projection (no raw DB entity,
 * §IV). Conflicts (409) carry `error.code = "conflict"`; absent / out-of-scope
 * ids are non-disclosing 404s. Happy-path audit subjects are emitted by the
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
  toErpnextWarehouseMapping,
  type ErpnextWarehouseMappingBody,
} from "./dto/erpnext-warehouse-mapping.dto";
import {
  SetErpnextWarehouseMappingRequestSchema,
  type SetErpnextWarehouseMappingRequestDto,
} from "./dto/set-request.dto";
import {
  VersionedMutationRequestSchema,
  type VersionedMutationRequestDto,
} from "./dto/versioned-mutation-request.dto";
import { ErpnextWarehouseMapService } from "./erpnext-warehouse-map.service";

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class ErpnextWarehouseMapController {
  constructor(private readonly service: ErpnextWarehouseMapService) {}

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

  /** GET — list the tenant's active mappings. */
  @Get("api/v1/catalog/erpnext-warehouse-mappings")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async list(
    @Req() request: TenantContextRequest,
  ): Promise<{ items: ErpnextWarehouseMappingBody[] }> {
    const { tenantId } = this.requireContext(request);
    const rows = await this.service.list({ tenantId });
    return { items: rows.map(toErpnextWarehouseMapping) };
  }

  /** POST — set a manual mapping (purpose='stock' in v1). */
  @Post("api/v1/catalog/erpnext-warehouse-mappings")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("erpnext_warehouse_map.set")
  async set(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(SetErpnextWarehouseMappingRequestSchema))
    body: SetErpnextWarehouseMappingRequestDto,
  ): Promise<ErpnextWarehouseMappingBody> {
    const { tenantId, userId } = this.requireContext(request);
    const result = await this.service.set({
      tenantId,
      storeId: body.store_id,
      erpnextWarehouseRef: body.erpnext_warehouse_ref,
      actorUserId: userId,
    });
    if (result.kind === "ok") {
      return toErpnextWarehouseMapping(result.row);
    }
    if (result.kind === "conflict") {
      throw new ConflictException({
        code: "conflict",
        message:
          "An active mapping already exists for this store (1:1, OQ-2).",
      });
    }
    // Non-disclosing 404 — absent OR cross-tenant store (§II/§XII).
    throw new NotFoundException("Not Found");
  }

  /**
   * POST :id/retire — retire a mapping (append-only soft-delete; optimistic
   * version). A re-point is this retire followed by a fresh set — never an
   * in-place identity rewrite (data-model §2).
   */
  @Post("api/v1/catalog/erpnext-warehouse-mappings/:id/retire")
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("erpnext_warehouse_map.retired")
  async retire(
    @Req() request: TenantContextRequest,
    @Param("id", new ZodValidationPipe(z.string().uuid())) id: string,
    @Body(new ZodValidationPipe(VersionedMutationRequestSchema))
    body: VersionedMutationRequestDto,
  ): Promise<ErpnextWarehouseMappingBody> {
    const { tenantId, userId } = this.requireContext(request);
    const result = await this.service.retire({
      tenantId,
      id,
      version: body.version,
      actorUserId: userId,
    });
    if (result.kind === "ok") {
      return toErpnextWarehouseMapping(result.row);
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
