/**
 * RT-144 — HealthService readiness checks: per-dependency results, bounded
 * by a timeout, coalesced across concurrent callers, no error text leaked.
 */
import type { Pool } from "pg";

import type { RedisLike } from "../../src/auth/rate-limit";
import { HEALTH_CHECK_TIMEOUT_MS, HealthService } from "../../src/health/health.service";

function pool(query: () => Promise<unknown>): Pool & { query: jest.Mock } {
  return { query: jest.fn(query) } as unknown as Pool & { query: jest.Mock };
}

function redis(pttl: () => Promise<number>): RedisLike & { pttl: jest.Mock } {
  return { pttl: jest.fn(pttl) } as unknown as RedisLike & { pttl: jest.Mock };
}

const ok = async (): Promise<unknown> => ({ rows: [{ "?column?": 1 }] });
const never = (): Promise<never> => new Promise<never>(() => undefined);

describe("HealthService.readiness", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("reports ready when every dependency answers", async () => {
    const svc = new HealthService(pool(ok), pool(ok), redis(async () => -2));
    await expect(svc.readiness()).resolves.toEqual({
      status: "ready",
      checks: { database: "ok", auth_database: "ok", redis: "ok" },
    });
  });

  it("reports the failing dependency and not_ready", async () => {
    const svc = new HealthService(
      pool(ok),
      pool(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
      redis(async () => -2),
    );
    await expect(svc.readiness()).resolves.toEqual({
      status: "not_ready",
      checks: { database: "ok", auth_database: "failed", redis: "ok" },
    });
  });

  it("fails a check that does not answer within the timeout", async () => {
    jest.useFakeTimers();
    const svc = new HealthService(pool(ok), pool(ok), redis(never));
    const report = svc.readiness();
    await jest.advanceTimersByTimeAsync(HEALTH_CHECK_TIMEOUT_MS);
    await expect(report).resolves.toEqual({
      status: "not_ready",
      checks: { database: "ok", auth_database: "ok", redis: "failed" },
    });
  });

  it("shares one in-flight run between concurrent callers, then runs again", async () => {
    const domain = pool(ok);
    const lookup = pool(ok);
    const cache = redis(async () => -2);
    const svc = new HealthService(domain, lookup, cache);

    const [a, b, c] = await Promise.all([svc.readiness(), svc.readiness(), svc.readiness()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(domain.query).toHaveBeenCalledTimes(1);
    expect(lookup.query).toHaveBeenCalledTimes(1);
    expect(cache.pttl).toHaveBeenCalledTimes(1);

    await svc.readiness();
    expect(domain.query).toHaveBeenCalledTimes(2);
  });

  it("logs the check name and an error code only, never the error text", async () => {
    const warn = jest.fn();
    const failure = Object.assign(new Error("password authentication failed for user secret_user"), {
      code: "28P01",
    });
    const svc = new HealthService(
      pool(async () => {
        throw failure;
      }),
      pool(ok),
      redis(async () => -2),
      { warn } as never,
    );
    await svc.readiness();
    expect(warn).toHaveBeenCalledWith({ check: "database", code: "28P01" }, "readiness check failed");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret_user");
  });

  it("does not echo an arbitrary error code", async () => {
    const warn = jest.fn();
    const svc = new HealthService(
      pool(async () => {
        throw Object.assign(new Error("x"), { code: "host=db.internal user=admin" });
      }),
      pool(ok),
      redis(async () => -2),
      { warn } as never,
    );
    await svc.readiness();
    expect(warn).toHaveBeenCalledWith({ check: "database", code: "ERROR" }, "readiness check failed");
  });
});
