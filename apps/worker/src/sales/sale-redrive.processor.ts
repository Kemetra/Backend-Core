/**
 * RT-457 (RT-447 F02) — `SaleRedriveProcessor`: the scheduled re-drive of
 * sales stranded before their ERP posting intent.
 *
 * The live pipeline is: capture writes the sale and `sale.captured` in one
 * transaction → the drainer enqueues a BullMQ `sale-processing` job and marks
 * the outbox row delivered → the job sets `processed_at` and emits
 * `erpnext.posting.requested` → the posting consumer inserts the posting row.
 * Before RT-457 two hops could strand a sale for good, with nothing to notice:
 *   - the sale-processing job ran out of its 5 attempts (a DB outage longer
 *     than ~15 s) or was lost with Redis; its fixed jobId made a re-add a no-op;
 *   - an `erpnext.posting.requested` event dead-lettered in the outbox, so no
 *     posting row was ever created (invisible to the ERP sync-ops screens).
 *
 * Every tick (`SaleRedriveScheduler`), for every tenant:
 *   (a) sales still unprocessed inside the age window are processed through the
 *       same idempotent `SaleProcessingProcessor` the BullMQ job uses (its
 *       `processed_at IS NULL` guard makes a concurrent or repeated run a
 *       no-op), which emits their posting intent in the same transaction;
 *   (b/c) processed sales without a `sale_post` row, and voids / refunds /
 *       returns without a `reversal` row, get their `erpnext.posting.requested`
 *       event re-emitted once the live attempt dead-lettered (see the
 *       repository for the evidence rule and the cap).
 * Re-driving is idempotent end to end, and the scheduler hands each tick to
 * one worker, so replicas never double-drive.
 *
 * A failure in one sale or one tenant is logged and the sweep continues; the
 * job then fails with `SaleRedriveIncompleteError` so BullMQ retries it.
 */
import { z } from "zod";

import { recordSaleRedrive } from "../observability/metrics/worker.metrics";
import type { SaleRedriveRepository } from "./sale-redrive.repository";
import { SALE_REDRIVE_BATCH_LIMIT, type SaleRedriveWindow } from "./sale-redrive.config";
import type { SaleProcessingJob, SaleProcessingResult } from "./sale-processing.processor";

/** BullMQ job (and job-scheduler) name. */
export const SALE_REDRIVE_JOB_NAME = "sale-redrive";

const COMPONENT = "sales.sale-redrive";

/** Scheduled sweeps carry no payload; passthrough tolerates BullMQ metadata. */
const SaleRedriveJobSchema = z.object({}).passthrough();

export type SaleRedriveLogLine = Readonly<Record<string, string | number>>;
export type SaleRedriveLog = (line: SaleRedriveLogLine) => void;

function writeStderr(line: SaleRedriveLogLine): void {
  process.stderr.write(JSON.stringify(line) + "\n");
}

/** The slice of `SaleProcessingProcessor` the sweep drives. */
export interface SaleProcessing {
  process(job: SaleProcessingJob): Promise<SaleProcessingResult>;
}

export interface SaleRedriveResult {
  readonly tenants: number;
  readonly salesProcessed: number;
  readonly salePostIntents: number;
  readonly reversalIntents: number;
  readonly failures: number;
}

export class UnknownSaleRedriveJobError extends Error {
  constructor(name: string) {
    super(`Unknown sale-redrive job name: '${name}'`);
    this.name = "UnknownSaleRedriveJobError";
  }
}

export class SaleRedriveIncompleteError extends Error {
  constructor(result: SaleRedriveResult) {
    super(`sale re-drive incomplete: ${result.failures} failure(s)`);
    this.name = "SaleRedriveIncompleteError";
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}

/** Running totals of one sweep pass. */
class RedriveTally {
  tenants = 0;
  salesProcessed = 0;
  salePostIntents = 0;
  reversalIntents = 0;
  failures = 0;

  result(): SaleRedriveResult {
    return {
      tenants: this.tenants,
      salesProcessed: this.salesProcessed,
      salePostIntents: this.salePostIntents,
      reversalIntents: this.reversalIntents,
      failures: this.failures,
    };
  }
}

export class SaleRedriveProcessor {
  constructor(
    private readonly repo: SaleRedriveRepository,
    private readonly saleProcessing: SaleProcessing,
    private readonly window: SaleRedriveWindow,
    private readonly log: SaleRedriveLog = writeStderr,
  ) {}

  async process(jobName: string, data: unknown): Promise<SaleRedriveResult> {
    if (jobName !== SALE_REDRIVE_JOB_NAME) throw new UnknownSaleRedriveJobError(jobName);
    SaleRedriveJobSchema.parse(data ?? {});

    const tally = new RedriveTally();
    for (const tenantId of await this.repo.listTenantIds()) {
      tally.tenants += 1;
      try {
        await this.sweepTenant(tenantId, tally);
      } catch (err) {
        this.failed(tally, { message: "tenant_redrive_failed", tenant_id: tenantId }, err);
      }
    }

    recordSaleRedrive("sale_processing", tally.salesProcessed);
    recordSaleRedrive("sale_post_intent", tally.salePostIntents);
    recordSaleRedrive("reversal_intent", tally.reversalIntents);
    const result = tally.result();
    this.log({ level: "info", component: COMPONENT, message: "sale_redrive_completed", ...result });
    if (result.failures > 0) throw new SaleRedriveIncompleteError(result);
    return result;
  }

  /** (a) process this tenant's stranded sales, then (b/c) re-emit its missing intents. */
  private async sweepTenant(tenantId: string, tally: RedriveTally): Promise<void> {
    const stranded = await this.repo.findUnprocessedSales(tenantId, this.window, SALE_REDRIVE_BATCH_LIMIT);
    for (const sale of stranded) {
      try {
        const r = await this.saleProcessing.process({ ...sale, tenantId, correlationId: null });
        if (r.applied) tally.salesProcessed += 1;
      } catch (err) {
        this.failed(tally, { message: "sale_redrive_failed", tenant_id: tenantId, sale_id: sale.saleId }, err);
      }
    }
    const emitted = await this.repo.reemitMissingIntents(tenantId, this.window, SALE_REDRIVE_BATCH_LIMIT);
    tally.salePostIntents += emitted.salePost;
    tally.reversalIntents += emitted.reversal;
  }

  /** Log ids + the error class only (never the message) and count the failure. */
  private failed(tally: RedriveTally, fields: Record<string, string>, err: unknown): void {
    tally.failures += 1;
    this.log({ level: "error", component: COMPONENT, ...fields, error_class: errorName(err) });
  }
}
