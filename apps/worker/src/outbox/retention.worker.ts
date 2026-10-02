/**
 * OutboxRetentionWorker -- T590 Layer B.
 *
 * Thin BullMQ glue for the outbox retention sweep queue. Mirrors
 * `AuditRetentionWorker` exactly, substituting the queue name and
 * processor.
 *
 * Queue name (`"outbox-retention"`) is the transport channel. The only
 * job name carried by this queue is `"outbox-retention-sweep"`, validated
 * downstream by `OutboxRetentionProcessor.process`.
 *
 * Logging
 * -------
 * Worker-level errors emit a structured pino-compatible line to stderr
 * with `errorName` and a fixed component identifier. Payload contents
 * are NEVER logged -- per FR-B-005 the redaction matrix forbids any
 * outbox payload field from reaching log output; the processor's return
 * value (`purgedCount`, `batchCount`, `durationMs`) carries everything
 * an operator needs without touching row data.
 */
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
} from "@nestjs/common";
import {
  DEFAULT_WORKER_OPTIONS,
} from "@data-pulse-2/shared/queues/queue-config";
import { OutboxRetentionProcessor } from "./retention.processor";
import {
  type JobLike,
  type WorkerFactory,
  type WorkerLike,
  WORKER_FACTORY,
} from "../email/email.worker";
import { QUEUE_NAMES } from "@data-pulse-2/shared";

export const OUTBOX_RETENTION_QUEUE_NAME = QUEUE_NAMES.outboxRetention;

export type { JobLike, WorkerFactory, WorkerLike } from "../email/email.worker";
export { WORKER_FACTORY } from "../email/email.worker";
export type OutboxRetentionJobHandler = (job: JobLike) => Promise<void>;

@Injectable()
export class OutboxRetentionWorker implements OnModuleDestroy {
  private worker: WorkerLike | null = null;

  constructor(
    private readonly processor: OutboxRetentionProcessor,
    @Inject(WORKER_FACTORY)
    private readonly workerFactory: WorkerFactory,
  ) {}

  start(): void {
    if (this.worker !== null) return;
    this.worker = this.workerFactory.create(
      OUTBOX_RETENTION_QUEUE_NAME,
      async (job: JobLike) => {
        await this.processor.process(job.name, job.data);
      },
      DEFAULT_WORKER_OPTIONS,
    );
    this.worker.on("error", (err) => {
      // PII-safe structured error line: ONLY error class + message text
      // (which is operator-authored) reach stderr. No payload, no row
      // contents. Mirrors drainer.processor.ts logError shape.
      const line = JSON.stringify({
        level: "error",
        component: "outbox-retention.worker",
        message: err.message,
        name: err.name,
      });
      process.stderr.write(line + "\n");
    });
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w !== null) {
      await w.close();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
