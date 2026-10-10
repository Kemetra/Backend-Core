/**
 * AuditRetentionWorker unit tests — T311 Layer B.
 *
 * Mirrors audit.worker.spec.ts exactly, substituting the queue name,
 * processor type, and component tag.
 *
 * No real BullMQ runtime, no Redis, no Postgres.
 *
 * Coverage:
 *   - queue name is "audit-retention" (NOT "audit-retention-sweep")
 *   - AUDIT_RETENTION_QUEUE_NAME literal pin
 *   - starts through a fake WorkerFactory
 *   - handler delegates (job.name, job.data) to AuditRetentionProcessor.process
 *   - subscribes to the "error" event
 *   - error events write structured JSON to stderr with component "audit-retention.worker"
 *   - start() is idempotent
 *   - close() closes the underlying worker
 *   - close() before start() is a tolerated no-op
 *   - close() is idempotent
 *   - onModuleDestroy() invokes close()
 */
import {
  AUDIT_RETENTION_QUEUE_NAME,
  AuditRetentionWorker,
  type AuditRetentionJobHandler,
  type JobLike,
  type WorkerFactory,
  type WorkerLike,
} from "../../src/audit/audit-retention.worker";
import { AuditRetentionProcessor } from "../../src/audit/audit-retention.processor";
import {
  DEFAULT_WORKER_OPTIONS,
  type DefaultWorkerOptionsShape,
} from "@data-pulse-2/shared/queues/queue-config";

class FakeWorker implements WorkerLike {
  errorListeners: Array<(err: Error) => void> = [];
  closed = 0;
  on(event: "error", listener: (err: Error) => void): unknown {
    if (event === "error") this.errorListeners.push(listener);
    return this;
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
  emitError(err: Error): void {
    for (const l of this.errorListeners) l(err);
  }
}

class FakeWorkerFactory implements WorkerFactory {
  calls: Array<{
    queueName: string;
    handler: AuditRetentionJobHandler;
    options: DefaultWorkerOptionsShape;
  }> = [];
  workers: FakeWorker[] = [];
  create(
    queueName: string,
    handler: AuditRetentionJobHandler,
    options: DefaultWorkerOptionsShape,
  ): WorkerLike {
    this.calls.push({ queueName, handler, options });
    const w = new FakeWorker();
    this.workers.push(w);
    return w;
  }
}

class FakeProcessor {
  calls: Array<{ jobName: string; data: unknown }> = [];
  reject?: Error;
  async process(jobName: string, data: unknown): Promise<void> {
    this.calls.push({ jobName, data });
    if (this.reject) throw this.reject;
  }
}

let factory: FakeWorkerFactory;
let processor: FakeProcessor;
let worker: AuditRetentionWorker;
let stderrSpy: jest.SpyInstance;

beforeEach(() => {
  factory = new FakeWorkerFactory();
  processor = new FakeProcessor();
  worker = new AuditRetentionWorker(
    processor as unknown as AuditRetentionProcessor,
    factory,
  );
  stderrSpy = jest
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe("AuditRetentionWorker.start — queue-name pin", () => {
  it("registers a worker against the 'audit-retention' queue", () => {
    worker.start();
    expect(factory.calls).toHaveLength(1);
    expect(factory.calls[0]!.queueName).toBe("audit-retention");
    expect(factory.calls[0]!.queueName).toBe(AUDIT_RETENTION_QUEUE_NAME);
  });

  it("queue name is NOT the job name 'audit-retention-sweep'", () => {
    worker.start();
    expect(factory.calls[0]!.queueName).not.toBe("audit-retention-sweep");
  });

  it("forwards DEFAULT_WORKER_OPTIONS to the factory", () => {
    worker.start();
    expect(factory.calls[0]!.options).toBe(DEFAULT_WORKER_OPTIONS);
  });

  it("forwards the shared concurrency / lock / stalled defaults", () => {
    worker.start();
    const opts = factory.calls[0]!.options;
    expect(opts.concurrency).toBe(DEFAULT_WORKER_OPTIONS.concurrency);
    expect(opts.lockDuration).toBe(DEFAULT_WORKER_OPTIONS.lockDuration);
    expect(opts.stalledInterval).toBe(DEFAULT_WORKER_OPTIONS.stalledInterval);
    expect(opts.maxStalledCount).toBe(DEFAULT_WORKER_OPTIONS.maxStalledCount);
  });
});

describe("AuditRetentionWorker.start — handler delegation", () => {
  it("delegates (job.name, job.data) to AuditRetentionProcessor.process verbatim", async () => {
    worker.start();
    const handler = factory.calls[0]!.handler;
    const job: JobLike = {
      name: "audit-retention-sweep",
      data: { timestamp: 1715515200000 },
    };
    await handler(job);
    expect(processor.calls).toHaveLength(1);
    expect(processor.calls[0]).toEqual({
      jobName: "audit-retention-sweep",
      data: job.data,
    });
  });

  it("forwards job.name unchanged — does NOT hardcode the job name string", async () => {
    worker.start();
    const handler = factory.calls[0]!.handler;
    await handler({ name: "some-other-job", data: {} });
    expect(processor.calls[0]!.jobName).toBe("some-other-job");
  });

  it("propagates handler errors so BullMQ can retry", async () => {
    processor.reject = new Error("db connection lost");
    worker.start();
    const handler = factory.calls[0]!.handler;
    await expect(handler({ name: "audit-retention-sweep", data: {} })).rejects.toThrow(
      "db connection lost",
    );
  });
});

describe("AuditRetentionWorker.start — error logging", () => {
  it("subscribes to the 'error' event", () => {
    worker.start();
    expect(factory.workers[0]!.errorListeners).toHaveLength(1);
  });

  it("writes structured JSON to stderr with component 'audit-retention.worker'", () => {
    worker.start();
    factory.workers[0]!.emitError(new Error("redis ECONNREFUSED"));
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = String(stderrSpy.mock.calls[0]![0]);
    const parsed = JSON.parse(written.trim()) as Record<string, string>;
    expect(parsed["level"]).toBe("error");
    expect(parsed["component"]).toBe("audit-retention.worker");
    expect(parsed["message"]).toBe("redis ECONNREFUSED");
  });

  it("stderr JSON includes error name field", () => {
    worker.start();
    const err = new TypeError("bad type");
    factory.workers[0]!.emitError(err);
    const written = String(stderrSpy.mock.calls[0]![0]);
    const parsed = JSON.parse(written.trim()) as Record<string, string>;
    expect(parsed["name"]).toBe("TypeError");
  });
});

describe("AuditRetentionWorker.start — failed job logging (RT-353)", () => {
  it("logs a failed sweep as structured JSON on stderr, then rethrows", async () => {
    const failure = Object.assign(new Error("permission denied for table audit_events"), {
      code: "42501",
    });
    processor.reject = failure;
    worker.start();
    const handler = factory.calls[0]!.handler;

    await expect(handler({ name: "audit-retention-sweep", data: {}, id: "job-7" })).rejects.toBe(
      failure,
    );
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(stderrSpy.mock.calls[0]![0]).trim()) as Record<string, unknown>;
    expect(parsed).toEqual({
      level: "error",
      component: "audit-retention.worker",
      event: "job_failed",
      job_name: "audit-retention-sweep",
      job_id: "job-7",
      name: "Error",
      code: "42501",
      message: "permission denied for table audit_events",
    });
  });

  it("writes nothing to stderr for a successful sweep", async () => {
    worker.start();
    await factory.calls[0]!.handler({ name: "audit-retention-sweep", data: {} });
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe("AuditRetentionWorker.start — idempotency", () => {
  it("second start() is a no-op — factory.create called only once", () => {
    worker.start();
    worker.start();
    expect(factory.calls).toHaveLength(1);
  });
});

describe("AuditRetentionWorker.close", () => {
  it("closes the underlying worker after start", async () => {
    worker.start();
    await worker.close();
    expect(factory.workers[0]!.closed).toBe(1);
  });

  it("close() before start() is a tolerated no-op", async () => {
    await expect(worker.close()).resolves.toBeUndefined();
  });

  it("close() is idempotent — second close does not re-close the worker", async () => {
    worker.start();
    await worker.close();
    await worker.close();
    expect(factory.workers[0]!.closed).toBe(1);
  });

  it("onModuleDestroy() invokes close()", async () => {
    worker.start();
    await worker.onModuleDestroy();
    expect(factory.workers[0]!.closed).toBe(1);
  });
});

describe("AUDIT_RETENTION_QUEUE_NAME — literal pin", () => {
  it("is the literal 'audit-retention'", () => {
    expect(AUDIT_RETENTION_QUEUE_NAME).toBe("audit-retention");
  });

  it("is distinct from the job name 'audit-retention-sweep'", () => {
    expect(AUDIT_RETENTION_QUEUE_NAME).not.toBe("audit-retention-sweep");
  });
});
