/**
 * SaleSyncOpsController — 032 §9 Console read/repair surface (T016–T020).
 *
 * The human Console operator's sale-sync READ + server-mediated REPAIR surface
 * (packages/contracts/openapi/sale-sync-ops/sale-sync-ops.yaml). Four routes
 * under /api/v1/catalog/sale-sync-ops, mirroring the 025
 * /api/v1/catalog/erpnext-sync-ops namespace family + auth posture:
 *
 *   GET  /sales/{saleRef}/status          consoleGetSaleSyncStatus    (T016)
 *   GET  /needs-repair                    consoleListNeedsRepair      (T017)
 *   GET  /sales/{saleRef}/audit-timeline  consoleGetSaleAuditTimeline (T019)
 *   POST /sales/{saleRef}/repair          consoleRepairSaleSync       (T020)
 *
 * Authenticated by the HUMAN `cookieAuth` → `DashboardAuthGuard` (NOT the POS
 * `clerkJwt` device scheme, NOT a machine bearer). `TenantContextGuard`
 * publishes `request.context`; `RolesGuard` + `@Roles` gate the surface
 * (default deny → 404). `tenant_id` resolves server-side from `request.context`,
 * never the query/body (§XII). Every response is a `toBody` projection (no raw
 * DB entity, §IV). 401/403 semantics are owned by 028 (G10).
 *
 * The repair route is the ONLY write — server-mediated, audited
 * (`@Auditable`), Idempotency-Key-required. It acts only on a DP-2-classified
 * NEEDS_REPAIR item, performs no sale-fact rewrite, and has no POS-local
 * override path (DP3 / §13 item 3). It does NOT touch the live POS provenance
 * 409 (F-3) and invents no server settlement (F-2).
 */
import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
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
import { Idempotent } from "../../idempotency/idempotent.decorator";
import {
  NeedsRepairListQuerySchema,
  type NeedsRepairListQuery,
} from "./dto/sale-sync-ops-query.dto";
import {
  RepairConflictError,
  SaleSyncNotFoundError,
  SaleSyncOpsReadModelService,
  StoreNotInScopeError,
  type NeedsRepairItem,
  type Page,
  type SaleAuditTimelineBody,
  type SaleSyncStatusBody,
} from "./sale-sync-ops.read-model.service";

/**
 * Canonical UUID shape — a saleRef that fails this never hits the DB.
 *
 * A saleRef that does not match is a MALFORMED request-shape error → 400
 * `validation_error` (NOT a safe-404). This is not a non-disclosure concern:
 * the check runs BEFORE any DB hit, so it reveals nothing about whether a
 * resource exists. The non-disclosing 404 is reserved for the
 * exists-but-out-of-scope / cross-tenant / genuinely-absent trio — a VALID ref
 * that does not resolve in the operator's scope — where 404 and "absent" must
 * be indistinguishable (FR-063/102).
 */
const SaleRefSchema = z.string().uuid();

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class SaleSyncOpsController {
  constructor(private readonly service: SaleSyncOpsReadModelService) {}

  private requireTenant(request: TenantContextRequest): string {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    return ctx.tenantId;
  }

  /**
   * Reject a syntactically MALFORMED saleRef with a 400 `validation_error`
   * BEFORE any DB hit (a request-shape error, discloses nothing). A
   * VALID-but-out-of-scope ref is left to the service layer's non-disclosing
   * 404 — the two cases are deliberately distinct.
   */
  private assertSaleRef(saleRef: string): void {
    if (!SaleRefSchema.safeParse(saleRef).success) {
      throw new BadRequestException({
        code: "validation_error",
        message: "saleRef must be a valid UUID.",
      });
    }
  }

  private async assertStore(tenantId: string, storeId?: string): Promise<void> {
    try {
      await this.service.assertStoreInScope(tenantId, storeId);
    } catch (err) {
      if (err instanceof StoreNotInScopeError) {
        throw new NotFoundException({ code: "not_found", message: "Not found." });
      }
      throw err;
    }
  }

  /** GET — one sale's server-authoritative sync-status (T016). */
  @Get("api/v1/catalog/sale-sync-ops/sales/:saleRef/status")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("sale_sync_ops.status.read")
  async getStatus(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
  ): Promise<SaleSyncStatusBody> {
    const tenantId = this.requireTenant(request);
    this.assertSaleRef(saleRef);
    return this.withNotFound(() =>
      this.service.getSaleSyncStatus(tenantId, saleRef),
    );
  }

  /** GET — the NEEDS_REPAIR queue, newest-first, keyset paginated (T017). */
  @Get("api/v1/catalog/sale-sync-ops/needs-repair")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("sale_sync_ops.needs_repair.listed")
  async listNeedsRepair(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(NeedsRepairListQuerySchema))
    query: NeedsRepairListQuery,
  ): Promise<Page<NeedsRepairItem>> {
    const tenantId = this.requireTenant(request);
    await this.assertStore(tenantId, query.store_id);
    return this.service.listNeedsRepair({
      tenantId,
      cursor: query.cursor ?? null,
      limit: query.page_size ?? 50,
      ...(query.store_id ? { storeId: query.store_id } : {}),
    });
  }

  /** GET — the read-only correlation/audit timeline for one sale (T019). */
  @Get("api/v1/catalog/sale-sync-ops/sales/:saleRef/audit-timeline")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("sale_sync_ops.audit_timeline.read")
  async getAuditTimeline(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
  ): Promise<SaleAuditTimelineBody> {
    const tenantId = this.requireTenant(request);
    this.assertSaleRef(saleRef);
    return this.withNotFound(() =>
      this.service.getSaleAuditTimeline(tenantId, saleRef),
    );
  }

  /** POST — the server-mediated repair/retry of a NEEDS_REPAIR sale (T020). */
  @Post("api/v1/catalog/sale-sync-ops/sales/:saleRef/repair")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Idempotent("required")
  @Auditable("sale_sync_ops.repair.requested")
  async repair(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
  ): Promise<SaleSyncStatusBody> {
    const tenantId = this.requireTenant(request);
    this.assertSaleRef(saleRef);
    try {
      return await this.service.repairSaleSync(tenantId, saleRef);
    } catch (err) {
      if (err instanceof SaleSyncNotFoundError) {
        throw new NotFoundException({ code: "not_found", message: "Not found." });
      }
      if (err instanceof RepairConflictError) {
        // Item not in a repairable state — DISTINCT from the live POS
        // provenance-conflict 409 (F-3), which is untouched.
        throw new ConflictException({
          code: "repair_conflict",
          message: "The sale is not in a repairable state.",
        });
      }
      throw err;
    }
  }

  private async withNotFound<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SaleSyncNotFoundError) {
        throw new NotFoundException({ code: "not_found", message: "Not found." });
      }
      throw err;
    }
  }
}
