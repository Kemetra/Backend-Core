/**
 * CashVariancePolicyDeviceController — RT-387: `posGetCashVariancePolicy`
 * (`cash-variance-policy.openapi.yaml` 1.0.0-draft).
 *
 *   GET /api/pos/v1/store/cash-variance-policy
 *
 * Auth: the paired terminal's `devices` pairing token (`PosDeviceAuthGuard`,
 * the read-down / branding scheme). Tenant and store come only from the device
 * row; no query parameter is accepted (an unknown key is 400).
 *
 * Conditional read (AD-CASH-001 D-5): a strong `ETag` over the resolved
 * policy (not `serverTime`), so an override expiry changes it with no write.
 * An `If-None-Match` equal to it is `304` with no body; a malformed one is
 * 400. Both answers carry `Cache-Control: no-cache, private`.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { annotateAudit, Auditable } from "../audit/auditable.decorator";
import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { DeviceBearer } from "../auth/route-auth";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { TenantContextRequest } from "../context/types";
import { policyEtag, type DevicePolicyBody } from "./policy.projections";
import { DeviceReadQuerySchema, IfNoneMatchSchema } from "./policy.query";
import { CashVariancePolicyService } from "./policy.service";

const CACHE_CONTROL = "no-cache, private";

@Controller()
export class CashVariancePolicyDeviceController {
  constructor(private readonly service: CashVariancePolicyService) {}

  @Get("api/pos/v1/store/cash-variance-policy")
  @DeviceBearer()
  @UseGuards(PosDeviceAuthGuard)
  @Auditable("cash_variance_policy.device_read")
  async read(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(DeviceReadQuerySchema)) _query: Record<string, never>,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DevicePolicyBody | undefined> {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null || ctx.storeId === null) throw new UnauthorizedException("Unauthorized");
    const etagWanted = IfNoneMatchSchema.safeParse(ifNoneMatch);
    if (!etagWanted.success) {
      throw new BadRequestException({ code: "validation_error", message: "If-None-Match is not a valid ETag." });
    }
    if (request.posDeviceId !== undefined) annotateAudit(request, { device_id: request.posDeviceId });

    const body = await this.service.deviceRead({ tenantId: ctx.tenantId, storeId: ctx.storeId });
    const etag = policyEtag(body);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", CACHE_CONTROL);
    if (etagWanted.data === etag) {
      res.status(304);
      return undefined;
    }
    return body;
  }
}
