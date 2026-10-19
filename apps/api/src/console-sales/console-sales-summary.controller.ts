/**
 * ConsoleSalesSummaryController — RT-649 (BC-009-1): the deterministic sales
 * summary (`console-sales-summary.openapi.yaml` 1.0.0-draft) for
 * Admin-Console spec 009 P-6 and a future Daily Briefing.
 *
 *   GET /api/v1/sales-summary  consoleGetSalesSummary
 *
 * Auth: the `console-sales` chain. The HUMAN `cookieAuth` session only →
 * `SessionOnlyAdminGuard` (every bearer is 401), `TenantContextGuard`, then
 * `RolesGuard` + `@Roles("owner", "tenant_admin", "store_manager")` (default
 * deny → 404). The guards run before the query is validated, so a refused
 * role is a 404 for any input. The store scope is applied by the service.
 *
 * Refusals: a malformed query or cursor is 400 `validation_error`; a role or
 * store outside the scope is the one non-disclosing 404 of `console-sales`.
 *
 * Audit: one `console_sales.summary_read` per 200, emitted by the request
 * audit interceptor. Metadata (`annotateAudit`): the scope mode, the store,
 * the range, the number of stores returned and whether a cursor was used;
 * never a figure.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
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
import { ConsoleRateLimit } from "../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import type { ConsoleSalesSummary } from "./console-sales-summary.projections";
import {
  ConsoleSalesSummaryQuerySchema,
  InvalidSalesSummaryCursorError,
  SUMMARY_PAGE_SIZE_DEFAULT,
  type ConsoleSalesSummaryQuery,
} from "./console-sales-summary.query";
import { ConsoleSalesSummaryService } from "./console-sales-summary.service";
import { StoreNotInScopeError } from "./console-sales.service";

/** The `console-sales` 404 body: a role and a store refusal cannot be told apart (FR-ISO-4). */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

/** The `console_sales.summary_read` metadata: never a figure. */
export function summaryAuditOf(query: ConsoleSalesSummaryQuery, storeCount: number): Record<string, unknown> {
  return {
    scope: query.store_id === undefined ? "all_in_scope" : "store",
    store_id: query.store_id ?? null,
    from: query.from,
    to: query.to,
    page_size: query.page_size ?? SUMMARY_PAGE_SIZE_DEFAULT,
    continued: query.cursor !== undefined,
    store_count: storeCount,
  };
}

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class ConsoleSalesSummaryController {
  constructor(private readonly service: ConsoleSalesSummaryService) {}

  /** GET — the KPIs of one store or of every store in the caller's scope. */
  @Get("api/v1/sales-summary")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Auditable("console_sales.summary_read")
  @Header("Cache-Control", "no-store")
  // RT-649: an aggregate over up to 31 business days of every store in scope.
  @ConsoleRateLimit("expensiveRead")
  async summary(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ConsoleSalesSummaryQuerySchema)) query: ConsoleSalesSummaryQuery,
  ): Promise<ConsoleSalesSummary> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
    let body: ConsoleSalesSummary;
    try {
      body = await this.service.summary({
        tenantId: ctx.tenantId,
        context: ctx,
        storeId: query.store_id ?? null,
        from: query.from,
        to: query.to,
        cursor: query.cursor ?? null,
        pageSize: query.page_size ?? SUMMARY_PAGE_SIZE_DEFAULT,
      });
    } catch (err) {
      if (err instanceof InvalidSalesSummaryCursorError) {
        throw new BadRequestException({ code: "validation_error", message: err.message });
      }
      if (err instanceof StoreNotInScopeError) throw new NotFoundException(NOT_FOUND);
      throw err;
    }
    annotateAudit(request, summaryAuditOf(query, body.stores.length));
    return body;
  }
}
