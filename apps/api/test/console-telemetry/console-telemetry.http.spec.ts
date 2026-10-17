/**
 * RT-632 (OBS-3) — the Console Sentry tunnel over HTTP.
 *
 * A minimal Nest app mounts only the tunnel controller, with the real
 * GlobalExceptionFilter, the real RateLimiter over an in-memory Redis fake
 * and a fetch spy in place of the network. Supertest drives real requests.
 */
import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { RateLimiter, type RedisLike } from "../../src/auth/rate-limit";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { ROOT_LOGGER } from "../../src/common/logging.interceptor";
import { ConsoleTelemetryController } from "../../src/console-telemetry/console-telemetry.controller";
import {
  CONSOLE_TELEMETRY_FETCH,
  ConsoleTelemetryForwarder,
  MAX_IN_FLIGHT_FORWARDS,
} from "../../src/console-telemetry/console-telemetry.forwarder";
import { CONSOLE_TELEMETRY_BUCKETS, MAX_ENVELOPE_BYTES } from "../../src/console-telemetry/console-telemetry.limits";
import { SAME_ORIGIN } from "../_helpers/same-origin";

const PATH = "/api/v1/console/telemetry/envelope";
const CONSOLE_DSN = "https://consolekey@o4500.ingest.de.sentry.io/4511";
const UPSTREAM = "https://o4500.ingest.de.sentry.io/api/4511/envelope/";
const FOREIGN_DSN = "https://attackerkey@o1.ingest.us.sentry.io/1";
const EVENT_ID = "0123456789abcdef0123456789abcdef";

class MapRedis implements RedisLike {
  readonly store = new Map<string, number>();
  async incr(key: string): Promise<number> {
    const next = (this.store.get(key) ?? 0) + 1;
    this.store.set(key, next);
    return next;
  }
  async pexpireNx(): Promise<number> {
    return 1;
  }
  async pttl(): Promise<number> {
    return 42_000;
  }
  async decr(key: string): Promise<number> {
    const next = (this.store.get(key) ?? 0) - 1;
    this.store.set(key, next);
    return next;
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

class BrokenRedis extends MapRedis {
  override async incr(): Promise<number> {
    throw new Error("redis down");
  }
}

interface Harness {
  app: INestApplication;
  fetchSpy: jest.Mock;
  warn: jest.Mock;
  redis: MapRedis;
}

function errorEnvelope(headerExtras: Record<string, unknown> = {}, value = "boom for owner@example.com"): string {
  const event = JSON.stringify({
    event_id: EVENT_ID,
    platform: "javascript",
    level: "error",
    request: { headers: { Cookie: "dp2_session=s3cret" } },
    user: { email: "owner@example.com" },
    breadcrumbs: [{ message: "nav" }],
    exception: { values: [{ type: "Error", value }] },
  });
  return [
    JSON.stringify({ event_id: EVENT_ID, sent_at: "2026-10-17T10:00:00Z", ...headerExtras }),
    JSON.stringify({ type: "event", length: Buffer.byteLength(event) }),
    event,
    "",
  ].join("\n");
}

async function boot(options: { dsn?: string | undefined; redis?: MapRedis; fetchImpl?: jest.Mock } = {}): Promise<Harness> {
  if (options.dsn === undefined) delete process.env["CONSOLE_SENTRY_DSN"];
  else process.env["CONSOLE_SENTRY_DSN"] = options.dsn;
  const fetchSpy = options.fetchImpl ?? jest.fn().mockResolvedValue({ status: 200, body: null });
  const warn = jest.fn();
  const redis = options.redis ?? new MapRedis();
  const moduleRef = await Test.createTestingModule({
    controllers: [ConsoleTelemetryController],
    providers: [
      ConsoleTelemetryForwarder,
      { provide: CONSOLE_TELEMETRY_FETCH, useValue: fetchSpy },
      { provide: RateLimiter, useValue: new RateLimiter(redis) },
      { provide: ROOT_LOGGER, useValue: { warn, info: jest.fn(), error: jest.fn() } },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
  return { app, fetchSpy, warn, redis };
}

function post(h: Harness, body: string | Buffer, contentType = "text/plain;charset=UTF-8") {
  return request(h.app.getHttpServer()).post(PATH).set(SAME_ORIGIN).set("Content-Type", contentType).send(body);
}

/** Lets the fire-and-forget forward run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

const ORIGINAL_DSN = process.env["CONSOLE_SENTRY_DSN"];
let harness: Harness | null = null;

afterEach(async () => {
  if (harness) await harness.app.close();
  harness = null;
});

afterAll(() => {
  if (ORIGINAL_DSN === undefined) delete process.env["CONSOLE_SENTRY_DSN"];
  else process.env["CONSOLE_SENTRY_DSN"] = ORIGINAL_DSN;
});

const CONFIG_PATH = "/api/v1/console/telemetry/config";
const ENV_KEYS = ["SENTRY_ENVIRONMENT", "DEPLOYMENT_ENVIRONMENT"] as const;
const ORIGINAL_ENVIRONMENT = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENVIRONMENT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("console telemetry config", () => {
  it("answers 204 no-store when the tunnel is inert", async () => {
    harness = await boot();
    const res = await request(harness.app.getHttpServer()).get(CONFIG_PATH);
    expect(res.status).toBe(204);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).toBe("");
  });

  it("answers 200 no-store with the tunnel and the server environment, never the DSN", async () => {
    process.env["SENTRY_ENVIRONMENT"] = "staging";
    harness = await boot({ dsn: CONSOLE_DSN });
    const res = await request(harness.app.getHttpServer()).get(CONFIG_PATH);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ tunnel: PATH, environment: "staging" });
    expect(res.text).not.toContain("consolekey");
    expect(res.text).not.toContain("sentry.io");
  });

  it("falls back to DEPLOYMENT_ENVIRONMENT, then unknown", async () => {
    delete process.env["SENTRY_ENVIRONMENT"];
    process.env["DEPLOYMENT_ENVIRONMENT"] = "lab";
    harness = await boot({ dsn: CONSOLE_DSN });
    expect((await request(harness.app.getHttpServer()).get(CONFIG_PATH)).body.environment).toBe("lab");
    await harness.app.close();
    delete process.env["DEPLOYMENT_ENVIRONMENT"];
    harness = await boot({ dsn: CONSOLE_DSN });
    expect((await request(harness.app.getHttpServer()).get(CONFIG_PATH)).body.environment).toBe("unknown");
  });
});

describe("console telemetry tunnel — no DSN configured", () => {
  it.each([undefined, "", "   ", "not-a-dsn", "https://o1.ingest.de.sentry.io/1"])(
    "is inert (DSN %p): 204, nothing forwarded, no rate-limit hit",
    async (dsn) => {
      harness = await boot({ dsn });
      const res = await post(harness, errorEnvelope());
      await settle();
      expect(res.status).toBe(204);
      expect(harness.fetchSpy).not.toHaveBeenCalled();
      expect(harness.redis.store.size).toBe(0);
    },
  );

  it("warns once about a malformed DSN without echoing it", async () => {
    harness = await boot({ dsn: "not-a-dsn-SECRETVALUE" });
    expect(harness.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(harness.warn.mock.calls)).not.toContain("SECRETVALUE");
  });
});

describe("console telemetry tunnel — DSN configured", () => {
  it("forwards the scrubbed event only to the configured project, ignoring the envelope dsn", async () => {
    harness = await boot({ dsn: CONSOLE_DSN });
    const res = await post(harness, errorEnvelope({ dsn: FOREIGN_DSN }));
    await settle();

    expect(res.status).toBe(204);
    expect(harness.fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = harness.fetchSpy.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: Buffer; redirect: string }];
    expect(url).toBe(UPSTREAM);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({
      "Content-Type": "application/x-sentry-envelope",
      "X-Sentry-Auth": expect.stringContaining("sentry_key=consolekey") as unknown as string,
    });
    const forwarded = Buffer.from(init.body).toString("utf8");
    expect(forwarded).not.toContain("attackerkey");
    expect(forwarded).not.toContain("o1.ingest.us.sentry.io");
    expect(forwarded).not.toContain("owner@example.com");
    expect(forwarded).not.toContain("s3cret");
    expect(forwarded).not.toContain("breadcrumbs");
    expect(forwarded).toContain("boom for [email]");
    expect(forwarded).toContain('"infer_ip":"never"');
  });

  it("stamps the server environment on the forwarded event", async () => {
    process.env["SENTRY_ENVIRONMENT"] = "staging";
    harness = await boot({ dsn: CONSOLE_DSN });
    await post(harness, errorEnvelope());
    await settle();
    const init = harness.fetchSpy.mock.calls[0]?.[1] as { body: Buffer };
    const event = JSON.parse(Buffer.from(init.body).toString("utf8").split("\n")[2]!) as Record<string, unknown>;
    expect(event["environment"]).toBe("staging");
  });

  it("does not pass inbound headers upstream", async () => {
    harness = await boot({ dsn: CONSOLE_DSN });
    await post(harness, errorEnvelope()).set("Cookie", "dp2_session=s3cret").set("User-Agent", "secret-agent");
    await settle();
    const init = harness.fetchSpy.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(Object.keys(init.headers).sort()).toEqual(["Content-Type", "X-Sentry-Auth"]);
  });

  it.each([
    ["application/x-sentry-envelope"],
    ["application/octet-stream"],
  ])("accepts %s", async (contentType) => {
    harness = await boot({ dsn: CONSOLE_DSN });
    const res = await post(harness, Buffer.from(errorEnvelope()), contentType);
    await settle();
    expect(res.status).toBe(204);
    expect(harness.fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("answers 204 and forwards nothing for an envelope with no error event", async () => {
    harness = await boot({ dsn: CONSOLE_DSN });
    const body = `{}\n${JSON.stringify({ type: "session" })}\n${JSON.stringify({ sid: "x" })}\n`;
    const res = await post(harness, body);
    await settle();
    expect(res.status).toBe(204);
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a malformed envelope with a fixed 400 that never quotes the input", async () => {
    harness = await boot({ dsn: CONSOLE_DSN });
    const res = await post(harness, '{"leak":"owner@example.com"\n');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("envelope_malformed");
    expect(JSON.stringify(res.body)).not.toContain("owner@example.com");
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an empty body as malformed", async () => {
    harness = await boot({ dsn: CONSOLE_DSN });
    const res = await post(harness, "");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("envelope_malformed");
  });

  it("rejects an oversized envelope with 413 and forwards nothing", async () => {
    harness = await boot({ dsn: CONSOLE_DSN });
    const res = await post(harness, Buffer.alloc(MAX_ENVELOPE_BYTES + 1, 0x61));
    await settle();
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("envelope_too_large");
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it.each([["application/json"], ["application/x-www-form-urlencoded"], ["multipart/form-data; boundary=x"]])(
    "rejects Content-Type %s with 415",
    async (contentType) => {
      harness = await boot({ dsn: CONSOLE_DSN });
      const res = await post(harness, "{}", contentType);
      expect(res.status).toBe(415);
      expect(res.body.error.code).toBe("unsupported_media_type");
    },
  );

  it("rejects a compressed body with 415", async () => {
    harness = await boot({ dsn: CONSOLE_DSN });
    const res = await post(harness, errorEnvelope()).set("Content-Encoding", "gzip");
    expect(res.status).toBe(415);
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["foreign", "https://evil.example"],
    ["opaque null", "null"],
  ])("rejects a %s Origin with 403", async (_name, origin) => {
    harness = await boot({ dsn: CONSOLE_DSN });
    const req = request(harness.app.getHttpServer()).post(PATH).set("Host", SAME_ORIGIN.Host).set("Content-Type", "text/plain");
    const res = await (origin === undefined ? req : req.set("Origin", origin)).send(errorEnvelope());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("origin_rejected");
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it("rate-limits per client IP with 429 and Retry-After", async () => {
    harness = await boot({ dsn: CONSOLE_DSN });
    for (let i = 0; i < CONSOLE_TELEMETRY_BUCKETS.perIp.limit; i++) {
      expect((await post(harness, errorEnvelope())).status).toBe(204);
    }
    const res = await post(harness, errorEnvelope());
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(Number(res.headers["retry-after"])).toBe(42);
  });

  it("rate-limits on the global budget", async () => {
    const redis = new MapRedis();
    redis.store.set("rl:console_telemetry_global:global", CONSOLE_TELEMETRY_BUCKETS.global.limit);
    harness = await boot({ dsn: CONSOLE_DSN, redis });
    const res = await post(harness, errorEnvelope());
    expect(res.status).toBe(429);
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it("drops the envelope with 204 when Redis is down", async () => {
    harness = await boot({ dsn: CONSOLE_DSN, redis: new BrokenRedis() });
    const res = await post(harness, errorEnvelope());
    await settle();
    expect(res.status).toBe(204);
    expect(harness.fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 204 without waiting on Sentry, and a failed forward logs no content", async () => {
    let fail: (err: Error) => void = () => undefined;
    const pending = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    harness = await boot({ dsn: CONSOLE_DSN, fetchImpl: jest.fn().mockReturnValue(pending) });
    const res = await post(harness, errorEnvelope());
    expect(res.status).toBe(204);
    fail(new Error(`upstream ${UPSTREAM} owner@example.com`));
    await settle();
    await settle();
    expect(harness.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(harness.warn.mock.calls);
    for (const leak of ["owner@example.com", "consolekey", "ingest.de.sentry.io", "boom"]) {
      expect(logged).not.toContain(leak);
    }
  });

  it("logs an upstream rejection by status only", async () => {
    harness = await boot({ dsn: CONSOLE_DSN, fetchImpl: jest.fn().mockResolvedValue({ status: 500, body: null }) });
    await post(harness, errorEnvelope());
    await settle();
    await settle();
    expect(harness.warn).toHaveBeenCalledWith({ status: 500 }, expect.any(String));
  });

  it("bounds concurrent forwards and drops the excess", async () => {
    harness = await boot({ dsn: CONSOLE_DSN, fetchImpl: jest.fn().mockReturnValue(new Promise(() => undefined)) });
    for (let i = 0; i < MAX_IN_FLIGHT_FORWARDS + 2; i++) {
      expect((await post(harness, errorEnvelope())).status).toBe(204);
    }
    await settle();
    expect(harness.fetchSpy).toHaveBeenCalledTimes(MAX_IN_FLIGHT_FORWARDS);
  });
});
