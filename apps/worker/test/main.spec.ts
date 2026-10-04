/**
 * T090 — main.ts bootstrap spec.
 *
 * Smoke-tests the bootstrap function. Injects:
 *   - a fake Nest application context (so we never spin up real DI),
 *   - a fake `process` that captures signal handlers and `exit()` calls
 *     (so Jest itself never exits),
 *   - a fake stderr sink (so we can assert the structured log line).
 *
 * No Redis. No BullMQ. No real `process.exit`.
 */
import {
  bootstrap,
  type ProcessLike,
  type StderrLike,
} from "../src/main";
import type { INestApplicationContext } from "@nestjs/common";
import { EmailWorker } from "../src/email/email.worker";
import { AuditWorker } from "../src/audit/audit.worker";
import { SaleWorker } from "../src/sales/sale.worker";
import { AuditRetentionWorker } from "../src/audit/audit-retention.worker";
import { OutboxRetentionWorker } from "../src/outbox/retention.worker";
import { StockRunSweepWorker } from "../src/erpnext-reconciliation/stock-run-sweep.worker";

class FakeEmailWorker {
  starts = 0;
  start(): void {
    this.starts += 1;
  }
  async close(): Promise<void> {
    // app.close() invokes onModuleDestroy on the real worker; the fake
    // context calls this directly via its `close` member.
  }
  async onModuleDestroy(): Promise<void> {
    // not exercised in these tests
  }
}

class FakeAuditWorker {
  starts = 0;
  start(): void {
    this.starts += 1;
  }
  async close(): Promise<void> {
    // see FakeEmailWorker
  }
  async onModuleDestroy(): Promise<void> {
    // not exercised in these tests
  }
}

class FakeSaleWorker {
  starts = 0;
  start(): void {
    this.starts += 1;
  }
  async close(): Promise<void> {
    // see FakeEmailWorker
  }
  async onModuleDestroy(): Promise<void> {
    // not exercised in these tests
  }
}

/** RT-123: both retention workers share this start/close shape. */
class FakeRetentionWorker {
  starts = 0;
  start(): void {
    this.starts += 1;
  }
  async close(): Promise<void> {
    // see FakeEmailWorker
  }
}

class FakeAppContext implements Partial<INestApplicationContext> {
  closed = 0;
  closeReject?: Error;
  readonly auditRetentionWorker = new FakeRetentionWorker();
  readonly outboxRetentionWorker = new FakeRetentionWorker();
  readonly stockRunSweepWorker = new FakeRetentionWorker();
  constructor(
    private readonly emailWorker: FakeEmailWorker,
    private readonly auditWorker: FakeAuditWorker,
    private readonly saleWorker: FakeSaleWorker,
  ) {}

  // Only `get` and `close` are used by `bootstrap`. `get` dispatches by
  // token: `EmailWorker` → fake email; `AuditWorker` → fake audit;
  // `SaleWorker` → fake sale. Anything else throws so a future bootstrap
  // addition surfaces here instead of silently returning the wrong fake.
  get<TInput = unknown, TResult = TInput>(token: TInput): TResult {
    if ((token as unknown) === EmailWorker) {
      return this.emailWorker as unknown as TResult;
    }
    if ((token as unknown) === AuditWorker) {
      return this.auditWorker as unknown as TResult;
    }
    if ((token as unknown) === SaleWorker) {
      return this.saleWorker as unknown as TResult;
    }
    if ((token as unknown) === AuditRetentionWorker) {
      return this.auditRetentionWorker as unknown as TResult;
    }
    if ((token as unknown) === OutboxRetentionWorker) {
      return this.outboxRetentionWorker as unknown as TResult;
    }
    if ((token as unknown) === StockRunSweepWorker) {
      return this.stockRunSweepWorker as unknown as TResult;
    }
    throw new Error(
      `FakeAppContext.get: unknown token ${String(token)} — extend the fake.`,
    );
  }
  async close(): Promise<void> {
    this.closed += 1;
    if (this.closeReject) throw this.closeReject;
  }
}

class FakeProcess implements ProcessLike {
  handlers: Partial<
    Record<"SIGTERM" | "SIGINT", Array<(s: "SIGTERM" | "SIGINT") => void>>
  > = {};
  exits: number[] = [];

  on(
    event: "SIGTERM" | "SIGINT",
    listener: (signal: "SIGTERM" | "SIGINT") => void,
  ): unknown {
    (this.handlers[event] ??= []).push(listener);
    return this;
  }
  exit(code: number): void {
    this.exits.push(code);
  }
  fire(event: "SIGTERM" | "SIGINT"): Promise<void> {
    const handlers = this.handlers[event] ?? [];
    for (const h of handlers) h(event);
    // Allow the queued microtasks (the `void shutdown(...)` chain) to settle.
    return new Promise((resolve) => setImmediate(resolve));
  }
}

class FakeStderr implements StderrLike {
  lines: string[] = [];
  write(line: string): boolean {
    this.lines.push(line);
    return true;
  }
}

async function setup(): Promise<{
  emailWorker: FakeEmailWorker;
  auditWorker: FakeAuditWorker;
  saleWorker: FakeSaleWorker;
  ctx: FakeAppContext;
  proc: FakeProcess;
  stderr: FakeStderr;
  triggerShutdown: (s: "SIGTERM" | "SIGINT") => Promise<void>;
}> {
  const emailWorker = new FakeEmailWorker();
  const auditWorker = new FakeAuditWorker();
  const saleWorker = new FakeSaleWorker();
  const ctx = new FakeAppContext(emailWorker, auditWorker, saleWorker);
  const proc = new FakeProcess();
  const stderr = new FakeStderr();
  const result = await bootstrap({
    createContext: async () =>
      ctx as unknown as INestApplicationContext,
    process: proc,
    stderr,
  });
  return {
    emailWorker,
    auditWorker,
    saleWorker,
    ctx,
    proc,
    stderr,
    triggerShutdown: result.triggerShutdown,
  };
}

describe("bootstrap — happy path", () => {
  it("creates the context, resolves EmailWorker, calls start()", async () => {
    const { emailWorker } = await setup();
    expect(emailWorker.starts).toBe(1);
  });

  it("creates the context, resolves AuditWorker, calls start()", async () => {
    const { auditWorker } = await setup();
    expect(auditWorker.starts).toBe(1);
  });

  it("creates the context, resolves SaleWorker, calls start()", async () => {
    const { saleWorker } = await setup();
    expect(saleWorker.starts).toBe(1);
  });

  it("starts all three workers exactly once each", async () => {
    const { emailWorker, auditWorker, saleWorker } = await setup();
    expect(emailWorker.starts).toBe(1);
    expect(auditWorker.starts).toBe(1);
    expect(saleWorker.starts).toBe(1);
  });

  it("RT-123: starts the audit and outbox retention workers exactly once each", async () => {
    const { ctx } = await setup();
    expect(ctx.auditRetentionWorker.starts).toBe(1);
    expect(ctx.outboxRetentionWorker.starts).toBe(1);
  });

  it("RT-179: starts the stock reconciliation sweep worker exactly once", async () => {
    const { ctx } = await setup();
    expect(ctx.stockRunSweepWorker.starts).toBe(1);
  });

  it("registers SIGTERM and SIGINT handlers exactly once", async () => {
    const { proc } = await setup();
    expect(proc.handlers["SIGTERM"]).toHaveLength(1);
    expect(proc.handlers["SIGINT"]).toHaveLength(1);
  });

  it("writes a structured 'started' line to stderr", async () => {
    const { stderr } = await setup();
    const startLine = stderr.lines.find((l) => l.includes("\"message\":\"started\""));
    expect(startLine).toBeDefined();
    const parsed = JSON.parse(startLine!.trim()) as Record<string, string>;
    expect(parsed["level"]).toBe("info");
    expect(parsed["component"]).toBe("worker.bootstrap");
  });

  it("returns all three worker references for callers", async () => {
    const emailWorker = new FakeEmailWorker();
    const auditWorker = new FakeAuditWorker();
    const saleWorker = new FakeSaleWorker();
    const ctx = new FakeAppContext(emailWorker, auditWorker, saleWorker);
    const proc = new FakeProcess();
    const stderr = new FakeStderr();
    const result = await bootstrap({
      createContext: async () =>
        ctx as unknown as INestApplicationContext,
      process: proc,
      stderr,
    });
    expect(result.emailWorker).toBe(
      emailWorker as unknown as EmailWorker,
    );
    expect(result.auditWorker).toBe(
      auditWorker as unknown as AuditWorker,
    );
    expect(result.saleWorker).toBe(
      saleWorker as unknown as SaleWorker,
    );
    expect(result.auditRetentionWorker).toBe(
      ctx.auditRetentionWorker as unknown as AuditRetentionWorker,
    );
    expect(result.outboxRetentionWorker).toBe(
      ctx.outboxRetentionWorker as unknown as OutboxRetentionWorker,
    );
    expect(result.stockRunSweepWorker).toBe(
      ctx.stockRunSweepWorker as unknown as StockRunSweepWorker,
    );
  });
});

describe("bootstrap — shutdown sequence", () => {
  it("on SIGTERM, awaits app.close() then exits with code 0", async () => {
    const { ctx, proc, stderr } = await setup();
    await proc.fire("SIGTERM");
    expect(ctx.closed).toBe(1);
    expect(proc.exits).toEqual([0]);
    const shutdownLine = stderr.lines.find((l) =>
      l.includes("\"message\":\"shutdown\""),
    );
    expect(shutdownLine).toBeDefined();
    const parsed = JSON.parse(shutdownLine!.trim()) as Record<string, string>;
    expect(parsed["signal"]).toBe("SIGTERM");
  });

  it("on SIGINT, awaits app.close() then exits with code 0", async () => {
    const { ctx, proc } = await setup();
    await proc.fire("SIGINT");
    expect(ctx.closed).toBe(1);
    expect(proc.exits).toEqual([0]);
  });

  it("is idempotent — a second SIGTERM does not re-close the app", async () => {
    const { ctx, proc } = await setup();
    await proc.fire("SIGTERM");
    await proc.fire("SIGTERM");
    expect(ctx.closed).toBe(1);
    expect(proc.exits).toEqual([0]);
  });

  it("logs and still exits if app.close() throws", async () => {
    const emailWorker = new FakeEmailWorker();
    const auditWorker = new FakeAuditWorker();
    const saleWorker = new FakeSaleWorker();
    const ctx = new FakeAppContext(emailWorker, auditWorker, saleWorker);
    ctx.closeReject = new Error("redis disconnect failed");
    const proc = new FakeProcess();
    const stderr = new FakeStderr();
    await bootstrap({
      createContext: async () =>
        ctx as unknown as INestApplicationContext,
      process: proc,
      stderr,
    });
    await proc.fire("SIGTERM");
    const failLine = stderr.lines.find((l) =>
      l.includes("\"message\":\"shutdown_failed\""),
    );
    expect(failLine).toBeDefined();
    expect(proc.exits).toEqual([0]);
  });

  it("triggerShutdown can be invoked directly (test hook)", async () => {
    const { ctx, proc, triggerShutdown } = await setup();
    await triggerShutdown("SIGTERM");
    expect(ctx.closed).toBe(1);
    expect(proc.exits).toEqual([0]);
  });

  it("shuts down both workers via a single app.close() call (Nest lifecycle)", async () => {
    // Both workers' onModuleDestroy hooks are owned by Nest. The
    // bootstrap shutdown path must NOT call worker.close() directly —
    // it calls app.close(), which fans out via Nest. We assert the
    // app-level close happens exactly once on signal.
    const { ctx, proc } = await setup();
    await proc.fire("SIGTERM");
    expect(ctx.closed).toBe(1);
  });
});
