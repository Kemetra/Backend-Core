/**
 * RT-539 (RT-534 S3) — SaleHistoryAuthGuard unit spec. Docker-free.
 *
 * The sale-history routes accept two ALTERNATIVE credentials
 * (`pos-sales/sale-history.yaml` 1.0.0-draft, RT-537 D-2 / Q-2):
 *
 *   - the operator-authorization envelope (owner, tenant_admin,
 *     store_manager; PosOperatorEnvelopeSaleGuard, unchanged): no
 *     `X-Cashier-Admission` header. Store visibility.
 *   - the device bearer PLUS `X-Cashier-Admission: <admission_id>`: the
 *     header's presence selects this path. PosDeviceAuthGuard resolves the
 *     device; the admission is resolved by id WITHIN that device's tenant,
 *     store and device, must be live now (or, for a `record` reprint, cover
 *     `printedAt` under the capture window rules) and its cashier still
 *     eligible. Only then is that cashier published as the actor, which the
 *     handler turns into own-sales visibility (OD-534-1 A).
 *
 * Refusals: a bad credential, or an envelope that carries the header, is the
 * generic 401. A valid device that is refused (no header, or an admission
 * that is not accepted) is the generic 403 `refused`, one body for every
 * cause: to the POS a device 401 means "device revoked". On the reprint route
 * such a refusal is audited (`sale.receipt.reprinted`, outcome `refused`).
 *
 * The SQL behind the admission selector is covered by
 * sale-history.http.integration.spec.ts against real Postgres.
 */
import "reflect-metadata";

import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import { ZodError } from "zod";

import type { Principal } from "../../../../src/auth/auth.guard";
import type { ResolvedContext } from "../../../../src/context/types";
import {
  SALE_REPRINT_ROUTE_KEY,
  SaleHistoryAuthGuard,
  type CashierAdmissionSelector,
  type CashierAdmissionVerdict,
  type SaleHistoryRefusal,
  type SaleHistoryRefusalAudit,
} from "../../../../src/catalog/sales/history/sale-history-auth.guard";

const TENANT_ID = "0a539000-0000-4000-8000-000000000001";
const STORE_ID = "0a539000-0000-4000-8000-0000000000a1";
const DEVICE_ID = "0a539000-0000-4000-8000-0000000000e1";
const CASHIER_ID = "0a539000-0000-4000-8000-0000000000d1";
const MANAGER_ID = "0a539000-0000-4000-8000-0000000000d3";
const ADMISSION_ID = "0a539000-0000-4000-8000-0000000000aa";
const SALE_REF = "0a539000-0000-4000-8000-0000000000c1";
const PRINTED_AT = "2026-10-16T08:00:00.000Z";

interface FakeRequest {
  headers: Record<string, string>;
  params: Record<string, string>;
  body: unknown;
  requestId?: string;
  context?: ResolvedContext;
  principal?: Principal;
  posDeviceId?: string;
}

const listHandler = (): void => undefined;
const reprintHandler = (): void => undefined;
Reflect.defineMetadata(SALE_REPRINT_ROUTE_KEY, true, reprintHandler);

function ctxFor(req: FakeRequest, handler: () => void = listHandler): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: <T>() => req as unknown as T }),
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

function request(opts: { admission?: string; body?: unknown; saleRef?: string } = {}): FakeRequest {
  return {
    headers: {
      authorization: "Bearer token",
      ...(opts.admission === undefined ? {} : { "x-cashier-admission": opts.admission }),
    },
    params: opts.saleRef === undefined ? {} : { saleRef: opts.saleRef },
    body: opts.body,
    requestId: "0a539000-0000-4000-8000-0000000000ff",
  };
}

type Gate = { canActivate: jest.Mock };

/** The device guard publishes exactly what PosDeviceAuthGuard publishes. */
function deviceAccepting(): Gate {
  return {
    canActivate: jest.fn(async (ctx: ExecutionContext) => {
      const req = ctx.switchToHttp().getRequest<FakeRequest>();
      req.principal = {
        kind: "token",
        tokenId: DEVICE_ID,
        tenantId: TENANT_ID,
        userId: null,
        storeId: STORE_ID,
        scope: "pos",
      };
      req.context = { userId: null, tenantId: TENANT_ID, storeId: STORE_ID, isPlatformAdmin: false, source: "token" };
      req.posDeviceId = DEVICE_ID;
      return true;
    }),
  };
}

function envelopeAccepting(): Gate {
  return {
    canActivate: jest.fn(async (ctx: ExecutionContext) => {
      const req = ctx.switchToHttp().getRequest<FakeRequest>();
      req.principal = {
        kind: "token",
        tokenId: "envelope-token-id",
        tenantId: TENANT_ID,
        userId: MANAGER_ID,
        storeId: STORE_ID,
        scope: "pos_operator",
      };
      req.context = {
        userId: MANAGER_ID,
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        isPlatformAdmin: false,
        source: "token",
      };
      req.posDeviceId = DEVICE_ID;
      return true;
    }),
  };
}

function refusing(err: Error = new UnauthorizedException("Unauthorized")): Gate {
  return {
    canActivate: jest.fn(async () => {
      throw err;
    }),
  };
}

function selector(verdict: CashierAdmissionVerdict): CashierAdmissionSelector & { resolve: jest.Mock } {
  return { resolve: jest.fn(async () => verdict) };
}

function auditSpy(): SaleHistoryRefusalAudit & { recordRefusal: jest.Mock; calls: SaleHistoryRefusal[] } {
  const calls: SaleHistoryRefusal[] = [];
  return {
    calls,
    recordRefusal: jest.fn(async (r: SaleHistoryRefusal) => {
      calls.push(r);
    }),
  };
}

function makeGuard(opts: {
  envelope?: Gate;
  device?: Gate;
  admissions?: CashierAdmissionSelector;
  audit?: SaleHistoryRefusalAudit;
  logger?: { warn: jest.Mock };
}) {
  const envelope = opts.envelope ?? refusing();
  const device = opts.device ?? deviceAccepting();
  const admissions = opts.admissions ?? selector({ ok: true, userId: CASHIER_ID });
  const audit = opts.audit ?? auditSpy();
  const logger = opts.logger ?? { warn: jest.fn() };
  return { guard: new SaleHistoryAuthGuard(envelope, device, admissions, audit, logger), envelope, device, logger };
}

async function refusalOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
}

describe("envelope path (no X-Cashier-Admission)", () => {
  it("delegates to the envelope guard and leaves its published scope untouched", async () => {
    const envelope = envelopeAccepting();
    const { guard, device } = makeGuard({ envelope });
    const req = request();
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(envelope.canActivate).toHaveBeenCalledTimes(1);
    expect(device.canActivate).not.toHaveBeenCalled();
    expect(req.principal).toMatchObject({ kind: "token", scope: "pos_operator" });
    expect(req.context?.userId).toBe(MANAGER_ID);
  });

  it("a bad credential that is not a device either stays the generic 401", async () => {
    const { guard } = makeGuard({ device: refusing() });
    expect(await refusalOf(guard.canActivate(ctxFor(request())))).toBeInstanceOf(UnauthorizedException);
  });

  it("a valid DEVICE without the header is the generic 403 refused, never a 401", async () => {
    const logger = { warn: jest.fn() };
    const { guard } = makeGuard({ logger });
    const err = await refusalOf(guard.canActivate(ctxFor(request())));
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toEqual({ code: "refused", message: "Forbidden" });
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      event: "sale_history.cashier_refused.admission_missing",
      tenant_id: TENANT_ID,
      store_id: STORE_ID,
      status: 403,
    });
  });

  it("an envelope error that is not a 401 is not masked by the device probe", async () => {
    const outage = new ServiceUnavailableException();
    const { guard, device } = makeGuard({ envelope: refusing(outage) });
    expect(await refusalOf(guard.canActivate(ctxFor(request())))).toBe(outage);
    expect(device.canActivate).not.toHaveBeenCalled();
  });

  it("a device-probe error that is not a 401 propagates", async () => {
    const outage = new ServiceUnavailableException();
    const { guard } = makeGuard({ device: refusing(outage) });
    expect(await refusalOf(guard.canActivate(ctxFor(request())))).toBe(outage);
  });

  it("on the reprint route the missing-header refusal is audited", async () => {
    const audit = auditSpy();
    const { guard } = makeGuard({ audit });
    const req = request({
      saleRef: SALE_REF,
      body: { mode: "authorize", kind: "duplicate", printedAt: PRINTED_AT },
    });
    expect(await refusalOf(guard.canActivate(ctxFor(req, reprintHandler)))).toBeInstanceOf(ForbiddenException);
    expect(audit.calls).toEqual([
      {
        scope: { tenantId: TENANT_ID, storeId: STORE_ID, deviceId: DEVICE_ID },
        actorUserId: null,
        saleRef: SALE_REF,
        mode: "authorize",
        kind: "duplicate",
        reason: "admission_missing",
        requestId: "0a539000-0000-4000-8000-0000000000ff",
      },
    ]);
  });

  it("an unparseable reprint body and a malformed saleRef are audited as null", async () => {
    const audit = auditSpy();
    const { guard } = makeGuard({ audit });
    const req = request({ saleRef: "not-a-uuid", body: { mode: "nope" } });
    await refusalOf(guard.canActivate(ctxFor(req, reprintHandler)));
    expect(audit.calls[0]).toMatchObject({ saleRef: null, mode: null, kind: null });
  });

  it("the list route never audits a refusal", async () => {
    const audit = auditSpy();
    const { guard } = makeGuard({ audit });
    await refusalOf(guard.canActivate(ctxFor(request())));
    expect(audit.recordRefusal).not.toHaveBeenCalled();
  });
});

describe("device path (X-Cashier-Admission present)", () => {
  it("an envelope that carries the header is the generic 401 (the device guard refuses it)", async () => {
    const envelope = envelopeAccepting();
    const { guard } = makeGuard({ envelope, device: refusing() });
    expect(await refusalOf(guard.canActivate(ctxFor(request({ admission: ADMISSION_ID }))))).toBeInstanceOf(
      UnauthorizedException,
    );
    expect(envelope.canActivate).not.toHaveBeenCalled();
  });

  it("an accepted admission publishes its cashier as the actor, scope from the device", async () => {
    const admissions = selector({ ok: true, userId: CASHIER_ID });
    const { guard } = makeGuard({ admissions });
    const req = request({ admission: ADMISSION_ID.toUpperCase() });
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(admissions.resolve).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      deviceId: DEVICE_ID,
      admissionId: ADMISSION_ID,
      checkAt: null,
    });
    expect(req.context).toEqual({
      userId: CASHIER_ID,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      isPlatformAdmin: false,
      source: "token",
    });
    expect(req.principal).toEqual({
      kind: "token",
      tokenId: DEVICE_ID,
      tenantId: TENANT_ID,
      userId: CASHIER_ID,
      storeId: STORE_ID,
      scope: "pos",
    });
    expect(req.posDeviceId).toBe(DEVICE_ID);
  });

  it("a malformed admission id from an authenticated device is a 400", async () => {
    const admissions = selector({ ok: true, userId: CASHIER_ID });
    const { guard } = makeGuard({ admissions });
    expect(await refusalOf(guard.canActivate(ctxFor(request({ admission: "adm-1" }))))).toBeInstanceOf(
      BadRequestException,
    );
    expect(admissions.resolve).not.toHaveBeenCalled();
  });

  it("an unauthenticated device never reaches the admission lookup", async () => {
    const admissions = selector({ ok: true, userId: CASHIER_ID });
    const { guard } = makeGuard({ admissions, device: refusing() });
    expect(await refusalOf(guard.canActivate(ctxFor(request({ admission: "adm-1" }))))).toBeInstanceOf(
      UnauthorizedException,
    );
    expect(admissions.resolve).not.toHaveBeenCalled();
  });

  it.each([
    "admission_unknown",
    "admission_not_live",
    "admission_not_covering",
    "membership_inactive",
    "role_ineligible",
    "store_not_accessible",
  ] as const)("a refused admission (%s) is the generic 403 refused, logged by cause", async (cause) => {
    const logger = { warn: jest.fn() };
    const { guard } = makeGuard({ logger, admissions: selector({ ok: false, cause, userId: null }) });
    const req = request({ admission: ADMISSION_ID });
    const err = await refusalOf(guard.canActivate(ctxFor(req)));
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toEqual({ code: "refused", message: "Forbidden" });
    expect(logger.warn.mock.calls[0]?.[0]).toEqual({
      event: `sale_history.cashier_refused.${cause}`,
      request_id: "0a539000-0000-4000-8000-0000000000ff",
      tenant_id: TENANT_ID,
      store_id: STORE_ID,
      status: 403,
      outcome: "failure",
    });
    // Nothing about the claimed cashier is published.
    expect(req.context?.userId).toBeNull();
  });

  it("a reprint authorize checks the admission live now (checkAt null)", async () => {
    const admissions = selector({ ok: true, userId: CASHIER_ID });
    const { guard } = makeGuard({ admissions });
    const req = request({
      admission: ADMISSION_ID,
      saleRef: SALE_REF,
      body: { mode: "authorize", kind: "sale_record", printedAt: PRINTED_AT },
    });
    await expect(guard.canActivate(ctxFor(req, reprintHandler))).resolves.toBe(true);
    expect(admissions.resolve.mock.calls[0]?.[0]).toMatchObject({ checkAt: null });
  });

  it("a reprint record checks the admission window at printedAt", async () => {
    const admissions = selector({ ok: true, userId: CASHIER_ID });
    const { guard } = makeGuard({ admissions });
    const req = request({
      admission: ADMISSION_ID,
      saleRef: SALE_REF,
      body: { mode: "record", kind: "duplicate", printedAt: PRINTED_AT, localCopyNumber: 3 },
    });
    await expect(guard.canActivate(ctxFor(req, reprintHandler))).resolves.toBe(true);
    expect(admissions.resolve.mock.calls[0]?.[0]).toMatchObject({ checkAt: PRINTED_AT });
  });

  it("a malformed reprint body from an authenticated device is a 400, before the lookup", async () => {
    const admissions = selector({ ok: true, userId: CASHIER_ID });
    const { guard } = makeGuard({ admissions });
    const req = request({ admission: ADMISSION_ID, saleRef: SALE_REF, body: { mode: "record", kind: "duplicate" } });
    expect(await refusalOf(guard.canActivate(ctxFor(req, reprintHandler)))).toBeInstanceOf(ZodError);
    expect(admissions.resolve).not.toHaveBeenCalled();
  });

  it("a refused reprint admission is audited with the admission's cashier when known", async () => {
    const audit = auditSpy();
    const { guard } = makeGuard({
      audit,
      admissions: selector({ ok: false, cause: "admission_not_covering", userId: CASHIER_ID }),
    });
    const req = request({
      admission: ADMISSION_ID,
      saleRef: SALE_REF,
      body: { mode: "record", kind: "duplicate", printedAt: PRINTED_AT, localCopyNumber: 1 },
    });
    expect(await refusalOf(guard.canActivate(ctxFor(req, reprintHandler)))).toBeInstanceOf(ForbiddenException);
    expect(audit.calls).toEqual([
      {
        scope: { tenantId: TENANT_ID, storeId: STORE_ID, deviceId: DEVICE_ID },
        actorUserId: CASHIER_ID,
        saleRef: SALE_REF,
        mode: "record",
        kind: "duplicate",
        reason: "admission_not_covering",
        requestId: "0a539000-0000-4000-8000-0000000000ff",
      },
    ]);
  });
});
