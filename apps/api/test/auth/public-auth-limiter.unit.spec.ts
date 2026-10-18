/**
 * RT-628 (RT-574 issue 5e, owner ruling O6) — the bounded public-auth limiter
 * call. Pure unit coverage of `checkWithin` / `releaseWithin` and the timeout
 * setting; the HTTP posture (503 + Retry-After) is pinned by
 * public-auth-redis-outage.http.spec.ts.
 */
import {
  checkWithin,
  DEFAULT_PUBLIC_AUTH_LIMITER_TIMEOUT_MS,
  OutageCaptureGate,
  PublicAuthLimiterUnavailable,
  readPublicAuthLimiterTimeoutMs,
  releaseWithin,
} from "../../src/auth/public-auth-limiter";
import type { RateLimitDecision, RateLimiter } from "../../src/auth/rate-limit";

const POLICY = { limit: 5, windowMs: 60_000 };
const ALLOWED: RateLimitDecision = { allowed: true, count: 1, remaining: 4, resetMs: 60_000 };

function limiter(check: () => Promise<RateLimitDecision>, release: () => Promise<void> = async () => undefined) {
  const fake = { check: jest.fn(check), release: jest.fn(release) };
  return { fake, asLimiter: fake as unknown as RateLimiter };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const hit = (bucketName: string, identifier: string) => ({ bucketName, identifier, bucket: POLICY });

describe("checkWithin", () => {
  it("returns the limiter's decision when it answers in time", async () => {
    const { asLimiter, fake } = limiter(async () => ALLOWED);
    await expect(checkWithin(asLimiter, hit("signin_ip", "1.2.3.4"), 1_000)).resolves.toEqual(ALLOWED);
    expect(fake.check).toHaveBeenCalledWith("signin_ip", "1.2.3.4", POLICY);
    expect(fake.release).not.toHaveBeenCalled();
  });

  it("returns a refusal unchanged (a 429 decision is not an outage)", async () => {
    const refused = { allowed: false, count: 6, remaining: 0, resetMs: 1_000 };
    const { asLimiter } = limiter(async () => refused);
    await expect(checkWithin(asLimiter, hit("signin_ip", "x"), 1_000)).resolves.toEqual(refused);
  });

  it("rejects with reason 'timeout' within the bound when the limiter never answers", async () => {
    const { asLimiter } = limiter(() => new Promise<never>(() => undefined));
    const started = Date.now();
    const err = await checkWithin(asLimiter, hit("signin_ip", "x"), 50).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(err).toBeInstanceOf(PublicAuthLimiterUnavailable);
    expect((err as PublicAuthLimiterUnavailable).reason).toBe("timeout");
  });

  it("rejects with reason 'error' when the limiter throws", async () => {
    const { asLimiter, fake } = limiter(async () => {
      throw new Error("connection refused");
    });
    const err = await checkWithin(asLimiter, hit("signin_ip", "x"), 1_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublicAuthLimiterUnavailable);
    expect((err as PublicAuthLimiterUnavailable).reason).toBe("error");
    expect(fake.release).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "an abandoned call that settles late (%s) is not released and never throws unhandled",
    async (settle) => {
      const late = deferred<RateLimitDecision>();
      const { asLimiter, fake } = limiter(() => late.promise);
      await expect(checkWithin(asLimiter, hit("signin_ip", "x"), 20)).rejects.toBeInstanceOf(
        PublicAuthLimiterUnavailable,
      );
      if (settle === "reject") late.reject(new Error("MaxRetriesPerRequestError"));
      else late.resolve(ALLOWED);
      await flush();
      expect(fake.release).not.toHaveBeenCalled();
    },
  );
});

describe("releaseWithin", () => {
  it("resolves after the release when it answers in time", async () => {
    const { asLimiter, fake } = limiter(async () => ALLOWED);
    await expect(releaseWithin(asLimiter, "signin_account", "a@x.test", 1_000)).resolves.toBeUndefined();
    expect(fake.release).toHaveBeenCalledWith("signin_account", "a@x.test");
  });

  it("resolves within the bound when the release never answers", async () => {
    const { asLimiter } = limiter(async () => ALLOWED, () => new Promise<never>(() => undefined));
    const started = Date.now();
    await expect(releaseWithin(asLimiter, "signin_account", "a", 50)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("resolves when the release throws (over-counting is the safe direction)", async () => {
    const { asLimiter } = limiter(async () => ALLOWED, async () => {
      throw new Error("down");
    });
    await expect(releaseWithin(asLimiter, "signin_account", "a", 1_000)).resolves.toBeUndefined();
  });
});

describe("readPublicAuthLimiterTimeoutMs", () => {
  it("defaults to 1000 ms and accepts 1..10000", () => {
    expect(DEFAULT_PUBLIC_AUTH_LIMITER_TIMEOUT_MS).toBe(1_000);
    expect(readPublicAuthLimiterTimeoutMs({})).toBe(1_000);
    expect(readPublicAuthLimiterTimeoutMs({ PUBLIC_AUTH_LIMITER_TIMEOUT_MS: "250" })).toBe(250);
    expect(readPublicAuthLimiterTimeoutMs({ PUBLIC_AUTH_LIMITER_TIMEOUT_MS: " 1 " })).toBe(1);
    expect(readPublicAuthLimiterTimeoutMs({ PUBLIC_AUTH_LIMITER_TIMEOUT_MS: "10000" })).toBe(10_000);
  });

  it("falls back to the default for an unset, non-integer or out-of-range value", () => {
    for (const raw of ["", "0", "10001", "-5", "1.5", "abc", "1e3"]) {
      expect(readPublicAuthLimiterTimeoutMs({ PUBLIC_AUTH_LIMITER_TIMEOUT_MS: raw })).toBe(1_000);
    }
  });
});

describe("OutageCaptureGate (one Sentry event per outage window)", () => {
  it("captures the first refusal, suppresses the rest until the limiter answers again", () => {
    const gate = new OutageCaptureGate();
    expect([gate.shouldCapture(), gate.shouldCapture(), gate.shouldCapture()]).toEqual([true, false, false]);
    gate.recovered();
    expect([gate.shouldCapture(), gate.shouldCapture()]).toEqual([true, false]);
  });

  it("a healthy call without an outage changes nothing", () => {
    const gate = new OutageCaptureGate();
    gate.recovered();
    gate.recovered();
    expect(gate.shouldCapture()).toBe(true);
  });
});
