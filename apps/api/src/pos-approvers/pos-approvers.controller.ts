/**
 * PosApproversController — RT-788 (RT-114 MA-BC2) runtime of
 * `packages/contracts/openapi/pos-approvers.openapi.yaml`:
 *
 *   POST /api/pos/v1/approvers/eligibility   posCheckApproverEligibility
 *
 * Auth: the role-named `device` scheme only — `@DeviceBearer()` +
 * `PosDeviceAuthGuard` (the paired terminal's opaque device token; no
 * operator credential). Tenant and store come from the device row the guard
 * resolved, never from the request.
 *
 * Outcome order: the guard answers 401 first; the Zod pipe answers 400; any
 * well-formed request is a 200, whatever the users are. It is a POST only so
 * the ids travel in the body; the 200 is `Cache-Control: no-store`.
 */
import { Body, Controller, Header, HttpCode, HttpStatus, Post, Req, UseGuards } from "@nestjs/common";

import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { DeviceBearer } from "../auth/route-auth";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { TenantContextRequest } from "../context/types";
import { deviceScopeOf } from "../pos-cashier-admissions/device-scope";
import { ApproverEligibilityService } from "./approver-eligibility.service";
import {
  ApproverEligibilityRequestSchema,
  type ApproverEligibilityRequestInput,
  type ApproverEligibilityResponseBody,
} from "./dto";

@Controller("api/pos/v1/approvers")
@DeviceBearer()
@UseGuards(PosDeviceAuthGuard)
export class PosApproversController {
  constructor(private readonly service: ApproverEligibilityService) {}

  @Post("eligibility")
  @HttpCode(HttpStatus.OK)
  @Header("Cache-Control", "no-store")
  async checkEligibility(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(ApproverEligibilityRequestSchema)) body: ApproverEligibilityRequestInput,
  ): Promise<ApproverEligibilityResponseBody> {
    return this.service.check(deviceScopeOf(request), body.user_ids, request.requestId ?? null);
  }
}
