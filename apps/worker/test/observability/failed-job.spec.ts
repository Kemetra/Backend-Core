/**
 * RT-698 — BullMQ final job failures to Sentry. `@sentry/node` and BullMQ's
 * `Worker` are mocked; no event leaves the process and no Redis is needed.
 */
import * as Sentry from "@sentry/node";
import { scrubSentryEvent } from "@data-pulse-2/shared";
import {
  createTestTracerProvider,
  injectTraceContext,
  trace,
  type TestTracerHandle,
} from "@data-pulse-2/shared/observability/otel";
import { Worker } from "bullmq";

import {
  captureFinalJobFailure,
  DECLARED_JOB_NAMES,
  failedJobTags,
  isFinalFailure,
  reportableError,
  type FailedJobLike,
} from "../../src/observability/sentry/failed-job";
import { BullMqWorkerFactory } from "../../src/worker.module";

jest.mock("@sentry/node", () => ({
  captureException: jest.fn(),
}));

jest.mock("bullmq", () => ({
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../../src/observability/instrumented-redis", () => ({
  InstrumentedRedis: jest.fn().mockImplementation(() => ({ disconnect: jest.fn() })),
}));

const QUEUE = "audit-fanout";
const REQUEST_ID = "018f3b1d-7c2a-7e3a-9bcd-0123456789ab";

function job(overrides: Partial<FailedJobLike> = {}): FailedJobLike {
  return { name: "audit-fanout", data: {}, attemptsMade: 5, opts: { attempts: 5 }, ...overrides };
}

function unrecoverable(message: string): Error {
  const err = new Error(message);
  err.name = "UnrecoverableError";
  return err;
}

const capture = Sentry.captureException as jest.Mock;

describe("isFinalFailure", () => {
  it.each([
    ["the last attempt", 5, 5, true],
    ["an attempt with retries left", 2, 5, false],
    ["a job with no attempts option (one try)", 1, undefined, true],
    ["a job with attempts: 0 (one try)", 1, 0, true],
  ])("treats %s correctly", (_label, attemptsMade, attempts, expected) => {
    const opts = attempts === undefined ? {} : { attempts };
    expect(isFinalFailure(job({ attemptsMade, opts }), new Error("x"))).toBe(expected);
  });

  it("treats an UnrecoverableError as final even with retries left", () => {
    expect(isFinalFailure(job({ attemptsMade: 1 }), unrecoverable("stop"))).toBe(true);
  });
});

describe("failedJobTags", () => {
  let tracer: TestTracerHandle | undefined;

  afterEach(async () => {
    await tracer?.teardown();
    tracer = undefined;
  });

  it("tags queue, job name, outcome and a bounded error_class", () => {
    expect(failedJobTags(QUEUE, job(), new Error("x"))).toEqual({
      queue: QUEUE,
      error_class: "UnknownError",
      job_name: "audit-fanout",
      outcome: "exhausted",
    });
  });

  it("keeps a known error_class from the worker metrics' closed set", () => {
    class TenantContextMissingError extends Error {}
    expect(failedJobTags(QUEUE, job(), new TenantContextMissingError("x"))["error_class"]).toBe(
      "TenantContextMissingError",
    );
  });

  it("marks an UnrecoverableError as outcome unrecoverable", () => {
    expect(failedJobTags(QUEUE, job(), unrecoverable("stop"))["outcome"]).toBe("unrecoverable");
  });

  it("leaves out a job name the worker does not declare", () => {
    const tags = failedJobTags(QUEUE, job({ name: "customer-jane-01012345678" }), new Error("x"));
    expect(tags).not.toHaveProperty("job_name");
    expect(tags["outcome"]).toBe("exhausted");
  });

  it("declares the job name of every queue the worker consumes", () => {
    expect([...DECLARED_JOB_NAMES].sort()).toEqual([
      "audit-fanout",
      "audit-retention-sweep",
      "auth.email-verify",
      "auth.password-reset",
      "cashier-admission-replay-purge",
      "erpnext-stock-reconciliation-sweep",
      "memberships.invitation",
      "outbox-retention-sweep",
      "sale-processing",
      "sale-redrive",
    ]);
  });

  it("keeps only the queue when BullMQ passes no job", () => {
    expect(failedJobTags(QUEUE, undefined, new Error("x"))).toEqual({ queue: QUEUE, error_class: "UnknownError" });
  });

  it("carries the job's request_id", () => {
    const tags = failedJobTags(QUEUE, job({ data: { request_id: REQUEST_ID } }), new Error("x"));
    expect(tags["request_id"]).toBe(REQUEST_ID);
  });

  it("ignores a non-string request_id and non-object data", () => {
    expect(failedJobTags(QUEUE, job({ data: { request_id: 42 } }), new Error("x"))).not.toHaveProperty("request_id");
    expect(failedJobTags(QUEUE, job({ data: "raw" }), new Error("x"))).not.toHaveProperty("request_id");
  });

  it("takes trace_id from the producer's traceContext carrier", () => {
    tracer = createTestTracerProvider();
    const producer = trace.getTracer("rt698").startActiveSpan("producer", (span) => {
      const carrier = injectTraceContext();
      span.end();
      return { carrier, traceId: span.spanContext().traceId };
    });
    const data = JSON.parse(JSON.stringify({ traceContext: producer.carrier })) as unknown;
    const tags = failedJobTags(QUEUE, job({ data }), new Error("x"));
    expect(tags["trace_id"]).toBe(producer.traceId);
  });

  it("does not use the active span: no carrier means no trace_id", () => {
    tracer = createTestTracerProvider();
    const tags = trace.getTracer("rt698").startActiveSpan("unrelated", (active) => {
      const out = failedJobTags(QUEUE, job(), new Error("x"));
      active.end();
      return out;
    });
    expect(tags).not.toHaveProperty("trace_id");
  });

  it("ignores a carrier that is not an object or has no valid traceparent", () => {
    tracer = createTestTracerProvider();
    expect(failedJobTags(QUEUE, job({ data: { traceContext: ["x"] } }), new Error("x"))).not.toHaveProperty("trace_id");
    expect(
      failedJobTags(QUEUE, job({ data: { traceContext: { traceparent: "garbage" } } }), new Error("x")),
    ).not.toHaveProperty("trace_id");
  });
});

describe("reportableError", () => {
  const RAW = "sku-4711-jane";

  it("masks an undeclared job name in the message and stack, keeping the name", () => {
    const err = new Error(`Unknown email job name: '${RAW}'`);
    err.name = "UnknownEmailJobError";
    const out = reportableError(job({ name: RAW }), err);
    expect(out).not.toBe(err);
    expect(out.message).toBe("Unknown email job name: '[job_name]'");
    expect(out.name).toBe("UnknownEmailJobError");
    expect(out.stack).not.toContain(RAW);
  });

  it("returns the error as is when there is nothing to mask", () => {
    const err = new Error("db exploded");
    expect(reportableError(job(), err)).toBe(err);
    expect(reportableError(job({ name: RAW }), err)).toBe(err);
    expect(reportableError(job({ name: "" }), err)).toBe(err);
    expect(reportableError(undefined, err)).toBe(err);
  });

  it("keeps a declared job name in the message", () => {
    const err = new Error("Malformed audit job 'audit-fanout': event_id: Invalid uuid");
    expect(reportableError(job(), err)).toBe(err);
  });

  it("masks the message even when the error has no stack", () => {
    const err = new Error(`bad ${RAW}`);
    delete err.stack;
    const out = reportableError(job({ name: RAW }), err);
    expect(out.message).toBe("bad [job_name]");
    expect(out.stack).toBeUndefined();
  });
});

describe("captureFinalJobFailure", () => {
  it("sends the masked copy for an undeclared job name", () => {
    captureFinalJobFailure(QUEUE)(job({ name: "jane-01012345678" }), new Error("Unknown job 'jane-01012345678'"));
    const [sent, hint] = capture.mock.calls[0] as [Error, { tags: Record<string, string> }];
    expect(sent.message).toBe("Unknown job '[job_name]'");
    expect(hint.tags).not.toHaveProperty("job_name");
  });

  it("captures a final failure once, with tags only", () => {
    const err = new Error("db exploded");
    captureFinalJobFailure(QUEUE)(job({ data: { request_id: REQUEST_ID } }), err);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(err, {
      tags: {
        queue: QUEUE,
        error_class: "UnknownError",
        job_name: "audit-fanout",
        outcome: "exhausted",
        request_id: REQUEST_ID,
      },
    });
  });

  it("does not capture a failure that BullMQ will retry", () => {
    captureFinalJobFailure(QUEUE)(job({ attemptsMade: 3 }), new Error("transient"));
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures an UnrecoverableError on its first attempt", () => {
    const err = unrecoverable("bad payload");
    captureFinalJobFailure(QUEUE)(job({ attemptsMade: 1 }), err);
    expect(capture).toHaveBeenCalledWith(err, expect.objectContaining({
      tags: expect.objectContaining({ outcome: "unrecoverable" }),
    }));
  });

  it("captures with the queue tag when BullMQ passes no job", () => {
    const err = new Error("orphan");
    captureFinalJobFailure(QUEUE)(undefined, err);
    expect(capture).toHaveBeenCalledWith(err, { tags: { queue: QUEUE, error_class: "UnknownError" } });
  });

  it("never sends job data, and the scrubber drops a malformed request_id", () => {
    const data = {
      request_id: "not-a-uuid jane@example.invalid",
      email: "jane@example.invalid",
      token: "rt698-secret-token",
      lines: [{ sku: "SKU-1", price: 12.5 }],
    };
    captureFinalJobFailure(QUEUE)(job({ data }), new Error("send failed"));
    const [err, hint] = capture.mock.calls[0] as [Error, { tags: Record<string, string> }];
    expect(Object.keys(hint)).toEqual(["tags"]);
    const sent = scrubSentryEvent({
      exception: { values: [{ type: err.name, value: err.message }] },
      tags: hint.tags,
    });
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain("jane@example.invalid");
    expect(wire).not.toContain("rt698-secret-token");
    expect(wire).not.toContain("SKU-1");
    expect(sent?.tags).toEqual({
      queue: QUEUE,
      error_class: "UnknownError",
      job_name: "audit-fanout",
      outcome: "exhausted",
    });
  });

  it("never throws when the SDK throws", () => {
    capture.mockImplementationOnce(() => {
      throw new Error("sdk down");
    });
    expect(() => captureFinalJobFailure(QUEUE)(job(), new Error("x"))).not.toThrow();
  });
});

describe("BullMqWorkerFactory wiring", () => {
  it("registers the final-failure listener on every BullMQ worker it builds", () => {
    new BullMqWorkerFactory("redis://127.0.0.1:6379").create(QUEUE, async () => undefined, {} as never);
    const built = (Worker as unknown as jest.Mock).mock.results[0]!.value as { on: jest.Mock };
    const call = built.on.mock.calls.find(([event]) => event === "failed");
    expect(call).toBeDefined();
    const err = new Error("final");
    (call![1] as (j: FailedJobLike, e: Error) => void)(job(), err);
    expect(capture).toHaveBeenCalledWith(err, expect.objectContaining({
      tags: expect.objectContaining({ queue: QUEUE }),
    }));
  });
});
