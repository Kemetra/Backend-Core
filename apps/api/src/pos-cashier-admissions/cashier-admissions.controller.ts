/**
 * CashierAdmissionsController — RT-113 BC2 runtime of
 * `packages/contracts/openapi/pos-cashier-admissions.openapi.yaml`:
 *
 *   POST /api/pos/v1/cashier-admissions                   posCreateCashierAdmission
 *   POST /api/pos/v1/cashier-admissions/{admission_id}/end posEndCashierAdmission
 *   GET  /api/pos/v1/cashier-admissions/roster            posListCashierAdmissionRoster
 *
 * Auth: the role-named `device` scheme only — `@DeviceBearer()` +
 * `PosDeviceAuthGuard` (the paired terminal's opaque device token; no
 * operator credential). Tenant, store and device come from the device row
 * the guard resolved, never from the request.
 *
 * Outcome order: the guard answers 401 first; the Zod pipes answer 400; the
 * service decides 409 / 429 / 403 / `active_elsewhere` / `admitted`. Every
 * refusal is the generic `{error:{code:'refused'}}` 403 — the cause is only
 * in the server log and audit, keyed by request_id.
 */
import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";

import { PosDeviceAuthGuard } from "../auth/pos-device-auth.guard";
import { DeviceBearer } from "../auth/route-auth";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { TenantContextRequest } from "../context/types";
import { CashierAdmissionsService, type AdmitOutcome } from "./cashier-admissions.service";
import { deviceScopeOf } from "./device-scope";
import {
  AdmissionIdSchema,
  AdmissionRequestSchema,
  type AdmissionRequestInput,
  type AdmissionResponseBody,
  type EndedBody,
  type RosterBody,
} from "./dto";

const ERRORS: Record<Exclude<AdmitOutcome["kind"], "admitted" | "active_elsewhere">, () => HttpException> = {
  refused: () => new ForbiddenException({ code: "refused", message: "Forbidden" }),
  idempotency_conflict: () =>
    new ConflictException({
      code: "idempotency_key_conflict",
      message: "idempotency_key was already used with a different request body",
    }),
  rate_limited: () =>
    new HttpException(
      { code: "rate_limited", message: "Too many takeover requests" },
      HttpStatus.TOO_MANY_REQUESTS,
    ),
};

function toResponse(outcome: AdmitOutcome): AdmissionResponseBody {
  if (outcome.kind === "admitted") return outcome.body;
  if (outcome.kind === "active_elsewhere") return { kind: "active_elsewhere" };
  throw ERRORS[outcome.kind]();
}

@Controller("api/pos/v1/cashier-admissions")
@DeviceBearer()
@UseGuards(PosDeviceAuthGuard)
export class CashierAdmissionsController {
  constructor(private readonly service: CashierAdmissionsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async admit(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(AdmissionRequestSchema)) body: AdmissionRequestInput,
  ): Promise<AdmissionResponseBody> {
    const outcome = await this.service.admit(deviceScopeOf(request), body, request.requestId ?? null);
    return toResponse(outcome);
  }

  @Post(":admission_id/end")
  @HttpCode(HttpStatus.OK)
  async end(
    @Req() request: TenantContextRequest,
    @Param("admission_id", new ZodValidationPipe(AdmissionIdSchema)) admissionId: string,
  ): Promise<EndedBody> {
    return this.service.end(deviceScopeOf(request), admissionId, request.requestId ?? null);
  }

  @Get("roster")
  async roster(@Req() request: TenantContextRequest): Promise<RosterBody> {
    return this.service.roster(deviceScopeOf(request));
  }
}
