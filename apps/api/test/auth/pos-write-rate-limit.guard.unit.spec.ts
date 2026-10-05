/**
 * pos-write-rate-limit.guard.unit.spec.ts
 *
 * Docker-free unit coverage for PosWriteRateLimitGuard — the implementation of
 * ratified ADR 0009 (audit M-2): a per-DEVICE throughput ceiling on POS write
 * endpoints, layered AFTER PosOperatorEnvelopeSaleGuard (which has already
 * attached `request.principal` with `tokenId`/`storeId`).
 *
 * Contract under test (ADR 0009 D1/D2/D3):
 *   - D1 keying: the bucket identifier is the DEVICE (resolved from
 *     `recoverDeviceId(principal.tokenId)`), NOT the IP and NOT the token.
 *   - over-limit: `RateLimiter.check` not-allowed → 429 TooManyRequests + Retry-After.
 *   - under-limit: allowed → guard returns true.
 *   - D3 fail-open: if `RateLimiter.check` THROWS (Redis outage), the guard
 *     ALLOWS the request (returns true) and logs a warn — it never blocks a write
 *     because the rate-limiter's datastore is down (coherent with ADR 0010 D1).
 *
 * Strategy: hand-written fakes for RateLimiter + OperatorReverifier + logger.
 * Guard constructed directly with a mock ExecutionContext. No NestJS module.
 */
import "reflect-metadata";

import { HttpException, HttpStatus, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { Logger } from "@data-pulse-2/shared";

import { PosWriteRateLimitGuard } from "../../src/auth/pos-write-rate-limit.guard";
import type { RateLimiter, RateLimitDecision } from "../../src/auth/rate-limit";
import type { OperatorReverifier } from "../../src/auth/operator-context-resolver";

const TOKEN_ID = "0a000000-0000-7000-8000-0000000tok01";
const DEVICE_ID = "0a000000-0000-7000-8000-0000000dev01";

interface FakeRequest {
  principal?: { kind: string; scope: string; tokenId: string | null } | null;
  posDeviceId?: string;
}

/**
 * ctx whose handler carries (or omits) the @PosWriteRateLimitBucket annotation.
 * NOTE: do NOT use a default param value here — an explicit `undefined` arg would
 * fall through to the default, defeating the unannotated-route test. Callers pass
 * the bucket (or `undefined` for an unannotated route) explicitly.
 */
function ctxWith(req: FakeRequest, bucket: string | undefined): ExecutionContext {
  const res = { setHeader: jest.fn() };
  // The handler function carries the bucket; the fake reflector reads it off the
  // handler arg (mirrors reflector.get(KEY, ctx.getHandler())).
  const handler = Object.assign(() => undefined, { __bucket: bucket });
  return {
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
      getResponse: <T>() => res as unknown as T,
    }),
  } as unknown as ExecutionContext;
}

const ALLOW: RateLimitDecision = { allowed: true, count: 1, remaining: 299, resetMs: 3600_000 };
const DENY: RateLimitDecision = { allowed: false, count: 301, remaining: 0, resetMs: 1800_000 };

function makeGuard(opts: {
  decision?: RateLimitDecision;
  checkThrows?: boolean;
  deviceId?: string | null;
}): {
  guard: PosWriteRateLimitGuard;
  checkSpy: jest.Mock;
  warnSpy: jest.Mock;
  recoverSpy: jest.Mock;
} {
  const checkSpy = jest.fn(async () => {
    if (opts.checkThrows) throw new Error("redis down");
    return opts.decision ?? ALLOW;
  });
  const rateLimiter = { check: checkSpy } as unknown as RateLimiter;
  const recoverSpy = jest.fn(async () => (opts.deviceId === undefined ? DEVICE_ID : opts.deviceId));
  const reverifier = { recoverDeviceId: recoverSpy } as unknown as OperatorReverifier;
  const warnSpy = jest.fn();
  const logger = { warn: warnSpy, error: jest.fn(), info: jest.fn(), debug: jest.fn() };
  // Fake reflector mirrors the real `reflector.get(KEY, handler)` by reading the
  // bucket annotation the ctx carries (set by ctxWith via __bucket).
  const reflector = {
    get: (_key: unknown, handler: { __bucket?: string }) => handler?.__bucket,
  } as unknown as Reflector;
  const guard = new PosWriteRateLimitGuard(rateLimiter, reverifier, reflector, logger as unknown as Logger);
  return { guard, checkSpy, warnSpy, recoverSpy };
}

const POS_PRINCIPAL = { kind: "token", scope: "pos_operator", tokenId: TOKEN_ID };

describe("PosWriteRateLimitGuard — ADR 0009 per-device write rate limit", () => {
  it("D1: keys the bucket by the resolved DEVICE id (not token, not ip)", async () => {
    const { guard, checkSpy } = makeGuard({ decision: ALLOW });
    const ok = await guard.canActivate(ctxWith({ principal: POS_PRINCIPAL }, "posWriteSale"));
    expect(ok).toBe(true);
    // identifier (2nd arg of check(bucketName, identifier, bucket)) must be the device id
    const [, identifier] = checkSpy.mock.calls[0] as [string, string, unknown];
    expect(identifier).toBe(DEVICE_ID);
    expect(identifier).not.toBe(TOKEN_ID);
  });

  it("under the limit → allowed", async () => {
    const { guard } = makeGuard({ decision: ALLOW });
    await expect(guard.canActivate(ctxWith({ principal: POS_PRINCIPAL }, "posWriteSale"))).resolves.toBe(true);
  });

  it("over the limit → 429 TooManyRequests", async () => {
    const { guard } = makeGuard({ decision: DENY });
    await expect(
      guard.canActivate(ctxWith({ principal: POS_PRINCIPAL }, "posWriteSale")),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS } as Partial<HttpException>);
  });

  it("D3 fail-open: RateLimiter throws (Redis down) → ALLOW + warn (never block a write)", async () => {
    const { guard, warnSpy } = makeGuard({ checkThrows: true });
    const ok = await guard.canActivate(ctxWith({ principal: POS_PRINCIPAL }, "posWriteSale"));
    expect(ok).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("fail-open: device id unresolvable → ALLOW + warn (do not hard-block on a lookup miss)", async () => {
    const { guard, warnSpy } = makeGuard({ deviceId: null });
    const ok = await guard.canActivate(ctxWith({ principal: POS_PRINCIPAL }, "posWriteSale"));
    expect(ok).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("unannotated route (no @PosWriteRateLimitBucket) → allowed, never checks the limiter", async () => {
    const { guard, checkSpy } = makeGuard({ decision: DENY });
    // bucket undefined → guard is inert for this route
    const ok = await guard.canActivate(ctxWith({ principal: POS_PRINCIPAL }, undefined));
    expect(ok).toBe(true);
    expect(checkSpy).not.toHaveBeenCalled();
  });

  it("selects the bucket named by the route annotation", async () => {
    const { guard, checkSpy } = makeGuard({ decision: ALLOW });
    await guard.canActivate(ctxWith({ principal: POS_PRINCIPAL }, "posWriteSettlementIntent"));
    const [bucketName] = checkSpy.mock.calls[0] as [string, string, unknown];
    expect(bucketName).toBe("posWriteSettlementIntent");
  });
});

/**
 * RT-224: captureSale's device-bearer path. PosDeviceAuthGuard publishes a
 * device principal (`scope: "pos"`, `tokenId` = the device id, NOT an
 * auth_tokens row) and `request.posDeviceId`. The bucket must still be the
 * device, so the device path is throttled exactly like the envelope path
 * (same bucket, same device key) instead of failing open on a token lookup
 * that can never match.
 */
describe("PosWriteRateLimitGuard — RT-224 device principal", () => {
  const OTHER_DEVICE_ID = "0a000000-0000-7000-8000-0000000dev02";
  const DEVICE_PRINCIPAL = { kind: "token", scope: "pos", tokenId: OTHER_DEVICE_ID };
  // A device id is never an auth_tokens id: the token lookup misses (null),
  // exactly as it does against the real table.
  const TOKEN_LOOKUP_MISSES = { deviceId: null } as const;

  it("keys the bucket by the device the device guard resolved; no token lookup", async () => {
    const { guard, checkSpy, recoverSpy } = makeGuard({ decision: ALLOW, ...TOKEN_LOOKUP_MISSES });
    const ok = await guard.canActivate(
      ctxWith({ principal: DEVICE_PRINCIPAL, posDeviceId: OTHER_DEVICE_ID }, "posWriteSale"),
    );
    expect(ok).toBe(true);
    expect(recoverSpy).not.toHaveBeenCalled();
    const [bucketName, identifier] = checkSpy.mock.calls[0] as [string, string, unknown];
    expect(bucketName).toBe("posWriteSale");
    expect(identifier).toBe(OTHER_DEVICE_ID);
  });

  it("over the limit → 429, as on the envelope path", async () => {
    const { guard } = makeGuard({ decision: DENY, ...TOKEN_LOOKUP_MISSES });
    await expect(
      guard.canActivate(
        ctxWith({ principal: DEVICE_PRINCIPAL, posDeviceId: OTHER_DEVICE_ID }, "posWriteSale"),
      ),
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS } as Partial<HttpException>);
  });

  it("a device principal without a resolved device fails open (allow + warn), never invents a key", async () => {
    const { guard, checkSpy, warnSpy } = makeGuard({ decision: DENY, ...TOKEN_LOOKUP_MISSES });
    const ok = await guard.canActivate(ctxWith({ principal: DEVICE_PRINCIPAL }, "posWriteSale"));
    expect(ok).toBe(true);
    expect(checkSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("the envelope path is unchanged: it still recovers the device from the token", async () => {
    const { guard, checkSpy, recoverSpy } = makeGuard({ decision: ALLOW });
    await guard.canActivate(
      ctxWith({ principal: POS_PRINCIPAL, posDeviceId: OTHER_DEVICE_ID }, "posWriteSale"),
    );
    expect(recoverSpy).toHaveBeenCalledWith(TOKEN_ID);
    const [, identifier] = checkSpy.mock.calls[0] as [string, string, unknown];
    expect(identifier).toBe(DEVICE_ID);
  });
});
