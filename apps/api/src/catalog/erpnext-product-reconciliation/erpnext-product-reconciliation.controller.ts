/**
 * ErpnextProductReconciliationController — 021.
 *
 * The human Tenant-Admin product-master reconciliation/repair surface
 * (packages/contracts/openapi/catalog/product-reconciliation.yaml). Authenticated
 * by the HUMAN `cookieAuth` → `DashboardAuthGuard` (the 007/013/014/017
 * convention), NOT the 012 `connectorBearer` machine scheme nor the POS `clerkJwt`
 * device scheme (FR-019). `TenantContextGuard` publishes `request.context`;
 * `RolesGuard` + `@Roles` gate the surface (default deny → 404, §II/§XII).
 *
 * Routes (under /api/v1/catalog/erpnext-product-reconciliation):
 *   GET  /backlog                       listProductReconciliationBacklog (US1 🎯)
 *   POST /repairs                       repairProductMapping (US2)
 *   POST /runs                          triggerProductReconciliationRun (US3)
 *   GET  /runs                          listProductReconciliationRuns (US3)
 *   GET  /runs/:runId/results           getProductReconciliationRunResults (US3)
 *
 * `tenant_id` + actor resolve server-side from `request.context`, never the
 * query/body (§XII; strict Zod DTOs reject smuggled fields with 400). Every
 * response is a projection (no raw DB entity, §IV).
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { DashboardAuthGuard } from "../../auth/dashboard-auth.guard";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import {
  ListQuerySchema,
  ListRunsQuerySchema,
  RepairProductMappingBodySchema,
  TriggerProductRunBodySchema,
  type ListQuery,
  type ListRunsQuery,
  type RepairProductMappingBody,
  type TriggerProductRunBody,
} from "./dto/product-reconciliation.dto";
import {
  ErpnextProductReconciliationService,
  ProductNotFoundError,
  RepairConflictError,
  RepairValidationError,
  RunNotFoundError,
  type RepairResult,
} from "./erpnext-product-reconciliation.service";
import type {
  BacklogItem,
  ProductReconciliationResultBody,
  ProductReconciliationRunBody,
  RecordedProductRepair,
} from "./product-reconciliation.projection";

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class ErpnextProductReconciliationController {
  constructor(
    private readonly service: ErpnextProductReconciliationService,
  ) {}

  private requireTenant(request: TenantContextRequest): string {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    return ctx.tenantId;
  }

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

  /** GET — the tenant's unmapped-product backlog (US1; a live read-projection). */
  @Get("api/v1/catalog/erpnext-product-reconciliation/backlog")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async listBacklog(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ListQuerySchema)) query: ListQuery,
  ): Promise<{ items: readonly BacklogItem[]; nextCursor: string | null }> {
    const tenantId = this.requireTenant(request);
    const cls =
      query.class === "unmapped_dp2_product" ||
      query.class === "suggestion_unconfirmed"
        ? query.class
        : undefined;
    return this.service.listBacklog({
      tenantId,
      cursor: query.cursor ?? null,
      limit: query.limit ?? 100,
      ...(cls ? { mismatchClass: cls } : {}),
    });
  }

  /** POST — repair an unmapped/divergent product via the 013 lifecycle (US2). */
  // NO @Auditable: the service writes the audit_events row IN-TRANSACTION (FR-015).
  @Post("api/v1/catalog/erpnext-product-reconciliation/repairs")
  @Idempotent("required")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @HttpCode(201)
  async repair(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(RepairProductMappingBodySchema))
    body: RepairProductMappingBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RecordedProductRepair> {
    const { tenantId, userId } = this.requireContext(request);
    if ((body.runId && !body.resultId) || (!body.runId && body.resultId)) {
      throw new BadRequestException({
        code: "validation_error",
        message: "runId and resultId must be supplied together.",
      });
    }
    const base = {
      tenantId,
      actorUserId: userId,
      repairKind: body.repairKind,
      tenantProductId: body.tenantProductId,
      ...(body.mappingId ? { mappingId: body.mappingId } : {}),
      ...(body.erpnextItemRef ? { erpnextItemRef: body.erpnextItemRef } : {}),
      ...(body.version !== undefined ? { version: body.version } : {}),
    };
    return this.handleRepair(
      () =>
        body.runId && body.resultId
          ? this.service.repairResult({ ...base, runId: body.runId, resultId: body.resultId })
          : this.service.repairBacklogItem(base),
      res,
    );
  }

  /** POST — trigger an on-demand product-master reconciliation run (US3). */
  // NO @Auditable: triggerRun writes the audit_events row IN-TRANSACTION (FR-015).
  @Post("api/v1/catalog/erpnext-product-reconciliation/runs")
  @Idempotent("required")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @HttpCode(201)
  async triggerRun(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(TriggerProductRunBodySchema))
    _body: TriggerProductRunBody,
  ): Promise<ProductReconciliationRunBody> {
    const { tenantId, userId } = this.requireContext(request);
    return this.service.triggerRun({ tenantId, actorUserId: userId });
  }

  /** GET — the tenant's reconciliation runs (US3), newest first. */
  @Get("api/v1/catalog/erpnext-product-reconciliation/runs")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async listRuns(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ListRunsQuerySchema)) query: ListRunsQuery,
  ): Promise<{ items: ProductReconciliationRunBody[]; nextCursor: string | null }> {
    const tenantId = this.requireTenant(request);
    return this.service.listRuns({
      tenantId,
      cursor: query.cursor ?? null,
      limit: query.limit ?? 100,
    });
  }

  /** GET — a run's classified mismatch results (US3), paginated. */
  @Get("api/v1/catalog/erpnext-product-reconciliation/runs/:runId/results")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async listResults(
    @Req() request: TenantContextRequest,
    @Param("runId", new ParseUUIDPipe()) runId: string,
    @Query(new ZodValidationPipe(ListQuerySchema)) query: ListQuery,
  ): Promise<{
    items: ProductReconciliationResultBody[];
    nextCursor: string | null;
  }> {
    const tenantId = this.requireTenant(request);
    try {
      return await this.service.listResults({
        tenantId,
        runId,
        cursor: query.cursor ?? null,
        limit: query.limit ?? 100,
        ...(query.class ? { mismatchClass: query.class } : {}),
      });
    } catch (err) {
      if (err instanceof RunNotFoundError) {
        throw new NotFoundException({ code: "not_found", message: "Run not found." });
      }
      throw err;
    }
  }

  /** Shared repair error → HTTP mapping. */
  private async handleRepair(
    run: () => Promise<RepairResult>,
    res: Response,
  ): Promise<RecordedProductRepair> {
    try {
      const result = await run();
      if (result.replayed) {
        res.setHeader("Idempotent-Replayed", "true");
        res.status(200);
      }
      return result.repair;
    } catch (err) {
      if (err instanceof RepairConflictError) {
        // The repair_attempt + audit are persisted (the conflict IS the recorded
        // outcome); surface a 409 with the canonical envelope (FR-012).
        throw new ConflictException({
          code: "conflict",
          message: "The mapping was concurrently modified.",
        });
      }
      if (err instanceof ProductNotFoundError) {
        throw new NotFoundException({ code: "not_found", message: "Product not found." });
      }
      if (err instanceof RunNotFoundError) {
        throw new NotFoundException({ code: "not_found", message: "Result not found." });
      }
      if (err instanceof RepairValidationError) {
        throw new BadRequestException({
          code: "validation_error",
          message: err.message,
        });
      }
      throw err;
    }
  }
}
