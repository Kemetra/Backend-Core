/**
 * RT-619 — ConsoleRateLimitGuard over a real Nest HTTP stack (RT-574 issue 1,
 * AC1-AC4, AC7, AC8).
 *
 * The app registers the real GlobalExceptionFilter and RequestIdInterceptor
 * the way main.ts does, so the 429 body, the `request_id` and the
 * `X-Request-Id` header are the production ones. A stand-in global guard sets
 * `request.principal` (FailClosedAuthGuard's job), registered before the
 * console guard exactly as in AppModule.
 *
 * Three limiter back ends:
 *   1. a stateful in-memory Redis fake with a controllable clock (Docker-free,
 *      runs in CI): boundary, headers, rollover, keying, idempotency non-claim;
 *   2. a REAL ioredis client pointed at a closed port (Docker-free): with the
 *      default client options a command sits in the offline queue, i.e. the
 *      "Redis hangs" case the decision record inferred; the guard must fail
 *      open within the timeout and the breaker must stop the waiting;
 *   3. a real Redis (REDIS_URL-gated, like rate-limit.real-redis.spec.ts; CI
 *      has no Redis service): the real key, TTL and Lua script end to end.
 */
import "reflect-metadata";

import {
  type CallHandler,
  type CanActivate,
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  type INestApplication,
  Injectable,
  type NestInterceptor,
  Post,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import Redis from "ioredis";
import type { Observable } from "rxjs";
import request from "supertest";

import { IoredisIdempotencyAdapter } from "../../src/auth/ioredis-idempotency-adapter";
import { RateLimiter, type RedisLike, type WindowHit } from "../../src/auth/rate-limit";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import {
  CONSOLE_RATE_LIMIT_CONFIG,
  type ConsoleRateLimitConfig,
} from "../../src/console-rate-limit/console-rate-limit.config";
import {
  CONSOLE_RATE_LIMIT_CLOCK,
  ConsoleRateLimitGuard,
} from "../../src/console-rate-limit/console-rate-limit.guard";
import { fixedWindowHit, type FixedWindowEntry } from "../_helpers/fixed-window-hit";

@Controller("api/v1/probe")
class ProbeController {
  @Get("items")
  list(): { ok: true } {
    return { ok: true };
  }

  @Post("items")
  @HttpCode(201)
  create(): { ok: true } {
    return { ok: true };
  }
}

/** Stand-in for FailClosedAuthGuard: `x-test-user` / `x-test-session` → a session principal. */
@Injectable()
class TestPrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      principal?: unknown;
    }>();
    const userId = req.headers["x-test-user"];
    if (userId) req.principal = { kind: "session", sessionId: req.headers["x-test-session"] ?? "s-1", userId };
    return true;
  }
}

/**
 * Records every request that reaches the interceptor chain, which is where
 * IdempotencyInterceptor claims a key. A request refused by a guard never
 * gets here, so it can never claim (or store) an idempotency key.
 */
class ReachedInterceptors implements NestInterceptor {
  readonly keys: Array<string | undefined> = [];
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    this.keys.push(req.headers["idempotency-key"]);
    return next.handle();
  }
}

class ClockedRedisFake implements RedisLike {
  readonly store = new Map<string, FixedWindowEntry>();
  calls = 0;
  constructor(private readonly clock: () => number) {}
  async incrWindow(key: string, ttlMs: number): Promise<WindowHit> {
    this.calls += 1;
    return fixedWindowHit(this.store, key, ttlMs, this.clock());
  }
  async pttl(): Promise<number> {
    return -2;
  }
  async decr(): Promise<number> {
    return 0;
  }
  async del(): Promise<number> {
    return 0;
  }
}

interface Harness {
  app: INestApplication;
  reached: ReachedInterceptors;
  advance(ms: number): void;
}

async function boot(mode: ConsoleRateLimitConfig["mode"], redis: RedisLike | "fake", timeoutMs = 250) {
  let now = 1_700_000_000_000;
  const clock = (): number => now;
  const backend = redis === "fake" ? new ClockedRedisFake(clock) : redis;
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    providers: [
      { provide: APP_GUARD, useClass: TestPrincipalGuard },
      { provide: APP_GUARD, useClass: ConsoleRateLimitGuard },
      { provide: CONSOLE_RATE_LIMIT_CONFIG, useValue: { mode, timeoutMs } },
      { provide: RateLimiter, useValue: new RateLimiter(backend) },
      { provide: CONSOLE_RATE_LIMIT_CLOCK, useValue: clock },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  const reached = new ReachedInterceptors();
  app.useGlobalInterceptors(new RequestIdInterceptor(), reached);
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
  const harness: Harness = {
    app,
    reached,
    advance(ms: number) {
      now += ms;
    },
  };
  return { ...harness, backend };
}

function post(app: INestApplication, user: string, extra: Record<string, string> = {}) {
  return request(app.getHttpServer()).post("/api/v1/probe/items").set({ "x-test-user": user, ...extra });
}

async function spend(app: INestApplication, user: string, times: number, extra: Record<string, string> = {}) {
  for (let i = 0; i < times; i++) {
    const res = await post(app, user, extra);
    expect(res.status).toBe(201);
  }
}

describe("enforce mode over HTTP (in-memory Redis fake)", () => {
  let h: Awaited<ReturnType<typeof boot>>;

  beforeEach(async () => {
    h = await boot("enforce", "fake");
  });

  afterEach(async () => {
    await h.app.close();
  });

  it("refuses request limit+1 with the canonical 429 envelope and headers, then the next window passes", async () => {
    await spend(h.app, "alice", 30);
    const refused = await post(h.app, "alice");
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({
      error: { code: "rate_limited", message: "Too many requests.", request_id: expect.any(String) },
    });
    expect(refused.headers["retry-after"]).toBe("60");
    expect(refused.headers["cache-control"]).toBe("no-store");
    expect(refused.headers["x-request-id"]).toBe(refused.body.error.request_id);

    h.advance(60_000);
    expect((await post(h.app, "alice")).status).toBe(201);
  });

  it("echoes a well-formed inbound X-Request-Id on the 429", async () => {
    const inbound = "0190f1cf-1111-7222-8333-944455556666";
    await spend(h.app, "alice", 30);
    const refused = await post(h.app, "alice", { "x-request-id": inbound });
    expect(refused.headers["x-request-id"]).toBe(inbound);
    expect(refused.body.error.request_id).toBe(inbound);
  });

  it("two sessions of one user share a budget; another user does not", async () => {
    await spend(h.app, "alice", 15, { "x-test-session": "s-1" });
    await spend(h.app, "alice", 15, { "x-test-session": "s-2" });
    expect((await post(h.app, "alice", { "x-test-session": "s-3" })).status).toBe(429);
    expect((await post(h.app, "bob")).status).toBe(201);
  });

  it("GET and POST spend separate class budgets", async () => {
    await spend(h.app, "alice", 30);
    expect((await post(h.app, "alice")).status).toBe(429);
    const read = await request(h.app.getHttpServer()).get("/api/v1/probe/items").set({ "x-test-user": "alice" });
    expect(read.status).toBe(200);
  });

  it("an unauthenticated request is never counted", async () => {
    for (let i = 0; i < 40; i++) {
      expect((await request(h.app.getHttpServer()).post("/api/v1/probe/items")).status).toBe(201);
    }
    expect((h.backend as ClockedRedisFake).calls).toBe(0);
  });

  it("a 429 never reaches the interceptor chain, so it cannot claim an idempotency key; the same key succeeds after the window", async () => {
    await spend(h.app, "alice", 30);
    const before = h.reached.keys.length;
    const refused = await post(h.app, "alice", { "idempotency-key": "key-31" });
    expect(refused.status).toBe(429);
    expect(h.reached.keys.length).toBe(before);

    h.advance(60_000);
    const retried = await post(h.app, "alice", { "idempotency-key": "key-31" });
    expect(retried.status).toBe(201);
    expect(h.reached.keys.at(-1)).toBe("key-31");
  });
});

describe("report and off modes over HTTP", () => {
  it("report never refuses", async () => {
    const h = await boot("report", "fake");
    try {
      await spend(h.app, "alice", 45);
    } finally {
      await h.app.close();
    }
  });

  it("off makes no limiter call at all", async () => {
    const h = await boot("off", "fake");
    try {
      await spend(h.app, "alice", 45);
      expect((h.backend as ClockedRedisFake).calls).toBe(0);
    } finally {
      await h.app.close();
    }
  });
});

describe("fail-open against a real ioredis client whose server is down (Docker-free)", () => {
  let client: Redis;
  let h: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    // Offline queue on (the ioredis default, as in AuthModule's
    // redisClientFactory), with unlimited per-request retries so every command
    // waits in the queue: the worst case of the default client, a hang.
    client = new Redis("redis://127.0.0.1:1", { retryStrategy: () => 50, maxRetriesPerRequest: null });
    client.on("error", () => undefined);
    h = await boot("enforce", new IoredisIdempotencyAdapter(client), 250);
  });

  afterAll(async () => {
    await h.app.close();
    client.disconnect();
  });

  it("allows each request within the timeout, then the open breaker stops the waiting", async () => {
    for (let i = 0; i < 5; i++) {
      const started = Date.now();
      const res = await post(h.app, "alice");
      const elapsed = Date.now() - started;
      expect(res.status).toBe(201);
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(1_500);
    }
    const started = Date.now();
    expect((await post(h.app, "alice")).status).toBe(201);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

const REDIS_URL = process.env["REDIS_URL"];
const withRealRedis = REDIS_URL ? describe : describe.skip;

withRealRedis(
  "RT-619 console guard on a real Redis — skipped without REDIS_URL (CI has no Redis service; run locally against redis:7)",
  () => {
    let client: Redis;
    let h: Awaited<ReturnType<typeof boot>>;
    const user = `rt619-${process.pid}-${Date.now()}`;
    const key = `rl:console_write:u:${user}`;

    beforeAll(async () => {
      client = new Redis(REDIS_URL as string);
      await client.ping();
      h = await boot("enforce", new IoredisIdempotencyAdapter(client));
    });

    afterAll(async () => {
      await client.del(key);
      await h.app.close();
      client.disconnect();
    });

    it("counts under rl:console_write:u:<userId> with the window TTL, refuses at 31, passes after rollover", async () => {
      await spend(h.app, user, 30);
      expect(await client.get(key)).toBe("30");
      const ttl = await client.pttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);

      const refused = await post(h.app, user);
      expect(refused.status).toBe(429);
      expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(60);

      await client.pexpire(key, 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await post(h.app, user)).status).toBe(201);
    });
  },
);
