/**
 * RT-632 (OBS-3) — the Console Sentry tunnel inside the full AppModule.
 *
 * Proves the route is reachable through the global fail-closed auth guard
 * without credentials, and that an attached `dp2_session` cookie is never
 * looked up (the database is unreachable here, so a lookup would fail).
 * The network is replaced by a fetch spy.
 */
import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { CONSOLE_TELEMETRY_FETCH } from "../../src/console-telemetry/console-telemetry.forwarder";
import { SAME_ORIGIN } from "../_helpers/same-origin";

const ENV_KEYS = ["NODE_ENV", "DATABASE_URL", "AUTH_LOOKUP_DATABASE_URL", "REDIS_URL", "CONSOLE_SENTRY_DSN"] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const EVENT = JSON.stringify({ event_id: "0123456789abcdef0123456789abcdef", exception: { values: [{ type: "Error", value: "x" }] } });
const ENVELOPE = `{}\n${JSON.stringify({ type: "event" })}\n${EVENT}\n`;

let app: INestApplication;
const fetchSpy = jest.fn().mockResolvedValue({ status: 200, body: null });

beforeAll(async () => {
  process.env["NODE_ENV"] = "test";
  process.env["DATABASE_URL"] = "postgres://route-check:route-check@127.0.0.1:1/route-check";
  process.env["CONSOLE_SENTRY_DSN"] = "https://consolekey@o4500.ingest.de.sentry.io/4511";
  delete process.env["AUTH_LOOKUP_DATABASE_URL"];
  delete process.env["REDIS_URL"];
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CONSOLE_TELEMETRY_FETCH)
    .useValue(fetchSpy)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  await app.close();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

it("accepts an envelope without credentials and ignores a session cookie", async () => {
  const res = await request(app.getHttpServer())
    .post("/api/v1/console/telemetry/envelope")
    .set(SAME_ORIGIN)
    .set("Content-Type", "text/plain;charset=UTF-8")
    .set("Cookie", "dp2_session=not-a-real-session")
    .send(ENVELOPE);
  await new Promise((resolve) => setImmediate(resolve));

  expect(res.status).toBe(204);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});
