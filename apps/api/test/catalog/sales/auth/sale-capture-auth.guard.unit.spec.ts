/**
 * RT-224 (Option B) — SaleCaptureAuthGuard unit spec. Docker-free.
 *
 * captureSale accepts two alternative credentials (sales.yaml 1.5.0-draft):
 *
 *   - the operator-authorization envelope (unchanged, 031): the body carries
 *     no `operatorUserId`, so the guard hands the request to
 *     PosOperatorEnvelopeSaleGuard and does nothing else;
 *   - the device bearer + `operatorUserId`: the presence of the field selects
 *     this path. PosDeviceAuthGuard resolves the device (tenant, store,
 *     device), the body is validated, and the attribution verifier must accept
 *     (device, store, user, occurredAt). Only then is the verified user
 *     published as the actor.
 *
 * Refusals (RT-224 rev709 F1): a bad, revoked or missing device credential is
 * the generic 401; a refused cashier claim from an AUTHENTICATED device is the
 * generic 403 `refused`, the same body for every cause. A device 401 means
 * "device revoked" to the POS (RT-113 D4/D8), so a refused sale must never
 * look like one.
 *
 * The SQL behind the verifier is covered by
 * device-operator-capture.http.integration.spec.ts against real Postgres.
 */
import "reflect-metadata";

import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { ZodError } from "zod";

import type { Principal } from "../../../../src/auth/auth.guard";
import type { ResolvedContext } from "../../../../src/context/types";
import {
  ATTRIBUTION_REFUSAL_EVENTS,
  type AttributionVerdict,
  type OperatorAttributionInput,
  type OperatorAttributionVerifier,
} from "../../../../src/catalog/sales/operator-attribution";
import { SaleCaptureAuthGuard } from "../../../../src/catalog/sales/sale-capture-auth.guard";

const TENANT_ID = "0a240000-0000-4000-8000-000000000001";
const STORE_ID = "0a240000-0000-4000-8000-000000000002";
const DEVICE_ID = "0a240000-0000-4000-8000-000000000003";
const CASHIER_ID = "0a240000-0000-4000-8000-000000000004";
const OCCURRED_AT = "2026-09-01T09:00:00.000Z";

interface FakeRequest {
  headers: Record<string, string>;
  body: unknown;
  requestId?: string;
  context?: ResolvedContext;
  principal?: Principal;
  posDeviceId?: string;
}

function saleBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceSystem: "pos-pulse",
    externalId: "rt224-unit-1",
    currencyCode: "EGP",
    posTotal: "5.00",
    occurredAt: OCCURRED_AT,
    lines: [
      {
        lineName: "Tea",
        unitPrice: "5.00",
        currencyCode: "EGP",
        quantity: "1",
        lineAmount: "5.00",
        unit: "unit",
      },
    ],
    ...extra,
  };
}

function ctxFor(req: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: <T>() => req as unknown as T }),
  } as unknown as ExecutionContext;
}

/** The device guard publishes exactly what PosDeviceAuthGuard publishes. */
function deviceGuardAccepting(): { canActivate: jest.Mock } {
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
      req.context = {
        userId: null,
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

function deviceGuardRefusing(): { canActivate: jest.Mock } {
  return {
    canActivate: jest.fn(async () => {
      throw new UnauthorizedException("Unauthorized");
    }),
  };
}

function verifier(verdict: AttributionVerdict): OperatorAttributionVerifier & { verify: jest.Mock } {
  return { verify: jest.fn(async (_input: OperatorAttributionInput) => verdict) };
}

function makeGuard(opts: {
  envelope?: { canActivate: jest.Mock };
  device?: { canActivate: jest.Mock };
  attribution?: OperatorAttributionVerifier & { verify: jest.Mock };
  logger?: { warn: jest.Mock };
}) {
  const envelope = opts.envelope ?? { canActivate: jest.fn(async () => true) };
  const device = opts.device ?? deviceGuardAccepting();
  const attribution = opts.attribution ?? verifier({ ok: true });
  const logger = opts.logger ?? { warn: jest.fn() };
  const guard = new SaleCaptureAuthGuard(envelope, device, attribution, logger);
  return { guard, envelope, device, attribution, logger };
}

function deviceRequest(body: unknown): FakeRequest {
  return { headers: { authorization: "Bearer device-token" }, body, requestId: "req-1" };
}

describe("SaleCaptureAuthGuard — path selection", () => {
  it("a body without operatorUserId takes the envelope path only (unchanged behaviour)", async () => {
    const t = makeGuard({});
    const req = deviceRequest(saleBody());
    await expect(t.guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(t.envelope.canActivate).toHaveBeenCalledTimes(1);
    expect(t.device.canActivate).not.toHaveBeenCalled();
    expect(t.attribution.verify).not.toHaveBeenCalled();
  });

  it("an envelope refusal propagates unchanged", async () => {
    const refusal = new UnauthorizedException("Unauthorized");
    const t = makeGuard({ envelope: { canActivate: jest.fn(async () => Promise.reject(refusal)) } });
    await expect(t.guard.canActivate(ctxFor(deviceRequest(saleBody())))).rejects.toBe(refusal);
    expect(t.device.canActivate).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing body", undefined],
    ["an array body", [saleBody({ operatorUserId: CASHIER_ID })]],
    ["a string body", "operatorUserId"],
  ])("%s takes the envelope path", async (_label, body) => {
    const t = makeGuard({});
    await t.guard.canActivate(ctxFor(deviceRequest(body)));
    expect(t.envelope.canActivate).toHaveBeenCalledTimes(1);
    expect(t.device.canActivate).not.toHaveBeenCalled();
  });

  it("operatorUserId selects the device path; the envelope guard never runs", async () => {
    const t = makeGuard({});
    await t.guard.canActivate(ctxFor(deviceRequest(saleBody({ operatorUserId: CASHIER_ID }))));
    expect(t.device.canActivate).toHaveBeenCalledTimes(1);
    expect(t.envelope.canActivate).not.toHaveBeenCalled();
  });

  it("operatorUserId: null still selects the device path (and fails validation, 400)", async () => {
    const t = makeGuard({});
    await expect(
      t.guard.canActivate(ctxFor(deviceRequest(saleBody({ operatorUserId: null })))),
    ).rejects.toBeInstanceOf(ZodError);
    expect(t.envelope.canActivate).not.toHaveBeenCalled();
    expect(t.attribution.verify).not.toHaveBeenCalled();
  });
});

describe("SaleCaptureAuthGuard — device path", () => {
  it("verifies the device's scope, the claimed user and occurredAt; tenant/store/device come from the device", async () => {
    const t = makeGuard({});
    // A body that tries to smuggle scope is rejected by the strict schema
    // (see below); here the body is clean and the scope must be the device's.
    await t.guard.canActivate(ctxFor(deviceRequest(saleBody({ operatorUserId: CASHIER_ID }))));
    expect(t.attribution.verify).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      deviceId: DEVICE_ID,
      userId: CASHIER_ID,
      occurredAt: OCCURRED_AT,
    });
  });

  it("on success publishes the VERIFIED cashier as the actor (context + principal), keeps the device", async () => {
    const t = makeGuard({});
    const req = deviceRequest(saleBody({ operatorUserId: CASHIER_ID }));
    await expect(t.guard.canActivate(ctxFor(req))).resolves.toBe(true);
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

  it("an unauthenticated device is a 401 and nothing else runs", async () => {
    const t = makeGuard({ device: deviceGuardRefusing() });
    const req = deviceRequest(saleBody({ operatorUserId: CASHIER_ID }));
    await expect(t.guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(t.attribution.verify).not.toHaveBeenCalled();
    expect(req.context).toBeUndefined();
  });

  it("an unauthenticated device with a malformed body is still a 401, never a 400", async () => {
    const t = makeGuard({ device: deviceGuardRefusing() });
    const req = deviceRequest({ operatorUserId: "not-a-uuid" });
    await expect(t.guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("an authenticated device with a malformed operatorUserId is the usual validation 400", async () => {
    const t = makeGuard({});
    const req = deviceRequest(saleBody({ operatorUserId: "not-a-uuid" }));
    await expect(t.guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(ZodError);
    expect(t.attribution.verify).not.toHaveBeenCalled();
  });

  it("an authenticated device whose body smuggles scope fields is a 400 (strict body)", async () => {
    const t = makeGuard({});
    const req = deviceRequest(
      saleBody({ operatorUserId: CASHIER_ID, tenantId: TENANT_ID, createdBy: CASHIER_ID }),
    );
    await expect(t.guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(ZodError);
    expect(t.attribution.verify).not.toHaveBeenCalled();
  });

  it.each(Object.keys(ATTRIBUTION_REFUSAL_EVENTS))(
    "refusal %s → the same generic 403 refused (never the device's 401), and the cashier is never published",
    async (cause) => {
      const t = makeGuard({
        attribution: verifier({ ok: false, cause } as AttributionVerdict),
      });
      const req = deviceRequest(saleBody({ operatorUserId: CASHIER_ID }));
      const err = await t.guard.canActivate(ctxFor(req)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getStatus()).toBe(403);
      expect((err as ForbiddenException).getResponse()).toEqual({ code: "refused", message: "Forbidden" });
      expect(req.context?.userId ?? null).toBeNull();
      expect(req.principal?.userId ?? null).toBeNull();
    },
  );
});

describe("SaleCaptureAuthGuard — refusal log (redaction matrix)", () => {
  // signals.md §4 defaults + redaction-matrix §3.4 business fields only.
  const ALLOWED = new Set(["event", "request_id", "tenant_id", "store_id", "status", "outcome"]);

  it("logs one warn with allowlisted fields and a closed-set event name", async () => {
    const t = makeGuard({ attribution: verifier({ ok: false, cause: "no_covering_admission" }) });
    const req = deviceRequest(saleBody({ operatorUserId: CASHIER_ID }));
    await t.guard.canActivate(ctxFor(req)).catch(() => undefined);
    expect(t.logger.warn).toHaveBeenCalledTimes(1);
    const fields = t.logger.warn.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(fields).filter((k) => !ALLOWED.has(k))).toEqual([]);
    expect(fields).toEqual({
      event: ATTRIBUTION_REFUSAL_EVENTS.no_covering_admission,
      request_id: "req-1",
      tenant_id: TENANT_ID,
      store_id: STORE_ID,
      status: 403,
      outcome: "failure",
    });
    // Never the claimed user, the token or the body.
    const serialized = JSON.stringify(t.logger.warn.mock.calls[0]);
    expect(serialized).not.toContain(CASHIER_ID);
    expect(serialized).not.toContain("device-token");
    expect(serialized).not.toContain(OCCURRED_AT);
  });

  it("the closed set covers the rev709 F3 caps: a future-dated sale and a too-old admission window", () => {
    expect(Object.keys(ATTRIBUTION_REFUSAL_EVENTS)).toEqual(
      expect.arrayContaining(["no_covering_admission", "future_dated", "admission_too_old"]),
    );
  });

  it("event names are fixed, code-defined strings (one per refusal cause)", () => {
    for (const name of Object.values(ATTRIBUTION_REFUSAL_EVENTS)) {
      expect(name).toMatch(/^sale\.capture\.operator_refused\.[a-z_]+$/);
    }
    expect(new Set(Object.values(ATTRIBUTION_REFUSAL_EVENTS)).size).toBe(
      Object.keys(ATTRIBUTION_REFUSAL_EVENTS).length,
    );
  });

  it("a success logs nothing", async () => {
    const t = makeGuard({});
    await t.guard.canActivate(ctxFor(deviceRequest(saleBody({ operatorUserId: CASHIER_ID }))));
    expect(t.logger.warn).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// RT-225 — admissionCheckAt ([GATED] approval: Jira RT-225, sales.yaml
// 1.6.0-draft). The guard hands it to the verifier, which compares it (not
// occurredAt) with the admission window. The body rules are the DTO's: the
// field needs operatorUserId, must not be after occurredAt and at most 7 days
// before it. It is never logged.
// ===========================================================================
describe("SaleCaptureAuthGuard — RT-225 admissionCheckAt", () => {
  const CHECK_AT = "2026-09-01T08:45:00.000Z";

  it("passes admissionCheckAt to the verifier beside occurredAt", async () => {
    const t = makeGuard({});
    await t.guard.canActivate(
      ctxFor(deviceRequest(saleBody({ operatorUserId: CASHIER_ID, admissionCheckAt: CHECK_AT }))),
    );
    expect(t.attribution.verify).toHaveBeenCalledTimes(1);
    expect(t.attribution.verify.mock.calls[0]![0]).toEqual({
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      deviceId: DEVICE_ID,
      userId: CASHIER_ID,
      occurredAt: OCCURRED_AT,
      admissionCheckAt: CHECK_AT,
    });
  });

  it("without the field the verifier input carries no admissionCheckAt key (unchanged)", async () => {
    const t = makeGuard({});
    await t.guard.canActivate(ctxFor(deviceRequest(saleBody({ operatorUserId: CASHIER_ID }))));
    expect(Object.keys(t.attribution.verify.mock.calls[0]![0] as object)).not.toContain("admissionCheckAt");
  });

  it("does not select the device path on its own: without operatorUserId the envelope guard runs", async () => {
    const t = makeGuard({});
    await t.guard.canActivate(ctxFor(deviceRequest(saleBody({ admissionCheckAt: CHECK_AT }))));
    expect(t.envelope.canActivate).toHaveBeenCalledTimes(1);
    expect(t.device.canActivate).not.toHaveBeenCalled();
  });

  it.each([
    ["after occurredAt", "2026-09-01T09:00:00.001Z"],
    ["more than 7 days before occurredAt", "2026-08-25T08:59:59.999Z"],
    ["not a date-time", "2026-09-01 08:45"],
  ])("an authenticated device with admissionCheckAt %s → the usual 400, the verifier never runs", async (_label, checkAt) => {
    const t = makeGuard({});
    const req = deviceRequest(saleBody({ operatorUserId: CASHIER_ID, admissionCheckAt: checkAt }));
    await expect(t.guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(ZodError);
    expect(t.attribution.verify).not.toHaveBeenCalled();
  });

  it("a refusal never logs admissionCheckAt or occurredAt", async () => {
    const t = makeGuard({ attribution: verifier({ ok: false, cause: "no_covering_admission" }) });
    const req = deviceRequest(saleBody({ operatorUserId: CASHIER_ID, admissionCheckAt: CHECK_AT }));
    await expect(t.guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.logger.warn).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(t.logger.warn.mock.calls[0]);
    expect(serialized).not.toContain(CHECK_AT);
    expect(serialized).not.toContain(OCCURRED_AT);
    expect(serialized).not.toContain(CASHIER_ID);
  });
});
