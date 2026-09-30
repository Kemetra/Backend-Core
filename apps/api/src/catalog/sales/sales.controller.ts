/**
 * SalesController — 008 US1 capture (T035).
 *
 * Implements the `captureSale` (+ `readSale`) operationIds from
 * `packages/contracts/openapi/pos-sales/sales.yaml`:
 *   POST /api/pos/v1/sales            → captureSale
 *   GET  /api/pos/v1/sales/{saleRef}  → readSale
 *
 * Auth / context: mirrors `posCaptureItem` — `@UseGuards(PosOperatorAuthGuard,
 * TenantContextGuard)` resolve the POS principal onto `req.context`; the
 * tenant/store/actor come from there and are NEVER read from the body
 * (FR-061). Body strictness (FR-062) is enforced by the `.strict()` Zod DTO.
 *
 * Idempotency: `@Idempotent("required")` engages the existing global
 * IdempotencyInterceptor (FR-051) — no new primitive. Provenance dedup
 * (FR-050) is enforced independently in the service, so a re-delivery with a
 * different Idempotency-Key still resolves to the same sale.
 *
 * Audit: `@Auditable("sale.captured")` is passive metadata read by the global
 * AuditEmitterInterceptor (FR-090).
 *
 * Status: 201 for a fresh capture; 200 with `Idempotent-Replayed: true` for a
 * provenance dedup-hit (deterministic, identical body — FR-100).
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
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

import { Auditable } from "../../audit/auditable.decorator";
import { PosOperatorAuthGuard } from "../../auth/pos-operator-auth.guard";
import { PosOperatorEnvelopeSaleGuard } from "../../auth/pos-operator-envelope-sale.guard";
import { PosWriteRateLimitGuard } from "../../auth/pos-write-rate-limit.guard";
import { PosWriteRateLimitBucket } from "../../auth/pos-write-rate-limit.decorator";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import { type CaptureSaleRequestDto } from "./dto/capture-sale-request.dto";
import { CaptureSaleRequestPipe } from "./dto/capture-sale-request.pipe";
import {
  RecordVoidRequestSchema,
  type RecordVoidRequestDto,
} from "./dto/record-void-request.dto";
import {
  RecordRefundRequestSchema,
  type RecordRefundRequestDto,
} from "./dto/record-refund-request.dto";
import {
  RecordReturnRequestSchema,
  type RecordReturnRequestDto,
} from "./dto/record-return-request.dto";
import { isPosReturnsEnabled } from "./returns-gate";
import {
  SaleReturnsService,
  type SaleReturnProjection,
} from "./sale-returns.service";
import {
  ReturnLineInvalidError,
  ReturnOverReturnError,
  ReturnTenderMismatchError,
  SaleAlreadyReversedError,
} from "./sale-reversal";
import {
  SalesService,
  SaleLinePricingInvalidError,
  SaleNotFoundError,
  SaleTenderMismatchError,
  SaleTenderReplayConflictError,
  TerminalEventProvenanceConflictError,
  type SaleProjection,
  type TerminalEventProjection,
} from "./sales.service";

/**
 * Map a capture service error to its contract response (RT-77). The filter's
 * status fallback has no 422 case, so the code is passed explicitly.
 */
function toCaptureHttpError(err: unknown): unknown {
  if (err instanceof SaleTenderMismatchError) {
    return new UnprocessableEntityException({
      code: "sale_tender_mismatch",
      message: "tenders do not sum to posTotal",
    });
  }
  if (err instanceof SaleLinePricingInvalidError) {
    return new UnprocessableEntityException({
      code: "sale_line_pricing_invalid",
      message: "a sale line's price, amount or quantity breaks the price invariant",
    });
  }
  if (err instanceof SaleTenderReplayConflictError) {
    // The contract's single 409 wire code (sales.yaml `Conflict`): the same
    // provenance reused with a different logical payload.
    return new ConflictException({
      code: "idempotency_key_conflict",
      message: "sale already captured with different tenders",
    });
  }
  return err;
}

/** Canonical UUID shape (any version) — a saleRef that fails this never hits the DB. */
const SALE_REF_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map a void / return service error to its contract response. Every code is
 * passed explicitly: the filter's status fallback has no 422 case.
 */
function toReversalHttpError(err: unknown): unknown {
  if (err instanceof SaleNotFoundError) {
    // Cross-tenant / cross-store / unknown sale are indistinguishable.
    return new NotFoundException("not_found");
  }
  if (err instanceof TerminalEventProvenanceConflictError) {
    // Provenance reused for a different sale or payload → 409 (FR-013).
    return new ConflictException("conflict");
  }
  if (err instanceof SaleAlreadyReversedError) {
    return new ConflictException({ code: "already_reversed", message: "sale already reversed" });
  }
  if (err instanceof ReturnOverReturnError) {
    return new ConflictException({ code: "over_return", message: "return exceeds the returnable quantity" });
  }
  if (err instanceof ReturnTenderMismatchError) {
    return new UnprocessableEntityException({
      code: "return_tender_mismatch",
      message: "refund tenders do not match the return total",
    });
  }
  if (err instanceof ReturnLineInvalidError) {
    return new BadRequestException({ code: "validation_error", message: "lineRef is not a line of this sale" });
  }
  return err;
}

@Controller()
export class SalesController {
  constructor(
    private readonly salesService: SalesService,
    private readonly saleReturnsService: SaleReturnsService,
  ) {}

  @Post("api/pos/v1/sales")
  // Guard order matters: the envelope guard runs FIRST (resolves
  // request.principal + the bound device), THEN the per-device rate limit
  // (ADR 0009) throttles on the resolved device. The rate limit fails open on a
  // Redis/lookup error, so it never blocks a write the envelope guard admitted.
  @UseGuards(PosOperatorEnvelopeSaleGuard, PosWriteRateLimitGuard)
  @PosWriteRateLimitBucket("posWriteSale")
  @Idempotent("required")
  @Auditable("sale.captured")
  async captureSale(
    @Req() request: TenantContextRequest,
    // RT-77: the schema is chosen per request by POS_SALE_TENDERS_ENABLED
    // (default off → the pre-RT-77 strict body, `tenders` is a 400).
    @Body(CaptureSaleRequestPipe)
    body: CaptureSaleRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SaleProjection> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      // A POS sale MUST resolve a store binding (FR-001).
      throw new UnauthorizedException("store_context_required");
    }
    // RT-77 (RT-10 D7(i)): the envelope guard's bound device is the sale's
    // device — never a body field. A request the guard did not resolve to a
    // device is refused (the settlement-intent precedent).
    if (!request.posDeviceId) throw new UnauthorizedException("Unauthorized");

    let result;
    try {
      result = await this.salesService.captureSale({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        actorUserId: ctx.userId,
        deviceId: request.posDeviceId,
        body,
      });
    } catch (err) {
      throw toCaptureHttpError(err);
    }

    if (result.created) {
      res.status(HttpStatus.CREATED);
    } else {
      // Provenance dedup-hit: deterministic replay, identical body (FR-100).
      res.status(HttpStatus.OK);
      res.setHeader("Idempotent-Replayed", "true");
    }
    return result.projection;
  }

  @Get("api/pos/v1/sales/:saleRef")
  @UseGuards(PosOperatorAuthGuard, TenantContextGuard)
  async readSale(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
  ): Promise<SaleProjection> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      // Reads are store-scoped: a POS principal may only read sales captured
      // within its own store (spec §120/§449, FR-063). Mirrors captureSale.
      throw new UnauthorizedException("store_context_required");
    }
    if (!SALE_REF_RE.test(saleRef)) {
      // Non-disclosing input guard: a malformed ref must not reach the DB (an
      // invalid uuid would surface as a 500). Treat it as a safe-404.
      throw new NotFoundException("not_found");
    }
    try {
      return await this.salesService.readSaleProjection(
        ctx.tenantId,
        ctx.storeId,
        saleRef,
      );
    } catch (err) {
      if (err instanceof SaleNotFoundError) {
        // Non-disclosing 404 — cross-tenant / cross-store / absent are
        // indistinguishable (FR-063/102, SI-004).
        throw new NotFoundException("not_found");
      }
      throw err;
    }
  }

  @Post("api/pos/v1/sales/:saleRef/void")
  @UseGuards(PosOperatorEnvelopeSaleGuard)
  @Idempotent("required")
  @Auditable("sale.voided")
  async recordVoid(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
    @Body(new ZodValidationPipe(RecordVoidRequestSchema))
    body: RecordVoidRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TerminalEventProjection> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.userId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    if (ctx.storeId === null) {
      throw new UnauthorizedException("store_context_required");
    }
    if (!SALE_REF_RE.test(saleRef)) {
      // A malformed ref is a non-disclosing safe-404, never a 500 (SI-004).
      throw new NotFoundException("not_found");
    }
    try {
      const result = await this.salesService.recordVoid({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        actorUserId: ctx.userId,
        saleRef,
        body,
      });
      if (result.created) {
        res.status(HttpStatus.CREATED);
      } else {
        // Provenance dedup-hit: deterministic replay, no duplicate (FR-013).
        res.status(HttpStatus.OK);
        res.setHeader("Idempotent-Replayed", "true");
      }
      return result.projection;
    } catch (err) {
      throw toReversalHttpError(err);
    }
  }

  /**
   * RT-73 line-aware return (RT-14 D1–D3). Behind the AC4 deployment gate:
   * until `POS_RETURNS_ENABLED` is on, the route answers 404 and records
   * nothing, so no `return` reversal reaches a Connector that predates RT-16.
   */
  @Post("api/pos/v1/sales/:saleRef/returns")
  @UseGuards(PosOperatorEnvelopeSaleGuard)
  @Idempotent("required")
  @Auditable("sale.returned")
  async recordReturn(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
    @Body(new ZodValidationPipe(RecordReturnRequestSchema))
    body: RecordReturnRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SaleReturnProjection> {
    if (!isPosReturnsEnabled()) {
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
      const result = await this.saleReturnsService.recordReturn({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        actorUserId: ctx.userId,
        saleRef,
        body,
      });
      if (result.created) {
        res.status(HttpStatus.CREATED);
      } else {
        // Provenance replay: identical stored return, no duplicate (FR-013).
        res.status(HttpStatus.OK);
        res.setHeader("Idempotent-Replayed", "true");
      }
      return result.projection;
    } catch (err) {
      throw toReversalHttpError(err);
    }
  }

  @Post("api/pos/v1/sales/:saleRef/refund")
  @UseGuards(PosOperatorEnvelopeSaleGuard)
  @Idempotent("required")
  @Auditable("sale.refunded")
  async recordRefund(
    @Req() request: TenantContextRequest,
    @Param("saleRef") saleRef: string,
    @Body(new ZodValidationPipe(RecordRefundRequestSchema))
    body: RecordRefundRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TerminalEventProjection> {
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
      const result = await this.salesService.recordRefund({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        actorUserId: ctx.userId,
        saleRef,
        body,
      });
      if (result.created) {
        res.status(HttpStatus.CREATED);
      } else {
        res.status(HttpStatus.OK);
        res.setHeader("Idempotent-Replayed", "true");
      }
      return result.projection;
    } catch (err) {
      if (err instanceof SaleNotFoundError) {
        throw new NotFoundException("not_found");
      }
      if (err instanceof TerminalEventProvenanceConflictError) {
        // Refund provenance reused for a different sale → 409 (FR-013).
        throw new ConflictException("conflict");
      }
      throw err;
    }
  }
}
