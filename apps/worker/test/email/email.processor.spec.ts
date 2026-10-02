/**
 * T114 — EmailProcessor spec.
 *
 * Pure unit-level. The processor's collaborators are:
 *   - an `EmailAdapter` (driven port — represented in tests by
 *     `RecordingEmailAdapter`, which captures every send), and
 *   - templated render functions (pure, no I/O).
 *
 * No real BullMQ runtime, no Redis, no `ioredis-mock`, no provider SDK.
 * The processor is invoked directly with `(jobName, data)` exactly as a
 * future BullMQ `Worker` callback would invoke it.
 *
 * Coverage matches T114 + the approval list:
 *   - dispatches `auth.password-reset` to the password-reset template
 *   - dispatches `auth.email-verify` to the verification template
 *   - unknown job name throws (so future BullMQ DLQ fires)
 *   - malformed payload throws BEFORE adapter.send
 *   - adapter failure propagates (so future BullMQ retries fire)
 *   - rawToken is present in the rendered body (email is functional)
 *   - userId is NOT present in subject, tags, or body
 *   - tags are PII-free
 *   - to === payload.email
 *   - subject is non-empty
 *   - T303: jobs with traceContext still parse and send normally
 *   - T303: legacy jobs without traceContext still work
 */
// T596: mock the worker.metrics module BEFORE importing the processor.
// The processor imports recordWorkerJobDuration / recordWorkerProcessingFailure
// / sanitizeErrorClass as side effects at module load. Letting the real module
// run would require an OTel SDK; the unit suite stays Docker- and OTel-free.
// The mock returns no-op jest.fn() spies so we can assert call counts and
// arguments, and a passthrough sanitizeErrorClass that mirrors the real
// closed-allowlist behavior (anything outside the allowlist → "UnknownError").
jest.mock("../../src/observability/metrics/worker.metrics", () => {
  const WORKER_ERROR_CLASSES = new Set([
    "TenantContextMissingError",
    "ZodValidationError",
    "PostgresUniqueViolation",
    "RedisConnectionError",
    "Timeout",
    "UnknownError",
  ]);
  return {
    recordWorkerJobDuration: jest.fn(),
    recordWorkerProcessingFailure: jest.fn(),
    sanitizeErrorClass: jest.fn((name: string | null | undefined) =>
      typeof name === "string" && WORKER_ERROR_CLASSES.has(name) ? name : "UnknownError",
    ),
  };
});

import {
  EmailProcessor,
  EMAIL_JOB_NAMES,
  UnknownEmailJobError,
  MalformedEmailJobError,
} from "../../src/email/email.processor";
import {
  RecordingEmailAdapter,
  type EmailMessage,
} from "../../src/email/email.adapter";
import {
  createTestTracerProvider,
  context,
  trace,
  injectTraceContext,
  type TestTracerHandle,
} from "@data-pulse-2/shared/observability/otel";
import {
  recordWorkerJobDuration,
  recordWorkerProcessingFailure,
} from "../../src/observability/metrics/worker.metrics";

const TENANT_ID = "0b000000-0000-7000-8000-00000000bb01";

const RAW_TOKEN = "raw-token-aaaaaaaaaaaaaaaaaa";
const EMAIL = "alice@example.com";
const USER_ID = "0a000000-0000-7000-8000-00000000aa01";

let adapter: RecordingEmailAdapter;
let processor: EmailProcessor;

beforeEach(() => {
  adapter = new RecordingEmailAdapter();
  processor = new EmailProcessor(adapter);
  // T596: reset metric spies so per-test call-count assertions are clean.
  (recordWorkerJobDuration as jest.Mock).mockClear();
  (recordWorkerProcessingFailure as jest.Mock).mockClear();
});

describe("EmailProcessor — auth.password-reset", () => {
  it("dispatches the password-reset job to adapter.send exactly once", async () => {
    await processor.process(EMAIL_JOB_NAMES.passwordReset, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    expect(adapter.sent).toHaveLength(1);
  });

  it("sends to the address from the job payload", async () => {
    await processor.process(EMAIL_JOB_NAMES.passwordReset, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    expect(adapter.sent[0]!.to).toBe(EMAIL);
  });

  it("renders a non-empty subject", async () => {
    await processor.process(EMAIL_JOB_NAMES.passwordReset, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    const { subject } = adapter.sent[0]!;
    expect(subject).toBeDefined();
    expect(subject.length).toBeGreaterThan(0);
  });

  it("includes the rawToken in the rendered body so the email is functional", async () => {
    await processor.process(EMAIL_JOB_NAMES.passwordReset, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    const message = adapter.sent[0]!;
    expect(message.textBody).toContain(RAW_TOKEN);
    if (message.htmlBody) {
      expect(message.htmlBody).toContain(RAW_TOKEN);
    }
  });
});

describe("EmailProcessor — auth.email-verify", () => {
  it("dispatches the verification job to adapter.send exactly once", async () => {
    await processor.process(EMAIL_JOB_NAMES.emailVerification, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    expect(adapter.sent).toHaveLength(1);
  });

  it("sends to the address from the job payload", async () => {
    await processor.process(EMAIL_JOB_NAMES.emailVerification, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    expect(adapter.sent[0]!.to).toBe(EMAIL);
  });

  it("renders a non-empty subject", async () => {
    await processor.process(EMAIL_JOB_NAMES.emailVerification, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    expect(adapter.sent[0]!.subject.length).toBeGreaterThan(0);
  });

  it("includes the rawToken in the rendered body so the email is functional", async () => {
    await processor.process(EMAIL_JOB_NAMES.emailVerification, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    const message = adapter.sent[0]!;
    expect(message.textBody).toContain(RAW_TOKEN);
    if (message.htmlBody) {
      expect(message.htmlBody).toContain(RAW_TOKEN);
    }
  });

  it("renders a different subject than the password-reset job", async () => {
    await processor.process(EMAIL_JOB_NAMES.emailVerification, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    const verifySubject = adapter.sent[0]!.subject;

    adapter = new RecordingEmailAdapter();
    processor = new EmailProcessor(adapter);
    await processor.process(EMAIL_JOB_NAMES.passwordReset, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    const resetSubject = adapter.sent[0]!.subject;

    expect(verifySubject).not.toBe(resetSubject);
  });
});

describe("EmailProcessor — error paths", () => {
  it("throws UnknownEmailJobError on an unknown job name (so BullMQ DLQ fires)", async () => {
    await expect(
      processor.process("auth.not-a-real-job", {
        email: EMAIL,
        rawToken: RAW_TOKEN,
        userId: USER_ID,
      }),
    ).rejects.toBeInstanceOf(UnknownEmailJobError);
    expect(adapter.sent).toHaveLength(0);
  });

  it("throws MalformedEmailJobError BEFORE calling adapter.send when payload is missing fields", async () => {
    await expect(
      processor.process(EMAIL_JOB_NAMES.passwordReset, {
        email: EMAIL,
        // rawToken missing
        userId: USER_ID,
      } as unknown),
    ).rejects.toBeInstanceOf(MalformedEmailJobError);
    expect(adapter.sent).toHaveLength(0);
  });

  it("throws MalformedEmailJobError when email is not a valid email", async () => {
    await expect(
      processor.process(EMAIL_JOB_NAMES.passwordReset, {
        email: "not-an-email",
        rawToken: RAW_TOKEN,
        userId: USER_ID,
      }),
    ).rejects.toBeInstanceOf(MalformedEmailJobError);
    expect(adapter.sent).toHaveLength(0);
  });

  it("throws MalformedEmailJobError when rawToken is empty", async () => {
    await expect(
      processor.process(EMAIL_JOB_NAMES.passwordReset, {
        email: EMAIL,
        rawToken: "",
        userId: USER_ID,
      }),
    ).rejects.toBeInstanceOf(MalformedEmailJobError);
    expect(adapter.sent).toHaveLength(0);
  });

  it("throws MalformedEmailJobError when payload is null", async () => {
    await expect(
      processor.process(EMAIL_JOB_NAMES.passwordReset, null),
    ).rejects.toBeInstanceOf(MalformedEmailJobError);
    expect(adapter.sent).toHaveLength(0);
  });

  it("propagates errors thrown by adapter.send (so BullMQ can retry)", async () => {
    adapter.reject = new Error("smtp ECONNREFUSED");
    await expect(
      processor.process(EMAIL_JOB_NAMES.passwordReset, {
        email: EMAIL,
        rawToken: RAW_TOKEN,
        userId: USER_ID,
      }),
    ).rejects.toThrow("smtp ECONNREFUSED");
  });
});

describe("EmailProcessor — PII discipline", () => {
  const everyJob: ReadonlyArray<readonly [string, string]> = [
    ["password reset", EMAIL_JOB_NAMES.passwordReset],
    ["email verify", EMAIL_JOB_NAMES.emailVerification],
  ];

  it.each(everyJob)(
    "%s: userId never appears in subject, body, or tags",
    async (_label, jobName) => {
      await processor.process(jobName, {
        email: EMAIL,
        rawToken: RAW_TOKEN,
        userId: USER_ID,
      });
      const message: EmailMessage = adapter.sent[0]!;
      expect(message.subject).not.toContain(USER_ID);
      expect(message.textBody).not.toContain(USER_ID);
      if (message.htmlBody) {
        expect(message.htmlBody).not.toContain(USER_ID);
      }
      const tagsBlob = JSON.stringify(message.tags ?? {});
      expect(tagsBlob).not.toContain(USER_ID);
      expect(tagsBlob).not.toContain(EMAIL);
      expect(tagsBlob).not.toContain(RAW_TOKEN);
    },
  );

  it.each(everyJob)(
    "%s: tags (if present) only contain non-PII labels",
    async (_label, jobName) => {
      await processor.process(jobName, {
        email: EMAIL,
        rawToken: RAW_TOKEN,
        userId: USER_ID,
      });
      const tags = adapter.sent[0]!.tags;
      if (tags) {
        for (const value of Object.values(tags)) {
          expect(value).not.toContain("@");
          expect(value).not.toContain(USER_ID);
          expect(value).not.toContain(RAW_TOKEN);
        }
      }
    },
  );
});

describe("EmailProcessor — memberships.invitation", () => {
  it("dispatches the invitation job to adapter.send exactly once", async () => {
    await processor.process(EMAIL_JOB_NAMES.invitation, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      tenantId: TENANT_ID,
    });
    expect(adapter.sent).toHaveLength(1);
  });

  it("sends to the address from the job payload", async () => {
    await processor.process(EMAIL_JOB_NAMES.invitation, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      tenantId: TENANT_ID,
    });
    expect(adapter.sent[0]!.to).toBe(EMAIL);
  });

  it("renders a non-empty subject", async () => {
    await processor.process(EMAIL_JOB_NAMES.invitation, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      tenantId: TENANT_ID,
    });
    expect(adapter.sent[0]!.subject.length).toBeGreaterThan(0);
  });

  it("includes the rawToken in the rendered body so the email is functional", async () => {
    await processor.process(EMAIL_JOB_NAMES.invitation, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      tenantId: TENANT_ID,
    });
    const message = adapter.sent[0]!;
    expect(message.textBody).toContain(RAW_TOKEN);
    if (message.htmlBody) {
      expect(message.htmlBody).toContain(RAW_TOKEN);
    }
  });

  it("names the product as Retail Tower OS, not the legacy Data Pulse name (RT-122)", async () => {
    await processor.process(EMAIL_JOB_NAMES.invitation, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      tenantId: TENANT_ID,
    });
    const message = adapter.sent[0]!;
    for (const text of [message.subject, message.textBody, message.htmlBody ?? ""]) {
      expect(text).not.toMatch(/data pulse/i);
    }
    expect(message.subject).toContain("Retail Tower OS");
    expect(message.textBody).toContain("Retail Tower OS");
  });

  it("throws MalformedEmailJobError when tenantId is missing", async () => {
    await expect(
      processor.process(EMAIL_JOB_NAMES.invitation, {
        email: EMAIL,
        rawToken: RAW_TOKEN,
        // tenantId missing
      } as unknown),
    ).rejects.toBeInstanceOf(MalformedEmailJobError);
    expect(adapter.sent).toHaveLength(0);
  });

  it("tags are PII-free (no email, no rawToken, no tenantId in tag values)", async () => {
    await processor.process(EMAIL_JOB_NAMES.invitation, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      tenantId: TENANT_ID,
    });
    const tags = adapter.sent[0]!.tags;
    if (tags) {
      for (const value of Object.values(tags)) {
        expect(value).not.toContain("@");
        expect(value).not.toContain(RAW_TOKEN);
        expect(value).not.toContain(TENANT_ID);
      }
    }
  });
});

describe("EmailProcessor — job name contract with EmailQueueProducer", () => {
  // The producer in `apps/api/src/auth/email-queue.producer.ts` writes
  // these exact string literals. If either side drifts, this test fails
  // and reminds us to extract the constants to `packages/shared`.
  it("uses 'auth.password-reset' for password reset jobs", () => {
    expect(EMAIL_JOB_NAMES.passwordReset).toBe("auth.password-reset");
  });
  it("uses 'auth.email-verify' for email verification jobs", () => {
    expect(EMAIL_JOB_NAMES.emailVerification).toBe("auth.email-verify");
  });
  it("uses 'memberships.invitation' for invitation jobs", () => {
    expect(EMAIL_JOB_NAMES.invitation).toBe("memberships.invitation");
  });
});

describe("T303 — OTel traceContext wiring in EmailProcessor", () => {
  let tracerHandle: TestTracerHandle;

  beforeEach(() => {
    tracerHandle = createTestTracerProvider();
  });

  afterEach(async () => {
    await tracerHandle.teardown();
  });

  it("processes a password-reset job that includes traceContext without error", async () => {
    await processor.process(EMAIL_JOB_NAMES.passwordReset, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
      traceContext: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
    });
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.to).toBe(EMAIL);
  });

  it("processes an email-verify job that includes traceContext without error", async () => {
    await processor.process(EMAIL_JOB_NAMES.emailVerification, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
      traceContext: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
    });
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.to).toBe(EMAIL);
  });

  it("processes an invitation job that includes traceContext without error", async () => {
    await processor.process(EMAIL_JOB_NAMES.invitation, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      tenantId: TENANT_ID,
      traceContext: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
    });
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]!.to).toBe(EMAIL);
  });

  it("legacy job without traceContext still processes normally", async () => {
    await processor.process(EMAIL_JOB_NAMES.passwordReset, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
      // no traceContext — legacy producer
    });
    expect(adapter.sent).toHaveLength(1);
  });

  it("active context inside process() carries the producer traceId from traceContext", async () => {
    const tracer = trace.getTracer("test-producer");
    const producerSpan = tracer.startSpan("api.enqueue");
    const producerCtx = trace.setSpan(context.active(), producerSpan);
    const traceContext = context.with(producerCtx, () => injectTraceContext());
    producerSpan.end();
    const producerTraceId = producerSpan.spanContext().traceId;

    let contextTraceId: string | undefined;
    const capturingAdapter = new RecordingEmailAdapter();
    const capturingProcessor = new EmailProcessor(capturingAdapter);

    const origSend = capturingAdapter.send.bind(capturingAdapter);
    capturingAdapter.send = async (msg) => {
      // Inside context.with(restoredCtx), the active context carries the
      // producer's span context — extractable via trace.getSpanContext.
      const spanCtx = trace.getSpanContext(context.active());
      contextTraceId = spanCtx?.traceId;
      return origSend(msg);
    };

    await capturingProcessor.process(EMAIL_JOB_NAMES.passwordReset, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
      traceContext,
    });

    expect(contextTraceId).toBe(producerTraceId);
  });
});

describe("T596 — EmailProcessor metric emission (worker_job_duration, worker_processing_failure)", () => {
  it("success: records worker_job_duration_seconds with job_name='email' and non-negative duration", async () => {
    await processor.process(EMAIL_JOB_NAMES.passwordReset, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    expect(recordWorkerJobDuration).toHaveBeenCalledTimes(1);
    const [attrs, durationSeconds] = (recordWorkerJobDuration as jest.Mock).mock.calls[0]!;
    expect(attrs).toEqual({ job_name: "email" });
    expect(typeof durationSeconds).toBe("number");
    expect(durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it("success: does NOT record worker_processing_failure_total", async () => {
    await processor.process(EMAIL_JOB_NAMES.emailVerification, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      userId: USER_ID,
    });
    expect(recordWorkerProcessingFailure).not.toHaveBeenCalled();
  });

  it("malformed payload: records worker_processing_failure with job_name='email' and error_class='UnknownError'", async () => {
    // MalformedEmailJobError is not in WORKER_ERROR_CLASSES — sanitizes to "UnknownError".
    await expect(
      processor.process(EMAIL_JOB_NAMES.passwordReset, {
        email: EMAIL,
        rawToken: "",
        userId: USER_ID,
      }),
    ).rejects.toBeInstanceOf(MalformedEmailJobError);

    expect(recordWorkerProcessingFailure).toHaveBeenCalledTimes(1);
    expect(recordWorkerProcessingFailure).toHaveBeenCalledWith({
      job_name: "email",
      error_class: "UnknownError",
    });
  });

  it("malformed payload: still records worker_job_duration_seconds (finally branch fires)", async () => {
    await expect(
      processor.process(EMAIL_JOB_NAMES.passwordReset, {
        email: EMAIL,
        rawToken: "",
        userId: USER_ID,
      }),
    ).rejects.toBeInstanceOf(MalformedEmailJobError);

    expect(recordWorkerJobDuration).toHaveBeenCalledTimes(1);
    const [attrs] = (recordWorkerJobDuration as jest.Mock).mock.calls[0]!;
    expect(attrs).toEqual({ job_name: "email" });
  });

  it("unknown job name: records worker_processing_failure with error_class='UnknownError'", async () => {
    await expect(
      processor.process("auth.not-a-real-job", {
        email: EMAIL,
        rawToken: RAW_TOKEN,
        userId: USER_ID,
      }),
    ).rejects.toBeInstanceOf(UnknownEmailJobError);

    expect(recordWorkerProcessingFailure).toHaveBeenCalledTimes(1);
    expect(recordWorkerProcessingFailure).toHaveBeenCalledWith({
      job_name: "email",
      error_class: "UnknownError",
    });
  });

  it("adapter error: records worker_processing_failure and rethrows the original error unchanged", async () => {
    adapter.reject = new Error("smtp ECONNREFUSED");
    await expect(
      processor.process(EMAIL_JOB_NAMES.passwordReset, {
        email: EMAIL,
        rawToken: RAW_TOKEN,
        userId: USER_ID,
      }),
    ).rejects.toThrow("smtp ECONNREFUSED");

    // Generic Error is not in WORKER_ERROR_CLASSES → sanitizes to UnknownError.
    expect(recordWorkerProcessingFailure).toHaveBeenCalledWith({
      job_name: "email",
      error_class: "UnknownError",
    });
    expect(recordWorkerJobDuration).toHaveBeenCalledTimes(1);
  });

  it("invitation job success path records duration with job_name='email' (same queue-level label)", async () => {
    await processor.process(EMAIL_JOB_NAMES.invitation, {
      email: EMAIL,
      rawToken: RAW_TOKEN,
      tenantId: TENANT_ID,
    });
    expect(recordWorkerJobDuration).toHaveBeenCalledTimes(1);
    const [attrs] = (recordWorkerJobDuration as jest.Mock).mock.calls[0]!;
    expect(attrs).toEqual({ job_name: "email" });
    expect(recordWorkerProcessingFailure).not.toHaveBeenCalled();
  });
});
