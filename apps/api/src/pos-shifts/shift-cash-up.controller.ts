/**
 * ShiftCashUpController — RT-17 slice 2b ([GATED] approval: Jira RT-17
 * comments 10760 + 10919 + 10920). Implements, from
 * `packages/contracts/openapi/pos-shifts.openapi.yaml` 1.1.0-draft:
 *
 *   POST /api/pos/v1/shifts                            → openShift
 *   POST /api/pos/v1/shifts/{shift_id}/cash-movements  → recordCashMovement
 *   POST /api/pos/v1/shifts/{shift_id}/close           → closeShift (slice 2b-2)
 *   POST /api/pos/v1/shifts/{shift_id}/forced-close    → forceCloseShift (RT-742, 1.4.0-draft)
 *
 * The captureSale device path, reused (RT-224): `@DeviceBearer()` +
 * `ShiftCashUpAuthGuard` (envelope OR device bearer with a verified
 * `operatorUserId`), then the per-device write rate limit (ADR 0009; its 429
 * carries `RATE_LIMITED`), `@Idempotent("required")` (the existing
 * interceptor: identical retry → stored replay; same key, other body → 409
 * `idempotency_key_conflict`; in flight → 425) and `@Auditable`.
 *
 * forceCloseShift is the manager envelope ONLY (no `@DeviceBearer`, so the
 * global FailClosedAuthGuard's opaque-token lookup refuses a device token
 * with the generic 401), then PosOperatorEnvelopeSaleGuard's live re-check of
 * membership, device, store access and the owner / tenant_admin /
 * store_manager role (generic 401), the same rate limit, idempotency and
 * audit. The audit metadata names the shift and both terminals, never the
 * reason.
 *
 * Status: 201 for a first record; 200 with `Idempotent-Replayed: true` for a
 * natural-key replay under another key. Scope, actor and auth path come from
 * the guard, never from the body; the `operatorUserId` claim is dropped before the
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

import { Auditable, annotateAudit } from "../audit/auditable.decorator";
import { PosWriteRateLimitBucket } from "../auth/pos-write-rate-limit.decorator";
import { PosWriteRateLimitGuard } from "../auth/pos-write-rate-limit.guard";
import { PosOperatorEnvelopeSaleGuard } from "../auth/pos-operator-envelope-sale.guard";
import { DeviceBearer } from "../auth/route-auth";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import type { TenantContextRequest } from "../context/types";
import { Idempotent } from "../idempotency/idempotent.decorator";
import { deviceScopeOf } from "../pos-cashier-admissions/device-scope";
import { ShiftCashUpAuthGuard, ShiftFactRoute } from "./shift-cash-up-auth.guard";
import {
  CloseShiftRequestSchema,
  ForceCloseShiftRequestSchema,
  OpenShiftRequestSchema,
  RecordCashMovementRequestSchema,
  ShiftIdParamSchema,
  type CloseShiftRequestDto,
  type ForceCloseShiftRequestDto,
  type OpenShiftRequestDto,
  type RecordCashMovementRequestDto,
} from "./shift-cash-up.dto";
import { toShiftHttpError } from "./shift-cash-up.errors";
import type { CashMovementProjection, ShiftProjection } from "./shift-cash-up.projections";
import {
  ShiftForceCloseService,
  type ForceCloseContext,
  type ForceClosedShiftProjection,
} from "./shift-force-close.service";
import {
  ShiftCashUpService,
  type ShiftAuthPath,
  type ShiftWriteContext,
  type ShiftWriteResult,
} from "./shift-cash-up.service";

/**
 * The auth path, from the principal the guard published (PR #713 review #3):
 * `pos` is the device path (ShiftCashUpAuthGuard), `pos_operator` the
 * envelope path (PosOperatorEnvelopeSaleGuard). Never re-read from the body.
 */
const PATH_OF_SCOPE: ReadonlyMap<string, ShiftAuthPath> = new Map([
  ["pos", "device"],
  ["pos_operator", "envelope"],
]);

/** The scope, actor and path the guard published; a gap is the generic 401. */
export function shiftWriteContext(request: TenantContextRequest): ShiftWriteContext {
  const scope = deviceScopeOf(request);
  const actorUserId = request.context?.userId;
  const principal = request.principal;
  const path = principal?.kind === "token" ? PATH_OF_SCOPE.get(principal.scope) : undefined;
  if (!actorUserId || path === undefined) throw new UnauthorizedException("Unauthorized");
  return { scope, actorUserId, path };
}

/**
 * RT-742: what PosOperatorEnvelopeSaleGuard published for forceCloseShift.
 * Only an envelope (`pos_operator`) principal with a full scope, its bound
 * terminal and its own session reaches the service; anything else is the
 * generic 401.
 */
export function forceCloseContext(request: TenantContextRequest): ForceCloseContext {
  const principal = request.principal;
  const tokenId = principal?.kind === "token" && principal.scope === "pos_operator" ? principal.tokenId : null;
  const { userId, tenantId, storeId } = request.context ?? {};
  const callerDeviceId = request.posDeviceId;
  if (!tokenId || !userId || !tenantId || !storeId || !callerDeviceId) throw new UnauthorizedException("Unauthorized");
  return { tenantId, storeId, actorUserId: userId, callerDeviceId, callerTokenId: tokenId };
}

/** A forced close is manager-envelope only (contract "Forced close"). */
function isForcedClose(body: Readonly<Record<string, unknown>>): boolean {
  return body["closeKind"] === "forced";
}

/** Run a write, answering 201 or a 200 replay, with refusals mapped to the contract. */
async function respond<T>(res: Response, write: () => Promise<ShiftWriteResult<T>>): Promise<T> {
  return settle(res, await mapped(write));
}

/** The write's result, its refusals mapped to the contract. */
async function mapped<R>(write: () => Promise<R>): Promise<R> {
  try {
    return await write();
  } catch (err) {
    throw toShiftHttpError(err);
  }
}

/** 201 for a first record; 200 with `Idempotent-Replayed: true` for a replay. */
function settle<T>(res: Response, result: ShiftWriteResult<T>): T {
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
  constructor(
    private readonly shifts: ShiftCashUpService,
    private readonly forceCloses: ShiftForceCloseService,
  ) {}

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
    const ctx = shiftWriteContext(request);
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
    const ctx = shiftWriteContext(request);
    const { operatorUserId: _claim, ...fact } = body;
    return respond(res, () => this.shifts.recordCashMovement(ctx, shiftId, fact));
  }

  @Post(":shift_id/close")
  @DeviceBearer()
  @UseGuards(ShiftCashUpAuthGuard, PosWriteRateLimitGuard)
  @ShiftFactRoute({
    schema: CloseShiftRequestSchema,
    timeField: "closedAt",
    actorField: "closingUserId",
    envelopeOnly: isForcedClose,
  })
  @PosWriteRateLimitBucket("posWriteShift")
  @Idempotent("required")
  @Auditable("shift.closed")
  async closeShift(
    @Req() request: TenantContextRequest,
    @Param("shift_id", new ZodValidationPipe(ShiftIdParamSchema)) shiftId: string,
    @Body(new ZodValidationPipe(CloseShiftRequestSchema)) body: CloseShiftRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ShiftProjection> {
    const ctx = shiftWriteContext(request);
    const { operatorUserId: _claim, ...fact } = body;
    return respond(res, () => this.shifts.closeShift(ctx, shiftId, fact));
  }

  @Post(":shift_id/forced-close")
  @UseGuards(PosOperatorEnvelopeSaleGuard, PosWriteRateLimitGuard)
  @PosWriteRateLimitBucket("posWriteShift")
  @Idempotent("required")
  @Auditable("shift.force_closed")
  async forceCloseShift(
    @Req() request: TenantContextRequest,
    @Param("shift_id", new ZodValidationPipe(ShiftIdParamSchema)) shiftId: string,
    @Body(new ZodValidationPipe(ForceCloseShiftRequestSchema)) body: ForceCloseShiftRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ForceClosedShiftProjection> {
    const ctx = forceCloseContext(request);
    const result = await mapped(() => this.forceCloses.forceClose(ctx, shiftId, body));
    annotateAudit(request, { ...result.audit });
    return settle(res, result);
  }
}
