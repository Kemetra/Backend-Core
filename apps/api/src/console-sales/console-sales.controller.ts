/**
 * ConsoleSalesController — RT-562 (RT-556 F2): the console read of received
 * sales (`console-sales.openapi.yaml` 1.0.0-draft, RT-561) for Admin-Console
 * spec 012 (sales search and sale detail).
 *
 *   GET /api/v1/sales            consoleListSales
 *   GET /api/v1/sales/{saleRef}  consoleGetSale
 *
 * Auth: the HUMAN `cookieAuth` session only → `SessionOnlyAdminGuard` (every
 * bearer, `dashboard_api`, a POS device token and an operator envelope
 * included, is 401), then `TenantContextGuard` (publishes `request.context`),
 * then `RolesGuard` + `@Roles("owner", "tenant_admin", "store_manager")`
 * (default deny → 404). The guards run before the query and path are
 * validated, so a refused role is a 404 for any input. The tenant is the
 * session's, never the request's (§XII); the store scope is applied by the
 * service. The RT-383 shift-closes precedent.
 *
 * Refusals: a malformed path, query or cursor is 400 `validation_error`; every
 * scope refusal (role, other tenant, store outside the scope, absent sale) is
 * the same non-disclosing 404.
 *
 * Audit (OD-534-7 applied to the console): one `console_sales.listed` per list
 * request and one `console_sales.detail_read` per open, emitted by the request
 * audit interceptor after a 200 only. The ids go in the event metadata through
 * `annotateAudit`: the store read (and the sale ref on the detail), the
 * filters (the sale number only as a flag) and the item count; never a row id.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { annotateAudit, Auditable } from "../audit/auditable.decorator";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import type { ConsoleSaleDetail, ConsoleSalePage } from "./console-sales.projections";
import {
  consoleFiltersOf,
  ConsoleSaleListQuerySchema,
  InvalidConsoleSaleCursorError,
  PAGE_SIZE_DEFAULT,
  SaleRefParamSchema,
  type ConsoleSaleListQuery,
} from "./console-sales.query";
import {
  ConsoleSaleNotFoundError,
  ConsoleSalesReadService,
  StoreNotInScopeError,
  type ScopedReadInput,
} from "./console-sales.service";

/**
 * The one 404 body of this surface: the `RolesGuard` role refusal's, so a role,
 * tenant, store or sale refusal cannot be told apart by its body (FR-ISO-4).
 */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: "validation_error", message });
}

/** The `console_sales.listed` metadata: the store, the filters and the count, never a row id. */
export function listAuditOf(storeId: string, query: ConsoleSaleListQuery, itemCount: number): Record<string, unknown> {
  const filters = consoleFiltersOf(query);
  return {
    store_id: storeId,
    from: filters.from,
    to: filters.to,
    sale_number_filtered: filters.saleNumber !== null,
    sync_status: filters.syncStatus,
    voided: filters.voided,
    return_state: filters.returnState,
    erp_posting_state: filters.erpPostingState,
    page_size: query.page_size ?? PAGE_SIZE_DEFAULT,
    continued: query.cursor !== undefined,
    item_count: itemCount,
  };
}

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class ConsoleSalesController {
  constructor(private readonly service: ConsoleSalesReadService) {}

  /** GET — one store's received sales over a business-date range, newest first. */
  @Get("api/v1/sales")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("console_sales.listed")
  @Header("Cache-Control", "no-store")
  async list(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ConsoleSaleListQuerySchema)) query: ConsoleSaleListQuery,
  ): Promise<ConsoleSalePage> {
    const scoped = requireTenant(request);
    let page: ConsoleSalePage;
    try {
      page = await this.service.list({
        ...scoped,
        storeId: query.store_id,
        filters: consoleFiltersOf(query),
        cursor: query.cursor ?? null,
        pageSize: query.page_size ?? PAGE_SIZE_DEFAULT,
      });
    } catch (err) {
      if (err instanceof InvalidConsoleSaleCursorError) throw validationError(err.message);
      if (err instanceof StoreNotInScopeError) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
    annotateAudit(request, listAuditOf(query.store_id, query, page.items.length));
    return page;
  }

  /** GET — the full recorded detail of one sale in the caller's store scope. */
  @Get("api/v1/sales/:saleRef")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("console_sales.detail_read")
  @Header("Cache-Control", "no-store")
  async get(
    @Req() request: TenantContextRequest,
    @Param("saleRef") rawSaleRef: string,
    @Query() query: Record<string, unknown>,
  ): Promise<ConsoleSaleDetail> {
    const scoped = requireTenant(request);
    // Request-shape errors, checked before any read: they disclose nothing.
    if (Object.keys(query).length > 0) throw validationError("this operation takes no query parameter");
    const parsed = SaleRefParamSchema.safeParse(rawSaleRef);
    if (!parsed.success) throw validationError("saleRef must be a valid UUID");
    let detail: ConsoleSaleDetail;
    try {
      detail = await this.service.get(scoped, parsed.data);
    } catch (err) {
      if (err instanceof ConsoleSaleNotFoundError) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
    annotateAudit(request, { sale_ref: parsed.data, store_id: detail.summary.storeRef });
    return detail;
  }
}

/** The session tenant + the context whose store scope bounds the read. */
function requireTenant(request: TenantContextRequest): ScopedReadInput {
  const ctx = request.context;
  if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
  return { tenantId: ctx.tenantId, context: ctx };
}
