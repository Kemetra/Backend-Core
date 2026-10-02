/**
 * AuditRetentionWorker — T311 Layer B.
 *
 * Thin BullMQ glue for the audit retention sweep queue. Mirrors AuditWorker
 * exactly, substituting the queue name and processor.
 *
 * Queue name (`"audit-retention"`) is the transport channel. The only job
 * name carried by this queue is `"audit-retention-sweep"`, validated
 * downstream by `AuditRetentionProcessor.process`.
 */
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
} from "@nestjs/common";
import {
  DEFAULT_WORKER_OPTIONS,
} from "@data-pulse-2/shared/queues/queue-config";
import { AuditRetentionProcessor } from "./audit-retention.processor";
import {
  type JobLike,
  type WorkerFactory,
  type WorkerLike,
  WORKER_FACTORY,
} from "../email/email.worker";
import { QUEUE_NAMES } from "@data-pulse-2/shared";

export const AUDIT_RETENTION_QUEUE_NAME = QUEUE_NAMES.auditRetention;

export type { JobLike, WorkerFactory, WorkerLike } from "../email/email.worker";
export { WORKER_FACTORY } from "../email/email.worker";
export type AuditRetentionJobHandler = (job: JobLike) => Promise<void>;

@Injectable()
export class AuditRetentionWorker implements OnModuleDestroy {
  private worker: WorkerLike | null = null;

  constructor(
    private readonly processor: AuditRetentionProcessor,
    @Inject(WORKER_FACTORY)
    private readonly workerFactory: WorkerFactory,
  ) {}

  start(): void {
    if (this.worker !== null) return;
    this.worker = this.workerFactory.create(
      AUDIT_RETENTION_QUEUE_NAME,
      async (job: JobLike) => {
        await this.processor.process(job.name, job.data);
      },
      DEFAULT_WORKER_OPTIONS,
    );
    this.worker.on("error", (err) => {
      const line = JSON.stringify({
        level: "error",
        component: "audit-retention.worker",
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
