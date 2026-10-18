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
  failedJobTags,
  isFinalFailure,
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
  return { name: "audit.write", data: {}, attemptsMade: 5, opts: { attempts: 5 }, ...overrides };
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

  it("tags queue, job name and outcome", () => {
    expect(failedJobTags(QUEUE, job(), new Error("x"))).toEqual({
      queue: QUEUE,
      job_name: "audit.write",
      outcome: "exhausted",
    });
  });

  it("marks an UnrecoverableError as outcome unrecoverable", () => {
    expect(failedJobTags(QUEUE, job(), unrecoverable("stop"))["outcome"]).toBe("unrecoverable");
  });

  it("keeps only the queue when BullMQ passes no job", () => {
    expect(failedJobTags(QUEUE, undefined, new Error("x"))).toEqual({ queue: QUEUE });
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

describe("captureFinalJobFailure", () => {
  it("captures a final failure once, with tags only", () => {
    const err = new Error("db exploded");
    captureFinalJobFailure(QUEUE)(job({ data: { request_id: REQUEST_ID } }), err);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(err, {
      tags: { queue: QUEUE, job_name: "audit.write", outcome: "exhausted", request_id: REQUEST_ID },
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
    expect(capture).toHaveBeenCalledWith(err, { tags: { queue: QUEUE } });
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
    expect(sent?.tags).toEqual({ queue: QUEUE, job_name: "audit.write", outcome: "exhausted" });
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
