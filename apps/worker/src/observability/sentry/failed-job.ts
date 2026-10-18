/**
 * BullMQ final job failures to Sentry (RT-698, closes the RT-631 worker gaps).
 *
 * A job processor's throw never reaches Sentry's global handlers: BullMQ
 * catches it and moves the job to `delayed` (retry) or `failed`. This listener
 * hangs off the Worker's `failed` event and captures only the LAST failure, so
 * one broken job is one event, not one per attempt.
 *
 * What leaves the process (OBS-1 §1-§3): the error itself, rebuilt by the
 * shared `beforeSend` scrubber, plus the tags below. Job data, ids, the failed
 * reason and the stored stacktrace are never passed to the SDK: job payloads
 * are business data (OBS-1 §3.3). The two correlation ids are read from the
 * job carrier only and the scrubber re-checks their exact format.
 *
 *   queue      - the BullMQ queue name
 *   job_name   - the job name, only when it is one the worker declares; a
 *                producer can set any string, so an undeclared name is left
 *                out and masked inside the error message (Unknown*JobError
 *                messages echo it)
 *   outcome    - `exhausted` (attempts used up) or `unrecoverable`
 *   error_class - the error's class from the worker metrics' closed set
 *                 (`sanitizeErrorClass`); anything else is `UnknownError`
 *   request_id - `job.data.request_id`, when the producer stamped one
 *   trace_id   - the producer's trace, from `job.data.traceContext`
 *
 * Why not the active span's trace id (as the api does): BullMQ emits `failed`
 * after the processor's `context.with(...)` has unwound, so whatever span is
 * active then (a Redis call, an idle poll) belongs to another trace.
 */
import * as Sentry from "@sentry/node";
import {
  extractTraceContext,
  trace,
  type TraceCarrier,
} from "@data-pulse-2/shared/observability/otel";

import { AUDIT_FANOUT_JOB_NAME } from "../../audit/audit-fanout.processor";
import { AUDIT_RETENTION_JOB_NAME } from "../../audit/audit-retention.processor";
import { REPLAY_PURGE_JOB_NAME } from "../../cashier-admissions/replay-purge.processor";
import { EMAIL_JOB_NAMES } from "../../email/email.processor";
import { STOCK_RUN_SWEEP_JOB_NAME } from "../../erpnext-reconciliation/stock-run-sweep.processor";
import { OUTBOX_SALE_PROCESSING_JOB_NAME } from "../../outbox/consumers/sale-captured.consumer";
import { OUTBOX_RETENTION_JOB_NAME } from "../../outbox/retention.processor";
import { SALE_REDRIVE_JOB_NAME } from "../../sales/sale-redrive.processor";
import { sanitizeErrorClass } from "../metrics/worker.metrics";

/** The parts of a BullMQ `Job` this listener reads. A real `Job` satisfies it. */
export interface FailedJobLike {
  readonly name: string;
  readonly data?: unknown;
  readonly attemptsMade: number;
  readonly opts?: { readonly attempts?: number };
}

/** Same name check BullMQ uses to skip retries (`Job.shouldRetryJob`). */
const UNRECOVERABLE_ERROR = "UnrecoverableError";

/** The job names the worker's producers and schedulers use, one queue each. */
export const DECLARED_JOB_NAMES: ReadonlySet<string> = new Set([
  ...Object.values(EMAIL_JOB_NAMES),
  AUDIT_FANOUT_JOB_NAME,
  AUDIT_RETENTION_JOB_NAME,
  OUTBOX_SALE_PROCESSING_JOB_NAME,
  OUTBOX_RETENTION_JOB_NAME,
  STOCK_RUN_SWEEP_JOB_NAME,
  REPLAY_PURGE_JOB_NAME,
  SALE_REDRIVE_JOB_NAME,
]);

const MASKED_JOB_NAME = "[job_name]";
// Start of the first V8 stack frame line.
const STACK_FRAME_LINE = "\n    at ";

/**
 * True when BullMQ will not retry this failure. In bullmq 5.76 `failed` fires
 * after `Job.moveToFailed` has bumped `attemptsMade`, and a retry happens only
 * while `attemptsMade < opts.attempts` (an unset `attempts` means one try).
 * `opts.attempts` already holds the queue's `defaultJobOptions` (5 for the
 * shared `DEFAULT_JOB_OPTIONS`); no queue registers a custom backoff strategy
 * that could stop retries early.
 */
export function isFinalFailure(job: FailedJobLike, error: Error | undefined): boolean {
  if (error?.name === UNRECOVERABLE_ERROR) return true;
  return job.attemptsMade >= Math.max(1, job.opts?.attempts ?? 1);
}

function dataField(data: unknown, key: string): unknown {
  if (typeof data !== "object" || data === null) return undefined;
  return (data as Record<string, unknown>)[key];
}

function isCarrier(value: unknown): value is TraceCarrier {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The producer's trace id from the job's W3C carrier, if it carries one. */
function carrierTraceId(data: unknown): string | undefined {
  const carrier = dataField(data, "traceContext");
  if (!isCarrier(carrier)) return undefined;
  return trace.getSpanContext(extractTraceContext(carrier))?.traceId;
}

/** Tags for one final failure. Undefined values are left out. */
export function failedJobTags(
  queueName: string,
  job: FailedJobLike | undefined,
  error: Error | undefined,
): Record<string, string> {
  const tags: Record<string, string> = {
    queue: queueName,
    error_class: sanitizeErrorClass(error?.constructor.name),
  };
  if (job === undefined) return tags;
  if (DECLARED_JOB_NAMES.has(job.name)) tags["job_name"] = job.name;
  tags["outcome"] = error?.name === UNRECOVERABLE_ERROR ? "unrecoverable" : "exhausted";
  return { ...tags, ...correlationTags(job.data) };
}

/** `request_id` and `trace_id` carried by the job, when present. */
function correlationTags(data: unknown): Record<string, string> {
  const tags: Record<string, string> = {};
  const requestId = dataField(data, "request_id");
  if (typeof requestId === "string") tags["request_id"] = requestId;
  const traceId = carrierTraceId(data);
  if (traceId !== undefined) tags["trace_id"] = traceId;
  return tags;
}

/**
 * Masks one undeclared job name that an error message echoes, in the message
 * and the stack header only. Stack frames are code locations and stay as they
 * are, so a short name (`at`, `/`) cannot break Sentry's frame parsing.
 */
class JobNameMask {
  private readonly name: string;

  private constructor(name: string) {
    this.name = name;
  }

  /** A mask when the job name is undeclared and the message repeats it. */
  static forFailure(job: FailedJobLike | undefined, error: Error): JobNameMask | undefined {
    const name = job?.name;
    if (!name || DECLARED_JOB_NAMES.has(name)) return undefined;
    // A thrown non-Error has no message to mask (the scrubber drops it anyway).
    const message = error instanceof Error ? error.message : "";
    return message.includes(name) ? new JobNameMask(name) : undefined;
  }

  applyTo(error: Error): Error {
    const masked = new Error(this.masked(error.message));
    masked.name = error.name;
    if (error.stack === undefined) delete masked.stack;
    else masked.stack = this.maskedStackHeader(error.stack);
    return masked;
  }

  private maskedStackHeader(stack: string): string {
    const firstFrame = stack.indexOf(STACK_FRAME_LINE);
    if (firstFrame === -1) return this.masked(stack);
    return this.masked(stack.slice(0, firstFrame)) + stack.slice(firstFrame);
  }

  private masked(text: string): string {
    return text.split(this.name).join(MASKED_JOB_NAME);
  }
}

/** The error to report: a masked copy when it echoes an undeclared job name. */
export function reportableError(job: FailedJobLike | undefined, error: Error): Error {
  return JobNameMask.forFailure(job, error)?.applyTo(error) ?? error;
}

/**
 * Listener for one queue's Worker `failed` event. A no-op until the SDK is
 * initialised, and never throws: BullMQ emits synchronously from its failure
 * path, so a throw here would surface inside the worker loop.
 */
export function captureFinalJobFailure(
  queueName: string,
): (job: FailedJobLike | undefined, error: Error) => void {
  return (job, error) => {
    try {
      if (job !== undefined && !isFinalFailure(job, error)) return;
      Sentry.captureException(reportableError(job, error), {
        tags: failedJobTags(queueName, job, error),
      });
    } catch {
      // Telemetry must never break job processing.
    }
  };
}
