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
 *   job_name   - the job name (a constant per producer)
 *   outcome    - `exhausted` (attempts used up) or `unrecoverable`
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

/** The parts of a BullMQ `Job` this listener reads. A real `Job` satisfies it. */
export interface FailedJobLike {
  readonly name: string;
  readonly data?: unknown;
  readonly attemptsMade: number;
  readonly opts?: { readonly attempts?: number };
}

/** Same name check BullMQ uses to skip retries (`Job.shouldRetryJob`). */
const UNRECOVERABLE_ERROR = "UnrecoverableError";

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
  const tags: Record<string, string> = { queue: queueName };
  if (job === undefined) return tags;
  tags["job_name"] = job.name;
  tags["outcome"] = error?.name === UNRECOVERABLE_ERROR ? "unrecoverable" : "exhausted";
  const requestId = dataField(job.data, "request_id");
  if (typeof requestId === "string") tags["request_id"] = requestId;
  const traceId = carrierTraceId(job.data);
  if (traceId !== undefined) tags["trace_id"] = traceId;
  return tags;
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
      Sentry.captureException(error, { tags: failedJobTags(queueName, job, error) });
    } catch {
      // Telemetry must never break job processing.
    }
  };
}
