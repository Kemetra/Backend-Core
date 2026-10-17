/**
 * RT-631 (OBS-2) — a real HTTP 500 reaches Sentry scrubbed and correlated.
 *
 * The RT-609 lab rollout only sent synthetic errors. Here a controller throws
 * inside a real Nest HTTP pipeline (`RequestIdInterceptor` + the production
 * `GlobalExceptionFilter`), the real `initApiSentry` sends to a local sink via
 * a DSN on 127.0.0.1, and the test reads the envelope bytes that left the
 * process. It checks the OBS-1 contract: `request_id`, active `trace_id`,
 * `service`/`version` tags, release = SHA12, a masked message, and no
 * request data, cookies or tokens. Docker-free.
 */
import "reflect-metadata";

import * as http from "http";
import type { AddressInfo } from "net";

import { context, createTestTracerProvider, trace } from "@data-pulse-2/shared";
import { Controller, Get, type INestApplication, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as Sentry from "@sentry/node";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";

import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { RequestIdInterceptor } from "../../src/common/request-id.interceptor";
import { initApiSentry } from "../../src/observability/sentry/sentry";

const SHA40 = "36bb0c7e1f2a3b4c5d6e7f8091a2b3c4d5e6f708";
const REQUEST_ID = "018f3b1d-7c2a-7e3a-9bcd-0123456789ab";
const COOKIE_SECRET = "cookie-secret-RT631";
const BEARER_SECRET = "bearer-secret-RT631";
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1XzEifQ.c2lnbmF0dXJl";
const FAILURE =
  `posting failed for cashier@example.test token ${JWT} ` +
  "at https://erp:pw@erp.example.test/api/resource/Item?api_key=K";

@Controller("rt631")
class ThrowingController {
  @Get("boom")
  boom(): never {
    throw new Error(FAILURE);
  }
}

@Module({ controllers: [ThrowingController] })
class ThrowingModule {}

interface SentryEvent {
  release?: string;
  environment?: string;
  tags?: Record<string, string>;
  exception?: { values?: { type?: string; value?: string }[] };
  [key: string]: unknown;
}

function startSentrySink(): Promise<{ server: http.Server; port: number; raw: string[] }> {
  const raw: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      raw.push(body);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port, raw });
    });
  });
}

/** Envelope = header line, then (item header, item payload) line pairs. */
function eventsIn(envelopes: string[]): SentryEvent[] {
  const events: SentryEvent[] = [];
  for (const envelope of envelopes) {
    const lines = envelope.split("\n").filter((line) => line.length > 0);
    for (let i = 1; i + 1 < lines.length; i += 2) {
      const header = JSON.parse(lines[i]!) as { type?: string };
      if (header.type === "event") events.push(JSON.parse(lines[i + 1]!) as SentryEvent);
    }
  }
  return events;
}

describe("RT-631 — HTTP 500 through GlobalExceptionFilter into Sentry", () => {
  let sink: Awaited<ReturnType<typeof startSentrySink>>;
  let app: INestApplication;
  let tracer: ReturnType<typeof createTestTracerProvider>;
  const traceIds: string[] = [];
  // Sentry.init adds process-level handlers (strict unhandledRejection exits
  // the process). Jest workers share `process` across files, so remove them.
  type ProcessListener = (...args: unknown[]) => void;
  const PROCESS_EVENTS = ["unhandledRejection", "uncaughtException"] as const;
  const processListeners = (event: (typeof PROCESS_EVENTS)[number]): ProcessListener[] =>
    process.listeners(event as "uncaughtException") as ProcessListener[];
  const listenersBefore = new Map<string, ProcessListener[]>();

  beforeAll(async () => {
    for (const event of PROCESS_EVENTS) listenersBefore.set(event, processListeners(event));
    sink = await startSentrySink();
    tracer = createTestTracerProvider();
    const result = initApiSentry({
      SENTRY_DSN: `http://publickey@127.0.0.1:${sink.port}/1`,
      SENTRY_RELEASE: SHA40,
      DEPLOYMENT_ENVIRONMENT: "staging",
    });
    expect(result).toBe("initialized");

    const moduleRef = await Test.createTestingModule({ imports: [ThrowingModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // Stands in for the OTel HTTP server span: the handler runs inside it.
    app.use((_req: Request, _res: Response, next: NextFunction) => {
      const span = trace.getTracer("rt-631").startSpan("http.server");
      traceIds.push(span.spanContext().traceId);
      context.with(trace.setSpan(context.active(), span), next);
      span.end();
    });
    app.useGlobalInterceptors(new RequestIdInterceptor());
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await Sentry.close(2000);
    for (const event of PROCESS_EVENTS) {
      const before = listenersBefore.get(event) ?? [];
      for (const listener of processListeners(event)) {
        if (!before.includes(listener)) process.removeListener(event, listener);
      }
    }
    await tracer.teardown();
    context.disable();
    trace.disable();
    await new Promise((resolve) => sink.server.close(resolve));
  });

  it("returns the 500 envelope and sends one scrubbed, correlated event", async () => {
    const res = await request(app.getHttpServer())
      .get("/rt631/boom")
      .set("X-Request-Id", REQUEST_ID)
      .set("Cookie", `dp2_session=${COOKIE_SECRET}`)
      .set("Authorization", `Bearer ${BEARER_SECRET}`);

    expect(res.status).toBe(500);
    expect(res.headers["x-request-id"]).toBe(REQUEST_ID);
    expect(res.body.error.request_id).toBe(REQUEST_ID);
    expect(JSON.stringify(res.body)).not.toContain("cashier@example.test");

    await Sentry.flush(5000);
    const events = eventsIn(sink.raw);
    expect(events).toHaveLength(1);
    const event = events[0]!;

    expect(event.release).toBe(SHA40.slice(0, 12));
    expect(event.environment).toBe("staging");
    expect(event.tags).toEqual({
      service: "backend-api",
      version: SHA40.slice(0, 12),
      request_id: REQUEST_ID,
      trace_id: traceIds[0],
    });
    expect(event.tags?.["trace_id"]).toMatch(/^[0-9a-f]{32}$/);

    for (const dropped of ["request", "user", "extra", "contexts", "breadcrumbs", "transaction"]) {
      expect(event).not.toHaveProperty(dropped);
    }

    const value = event.exception?.values?.[0]?.value ?? "";
    expect(value).toContain("[email]");
    expect(value).toContain("[jwt]");
    expect(value).toContain("https://erp.example.test/api/resource/Item");

    // Nothing sensitive anywhere in the bytes that left the process.
    const wire = sink.raw.join("\n");
    for (const secret of [COOKIE_SECRET, BEARER_SECRET, "cashier@example.test", "eyJ", "api_key", "erp:pw"]) {
      expect(wire).not.toContain(secret);
    }
  });
});
