/**
 * CreditSaleReversalsController — `recordCreditSaleReversal`
 * (`POST /api/pos/v1/sales/{saleRef}/credit-reversals`; Jira RT-577,
 * `pos-sales/sales.yaml` 1.11.0-draft).
 *
 * Auth / context / idempotency / audit mirror `recordVoid`: the operator
 * envelope guard resolves the principal onto `req.context` (tenant, store and
 * actor never come from the body, FR-061); `@Idempotent("required")` engages
 * the global interceptor, which stores successful responses only, so a refusal
 * stores no entry; `@Auditable("sale.credit_reversed")` emits on success only,
 * annotated with the decision's evidence. A `kind: return` is behind the
 * `POS_RETURNS_ENABLED` gate like `recordReturn` (404, nothing recorded).
 */
import {
  Body,
  Controller,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { annotateAudit, Auditable } from "../../audit/auditable.decorator";
import { PosOperatorEnvelopeSaleGuard } from "../../auth/pos-operator-envelope-sale.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import type { TenantContextRequest } from "../../context/types";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import {
  CreditReturnApprovalRefusedError,
  CreditReturnApprovalRequiredError,
  CreditReversalAllocationUnavailableError,
  CreditReversalNotApplicableError,
  CreditReversalRefundMismatchError,
  CreditReversalRoleRefusedError,
  CreditReversalSettlementUnavailableError,
} from "./credit-sale-reversal.checks";
import { CreditSaleReversalService } from "./credit-sale-reversal.service";
import type { CreditSaleReversalProjection } from "./credit-sale-reversal.store";
import {
  CreditSaleReversalRequestSchema,
  type CreditSaleReversalRequestDto,
} from "./dto/credit-sale-reversal-request.dto";
import { isPosReturnsEnabled } from "./returns-gate";
import { toReversalHttpError } from "./sales.controller";

/** Canonical UUID shape (any version) — a saleRef that fails this never hits the DB. */
const SALE_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The credit-reversal refusals (`CreditReversalForbidden` / `CreditReversalUnprocessable`). */
const CREDIT_REFUSALS: ReadonlyArray<readonly [new () => Error, 403 | 422, string]> = [
  [CreditReversalRoleRefusedError, 403, "credit_reversal_role_refused"],
  [CreditReturnApprovalRequiredError, 403, "credit_return_approval_required"],
  [CreditReturnApprovalRefusedError, 403, "credit_return_approval_refused"],
  [CreditReversalNotApplicableError, 422, "credit_reversal_not_applicable"],
  [CreditReversalAllocationUnavailableError, 422, "credit_reversal_allocation_unavailable"],
  [CreditReversalSettlementUnavailableError, 422, "credit_reversal_settlement_unavailable"],
  [CreditReversalRefundMismatchError, 422, "credit_reversal_refund_mismatch"],
];

function toCreditReversalHttpError(err: unknown): unknown {
  for (const [type, status, code] of CREDIT_REFUSALS) {
    if (err instanceof type) {
      const body = { code, message: err.message };
      return status === 403 ? new ForbiddenException(body) : new UnprocessableEntityException(body);
    }
  }
  return toReversalHttpError(err);
}

@Controller()
export class CreditSaleReversalsController {
  constructor(private readonly creditSaleReversalService: CreditSaleReversalService) {}

  @Post("api/pos/v1/sales/:saleRef/credit-reversals")
  @UseGuards(PosOperatorEnvelopeSaleGuard)
  @Idempotent("required")
  @Auditable("sale.credit_reversed")
  async recordCreditSaleReversal(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
    @Body(new ZodValidationPipe(CreditSaleReversalRequestSchema))
    body: CreditSaleReversalRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CreditSaleReversalProjection> {
    if (body.kind === "return" && !isPosReturnsEnabled()) {
      throw new NotFoundException("not_found");
    }
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      throw new UnauthorizedException("store_context_required");
    }
    if (!SALE_REF_RE.test(saleRef)) {
      throw new NotFoundException("not_found");
    }
    try {
      const result = await this.creditSaleReversalService.record({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        actorUserId: ctx.userId,
        saleRef,
        body,
      });
      if (result.created) {
        res.status(HttpStatus.CREATED);
      } else {
        // Provenance replay: the stored reversal, no duplicate (FR-013).
        res.status(HttpStatus.OK);
        res.setHeader("Idempotent-Replayed", "true");
      }
      annotateAudit(request, result.audit);
      return result.projection;
    } catch (err) {
      throw toCreditReversalHttpError(err);
    }
  }
}
