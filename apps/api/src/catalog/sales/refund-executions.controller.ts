/**
 * RefundExecutionsController — the RT-490 return reads and refund executions
 * (Jira RT-787; `pos-sales/sales.yaml` 1.13.0-draft): `listSaleReturns`,
 * `readReturnByProvenance` and `recordRefundExecution`.
 *
 * Its own controller (no new SalesController dependency). Auth and context
 * mirror the sales routes: the reads use readSale's `PosOperatorAuthGuard` +
 * `TenantContextGuard`; the execution uses recordReturn's
 * `PosOperatorEnvelopeSaleGuard`, `@Idempotent("required")` (stores successful
 * responses only, so a refusal stores nothing) and an `@Auditable` event on
 * success. None of the three is behind `POS_RETURNS_ENABLED`: the reads report
 * facts already recorded, and a gated execution would strand a payout the
 * drawer already made. A malformed ref is the same non-disclosing 404 as an
 * unknown one, never a 500.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { annotateAudit, Auditable } from "../../audit/auditable.decorator";
import { PosOperatorAuthGuard } from "../../auth/pos-operator-auth.guard";
import { PosOperatorEnvelopeSaleGuard } from "../../auth/pos-operator-envelope-sale.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import {
  RecordRefundExecutionRequestSchema,
  ReturnProvenanceQuerySchema,
  type RecordRefundExecutionRequestDto,
  type ReturnProvenanceQueryDto,
} from "./dto/record-refund-execution-request.dto";
import {
  RefundExecutionExceedsAllocationError,
  RefundExecutionInvalidError,
  RefundExecutionsService,
} from "./refund-executions.service";
import type { RefundExecutionProjection, ReturnReadProjection } from "./return-reads";
import { toReversalHttpError } from "./sales.controller";

/** Canonical UUID shape (any version) — a ref that fails this never hits the DB. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PosScope {
  readonly tenantId: string;
  readonly storeId: string;
  readonly userId: string | null;
}

/** The resolved principal's scope; a malformed saleRef is a safe-404 (SI-004). */
function posScope(request: TenantContextRequest, saleRef: string): PosScope {
  const ctx = request.context;
  if (!ctx || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
  if (ctx.storeId === null) throw new UnauthorizedException("store_context_required");
  if (!UUID_RE.test(saleRef)) throw new NotFoundException("not_found");
  return { tenantId: ctx.tenantId, storeId: ctx.storeId, userId: ctx.userId };
}

function toExecutionHttpError(err: unknown): unknown {
  if (err instanceof RefundExecutionInvalidError) {
    return new BadRequestException({ code: "validation_error", message: err.message });
  }
  if (err instanceof RefundExecutionExceedsAllocationError) {
    return new UnprocessableEntityException({ code: "refund_execution_exceeds_allocation", message: err.message });
  }
  return toReversalHttpError(err);
}

@Controller()
export class RefundExecutionsController {
  constructor(private readonly refundExecutionsService: RefundExecutionsService) {}

  @Get("api/pos/v1/sales/:saleRef/returns")
  @UseGuards(PosOperatorAuthGuard, TenantContextGuard)
  @Auditable("pos_sales.returns_listed")
  async listSaleReturns(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
  ): Promise<{ saleRef: string; returns: ReturnReadProjection[] }> {
    const scope = posScope(request, saleRef);
    try {
      const returns = await this.refundExecutionsService.listSaleReturns({ ...scope, saleRef });
      annotateAudit(request, { sale_ref: saleRef });
      return { saleRef, returns };
    } catch (err) {
      throw toReversalHttpError(err);
    }
  }

  @Get("api/pos/v1/sales/:saleRef/returns/by-provenance")
  @UseGuards(PosOperatorAuthGuard, TenantContextGuard)
  @Auditable("pos_sales.return_read")
  async readReturnByProvenance(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
    @Query(new ZodValidationPipe(ReturnProvenanceQuerySchema)) query: ReturnProvenanceQueryDto,
  ): Promise<ReturnReadProjection> {
    const scope = posScope(request, saleRef);
    let read: ReturnReadProjection | null;
    try {
      read = await this.refundExecutionsService.readReturnByProvenance({ ...scope, saleRef }, query);
    } catch (err) {
      throw toReversalHttpError(err);
    }
    if (read === null) throw new NotFoundException("not_found");
    annotateAudit(request, { sale_ref: saleRef, return_ref: read.saleReturn.returnRef });
    return read;
  }

  @Post("api/pos/v1/sales/:saleRef/returns/:returnRef/executions")
  @UseGuards(PosOperatorEnvelopeSaleGuard)
  @Idempotent("required")
  @Auditable("sale.refund_executed")
  async recordRefundExecution(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
    @Param("returnRef") returnRef: string,
    @Body(new ZodValidationPipe(RecordRefundExecutionRequestSchema)) body: RecordRefundExecutionRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefundExecutionProjection> {
    const scope = posScope(request, saleRef);
    if (scope.userId === null) throw new UnauthorizedException("Unauthorized");
    if (!UUID_RE.test(returnRef)) throw new NotFoundException("not_found");
    try {
      const result = await this.refundExecutionsService.recordExecution({
        tenantId: scope.tenantId,
        storeId: scope.storeId,
        actorUserId: scope.userId,
        saleRef,
        returnRef,
        body,
      });
      if (result.created) {
        res.status(HttpStatus.CREATED);
      } else {
        // Provenance replay: the stored execution, no duplicate (FR-013).
        res.status(HttpStatus.OK);
        res.setHeader("Idempotent-Replayed", "true");
      }
      // Identifiers only (FR-AUDIT-3, §XIV).
      annotateAudit(request, {
        sale_ref: saleRef,
        return_ref: returnRef,
        execution_ref: result.projection.executionRef,
      });
      return result.projection;
    } catch (err) {
      throw toExecutionHttpError(err);
    }
  }
}
