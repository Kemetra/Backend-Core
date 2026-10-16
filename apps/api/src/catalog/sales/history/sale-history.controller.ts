/**
 * SaleHistoryController — the POS sale history routes (Jira RT-539, RT-534
 * S3; contract `pos-sales/sale-history.yaml` 1.0.0-draft; owner decisions
 * OD-534-1..8, RT-534 comment 12048 / Confluence 40468506):
 *   GET  /api/pos/v1/sale-history                     -> listSaleHistory
 *   GET  /api/pos/v1/sale-history/{saleRef}           -> readSaleHistoryDetail
 *   POST /api/pos/v1/sale-history/{saleRef}/reprints  -> recordSaleReprint
 *
 * Auth: `SaleHistoryAuthGuard` (the envelope, or the device + an admitted
 * cashier). The published principal's scope decides visibility: `pos` (the
 * device path) is the admitted cashier's own sales, `pos_operator` (the
 * envelope) the whole store. Tenant, store and device always come from the
 * credential, never from the request (§XII).
 *
 * Audit (OD-534-7): one `sale_history.listed` per list request (filters and
 * count, no row ids) and one `sale_history.detail_read` per authorized open,
 * through the global interceptor; reprints are audited by the service, refusals
 * included (`sale-history.audit.ts`).
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";

import { annotateAudit, Auditable } from "../../../audit/auditable.decorator";
import { PosWriteRateLimitBucket } from "../../../auth/pos-write-rate-limit.decorator";
import { PosWriteRateLimitGuard } from "../../../auth/pos-write-rate-limit.guard";
import { DeviceBearer } from "../../../auth/route-auth";
import { ZodValidationPipe } from "../../../common/zod-validation.pipe";
import type { TenantContextRequest } from "../../../context/types";
import { Idempotent } from "../../../idempotency/idempotent.decorator";
import { SaleHistoryAuthGuard, SaleReprintRoute } from "./sale-history-auth.guard";
import type { SaleHistoryDetail } from "./sale-history.projections";
import {
  InvalidSaleHistoryCursorError,
  SaleHistoryListQuerySchema,
  SaleReprintRequestSchema,
  UUID_RE,
  type SaleHistoryFilters,
  type SaleHistoryListQuery,
  type SaleReprintRequestDto,
} from "./sale-history.query";
import {
  SaleHistoryNotFoundError,
  SaleHistoryService,
  type ReprintRefusalReason,
  type SaleHistoryPage,
  type SaleHistoryScope,
  type SaleReprintProjection,
} from "./sale-history.service";

interface CallerScope extends SaleHistoryScope {
  readonly actorUserId: string;
  readonly deviceId: string;
}

/**
 * The guard-published principal's path. Fail closed: only the envelope
 * (`pos_operator`) gets store visibility, only the device path (`pos`) gets
 * its cashier's own sales, and anything else is the generic 401.
 */
function pathOf(request: TenantContextRequest): "store" | "own_sales" {
  const principal = request.principal;
  if (principal?.kind !== "token") throw new UnauthorizedException("Unauthorized");
  if (principal.scope === "pos_operator") return "store";
  if (principal.scope === "pos") return "own_sales";
  throw new UnauthorizedException("Unauthorized");
}

/** A credential value the guard must have published; anything missing is the generic 401. */
function published<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new UnauthorizedException("Unauthorized");
  return value;
}

/** The caller's tenant, store, device and visibility, from the guard-published credential. */
export function callerScope(request: TenantContextRequest): CallerScope {
  const path = pathOf(request);
  const ctx = published(request.context);
  const userId = published(ctx.userId);
  const visibility = path === "own_sales" ? { kind: "own_sales" as const, userId } : { kind: "store" as const };
  return {
    tenantId: published(ctx.tenantId),
    storeId: published(ctx.storeId),
    actorUserId: userId,
    deviceId: published(request.posDeviceId),
    visibility,
  };
}

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: "validation_error", message });
}

/** These operations take no query parameter: an unknown key is a 400. */
function assertNoQuery(query: Record<string, unknown>): void {
  if (Object.keys(query).length > 0) throw validationError("unknown query parameter");
}

/** A malformed ref resolves like any invisible one: the non-disclosing 404 (never a DB 500). */
function saleRefOf(raw: string): string {
  if (!UUID_RE.test(raw)) throw new NotFoundException("not_found");
  return raw.toLowerCase();
}

/** The validated query as the filters the service and the cursor are bound to. */
export function listFiltersOf(query: SaleHistoryListQuery): SaleHistoryFilters {
  return {
    from: query.from,
    to: query.to,
    deviceRef: query.device_ref ?? null,
    operatorUserId: query.operator_user_id ?? null,
    saleNumber: query.sale_number ?? null,
  };
}

/**
 * The `sale_history.listed` metadata (OD-534-7): the filters and the count,
 * never a row id; the sale number filter only as a flag.
 */
export function listAuditOf(
  scope: CallerScope,
  query: SaleHistoryListQuery,
  itemCount: number,
): Record<string, unknown> {
  const filters = listFiltersOf(query);
  return {
    visibility: scope.visibility.kind,
    device_id: scope.deviceId,
    from: filters.from,
    to: filters.to,
    device_ref: filters.deviceRef,
    operator_user_id: filters.operatorUserId,
    sale_number_filtered: filters.saleNumber !== null,
    page_size: query.page_size,
    continued: query.cursor !== undefined,
    item_count: itemCount,
  };
}

export const REPRINT_REFUSALS: Readonly<Record<ReprintRefusalReason, () => Error>> = {
  not_visible: () => new NotFoundException("not_found"),
  not_capturing_device: () => new ForbiddenException({ code: "refused", message: "Forbidden" }),
  duplicate_unavailable: () =>
    new UnprocessableEntityException({
      code: "reprint_duplicate_unavailable",
      message: "a duplicate of this sale's original receipt is not available; request a sale_record",
    }),
  key_reused: () =>
    new ConflictException({ code: "idempotency_key_conflict", message: "Idempotency-Key reused with a different request" }),
};

@Controller()
export class SaleHistoryController {
  constructor(private readonly history: SaleHistoryService) {}

  // The auth guard runs FIRST (it publishes the principal and the device),
  // THEN the per-device rate limit (ADR 0009), which fails open.
  @Get("api/pos/v1/sale-history")
  @DeviceBearer()
  @UseGuards(SaleHistoryAuthGuard, PosWriteRateLimitGuard)
  @PosWriteRateLimitBucket("posReadSaleHistory")
  @Auditable("sale_history.listed")
  async listSaleHistory(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(SaleHistoryListQuerySchema)) query: SaleHistoryListQuery,
  ): Promise<SaleHistoryPage> {
    const scope = callerScope(request);
    if (scope.visibility.kind === "own_sales" && query.operator_user_id !== undefined) {
      // A cashier's visibility is their own sales; the operator filter is envelope-only.
      throw validationError("operator_user_id is not accepted on the device path");
    }
    let page: SaleHistoryPage;
    try {
      page = await this.history.listSales({
        ...scope,
        filters: listFiltersOf(query),
        cursor: query.cursor ?? null,
        pageSize: query.page_size,
      });
    } catch (err) {
      if (err instanceof InvalidSaleHistoryCursorError) throw validationError(err.message);
      throw err;
    }
    annotateAudit(request, listAuditOf(scope, query, page.items.length));
    return page;
  }

  @Get("api/pos/v1/sale-history/:saleRef")
  @DeviceBearer()
  @UseGuards(SaleHistoryAuthGuard, PosWriteRateLimitGuard)
  @PosWriteRateLimitBucket("posReadSaleHistory")
  @Auditable("sale_history.detail_read")
  async readSaleHistoryDetail(
    @Req() request: TenantContextRequest,
    @Param("saleRef") rawSaleRef: string,
    @Query() query: Record<string, unknown>,
  ): Promise<SaleHistoryDetail> {
    const scope = callerScope(request);
    assertNoQuery(query);
    const saleRef = saleRefOf(rawSaleRef);
    let detail: SaleHistoryDetail;
    try {
      detail = await this.history.readDetail(scope, saleRef);
    } catch (err) {
      if (err instanceof SaleHistoryNotFoundError) throw new NotFoundException("not_found");
      throw err;
    }
    annotateAudit(request, { sale_ref: saleRef, visibility: scope.visibility.kind, device_id: scope.deviceId });
    return detail;
  }

  @Post("api/pos/v1/sale-history/:saleRef/reprints")
  @DeviceBearer()
  @UseGuards(SaleHistoryAuthGuard, PosWriteRateLimitGuard)
  @PosWriteRateLimitBucket("posWriteSaleReprint")
  @SaleReprintRoute()
  @Idempotent("required")
  @HttpCode(HttpStatus.CREATED)
  async recordSaleReprint(
    @Req() request: TenantContextRequest,
    @Param("saleRef") rawSaleRef: string,
    @Query() query: Record<string, unknown>,
    @Headers("idempotency-key") idempotencyKey: string,
    @Body(new ZodValidationPipe(SaleReprintRequestSchema)) body: SaleReprintRequestDto,
  ): Promise<SaleReprintProjection> {
    const scope = callerScope(request);
    assertNoQuery(query);
    const saleRef = saleRefOf(rawSaleRef);
    const outcome = await this.history.recordReprint({
      ...scope,
      saleRef,
      idempotencyKey,
      requestId: request.requestId ?? null,
      body,
    });
    if (!outcome.ok) throw REPRINT_REFUSALS[outcome.reason]();
    return outcome.projection;
  }
}
