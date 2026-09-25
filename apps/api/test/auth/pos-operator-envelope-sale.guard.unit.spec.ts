/**
 * T9 (031 G-4) — PosOperatorEnvelopeSaleGuard live-predicate regression guard.
 *
 * The canonical PosOperatorAuthGuard validates the envelope token (scope
 * pos_operator, not revoked, not expired) but does NOT re-resolve the
 * operator's LIVE eligibility — membership-active, device-active, store-access.
 * Under Option-Y those were re-checked per sale request. The envelope re-wire
 * (T3) would otherwise let a mid-session-revoked operator keep ringing sales
 * for the full 8h TTL — a G-4 violation ("the envelope must not weaken any of
 * [the predicate legs]").
 *
 * Option B: this guard runs AFTER canonical auth attaches the pos_operator
 * principal, recovers device_id from the auth_tokens row (re-read by tokenId),
 * and calls OperatorContextResolver.reverify(userId, deviceId, storeId) to
 * re-evaluate membership/device/store-access/role LIVE per request. A refusal
 * collapses to the same generic 401.
 *
 * Strategy: fake the reverify seam + the principal (already attached by the
 * superclass). Docker-free.
 */
import "reflect-metadata";

import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";

import { PosOperatorEnvelopeSaleGuard } from "../../src/auth/pos-operator-envelope-sale.guard";
import type { OperatorReverifier } from "../../src/auth/operator-context-resolver";

const TENANT_ID = "0a000000-0000-7000-8000-0000000ten01";
const STORE_ID = "0a000000-0000-7000-8000-0000000sto01";
const USER_ID = "0a000000-0000-7000-8000-00000000aa01";
const DEVICE_ID = "0a000000-0000-7000-8000-0000000dev01";
const TOKEN_ID = "0a000000-0000-7000-8000-0000000tok01";

function makeCtx(req: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: <T>() => req as unknown as T }),
  } as unknown as ExecutionContext;
}

/**
 * A request that has ALREADY passed canonical auth: principal is a valid
 * pos_operator token principal. (The guard-under-test delegates to its
 * superclass for that; here we stub the superclass acceptance by pre-attaching
 * the principal and faking the super.canActivate via the resolver seam only.)
 */
function makeAuthedRequest(): Record<string, unknown> {
  return {
    headers: { authorization: "Bearer valid-envelope-raw" },
    principal: {
      kind: "token",
      tokenId: TOKEN_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      storeId: STORE_ID,
      scope: "pos_operator",
    },
  };
}

/** Fake the live re-verification seam + the device-id recovery. */
function makeReverifier(opts: {
  deviceId?: string | null;
  result: { kind: "ok" } | { kind: "refused"; reason: string };
}): { reverifier: OperatorReverifier; recoverDeviceId: jest.Mock; reverify: jest.Mock } {
  const recoverDeviceId = jest.fn().mockResolvedValue(opts.deviceId ?? DEVICE_ID);
  const reverify = jest.fn().mockResolvedValue(opts.result);
  return {
    reverifier: { recoverDeviceId, reverify } as unknown as OperatorReverifier,
    recoverDeviceId,
    reverify,
  };
}

/**
 * The guard-under-test extends the canonical PosOperatorAuthGuard. To unit-test
 * the live-predicate layer in isolation we stub the inherited canActivate to
 * succeed (principal already attached), so only the reverify branch is exercised.
 */
function makeGuard(reverifier: OperatorReverifier): PosOperatorEnvelopeSaleGuard {
  const guard = new PosOperatorEnvelopeSaleGuard(
    // sessions + authTokens are the superclass deps; not exercised here because
    // we stub super.canActivate.
    {} as never,
    {} as never,
    reverifier,
  );
  // Stub the inherited canonical auth: it would attach request.principal; our
  // makeAuthedRequest already does, so just resolve true.
  jest
    .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), "canActivate")
    .mockResolvedValue(true);
  return guard;
}

describe("PosOperatorEnvelopeSaleGuard — live predicate (G-4)", () => {
  it("G4-OK: valid envelope + live reverify ok → allows the sale", async () => {
    const { reverifier, reverify, recoverDeviceId } = makeReverifier({ result: { kind: "ok" } });
    const guard = makeGuard(reverifier);
    const req = makeAuthedRequest();

    const ok = await guard.canActivate(makeCtx(req));

    expect(ok).toBe(true);
    expect(recoverDeviceId).toHaveBeenCalledWith(TOKEN_ID);
    expect(reverify).toHaveBeenCalledWith(USER_ID, DEVICE_ID, STORE_ID);
  });

  it("CTX: publishes request.context (tenant/store/user) so the controller's ctx check passes", async () => {
    // Behavioural parity with the retired Option-Y guard, which set
    // request.context = result.context. The sale controllers read
    // `request.context` and 401 if it is absent — the envelope guard MUST
    // populate it from the resolved principal after reverify succeeds.
    const { reverifier } = makeReverifier({ result: { kind: "ok" } });
    const guard = makeGuard(reverifier);
    const req = makeAuthedRequest();

    await guard.canActivate(makeCtx(req));

    expect((req as { context?: unknown }).context).toEqual({
      userId: USER_ID,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      isPlatformAdmin: false,
      source: "token",
    });
    expect(req["posDeviceId"]).toBe(DEVICE_ID);
  });

  it("G4-MEMBERSHIP: membership revoked mid-session → 401 even with a valid envelope", async () => {
    const { reverifier } = makeReverifier({ result: { kind: "refused", reason: "membership_revoked" } });
    const guard = makeGuard(reverifier);

    await expect(guard.canActivate(makeCtx(makeAuthedRequest()))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("G4-DEVICE: device revoked mid-session → 401 even with a valid envelope", async () => {
    const { reverifier } = makeReverifier({ result: { kind: "refused", reason: "device_invalid" } });
    const guard = makeGuard(reverifier);

    await expect(guard.canActivate(makeCtx(makeAuthedRequest()))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("G4-STORE: store-access pulled mid-session → 401 even with a valid envelope", async () => {
    const { reverifier } = makeReverifier({
      result: { kind: "refused", reason: "store_not_in_access_set" },
    });
    const guard = makeGuard(reverifier);

    await expect(guard.canActivate(makeCtx(makeAuthedRequest()))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
