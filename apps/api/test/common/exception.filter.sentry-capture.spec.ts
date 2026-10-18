/**
 * RT-698 (RT-631 gap, RT-638 row 4) — the real HTTP-500 path to Sentry.
 *
 * `exception.filter.sentry.spec.ts` mocks `captureServerError`, so neither the
 * correlation tags nor the scrubber ran on this path. Here only `@sentry/node`
 * is mocked: an unhandled throw goes through `GlobalExceptionFilter`, the real
 * `captureServerError` and the real tag helper inside an active OTel span, and
 * the resulting event goes through the `beforeSend` that `initApiSentry` wires.
 * No event leaves the process.
 */
import "reflect-metadata";

import type { ArgumentsHost } from "@nestjs/common";
import * as Sentry from "@sentry/node";
import {
  createTestTracerProvider,
  trace,
  type TestTracerHandle,
} from "@data-pulse-2/shared/observability/otel";

import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { initApiSentry } from "../../src/observability/sentry/sentry";

jest.mock("@sentry/node", () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  onUnhandledRejectionIntegration: jest.fn(() => ({ name: "OnUnhandledRejection" })),
}));

const REQUEST_ID = "018f3b1d-7c2a-7e3a-9bcd-0123456789ab";
const VALID_DSN = "https://abc123@o1.ingest.de.sentry.io/42";

type BeforeSend = (event: Record<string, unknown>) => Record<string, unknown> | null;

function makeHost(sent: { status?: number; body?: unknown }): ArgumentsHost {
  const res = {
    status: (status: number) => ({
      json: (body: unknown) => {
        sent.status = status;
        sent.body = body;
      },
    }),
  };
  return {
    switchToHttp: () => ({
      getRequest: <T>() => ({ requestId: REQUEST_ID }) as unknown as T,
      getResponse: <T>() => res as unknown as T,
    }),
  } as unknown as ArgumentsHost;
}

/** The `beforeSend` hook the api hands to `Sentry.init`. */
function wiredBeforeSend(): BeforeSend {
  expect(initApiSentry({ SENTRY_DSN: VALID_DSN })).toBe("initialized");
  const opts = (Sentry.init as jest.Mock).mock.calls[0]![0] as { beforeSend: BeforeSend };
  return opts.beforeSend;
}

describe("GlobalExceptionFilter HTTP 500 -> one scrubbed Sentry capture", () => {
  let tracer: TestTracerHandle;

  beforeEach(() => {
    tracer = createTestTracerProvider();
  });

  afterEach(async () => {
    await tracer.teardown();
  });

  it("captures once, tagged with request_id and the active trace_id, and the event is scrubbed", () => {
    const err = new Error("insert failed for jane@example.invalid with Bearer rt698-opaque");
    const sent: { status?: number; body?: unknown } = {};

    const traceId = trace.getTracer("rt698").startActiveSpan("POST /api/v1/sales", (span) => {
      new GlobalExceptionFilter().catch(err, makeHost(sent));
      span.end();
      return span.spanContext().traceId;
    });

    expect(sent.status).toBe(500);
    const capture = Sentry.captureException as jest.Mock;
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(err, { tags: { request_id: REQUEST_ID, trace_id: traceId } });

    // What the SDK would build from that call, plus the fields an SDK
    // integration could add, through the wired allowlist scrubber.
    const [, hint] = capture.mock.calls[0] as [Error, { tags: Record<string, string> }];
    const event = wiredBeforeSend()({
      event_id: "a".repeat(32),
      level: "error",
      environment: "staging",
      tags: { ...hint.tags, service: "backend-api", tenant_id: "t-1" },
      exception: { values: [{ type: err.name, value: err.message }] },
      request: { url: "https://api.example.invalid/x?token=1", headers: { cookie: "sid=1" } },
      user: { email: "jane@example.invalid" },
      extra: { body: { lines: [] } },
    });

    expect(event).toEqual({
      event_id: "a".repeat(32),
      level: "error",
      environment: "staging",
      tags: { request_id: REQUEST_ID, trace_id: traceId, service: "backend-api" },
      exception: {
        values: [{ type: "Error", value: "insert failed for [email] with [redacted] [redacted]" }],
      },
    });
  });

  it("captures without trace_id when no span is active", () => {
    new GlobalExceptionFilter().catch(new Error("boom"), makeHost({}));
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { request_id: REQUEST_ID },
    });
  });
});
