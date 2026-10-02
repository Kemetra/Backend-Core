/**
 * T112 — EmailQueueProducer spec.
 *
 * Pure unit-level. The producer's only collaborator is a BullMQ `Queue`,
 * and we depend on a single method (`add`); the test injects an
 * in-memory fake that records every call. No real BullMQ runtime is
 * loaded, no Redis container, no `ioredis-mock`.
 *
 * Coverage matches the slice approval list:
 *   - password-reset job uses name `auth.password-reset`
 *   - email-verification job uses name `auth.email-verify`
 *   - payload is preserved verbatim
 *   - same rawToken → same jobId
 *   - different rawTokens → different jobIds
 *   - password-reset and email-verify scopes do not collide on the same
 *     rawToken (jobId carries a scope prefix)
 *   - jobId leaks none of: email, userId, rawToken
 *   - errors raised by `queue.add` propagate to the caller
 *   - T303: job.data includes traceContext as a plain object with traceparent
 */
import {
  deriveJobId,
  EMAIL_JOB_NAMES,
  EmailQueueProducer,
  type QueueLike,
} from "../../src/auth/email-queue.producer";
import {
  createTestTracerProvider,
  context,
  trace,
  type TestTracerHandle,
} from "@data-pulse-2/shared/observability/otel";

interface RecordedCall {
  name: string;
  data: unknown;
  opts?: { jobId?: string } | undefined;
}

class FakeQueue implements QueueLike {
  readonly calls: RecordedCall[] = [];
  reject?: Error;

  async add(
    name: string,
    data: unknown,
    opts?: { jobId?: string },
  ): Promise<unknown> {
    this.calls.push({ name, data, opts });
    if (this.reject) throw this.reject;
    return { id: opts?.jobId ?? "fake-job-id" };
  }
}

const RAW_TOKEN_A = "raw-token-aaaaaaaaaaaaaaaaaa";
const RAW_TOKEN_B = "raw-token-bbbbbbbbbbbbbbbbbb";
const EMAIL_A = "alice@example.com";
const USER_A = "0a000000-0000-7000-8000-00000000aa01";

let queue: FakeQueue;
let producer: EmailQueueProducer;
let tracerHandle: TestTracerHandle;

beforeEach(() => {
  tracerHandle = createTestTracerProvider();
  queue = new FakeQueue();
  producer = new EmailQueueProducer(queue);
});

afterEach(async () => {
  await tracerHandle.teardown();
});

describe("EmailQueueProducer.enqueuePasswordReset", () => {
  it("calls queue.add with name 'auth.password-reset' and the payload verbatim", async () => {
    await producer.enqueuePasswordReset({
      email: EMAIL_A,
      rawToken: RAW_TOKEN_A,
      userId: USER_A,
    });

    expect(queue.calls).toHaveLength(1);
    const [call] = queue.calls;
    expect(call!.name).toBe(EMAIL_JOB_NAMES.passwordReset);
    expect(call!.name).toBe("auth.password-reset");
    expect(call!.data).toEqual(
      expect.objectContaining({
        email: EMAIL_A,
        rawToken: RAW_TOKEN_A,
        userId: USER_A,
      }),
    );
  });

  it("uses the deterministic jobId derived from the rawToken", async () => {
    await producer.enqueuePasswordReset({
      email: EMAIL_A,
      rawToken: RAW_TOKEN_A,
      userId: USER_A,
    });
    expect(queue.calls[0]!.opts?.jobId).toBe(
      deriveJobId("pwreset", RAW_TOKEN_A),
    );
  });

  it("propagates errors thrown by queue.add", async () => {
    queue.reject = new Error("redis ECONNREFUSED");
    await expect(
      producer.enqueuePasswordReset({
        email: EMAIL_A,
        rawToken: RAW_TOKEN_A,
        userId: USER_A,
      }),
    ).rejects.toThrow("redis ECONNREFUSED");
  });
});

describe("EmailQueueProducer.enqueueEmailVerification", () => {
  it("calls queue.add with name 'auth.email-verify' and the payload verbatim", async () => {
    await producer.enqueueEmailVerification({
      email: EMAIL_A,
      rawToken: RAW_TOKEN_A,
      userId: USER_A,
    });

    expect(queue.calls).toHaveLength(1);
    const [call] = queue.calls;
    expect(call!.name).toBe(EMAIL_JOB_NAMES.emailVerification);
    expect(call!.name).toBe("auth.email-verify");
    expect(call!.data).toEqual(
      expect.objectContaining({
        email: EMAIL_A,
        rawToken: RAW_TOKEN_A,
        userId: USER_A,
      }),
    );
  });

  it("uses the deterministic jobId derived from the rawToken", async () => {
    await producer.enqueueEmailVerification({
      email: EMAIL_A,
      rawToken: RAW_TOKEN_A,
      userId: USER_A,
    });
    expect(queue.calls[0]!.opts?.jobId).toBe(
      deriveJobId("verify", RAW_TOKEN_A),
    );
  });

  it("propagates errors thrown by queue.add", async () => {
    queue.reject = new Error("redis ECONNREFUSED");
    await expect(
      producer.enqueueEmailVerification({
        email: EMAIL_A,
        rawToken: RAW_TOKEN_A,
        userId: USER_A,
      }),
    ).rejects.toThrow("redis ECONNREFUSED");
  });
});

describe("Idempotency / determinism of jobId derivation", () => {
  it("same rawToken produces the same jobId on every call (single method)", async () => {
    await producer.enqueuePasswordReset({
      email: EMAIL_A,
      rawToken: RAW_TOKEN_A,
      userId: USER_A,
    });
    await producer.enqueuePasswordReset({
      email: "different@example.com", // payload differs but token is the SAME
      rawToken: RAW_TOKEN_A,
      userId: "00000000-0000-7000-8000-000000000000",
    });
    expect(queue.calls).toHaveLength(2);
    expect(queue.calls[0]!.opts?.jobId).toBe(queue.calls[1]!.opts?.jobId);
  });

  it("different rawTokens produce different jobIds", async () => {
    await producer.enqueuePasswordReset({
      email: EMAIL_A,
      rawToken: RAW_TOKEN_A,
      userId: USER_A,
    });
    await producer.enqueuePasswordReset({
      email: EMAIL_A,
      rawToken: RAW_TOKEN_B,
      userId: USER_A,
    });
    expect(queue.calls[0]!.opts?.jobId).not.toBe(queue.calls[1]!.opts?.jobId);
  });

  it("password-reset and email-verify do NOT collide for the same rawToken (scope prefix isolates them)", async () => {
    await producer.enqueuePasswordReset({
      email: EMAIL_A,
      rawToken: RAW_TOKEN_A,
      userId: USER_A,
    });
    await producer.enqueueEmailVerification({
      email: EMAIL_A,
      rawToken: RAW_TOKEN_A,
      userId: USER_A,
    });
    expect(queue.calls[0]!.opts?.jobId).not.toBe(queue.calls[1]!.opts?.jobId);
    expect(queue.calls[0]!.opts?.jobId).toMatch(/^pwreset-/);
    expect(queue.calls[1]!.opts?.jobId).toMatch(/^verify-/);
  });
});

describe("jobId carries no PII", () => {
  it.each([
    ["password reset", () => producer.enqueuePasswordReset({
      email: EMAIL_A, rawToken: RAW_TOKEN_A, userId: USER_A,
    })],
    ["email verification", () => producer.enqueueEmailVerification({
      email: EMAIL_A, rawToken: RAW_TOKEN_A, userId: USER_A,
    })],
  ])(
    "jobId for %s does NOT contain the email, userId, or raw token",
    async (_label, run) => {
      await run();
      const jobId = queue.calls[0]!.opts?.jobId ?? "";
      expect(jobId).not.toContain(EMAIL_A);
      expect(jobId).not.toContain(USER_A);
      expect(jobId).not.toContain(RAW_TOKEN_A);
    },
  );

  it("jobId is exactly `<scope>-<32-hex-chars>` (BullMQ 5.x rejects ':')", async () => {
    await producer.enqueuePasswordReset({
      email: EMAIL_A,
      rawToken: RAW_TOKEN_A,
      userId: USER_A,
    });
    expect(queue.calls[0]!.opts?.jobId).toMatch(/^pwreset-[0-9a-f]{32}$/);
    expect(queue.calls[0]!.opts?.jobId).not.toContain(":");
  });
});

describe("deriveJobId — stable shape", () => {
  it("produces the same value for the same inputs across calls", () => {
    const a = deriveJobId("pwreset", RAW_TOKEN_A);
    const b = deriveJobId("pwreset", RAW_TOKEN_A);
    expect(a).toBe(b);
  });

  it("uses a 32-char hex hash slice", () => {
    const id = deriveJobId("verify", RAW_TOKEN_A);
    expect(id.startsWith("verify-")).toBe(true);
    expect(id.split("-")[1]).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("T303 — OTel trace context wiring", () => {
  it("job.data includes traceContext with a traceparent header when called inside an active span", async () => {
    const tracer = trace.getTracer("test-api");
    const span = tracer.startSpan("api.enqueue");
    const ctx = trace.setSpan(context.active(), span);

    await context.with(ctx, () =>
      producer.enqueuePasswordReset({
        email: EMAIL_A,
        rawToken: RAW_TOKEN_A,
        userId: USER_A,
      }),
    );
    span.end();

    const call = queue.calls[0]!;
    const data = call.data as Record<string, unknown>;
    expect(data["traceContext"]).toBeDefined();
    expect(typeof data["traceContext"]).toBe("object");
    expect(data["traceContext"]).not.toBeNull();
    const carrier = data["traceContext"] as Record<string, unknown>;
    expect(typeof carrier["traceparent"]).toBe("string");
    expect(carrier["traceparent"]).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
    );
  });

  it("enqueueEmailVerification also injects traceContext with traceparent", async () => {
    const tracer = trace.getTracer("test-api");
    const span = tracer.startSpan("api.enqueue-verify");
    const ctx = trace.setSpan(context.active(), span);

    await context.with(ctx, () =>
      producer.enqueueEmailVerification({
        email: EMAIL_A,
        rawToken: RAW_TOKEN_A,
        userId: USER_A,
      }),
    );
    span.end();

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data["traceContext"]).toBeDefined();
    const carrier = data["traceContext"] as Record<string, unknown>;
    expect(typeof carrier["traceparent"]).toBe("string");
    expect(carrier["traceparent"]).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
    );
  });

  it("traceContext does not contain PII (email, userId, rawToken)", async () => {
    const tracer = trace.getTracer("test-api");
    const span = tracer.startSpan("api.enqueue-pii-check");
    const ctx = trace.setSpan(context.active(), span);

    await context.with(ctx, () =>
      producer.enqueuePasswordReset({
        email: EMAIL_A,
        rawToken: RAW_TOKEN_A,
        userId: USER_A,
      }),
    );
    span.end();

    const carrier = JSON.stringify(
      (queue.calls[0]!.data as Record<string, unknown>)["traceContext"],
    );
    expect(carrier).not.toContain(EMAIL_A);
    expect(carrier).not.toContain(USER_A);
    expect(carrier).not.toContain(RAW_TOKEN_A);
  });
});
