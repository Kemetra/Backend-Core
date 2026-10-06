/**
 * ShiftCashUpController — RT-17 slice 2b ([GATED] approval: Jira RT-17
 * comments 10760 + 10919 + 10920). Implements, from
 * `packages/contracts/openapi/pos-shifts.openapi.yaml` 1.1.0-draft:
 *
 *   POST /api/pos/v1/shifts                            → openShift
 *   POST /api/pos/v1/shifts/{shift_id}/cash-movements  → recordCashMovement
 *
 * The captureSale device path, reused (RT-224): `@DeviceBearer()` +
 * `ShiftCashUpAuthGuard` (envelope OR device bearer with a verified
 * `operatorUserId`), then the per-device write rate limit (ADR 0009; its 429
 * carries `RATE_LIMITED`), `@Idempotent("required")` (the existing
 * interceptor: identical retry → stored replay; same key, other body → 409
 * `idempotency_key_conflict`; in flight → 425) and `@Auditable`.
 *
 * Status: 201 for a first record; 200 with `Idempotent-Replayed: true` for a
 * natural-key replay under another key. Scope and actor come from the guard,
 * never from the body; the `operatorUserId` claim is dropped before the
 * service hashes the fact.
 */
import {
  Body,
  Controller,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { Auditable } from "../audit/auditable.decorator";
import { PosWriteRateLimitBucket } from "../auth/pos-write-rate-limit.decorator";
import { PosWriteRateLimitGuard } from "../auth/pos-write-rate-limit.guard";
import { DeviceBearer } from "../auth/route-auth";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { TenantContextRequest } from "../context/types";
import { Idempotent } from "../idempotency/idempotent.decorator";
import { deviceScopeOf } from "../pos-cashier-admissions/device-scope";
import { ShiftCashUpAuthGuard, ShiftFactRoute } from "./shift-cash-up-auth.guard";
import {
  OpenShiftRequestSchema,
  RecordCashMovementRequestSchema,
  ShiftIdParamSchema,
  type OpenShiftRequestDto,
  type RecordCashMovementRequestDto,
} from "./shift-cash-up.dto";
import { toShiftHttpError } from "./shift-cash-up.errors";
import type { CashMovementProjection, ShiftProjection } from "./shift-cash-up.projections";
import { ShiftCashUpService, type ShiftWriteContext, type ShiftWriteResult } from "./shift-cash-up.service";

/** The scope, actor and path the guard published; a gap is the generic 401. */
export function shiftWriteContext(
  request: TenantContextRequest,
  body: { readonly operatorUserId?: string | undefined },
): ShiftWriteContext {
  const scope = deviceScopeOf(request);
  const actorUserId = request.context?.userId;
  if (!actorUserId) throw new UnauthorizedException("Unauthorized");
  return { scope, actorUserId, path: body.operatorUserId !== undefined ? "device" : "envelope" };
}

/** Run a write, answering 201 or a 200 replay, with refusals mapped to the contract. */
async function respond<T>(res: Response, write: () => Promise<ShiftWriteResult<T>>): Promise<T> {
  let result: ShiftWriteResult<T>;
  try {
    result = await write();
  } catch (err) {
    throw toShiftHttpError(err);
  }
  if (result.created) {
    res.status(HttpStatus.CREATED);
  } else {
    res.status(HttpStatus.OK);
    res.setHeader("Idempotent-Replayed", "true");
  }
  return result.projection;
}

@Controller("api/pos/v1/shifts")
export class ShiftCashUpController {
  constructor(private readonly shifts: ShiftCashUpService) {}

  @Post()
  @DeviceBearer()
  @UseGuards(ShiftCashUpAuthGuard, PosWriteRateLimitGuard)
  @ShiftFactRoute({ schema: OpenShiftRequestSchema, timeField: "openedAt", actorField: "openingUserId" })
  @PosWriteRateLimitBucket("posWriteShift")
  @Idempotent("required")
  @Auditable("shift.opened")
  async openShift(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(OpenShiftRequestSchema)) body: OpenShiftRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ShiftProjection> {
    const ctx = shiftWriteContext(request, body);
    const { operatorUserId: _claim, ...fact } = body;
    return respond(res, () => this.shifts.openShift(ctx, fact));
  }

  @Post(":shift_id/cash-movements")
  @DeviceBearer()
  @UseGuards(ShiftCashUpAuthGuard, PosWriteRateLimitGuard)
  @ShiftFactRoute({ schema: RecordCashMovementRequestSchema, timeField: "occurredAt" })
  @PosWriteRateLimitBucket("posWriteShift")
  @Idempotent("required")
  @Auditable("shift.cash_movement.recorded")
  async recordCashMovement(
    @Req() request: TenantContextRequest,
    @Param("shift_id", new ZodValidationPipe(ShiftIdParamSchema)) shiftId: string,
    @Body(new ZodValidationPipe(RecordCashMovementRequestSchema)) body: RecordCashMovementRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CashMovementProjection> {
    const ctx = shiftWriteContext(request, body);
    const { operatorUserId: _claim, ...fact } = body;
    return respond(res, () => this.shifts.recordCashMovement(ctx, shiftId, fact));
  }
}
