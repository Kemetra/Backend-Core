/**
 * RT-619 — ConsoleRateLimitGuard unit behaviour (RT-574 issue 1, D1-D6).
 *
 * Docker-free: the limiter is a stub whose decision the test controls, and
 * the execution context is a plain object. The HTTP shape over a real Nest
 * app (exception filter, request-id interceptor) is in
 * console-rate-limit.http.spec.ts.
 */
import "reflect-metadata";

import { Controller, Get, HttpException, Post, type ExecutionContext } from "@nestjs/common";

import type { RateLimitBucket, RateLimitDecision, RateLimiter } from "../../src/auth/rate-limit";
import { ConsoleRateLimit } from "../../src/console-rate-limit/console-rate-limit.decorator";
import { ConsoleRateLimitGuard } from "../../src/console-rate-limit/console-rate-limit.guard";
import type { ConsoleRateLimitConfig } from "../../src/console-rate-limit/console-rate-limit.config";
import * as apiMetrics from "../../src/observability/metrics/api.metrics";

@Controller("api/v1/probe")
class ProbeController {
  @Get("items")
  list(): void {}

  @Post("items")
  create(): void {}

  @Get("heavy")
  @ConsoleRateLimit("expensiveRead")
  heavy(): void {}

  @Post("revoke")
  @ConsoleRateLimit("incidentControl")
  revoke(): void {}
}

// Same class name as the real controller: the shared exemption list matches
// on `<Controller>.<handler>`.
@Controller("api/v1/auth")
class AuthController {
  @Post("signout")
  signOut(): void {}
}

type Principal = Record<string, unknown> | undefined;

interface Probe {
  context: ExecutionContext;
  request: { principal?: Principal; headers: Record<string, string>; requestId?: string };
  headers: Record<string, string>;
}

function probe(
  principal: Principal,
  handler = "list",
  options: { klass?: object; inboundRequestId?: string } = {},
): Probe {
  const klass = options.klass ?? ProbeController;
  const proto = (klass as { prototype: Record<string, unknown> }).prototype;
  const handlerFn = proto[handler];
  const headers: Record<string, string> = {};
  const request = {
    principal,
    headers: options.inboundRequestId ? { "x-request-id": options.inboundRequestId } : {},
  } as Probe["request"];
  const response = {
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => handlerFn,
    getClass: () => klass,
  } as unknown as ExecutionContext;
  return { context, request, headers };
}

const SESSION = { kind: "session", sessionId: "s-1", userId: "user-1" };

interface StubLimiter {
  limiter: RateLimiter;
  check: jest.Mock;
  setCount(count: number, resetMs?: number): void;
}

function stubLimiter(): StubLimiter {
  let count = 1;
  let resetMs = 30_000;
  const check = jest.fn(
    async (_bucket: string, _id: string, bucket: RateLimitBucket): Promise<RateLimitDecision> => ({
      allowed: count <= bucket.limit,
      count,
      remaining: Math.max(0, bucket.limit - count),
      resetMs,
    }),
  );
  return {
    limiter: { check } as unknown as RateLimiter,
    check,
    setCount(next: number, nextReset = 30_000) {
      count = next;
      resetMs = nextReset;
    },
  };
}

function config(mode: ConsoleRateLimitConfig["mode"], timeoutMs = 250): ConsoleRateLimitConfig {
  return { mode, timeoutMs };
}

function logger() {
  return { warn: jest.fn() };
}

let recordTotal: jest.SpyInstance;
let recordUtilisation: jest.SpyInstance;

beforeEach(() => {
  recordTotal = jest.spyOn(apiMetrics, "recordConsoleRateLimit");
  recordUtilisation = jest.spyOn(apiMetrics, "recordConsoleRateLimitUtilisation");
});

function guardWith(
  mode: ConsoleRateLimitConfig["mode"],
  stub: StubLimiter,
  log = logger(),
  clock: () => number = Date.now,
  timeoutMs = 250,
) {
  return new ConsoleRateLimitGuard(config(mode, timeoutMs), stub.limiter, log, clock);
}

async function refusal(guard: ConsoleRateLimitGuard, p: Probe): Promise<HttpException> {
  try {
    await guard.canActivate(p.context);
  } catch (err) {
    return err as HttpException;
  }
  throw new Error("expected a 429");
}

describe("mode off (default, RT-574 O3b)", () => {
  it("allows without any Redis call, metric or header", async () => {
    const stub = stubLimiter();
    stub.setCount(10_000);
    const p = probe(SESSION);
    await expect(guardWith("off", stub).canActivate(p.context)).resolves.toBe(true);
    expect(stub.check).not.toHaveBeenCalled();
    expect(recordTotal).not.toHaveBeenCalled();
    expect(recordUtilisation).not.toHaveBeenCalled();
    expect(p.headers).toEqual({});
    expect(p.request.requestId).toBeUndefined();
  });
});

describe("keying (RT-574 D2)", () => {
  it.each([
    ["a cookie session", SESSION, "u:user-1"],
    [
      "a dashboard_api bearer with a user",
      { kind: "token", tokenId: "tok-1", tenantId: "t", userId: "user-1", storeId: null, scope: "dashboard_api" },
      "u:user-1",
    ],
    [
      "a dashboard_api bearer without a user",
      { kind: "token", tokenId: "tok-1", tenantId: "t", userId: null, storeId: null, scope: "dashboard_api" },
      "t:tok-1",
    ],
  ])("keys %s per subject", async (_label, principal, identifier) => {
    const stub = stubLimiter();
    await guardWith("report", stub).canActivate(probe(principal).context);
    expect(stub.check).toHaveBeenCalledWith("console_cheapRead", identifier, { limit: 300, windowMs: 60_000 });
  });

  it("a user id and a token id with the same string never share a key", async () => {
    const stub = stubLimiter();
    const guard = guardWith("report", stub);
    await guard.canActivate(probe({ kind: "session", sessionId: "s", userId: "same" }).context);
    await guard.canActivate(
      probe({ kind: "token", tokenId: "same", tenantId: null, userId: null, storeId: null, scope: "dashboard_api" })
        .context,
    );
    expect(stub.check.mock.calls.map((c) => c[1])).toEqual(["u:same", "t:same"]);
  });

  it.each([
    ["no principal (public or device-bearer route)", undefined],
    ["a pos device", { kind: "token", tokenId: "d", tenantId: "t", userId: null, storeId: "s", scope: "pos" }],
    ["a pos_operator", { kind: "token", tokenId: "o", tenantId: "t", userId: "u", storeId: "s", scope: "pos_operator" }],
    ["a connector", { kind: "token", tokenId: "c", tenantId: "t", userId: null, storeId: null, scope: "connector" }],
    ["an unknown principal kind", { kind: "clerk", userId: "u" }],
    ["a session without a user id", { kind: "session", sessionId: "s", userId: "" }],
  ])("does not touch %s", async (_label, principal) => {
    const stub = stubLimiter();
    stub.setCount(10_000);
    await expect(guardWith("enforce", stub).canActivate(probe(principal).context)).resolves.toBe(true);
    expect(stub.check).not.toHaveBeenCalled();
    expect(recordTotal).not.toHaveBeenCalled();
  });
});

describe("classification (RT-574 D1/D3)", () => {
  it.each([
    ["list", "console_cheapRead", { limit: 300, windowMs: 60_000 }],
    ["create", "console_write", { limit: 30, windowMs: 60_000 }],
    ["heavy", "console_expensiveRead", { limit: 60, windowMs: 60_000 }],
    ["revoke", "console_incidentControl", { limit: 120, windowMs: 600_000 }],
  ] as const)("%s resolves to %s", async (handler, bucketName, bucket) => {
    const stub = stubLimiter();
    await guardWith("report", stub).canActivate(probe(SESSION, handler).context);
    expect(stub.check).toHaveBeenCalledWith(bucketName, "u:user-1", bucket);
  });

  it("an exempt operation is never checked and counts as class exempt", async () => {
    const stub = stubLimiter();
    stub.setCount(10_000);
    const p = probe(SESSION, "signOut", { klass: AuthController });
    await expect(guardWith("enforce", stub).canActivate(p.context)).resolves.toBe(true);
    expect(stub.check).not.toHaveBeenCalled();
    expect(recordTotal).toHaveBeenCalledWith({ class: "exempt", outcome: "allowed", route: "/api/v1/auth/signout" });
  });
});

describe("outcomes and utilisation (RT-574 D6)", () => {
  it.each([
    [1, "allowed"],
    [149, "allowed"],
    [150, "near_limit"],
    [300, "near_limit"],
  ])("count %i of 300 is %s", async (count, outcome) => {
    const stub = stubLimiter();
    stub.setCount(count);
    await expect(guardWith("enforce", stub).canActivate(probe(SESSION).context)).resolves.toBe(true);
    expect(recordTotal).toHaveBeenCalledWith({ class: "cheapRead", outcome, route: "/api/v1/probe/items" });
    expect(recordUtilisation).toHaveBeenCalledWith({ class: "cheapRead", route: "/api/v1/probe/items" }, count / 300);
  });

  it("labels carry no user, tenant or IP value", async () => {
    const stub = stubLimiter();
    await guardWith("report", stub).canActivate(probe(SESSION).context);
    for (const [labels] of [...recordTotal.mock.calls, ...recordUtilisation.mock.calls]) {
      expect(Object.keys(labels as object).sort()).toEqual(
        Object.keys(labels as object).includes("outcome") ? ["class", "outcome", "route"] : ["class", "route"],
      );
      expect(JSON.stringify(labels)).not.toContain("user-1");
    }
  });
});

describe("mode report", () => {
  it("never refuses; an over-budget request counts would_limit", async () => {
    const stub = stubLimiter();
    stub.setCount(301);
    const p = probe(SESSION);
    await expect(guardWith("report", stub).canActivate(p.context)).resolves.toBe(true);
    expect(recordTotal).toHaveBeenCalledWith({ class: "cheapRead", outcome: "would_limit", route: "/api/v1/probe/items" });
    expect(p.headers).toEqual({});
  });

  it("warns at most once per class per 60 s, with class and route only", async () => {
    let now = 1_000_000;
    const stub = stubLimiter();
    stub.setCount(301);
    const log = logger();
    const guard = guardWith("report", stub, log, () => now);
    await guard.canActivate(probe(SESSION).context);
    await guard.canActivate(probe(SESSION).context);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toEqual({ class: "cheapRead", route: "/api/v1/probe/items" });
    now += 60_000;
    await guard.canActivate(probe(SESSION).context);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("user-1");
  });
});

describe("mode enforce (RT-574 D5, owner O1)", () => {
  it("refuses limit+1 with the canonical 429 and its headers", async () => {
    const stub = stubLimiter();
    stub.setCount(31, 12_500);
    const p = probe(SESSION, "create");
    const err = await refusal(guardWith("enforce", stub), p);
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(429);
    expect(err.getResponse()).toEqual({ code: "rate_limited", message: "Too many requests." });
    expect(p.headers["Retry-After"]).toBe("13");
    expect(p.headers["Cache-Control"]).toBe("no-store");
    expect(p.headers["X-Request-Id"]).toBe(p.request.requestId);
    expect(p.request.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(recordTotal).toHaveBeenCalledWith({ class: "write", outcome: "limited", route: "/api/v1/probe/items" });
  });

  it("honours a well-formed inbound X-Request-Id", async () => {
    const inbound = "0190f1cf-1111-7222-8333-944455556666";
    const stub = stubLimiter();
    stub.setCount(31);
    const p = probe(SESSION, "create", { inboundRequestId: inbound });
    await refusal(guardWith("enforce", stub), p);
    expect(p.request.requestId).toBe(inbound);
    expect(p.headers["X-Request-Id"]).toBe(inbound);
  });

  it("replaces a malformed inbound X-Request-Id", async () => {
    const stub = stubLimiter();
    stub.setCount(31);
    const p = probe(SESSION, "create", { inboundRequestId: "not-a-uuid" });
    await refusal(guardWith("enforce", stub), p);
    expect(p.request.requestId).not.toBe("not-a-uuid");
    expect(p.headers["X-Request-Id"]).toBe(p.request.requestId);
  });

  it.each([
    [-1, "1"],
    [0, "1"],
    [1, "1"],
    [1_500, "2"],
    [3_600_000, "3600"],
    [7_200_000, "3600"],
  ])("resetMs %i gives Retry-After %s (clamped [1,3600])", async (resetMs, expected) => {
    const stub = stubLimiter();
    stub.setCount(31, resetMs);
    const p = probe(SESSION, "create");
    await refusal(guardWith("enforce", stub), p);
    expect(p.headers["Retry-After"]).toBe(expected);
  });
});

describe("fail-open (RT-574 D4, owner O3)", () => {
  it("allows when the limiter throws, counts fail_open and logs no identifiers", async () => {
    const stub = stubLimiter();
    stub.check.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const log = logger();
    await expect(guardWith("enforce", stub, log).canActivate(probe(SESSION).context)).resolves.toBe(true);
    expect(recordTotal).toHaveBeenCalledWith({ class: "cheapRead", outcome: "fail_open", route: "/api/v1/probe/items" });
    expect(recordUtilisation).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toEqual({ class: "cheapRead", route: "/api/v1/probe/items", err_class: "Error" });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("user-1");
  });

  it("allows within the timeout when the limiter hangs", async () => {
    const stub = stubLimiter();
    stub.check.mockReturnValueOnce(new Promise(() => undefined));
    const started = Date.now();
    await expect(
      guardWith("enforce", stub, logger(), Date.now, 30).canActivate(probe(SESSION).context),
    ).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(recordTotal).toHaveBeenCalledWith({ class: "cheapRead", outcome: "fail_open", route: "/api/v1/probe/items" });
  });

  it("after 5 consecutive failures the breaker skips the limiter, then probes once after 10 s", async () => {
    let now = 1_000_000;
    const stub = stubLimiter();
    stub.check.mockRejectedValue(new Error("down"));
    const guard = guardWith("enforce", stub, logger(), () => now);
    for (let i = 0; i < 5; i++) await guard.canActivate(probe(SESSION).context);
    expect(stub.check).toHaveBeenCalledTimes(5);

    await expect(guard.canActivate(probe(SESSION).context)).resolves.toBe(true);
    expect(stub.check).toHaveBeenCalledTimes(5);
    expect(recordTotal).toHaveBeenLastCalledWith({ class: "cheapRead", outcome: "fail_open", route: "/api/v1/probe/items" });

    now += 10_000;
    stub.check.mockReset();
    stub.check.mockResolvedValue({ allowed: true, count: 1, remaining: 299, resetMs: 60_000 });
    await guard.canActivate(probe(SESSION).context);
    await guard.canActivate(probe(SESSION).context);
    expect(stub.check).toHaveBeenCalledTimes(2);
  });

  it("warns about fail-open at most once per class per 60 s", async () => {
    const stub = stubLimiter();
    stub.check.mockRejectedValue(new Error("down"));
    const log = logger();
    const guard = guardWith("enforce", stub, log, () => 5_000_000);
    for (let i = 0; i < 3; i++) await guard.canActivate(probe(SESSION).context);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("an unexpected internal error fails open instead of becoming a 500", async () => {
    const stub = stubLimiter();
    const p = probe(SESSION);
    (p.context as unknown as { getHandler: () => never }).getHandler = () => {
      throw new TypeError("boom");
    };
    const log = logger();
    await expect(guardWith("enforce", stub, log).canActivate(p.context)).resolves.toBe(true);
    expect(stub.check).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith({ err_class: "TypeError" }, expect.any(String));
  });

  it("works without a logger", async () => {
    const stub = stubLimiter();
    stub.check.mockRejectedValueOnce(new Error("down"));
    const guard = new ConsoleRateLimitGuard(config("enforce"), stub.limiter);
    await expect(guard.canActivate(probe(SESSION).context)).resolves.toBe(true);
  });
});
