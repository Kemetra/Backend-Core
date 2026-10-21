/**
 * PosPayersController — RT-802: the till's payer lookup
 * (`pos-payers.openapi.yaml` 1.0.0-draft, RT-570):
 *   GET /api/pos/v1/payer-accounts  -> posListChargeablePayers
 *
 * Auth: `PosOperatorEnvelopeSaleGuard`, the operator-authorization envelope
 * only (no device path: option A makes credit an online manager / admin
 * action). Any envelope failure is its generic 401. Then the per-device rate
 * limit (ADR 0009), its own read bucket. Tenant, store and operator come only
 * from the guard-published context (§XII); the request carries no scope.
 *
 * Outcome order: 401 (guard), 403 `sale_responsibility_role_refused` (the
 * code and body `captureSale` uses), 400 `validation_error`, 200. The query is
 * taken raw and validated by the service after the role check, so a refused
 * operator never learns which query was malformed.
 *
 * Read-only: no audit event, no idempotency key. The 200 is `no-store`.
 */
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { PosOperatorEnvelopeSaleGuard } from "../../../auth/pos-operator-envelope-sale.guard";
import { PosWriteRateLimitBucket } from "../../../auth/pos-write-rate-limit.decorator";
import { PosWriteRateLimitGuard } from "../../../auth/pos-write-rate-limit.guard";
import type { TenantContextRequest } from "../../../context/types";
import { SaleResponsibilityRoleRefusedError } from "../sale-responsibilities";
import { InvalidPosPayersCursorError } from "./pos-payers.query";
import { PosPayersService, type PosPayerPage } from "./pos-payers.service";

@Controller()
export class PosPayersController {
  constructor(private readonly payers: PosPayersService) {}

  // The envelope guard runs FIRST (it publishes the scope), THEN the
  // per-device rate limit, which fails open.
  @Get("api/pos/v1/payer-accounts")
  @UseGuards(PosOperatorEnvelopeSaleGuard, PosWriteRateLimitGuard)
  @PosWriteRateLimitBucket("posReadPayers")
  @Header("Cache-Control", "no-store")
  async listChargeablePayers(
    @Req() request: TenantContextRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<PosPayerPage> {
    const ctx = request.context;
    if (!ctx?.tenantId || !ctx.storeId || !ctx.userId) throw new UnauthorizedException("Unauthorized");
    try {
      return await this.payers.list({ tenantId: ctx.tenantId, storeId: ctx.storeId, actorUserId: ctx.userId, rawQuery: query });
    } catch (err) {
      if (err instanceof SaleResponsibilityRoleRefusedError) {
        throw new ForbiddenException({ code: "sale_responsibility_role_refused", message: err.message });
      }
      if (err instanceof InvalidPosPayersCursorError) {
        throw new BadRequestException({ code: "validation_error", message: err.message });
      }
      throw err;
    }
  }
}
