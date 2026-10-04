/**
 * Worker bootstrap — slice 6 (T090).
 *
 * Standalone NestJS application context (no HTTP server). Loads
 * `WorkerModule`, resolves `EmailWorker`, and starts consuming the
 * `email` BullMQ queue.
 *
 * Lifecycle
 * ---------
 *   1. `NestFactory.createApplicationContext(WorkerModule)`
 *   2. `app.get(EmailWorker).start()`
 *   3. install `SIGTERM` / `SIGINT` handlers
 *   4. on signal: `await app.close()` (which fires `EmailWorker.onModuleDestroy`)
 *      then `process.exit(0)`
 *
 * Test seam
 * ---------
 * `bootstrap()` accepts an optional `BootstrapDeps` argument so unit
 * tests can inject a fake Nest context, fake `EmailWorker`, fake
 * `process` (for signal handling and exit assertions), and fake stderr
 * sink. Real production never passes anything; the defaults wire up
 * the real Nest factory and the real `process`.
 */

// instrumentation MUST be first: registers the OTel MeterProvider before
// any module that creates instruments at load time (worker.metrics.ts, etc.).
import "./instrumentation";

// Force worker metric instruments to register with the live MeterProvider.
// This module's top-level code calls `meter.createCounter(...)` /
// `assertMetricLabels(...)` as side effects; without this import the
// instruments are never created and the Prometheus scrape never shows
// platform-defined worker signals (signals.md §3).
// Constitution §VII / T483.
import "./observability/metrics/worker.metrics";

import {
  type INestApplicationContext,
  Logger,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { shutdownOtel } from "@data-pulse-2/shared";

import { EmailWorker } from "./email/email.worker";
import { AuditWorker } from "./audit/audit.worker";
import { SaleWorker } from "./sales/sale.worker";
import { AuditRetentionWorker } from "./audit/audit-retention.worker";
import { OutboxRetentionWorker } from "./outbox/retention.worker";
import { StockRunSweepWorker } from "./erpnext-reconciliation/stock-run-sweep.worker";
import { ReplayPurgeWorker } from "./cashier-admissions/replay-purge.worker";
import { WorkerModule } from "./worker.module";

/**
 * Narrow shape of `process` used by `bootstrap`. Mirrors the parts we
 * call so tests can inject a fake without trying to mock the real
 * Node `process` global (which has dozens of methods we don't touch).
 */
export interface ProcessLike {
  on(
    event: "SIGTERM" | "SIGINT",
    listener: (signal: "SIGTERM" | "SIGINT") => void,
  ): unknown;
  exit(code: number): void;
}

/**
 * Stderr sink used for the start/stop log lines. Tests can capture
 * these to assert structured output without monkey-patching the real
 * `process.stderr`.
 */
export interface StderrLike {
  write(line: string): boolean | void;
}

export interface BootstrapDeps {
  /** Builds the Nest application context. Defaults to `NestFactory.createApplicationContext`. */
  readonly createContext?: () => Promise<INestApplicationContext>;
  /** Process for signal handling + exit. Defaults to the real `process`. */
  readonly process?: ProcessLike;
  /** Stderr sink for diagnostic logs. Defaults to `process.stderr`. */
  readonly stderr?: StderrLike;
}

const logger = new Logger("worker.bootstrap");

/**
 * Bootstraps the worker. Returns the Nest context plus the workers it
 * resolved (`emailWorker`, `auditWorker`, `saleWorker`,
 * `auditRetentionWorker`, `outboxRetentionWorker`, `stockRunSweepWorker`,
 * `replayPurgeWorker`), and a `triggerShutdown`
 * callable that tests can call to simulate a signal without actually
 * emitting one.
 *
 * All seven workers are started by this function. The two retention workers,
 * the stock reconciliation sweep worker (RT-179) and the cashier-admission
 * replay purge worker (RT-209) consume the repeatable jobs their schedulers
 * register at module init (RT-123); without a consumer
 * those jobs accumulate unprocessed. Their shutdown is owned
 * by Nest's lifecycle: `app.close()` (called inside `shutdown()` below)
 * fires `onModuleDestroy` on every provider, which calls `close()` on
 * each worker.
 */
export async function bootstrap(
  deps: BootstrapDeps = {},
): Promise<{
  app: INestApplicationContext;
  emailWorker: EmailWorker;
  auditWorker: AuditWorker;
  saleWorker: SaleWorker;
  auditRetentionWorker: AuditRetentionWorker;
  outboxRetentionWorker: OutboxRetentionWorker;
  stockRunSweepWorker: StockRunSweepWorker;
  replayPurgeWorker: ReplayPurgeWorker;
  /** Test hook: invoke the registered shutdown sequence. */
  triggerShutdown: (signal: "SIGTERM" | "SIGINT") => Promise<void>;
}> {
  const createContext =
    deps.createContext ??
    (() => NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false }));
  const proc: ProcessLike = deps.process ?? process;
  const stderr: StderrLike = deps.stderr ?? process.stderr;

  // OTel SDK is already running (started by ./instrumentation, which is
  // imported as the very first module in this file). Log the port/host so
  // operators can confirm the scrape endpoint is up.
  const metricsPort = Number(process.env["WORKER_METRICS_PORT"] ?? 9091);
  const metricsHost = process.env["WORKER_METRICS_BIND_HOST"] ?? "127.0.0.1";

  writeLine(stderr, {
    level: "info",
    component: "worker.bootstrap",
    message: "metrics_listening",
    metricsPort: String(metricsPort),
    metricsHost,
  });

  const app = await createContext();
  const emailWorker = app.get(EmailWorker);
  const auditWorker = app.get(AuditWorker);
  // SaleWorker consumes the "sale-processing" BullMQ queue (the live half of
  // DP-008-LIVELOOP). It is registered in WorkerModule but NOT self-starting,
  // so it must be started imperatively here alongside email/audit.
  const saleWorker = app.get(SaleWorker);
  const auditRetentionWorker = app.get(AuditRetentionWorker);
  const outboxRetentionWorker = app.get(OutboxRetentionWorker);
  const stockRunSweepWorker = app.get(StockRunSweepWorker);
  const replayPurgeWorker = app.get(ReplayPurgeWorker);
  emailWorker.start();
  auditWorker.start();
  saleWorker.start();
  auditRetentionWorker.start();
  outboxRetentionWorker.start();
  stockRunSweepWorker.start();
  replayPurgeWorker.start();

  writeLine(stderr, {
    level: "info",
    component: "worker.bootstrap",
    message: "started",
  });

  let shuttingDown = false;
  const shutdown = async (signal: "SIGTERM" | "SIGINT"): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    writeLine(stderr, {
      level: "info",
      component: "worker.bootstrap",
      message: "shutdown",
      signal,
    });
    try {
      await app.close();
    } catch (err) {
      writeLine(stderr, {
        level: "error",
        component: "worker.bootstrap",
        message: "shutdown_failed",
        error: errMsg(err),
      });
    }
    // Flush metrics and shut down the OTel SDK (including the Prometheus
    // HTTP listener) before exiting.
    await shutdownOtel();
    proc.exit(0);
  };

  proc.on("SIGTERM", (s) => {
    void shutdown(s);
  });
  proc.on("SIGINT", (s) => {
    void shutdown(s);
  });

  return {
    app,
    emailWorker,
    auditWorker,
    saleWorker,
    auditRetentionWorker,
    outboxRetentionWorker,
    stockRunSweepWorker,
    replayPurgeWorker,
    triggerShutdown: shutdown,
  };
}

function writeLine(
  stderr: StderrLike,
  obj: Readonly<Record<string, string>>,
): void {
  stderr.write(JSON.stringify(obj) + "\n");
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Production entrypoint. Only runs when this file is the Node main
 * module (e.g., `node dist/main.js`). The Jest tests `import` the
 * module to call `bootstrap` directly, so this branch must not fire
 * during testing.
 */
if (require.main === module) {
  bootstrap().catch((err: unknown) => {
    logger.error(`worker bootstrap failed: ${errMsg(err)}`);
    process.exit(1);
  });
}
