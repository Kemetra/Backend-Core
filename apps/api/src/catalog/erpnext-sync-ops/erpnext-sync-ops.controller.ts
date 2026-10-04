/**
 * ErpnextSyncOpsController — 025 Console Sync-Ops Read-Model.
 *
 * The human Console operator's READ-ONLY sync-ops surface
 * (packages/contracts/openapi/erpnext-sync-ops/console-sync-ops.yaml). Three GET
 * routes under /api/v1/catalog/erpnext-sync-ops (mirrors 017's
 * /api/v1/catalog/erpnext-reconciliation namespace family):
 *
 *   GET /summary                 consoleGetSyncOpsSummary          (US1 🎯)
 *   GET /posting-backlog         consoleListPostingBacklog         (US2)
 *   GET /reconciliation-runs     consoleListReconciliationRuns     (US3)
 *
 * Authenticated by the HUMAN `cookieAuth` → `DashboardAuthGuard` (NOT the 012/015
 * `connectorBearer` machine scheme, NOT the `dashboard_api` bearer, NOT the POS
 * `clerkJwt` device scheme). `TenantContextGuard` publishes `request.context`;
 * `RolesGuard` + `@Roles` gate the surface (default deny → 404). `tenant_id`
 * resolves server-side from `request.context`, never the query/body (§XII; strict
 * Zod DTOs reject smuggled fields with 400). Every response is a `toBody`
 * projection (no raw DB entity, §IV). Read-only — no write/repair route (those
 * stay in 017).
 *
 * Routes land in US1/US2/US3. This scaffold ships the guarded, empty controller
 * so the DI graph + build stay green (T001).
 */
import {
  Controller,
  Get,
  NotFoundException,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { Auditable } from "../../audit/auditable.decorator";
import { DashboardAuthGuard } from "../../auth/dashboard-auth.guard";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { ResolvedContext, TenantContextRequest } from "../../context/types";
import {
  SyncOpsListQuerySchema,
  SyncOpsRunListQuerySchema,
  SyncOpsSummaryQuerySchema,
  type SyncOpsListQuery,
  type SyncOpsRunListQuery,
  type SyncOpsSummaryQuery,
} from "./dto/sync-ops-query.dto";
import {
  ErpnextSyncOpsReadModelService,
  StoreNotInScopeError,
  type Page,
  type PostingBacklogItem,
  type ReconciliationRunView,
  type SyncOpsSummaryBody,
} from "./erpnext-sync-ops.read-model.service";

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard)
export class ErpnextSyncOpsController {
  constructor(private readonly service: ErpnextSyncOpsReadModelService) {}

  /** The read context: tenant + the session context whose store scope bounds the read (RT-192). */
  private requireTenant(request: TenantContextRequest): { tenantId: string; context: ResolvedContext } {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    return { tenantId: ctx.tenantId, context: ctx };
  }

  /**
   * Validate an optional `store_id` is one of the caller's accessible stores
   * (membership store scope, RT-192, within the session tenant); map an
   * out-of-scope id to a non-disclosing 404 (FR-009 / SC-002). No-op when absent.
   */
  private async assertStore(
    scoped: { tenantId: string; context: ResolvedContext },
    storeId?: string,
  ): Promise<void> {
    try {
      await this.service.assertStoreInScope({ ...scoped, ...(storeId ? { storeId } : {}) });
    } catch (err) {
      if (err instanceof StoreNotInScopeError) {
        throw new NotFoundException({ code: "not_found", message: "Not found." });
      }
      throw err;
    }
  }

  /** GET — the consolidated sync-ops summary (US1 🎯). */
  @Get("api/v1/catalog/erpnext-sync-ops/summary")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("erpnext_sync_ops.summary.read")
  async getSummary(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(SyncOpsSummaryQuerySchema))
    query: SyncOpsSummaryQuery,
  ): Promise<SyncOpsSummaryBody> {
    const scoped = this.requireTenant(request);
    await this.assertStore(scoped, query.store_id);
    return this.service.getSummary({
      ...scoped,
      ...(query.store_id ? { storeId: query.store_id } : {}),
    });
  }

  /** GET — the posting dead-letter backlog drill (US2; read-only over 015). */
  @Get("api/v1/catalog/erpnext-sync-ops/posting-backlog")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("erpnext_sync_ops.posting_backlog.listed")
  async listPostingBacklog(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(SyncOpsListQuerySchema)) query: SyncOpsListQuery,
  ): Promise<Page<PostingBacklogItem>> {
    const scoped = this.requireTenant(request);
    await this.assertStore(scoped, query.store_id);
    return this.service.listPostingBacklog({
      ...scoped,
      cursor:
        query.cursor !== null && query.cursor !== undefined
          ? BigInt(query.cursor)
          : null,
      limit: query.page_size ?? 50,
      ...(query.store_id ? { storeId: query.store_id } : {}),
    });
  }

  /** GET — reconciliation run-history, newest-first (US3; read-only over 017). */
  @Get("api/v1/catalog/erpnext-sync-ops/reconciliation-runs")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Auditable("erpnext_sync_ops.reconciliation_runs.listed")
  async listReconciliationRuns(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(SyncOpsRunListQuerySchema))
    query: SyncOpsRunListQuery,
  ): Promise<Page<ReconciliationRunView>> {
    const scoped = this.requireTenant(request);
    await this.assertStore(scoped, query.store_id);
    return this.service.listReconciliationRuns({
      ...scoped,
      cursor: query.cursor ?? null,
      limit: query.page_size ?? 50,
      ...(query.store_id ? { storeId: query.store_id } : {}),
    });
  }
}
