/**
 * RT-144 — health routes through the full AppModule (global fail-closed
 * guard included) against a real PostgreSQL, and against an unreachable one.
 */
import "reflect-metadata";

import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const ORIGINAL_ENV = {
  NODE_ENV: process.env["NODE_ENV"],
  DATABASE_URL: process.env["DATABASE_URL"],
  AUTH_LOOKUP_DATABASE_URL: process.env["AUTH_LOOKUP_DATABASE_URL"],
  REDIS_URL: process.env["REDIS_URL"],
};

let env: PgTestEnv | null = null;
let dockerSkipped = false;

async function bootApp(databaseUrl: string): Promise<INestApplication> {
  process.env["NODE_ENV"] = "test";
  process.env["DATABASE_URL"] = databaseUrl;
  delete process.env["AUTH_LOOKUP_DATABASE_URL"];
  delete process.env["REDIS_URL"]; // AlwaysAllowRedis stub; the redis check answers locally
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  return app;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[health.http.integration.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 120_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}, 60_000);

describe("health routes — database reachable", () => {
  let app: INestApplication | null = null;

  beforeAll(async () => {
    if (dockerSkipped) return;
    app = await bootApp(env!.adminUri);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("GET /api/v1/health/live answers 200 without credentials", async () => {
    if (dockerSkipped) return;
    const res = await request(app!.getHttpServer()).get("/api/v1/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("GET /api/v1/health/ready answers 200 with every check ok", async () => {
    if (dockerSkipped) return;
    const res = await request(app!.getHttpServer()).get("/api/v1/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ready",
      checks: { database: "ok", auth_database: "ok", redis: "ok" },
    });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("the global guard still refuses an unauthenticated non-public route", async () => {
    if (dockerSkipped) return;
    const res = await request(app!.getHttpServer()).get("/api/v1/context/me");
    expect(res.status).toBe(401);
  });
});

describe("health routes — database unreachable", () => {
  let app: INestApplication | null = null;

  beforeAll(async () => {
    app = await bootApp("postgres://health-check:health-check@127.0.0.1:1/health-check");
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it("liveness stays 200: it checks no dependency", async () => {
    const res = await request(app!.getHttpServer()).get("/api/v1/health/live");
    expect(res.status).toBe(200);
  });

  it("readiness answers 503 naming the failed checks, with no error text", async () => {
    const res = await request(app!.getHttpServer()).get("/api/v1/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "not_ready",
      checks: { database: "failed", auth_database: "failed", redis: "ok" },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|health-check/);
  });
});
