/**
 * RT-628 (RT-574 issue 5e, owner ruling O6, 2026-10-17) — public-auth
 * limiter posture on a Redis outage: fail closed, deliberately. A bounded
 * timeout, then 503 with `Retry-After`; never a hang, never a 500.
 *
 * "Redis stopped" is reproduced with the production wiring: a real ioredis
 * client (default options: offline queue + reconnect retries) pointed at a
 * port nothing listens on, wrapped in `IoredisIdempotencyAdapter` and the
 * real `RateLimiter`. That is exactly how production behaves with Redis
 * down: the command queues and the promise neither resolves nor rejects for
 * seconds. No Docker needed, so this runs in CI.
 */
import "reflect-metadata";

import { type CanActivate, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import Redis from "ioredis";
import request from "supertest";

import { AuthController } from "../../src/auth/auth.controller";
import { AuthGuard } from "../../src/auth/auth.guard";
import { AuthService } from "../../src/auth/auth.service";
import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";
import { IoredisIdempotencyAdapter } from "../../src/auth/ioredis-idempotency-adapter";
import { PUBLIC_AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS } from "../../src/auth/public-auth-limiter";
import { RateLimiter, type RateLimitDecision } from "../../src/auth/rate-limit";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { ZodValidationPipe } from "../../src/common/zod-validation.pipe";
import { captureServerError } from "../../src/observability/sentry/sentry";

jest.mock("../../src/observability/sentry/sentry", () => ({
  ...jest.requireActual("../../src/observability/sentry/sentry"),
  captureServerError: jest.fn(),
}));

const TIMEOUT_MS = 200;
/** Generous CI slack on top of the timeout; a hang would be ~10 s (ioredis retries). */
const LATENCY_BOUND_MS = TIMEOUT_MS + 1_300;
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);

class SpyAuthService {
  calls: string[] = [];
  async signIn(): Promise<unknown> {
    this.calls.push("signIn");
    return {
      sessionId: "s",
      sessionCredential: "c",
      userId: "u",
      absoluteExpiresAt: FUTURE,
      user: { id: "u", email: "user@example.com", display_name: null, is_platform_admin: false },
      memberships: [],
    };
  }
  async requestPasswordReset(): Promise<void> {
    this.calls.push("requestPasswordReset");
  }
  async confirmPasswordReset(): Promise<void> {
    this.calls.push("confirmPasswordReset");
  }
}

const allowGuard: CanActivate = { canActivate: () => true };

async function boot(limiter: unknown, svc: SpyAuthService): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      { provide: AuthService, useValue: svc },
      { provide: RateLimiter, useValue: limiter },
    ],
  })
    .overrideGuard(AuthGuard)
    .useValue(allowGuard)
    .overrideGuard(DashboardAuthGuard)
    .useValue(allowGuard)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
  return app;
}

const ROUTES = [
  { path: "/api/v1/auth/signin", body: { email: "user@example.com", password: "secret123" } },
  { path: "/api/v1/auth/password-reset/request", body: { email: "user@example.com" } },
  {
    path: "/api/v1/auth/password-reset/confirm",
    body: { token: "a".repeat(43), new_password: "a-long-enough-password" },
  },
] as const;

let savedTimeout: string | undefined;
beforeAll(() => {
  savedTimeout = process.env["PUBLIC_AUTH_LIMITER_TIMEOUT_MS"];
  process.env["PUBLIC_AUTH_LIMITER_TIMEOUT_MS"] = String(TIMEOUT_MS);
});
afterAll(() => {
  if (savedTimeout === undefined) delete process.env["PUBLIC_AUTH_LIMITER_TIMEOUT_MS"];
  else process.env["PUBLIC_AUTH_LIMITER_TIMEOUT_MS"] = savedTimeout;
});

describe("RT-628 — Redis stopped: public-auth routes fail closed with 503 + Retry-After", () => {
  let client: Redis;
  let app: INestApplication;
  const svc = new SpyAuthService();

  beforeAll(async () => {
    client = new Redis("redis://127.0.0.1:1"); // nothing listens: production's hang
    client.on("error", () => undefined);
    app = await boot(new RateLimiter(new IoredisIdempotencyAdapter(client)), svc);
  });

  afterAll(async () => {
    if (app) await app.close();
    client.disconnect();
  });

  it.each(ROUTES)("$path answers 503 with Retry-After within the timeout and never reaches the service", async ({ path, body }) => {
    svc.calls = [];
    const started = Date.now();
    const res = await request(app.getHttpServer()).post(path).send(body);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe(String(PUBLIC_AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS));
    expect(res.body).toMatchObject({
      error: { code: "service_unavailable", message: expect.any(String), request_id: expect.any(String) },
    });
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 20);
    expect(elapsed).toBeLessThan(LATENCY_BOUND_MS);
    expect(svc.calls).toEqual([]);
  });
});

describe("RT-628 — partial outage and errors", () => {
  class ScriptedLimiter {
    mode: Record<string, "allow" | "hang" | "throw"> = {};
    released: string[] = [];
    releaseHangs = false;
    async check(bucket: string): Promise<RateLimitDecision> {
      const m = this.mode[bucket] ?? "allow";
      if (m === "hang") return new Promise<never>(() => undefined);
      if (m === "throw") throw new Error("ECONNREFUSED");
      return { allowed: true, count: 1, remaining: 4, resetMs: 60_000 };
    }
    async release(bucket: string): Promise<void> {
      this.released.push(bucket);
      if (this.releaseHangs) await new Promise<never>(() => undefined);
    }
  }

  let app: INestApplication;
  const svc = new SpyAuthService();
  const limiter = new ScriptedLimiter();

  beforeAll(async () => {
    app = await boot(limiter, svc);
  });
  afterAll(async () => {
    if (app) await app.close();
  });
  beforeEach(() => {
    limiter.mode = {};
    limiter.released = [];
    limiter.releaseHangs = false;
    svc.calls = [];
  });

  it("a limiter error (not a hang) is also a 503 + Retry-After, not a 500", async () => {
    limiter.mode = { signin_account: "throw" };
    const res = await request(app.getHttpServer()).post(ROUTES[0].path).send(ROUTES[0].body);
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe(String(PUBLIC_AUTH_UNAVAILABLE_RETRY_AFTER_SECONDS));
    expect(svc.calls).toEqual([]);
  });

  it("account check passes, IP check hangs: 503 within the bound, and the account hit is given back", async () => {
    limiter.mode = { signin_ip: "hang" };
    const started = Date.now();
    const res = await request(app.getHttpServer()).post(ROUTES[0].path).send(ROUTES[0].body);
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(LATENCY_BOUND_MS);
    expect(limiter.released).toEqual(["signin_account"]);
    expect(svc.calls).toEqual([]);
  });

  it("a hanging release cannot hang the 503 either (both waits are bounded)", async () => {
    limiter.mode = { signin_ip: "hang" };
    limiter.releaseHangs = true;
    const started = Date.now();
    const res = await request(app.getHttpServer()).post(ROUTES[0].path).send(ROUTES[0].body);
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(2 * TIMEOUT_MS + 1_300);
  });

  it("a hanging release after a successful sign-in still answers 200 within the bound", async () => {
    limiter.releaseHangs = true;
    const started = Date.now();
    const res = await request(app.getHttpServer()).post(ROUTES[0].path).send(ROUTES[0].body);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(LATENCY_BOUND_MS);
    expect(svc.calls).toEqual(["signIn"]);
  });

  it("sends ONE Sentry event per outage window, not one per refused attempt", async () => {
    const post = () => request(app.getHttpServer()).post(ROUTES[0].path).send(ROUTES[0].body);
    expect((await post()).status).toBe(200); // healthy: any earlier window is closed
    (captureServerError as jest.Mock).mockClear();

    limiter.mode = { signin_account: "throw" };
    expect([(await post()).status, (await post()).status, (await post()).status]).toEqual([503, 503, 503]);
    expect(captureServerError).toHaveBeenCalledTimes(1);

    limiter.mode = {}; // Redis back: the window closes
    expect((await post()).status).toBe(200);
    limiter.mode = { signin_account: "throw" }; // a new outage opens a new window
    expect([(await post()).status, (await post()).status]).toEqual([503, 503]);
    expect(captureServerError).toHaveBeenCalledTimes(2);
  });

  it("a healthy limiter is unaffected: 200 / 202 / 204", async () => {
    const statuses = [];
    for (const { path, body } of ROUTES) {
      statuses.push((await request(app.getHttpServer()).post(path).send(body)).status);
    }
    expect(statuses).toEqual([200, 202, 204]);
  });
});
