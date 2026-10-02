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
} {
  const checkSpy = jest.fn(async () => {
    if (opts.checkThrows) throw new Error("redis down");
    return opts.decision ?? ALLOW;
  });
  const rateLimiter = { check: checkSpy } as unknown as RateLimiter;
  const reverifier = {
    recoverDeviceId: jest.fn(async () => (opts.deviceId === undefined ? DEVICE_ID : opts.deviceId)),
  } as unknown as OperatorReverifier;
  const warnSpy = jest.fn();
  const logger = { warn: warnSpy, error: jest.fn(), info: jest.fn(), debug: jest.fn() };
  // Fake reflector mirrors the real `reflector.get(KEY, handler)` by reading the
  // bucket annotation the ctx carries (set by ctxWith via __bucket).
  const reflector = {
    get: (_key: unknown, handler: { __bucket?: string }) => handler?.__bucket,
  } as unknown as Reflector;
  const guard = new PosWriteRateLimitGuard(rateLimiter, reverifier, reflector, logger as unknown as Logger);
  return { guard, checkSpy, warnSpy };
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
