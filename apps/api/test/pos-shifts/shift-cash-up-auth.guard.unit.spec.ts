/**
 * RT-17 slice 2b — ShiftCashUpAuthGuard unit spec. Docker-free.
 *
 * The captureSale credential model (RT-224) on the cash-up writes: the
 * envelope path delegates to the envelope guard alone; the device path
 * (selected by `operatorUserId`) runs the device guard, the route's strict
 * body, the stated-user rule (#711 review note 1) and the attribution
 * verifier at the fact's own time, then publishes the verified cashier.
 * A refused claim is the generic 403 `refused` with a fixed log event; a
 * bad credential the generic 401. The SQL is covered by the HTTP suites.
 */
import "reflect-metadata";

import { ForbiddenException, HttpException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ZodError } from "zod";

import type { AttributionVerdict } from "../../src/catalog/sales/operator-attribution";
import type { TenantContextRequest } from "../../src/context/types";
import {
  SHIFT_FACT_ROUTE_KEY,
  ShiftCashUpAuthGuard,
  shiftRefusalEvent,
  type ShiftFactRouteSpec,
} from "../../src/pos-shifts/shift-cash-up-auth.guard";
import { ShiftCashUpController } from "../../src/pos-shifts/shift-cash-up.controller";
import { OpenShiftRequestSchema, RecordCashMovementRequestSchema } from "../../src/pos-shifts/shift-cash-up.dto";

const SCOPE = {
  tenantId: "0e170000-0000-4000-8000-0000000a0001",
  storeId: "0e170000-0000-4000-8000-0000000a5001",
  deviceId: "0e170000-0000-4000-8000-0000000e0001",
};
const CASHIER = "0e170000-0000-4000-8000-0000000c0001";
const OTHER_USER = "0e170000-0000-4000-8000-0000000c0002";
const OPENED_AT = "2026-10-05T08:00:00Z";

const OPEN_ROUTE: ShiftFactRouteSpec = {
  schema: OpenShiftRequestSchema,
  timeField: "openedAt",
  actorField: "openingUserId",
};
const MOVEMENT_ROUTE: ShiftFactRouteSpec = { schema: RecordCashMovementRequestSchema, timeField: "occurredAt" };

const openBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  shiftId: "0192f5a2-3b4c-7d8e-9f01-23456789ab01",
  openedAt: OPENED_AT,
  openingUserId: CASHIER,
  currencyCode: "EGP",
  openingFloat: "500.00",
  operatorUserId: CASHIER,
  ...extra,
});

/** A request and the route spec its handler carries (none → undefined). */
interface Call {
  readonly body: unknown;
  readonly route?: ShiftFactRouteSpec;
}

function contextFor(call: Call): { ctx: ExecutionContext; request: TenantContextRequest } {
  const request = { headers: {}, body: call.body, requestId: "req-1" } as unknown as TenantContextRequest;
  const handler = (): void => undefined;
  if (call.route !== undefined) Reflect.defineMetadata(SHIFT_FACT_ROUTE_KEY, call.route, handler);
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;
  return { ctx, request };
}

/** The device guard, publishing what PosDeviceAuthGuard publishes. */
const deviceGate = {
  canActivate: jest.fn(async (ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<TenantContextRequest>();
    req.context = { userId: null, tenantId: SCOPE.tenantId, storeId: SCOPE.storeId, isPlatformAdmin: false, source: "token" };
    req.posDeviceId = SCOPE.deviceId;
    return true;
  }),
};
const envelopeGate = { canActivate: jest.fn(async () => true) };
const verify = jest.fn<Promise<AttributionVerdict>, [unknown]>();
const warn = jest.fn();
const guard = new ShiftCashUpAuthGuard(envelopeGate, deviceGate, { verify }, { warn });

beforeEach(() => {
  jest.clearAllMocks();
  verify.mockResolvedValue({ ok: true });
});

describe("ShiftCashUpAuthGuard — envelope path", () => {
  it("a body without operatorUserId goes to the envelope guard alone", async () => {
    const { ctx } = contextFor({ body: { shiftId: "x" }, route: OPEN_ROUTE });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect([envelopeGate.canActivate.mock.calls.length, deviceGate.canActivate.mock.calls.length]).toEqual([1, 0]);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("ShiftCashUpAuthGuard — device path", () => {
  it("verifies the claim at the open's time and publishes the cashier as the actor", async () => {
    const { ctx, request } = contextFor({ body: openBody(), route: OPEN_ROUTE });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith({ ...SCOPE, userId: CASHIER, occurredAt: OPENED_AT });
    const published = { context: request.context, principal: request.principal };
    expect(published).toMatchObject({
      context: { userId: CASHIER, tenantId: SCOPE.tenantId, storeId: SCOPE.storeId },
      principal: { userId: CASHIER, tokenId: SCOPE.deviceId, scope: "pos" },
    });
    expect(envelopeGate.canActivate).not.toHaveBeenCalled();
  });

  it("a movement route has no stated user: only the verifier decides, at occurredAt", async () => {
    const body = {
      movementId: "0192f5a2-3b4c-7d8e-9f01-23456789ab02",
      kind: "pay_in",
      amount: "1.00",
      reasonCode: "other",
      occurredAt: "2026-10-05T09:00:00Z",
      operatorUserId: CASHIER,
    };
    const { ctx } = contextFor({ body, route: MOVEMENT_ROUTE });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ occurredAt: "2026-10-05T09:00:00Z" }));
  });

  it.each([
    ["actor_mismatch", { openingUserId: OTHER_USER }, null],
    ["operator_missing", { operatorUserId: undefined }, null],
    ["no_covering_admission", {}, { ok: false, cause: "no_covering_admission" } as const],
    ["role_ineligible", {}, { ok: false, cause: "role_ineligible" } as const],
  ])("%s → the generic 403 refused, logged as a fixed event", async (cause, extra, verdict) => {
    if (verdict !== null) verify.mockResolvedValue(verdict);
    const { ctx, request } = contextFor({ body: openBody(extra), route: OPEN_ROUTE });
    await expect(guard.canActivate(ctx)).rejects.toEqual(
      new ForbiddenException({ code: "refused", message: "Forbidden" }),
    );
    const logged = JSON.stringify(warn.mock.calls);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ event: shiftRefusalEvent(cause as never), status: 403 });
    expect([logged.includes(OTHER_USER), request.context?.userId ?? null]).toEqual([false, null]);
  });

  it("a malformed body from an authenticated device is a ZodError (400), before the verifier", async () => {
    const { ctx } = contextFor({ body: openBody({ openingFloat: "500.000" }), route: OPEN_ROUTE });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ZodError);
    expect(verify).not.toHaveBeenCalled();
  });


  it("a refused device credential is the device guard's 401, never a 403", async () => {
    deviceGate.canActivate.mockRejectedValueOnce(new UnauthorizedException("Unauthorized"));
    const { ctx } = contextFor({ body: openBody(), route: OPEN_ROUTE });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("ShiftCashUpAuthGuard — a route without @ShiftFactRoute is a configuration error (review #2)", () => {
  it.each([
    ["a device-path body", openBody()],
    ["an envelope body", { shiftId: "x" }],
  ])("%s: a plain Error (500) before any credential check, never a 401 the POS would read as revoked", async (_label, body) => {
    const { ctx } = contextFor({ body });
    const refusal = await guard.canActivate(ctx).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(HttpException);
    expect([deviceGate.canActivate.mock.calls.length, envelopeGate.canActivate.mock.calls.length]).toEqual([0, 0]);
  });

  it("every ShiftCashUpController handler behind this guard carries a spec", () => {
    const proto = ShiftCashUpController.prototype as unknown as Record<string, object>;
    const guarded = Object.getOwnPropertyNames(proto).filter((name) => {
      const guards = (Reflect.getMetadata(GUARDS_METADATA, proto[name] as object) ?? []) as unknown[];
      return guards.includes(ShiftCashUpAuthGuard);
    });
    const unspecified = guarded.filter((name) => Reflect.getMetadata(SHIFT_FACT_ROUTE_KEY, proto[name] as object) === undefined);
    expect({ guarded: guarded.length > 0, unspecified }).toEqual({ guarded: true, unspecified: [] });
  });
});
