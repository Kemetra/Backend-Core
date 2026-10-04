/**
 * NegativeOnHandController — RT-177.
 *
 * The two READ-ONLY ERPNext negative on-hand operations of
 * `packages/contracts/openapi/erpnext-reconciliation/reconciliation.yaml`:
 *
 *   GET /api/v1/catalog/erpnext-reconciliation/negative-on-hand/stores
 *       listErpnextNegativeOnHandStores
 *   GET /api/v1/catalog/erpnext-reconciliation/stores/:storeId/negative-on-hand
 *       listErpnextNegativeOnHand
 *
 * Same human `cookieAuth` boundary as the rest of the 017 surface
 * (`DashboardAuthGuard` → `TenantContextGuard` → `RolesGuard`). Read access is
 * `owner` / `tenant_admin` (their membership's store scope — tenant-wide for an
 * `all` membership — never narrowed by the active store) and
 * `store_manager` (its store scope, `resolveStoreScope`, RT-131); every other
 * role gets the default non-disclosing 404 (RT-51 D6). The service derives the
 * scope from the session context and the caller's role (`readScope`). Tenant and store scope come from the session, never the query
 * (§XII). No write path, no `@Idempotent`, no audit row: this is a pure read.
 */
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { DashboardAuthGuard } from "../../auth/dashboard-auth.guard";
import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { ResolvedContext, TenantContextRequest } from "../../context/types";
import {
  NegativeOnHandQuerySchema,
  StoreIdParamSchema,
  type NegativeOnHandQuery,
} from "./dto/negative-on-hand-query.dto";
import {
  InvalidCursorError,
  type StoreNegativeOnHandPage,
  type StoreNegativeOnHandSummaryPage,
} from "./negative-on-hand.projection";
import {
  NegativeOnHandService,
  NegativeOnHandStoreNotFoundError,
} from "./negative-on-hand.service";

const DEFAULT_LIMIT = 100;

@Controller()
@UseGuards(DashboardAuthGuard, TenantContextGuard, RolesGuard)
export class NegativeOnHandController {
  constructor(private readonly service: NegativeOnHandService) {}

  /** GET — per-store ERPNext negative on-hand summaries (RT-177). */
  @Get("api/v1/catalog/erpnext-reconciliation/negative-on-hand/stores")
  @Roles("owner", "tenant_admin", "store_manager")
  async listErpnextNegativeOnHandStores(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(NegativeOnHandQuerySchema)) query: NegativeOnHandQuery,
  ): Promise<StoreNegativeOnHandSummaryPage> {
    const { ctx, tenantId } = requireTenant(request);
    return mapErrors(() =>
      this.service.listStores({
        tenantId,
        context: ctx,
        cursor: query.cursor ?? null,
        limit: query.limit ?? DEFAULT_LIMIT,
      }),
    );
  }

  /** GET — one store's ERPNext items with negative on-hand (RT-177). */
  @Get("api/v1/catalog/erpnext-reconciliation/stores/:storeId/negative-on-hand")
  @Roles("owner", "tenant_admin", "store_manager")
  async listErpnextNegativeOnHand(
    @Req() request: TenantContextRequest,
    @Param("storeId", new ZodValidationPipe(StoreIdParamSchema)) storeId: string,
    @Query(new ZodValidationPipe(NegativeOnHandQuerySchema)) query: NegativeOnHandQuery,
  ): Promise<StoreNegativeOnHandPage> {
    const { ctx, tenantId } = requireTenant(request);
    return mapErrors(() =>
      this.service.listItems({
        tenantId,
        context: ctx,
        storeId,
        cursor: query.cursor ?? null,
        limit: query.limit ?? DEFAULT_LIMIT,
      }),
    );
  }
}

function requireTenant(request: TenantContextRequest): {
  ctx: ResolvedContext;
  tenantId: string;
} {
  const ctx = request.context;
  if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
  return { ctx, tenantId: ctx.tenantId };
}

/** Service errors → the canonical 400 / non-disclosing 404 envelopes. */
async function mapErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof InvalidCursorError) {
      throw new BadRequestException({ code: "validation_error", message: err.message });
    }
    if (err instanceof NegativeOnHandStoreNotFoundError) {
      throw new NotFoundException({ code: "not_found", message: "Store not found." });
    }
    throw err;
  }
}
