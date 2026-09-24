/**
 * T560 (full), T580 (partial) — Outbox repository: claim / deliver / fail / dead-letter.
 *
 * This module provides the four state-machine operations the drainer needs:
 *
 *   claimBatch   — SELECT ... FOR UPDATE SKIP LOCKED → UPDATE to 'claimed', increment attempts
 *   markDelivered — UPDATE delivery_state='delivered', set processed_at
 *   markFailed    — UPDATE delivery_state='failed', set last_error + next_attempt_at (backoff)
 *   markDeadLettered — UPDATE delivery_state='dead_lettered', set processed_at + last_error
 *
 * The claim query is the drainer's SKIP LOCKED claim CTE: attempts incremented inside
 * the same UPDATE so the counter is consistent with the in-flight row state.
 *
 * Drainer RLS pattern (Constitution §II, lifecycle.md §6)
 * -------------------------------------------------------
 * The drainer must claim rows ACROSS tenants. The RLS policy on `outbox_events`
 * allows reads when `app.is_platform_admin = 'true'`. The claim function
 * therefore executes under `{ tenantId: null, isPlatformAdmin: true }` context.
 *
 * State-machine transitions:
 *   pending  → claimed       (claimBatch; attempts += 1)
 *   claimed  → delivered     (markDelivered; processed_at = now())
 *   claimed  → failed        (markFailed; last_error set, next_attempt_at set)
 *   failed   → claimed       (claimBatch re-claims eligible failed rows)
 *   claimed  → dead_lettered (markDeadLettered, when attempts === 8)
 *   claimed  → pending/dead_lettered (reclaimStaleClaims, on expired lease)
 *
 * Backoff schedule (lifecycle.md §4.2):
 *   attempts=1 → now() + 30s   (first failure, wait 30s before retry 2)
 *   attempts=2 → now() + 2min  (wait 2min before retry 3)
 *   attempts=3 → now() + 10min (wait 10min before retry 4)
 *   attempts=4..7 → now() + 1h (plateau — wait 1h before each remaining retry)
 *   attempts=8 → dead-letter   (budget exhausted; caller invokes markDeadLettered)
 *
 * Note: `attempts` is incremented AT CLAIM TIME. After the first claim,
 * `attempts=1`. If that attempt fails → `markFailed(attempts=1)` → wait 30s.
 * After the second claim, `attempts=2`. If that fails → `markFailed(attempts=2)` → wait 2min.
 * After the 8th claim, `attempts=8`. Consumer throws → `markDeadLettered(attempts=8)`.
 *
 * All operations accept an injected `Pool` (no Drizzle ORM — raw `pg` for
 * maximum transparency over the SKIP LOCKED query shape).
 */
import type { Pool, PoolClient } from "pg";
import { runWithTenantContext } from "../middleware/tenant-context";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by the repository's state-transition functions when the precondition
 * for the transition is violated — i.e. the target row is NOT in `claimed`
 * state, the UPDATE matched zero (or more than one) rows, or the caller asked
 * for a transition the budget forbids (e.g. `markFailed` with attempts >=
 * `MAX_ATTEMPTS`).
 *
 * The drainer's safe-mark wrappers catch this, log the error class, and keep
 * polling. The named class is so `Error.name === "OutboxStateTransitionError"`
 * survives the drainer's `extractErrorClass(err)` redaction.
 */
export class OutboxStateTransitionError extends Error {
  override readonly name = "OutboxStateTransitionError";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A claimed outbox event row — the subset of columns the drainer needs to
 * route the event to its consumer.
 */
export interface ClaimedOutboxEvent {
  readonly event_id: string;
  readonly event_type: string;
  readonly tenant_id: string;
  readonly store_id: string | null;
  readonly payload: unknown;
  readonly correlation_id: string | null;
  readonly occurred_at: Date;
  /** attempts has already been incremented by the claim CTE. */
  readonly attempts: number;
}

/** Injected for testability; production callers omit it. */
export type ClaimFn = (client: PoolClient, batchSize: number) => Promise<ClaimedOutboxEvent[]>;

// ---------------------------------------------------------------------------
// Backoff schedule
// ---------------------------------------------------------------------------

/**
 * Compute `next_attempt_at` delay (in ms) for a failed event, given the
 * `attempts` count AFTER the just-completed claim/failure was recorded.
 *
 *   attempts ≤ 1 → 30s    (first failure — wait 30s before the second claim)
 *   attempts = 2 → 2min   (wait before the third claim)
 *   attempts = 3 → 10min  (wait before the fourth claim)
 *   attempts ≥ 4 → 1h     (plateau — applies for retries 5, 6, 7)
 *   attempts = 8 → caller MUST invoke markDeadLettered instead of markFailed
 *                  (markFailed itself throws OutboxStateTransitionError when
 *                  attempts ≥ MAX_ATTEMPTS).
 *
 * Locked by the `nextAttemptDelayMs backoff schedule (unit)` suite in
 * `packages/db/__tests__/outbox/repository-runtime.spec.ts`.
 */
export function nextAttemptDelayMs(attempts: number): number {
  // attempts is the count AFTER the current (failed) claim.
  // We use it to determine how long to wait before the NEXT attempt.
  if (attempts <= 1) return 30_000;          // wait 30s before attempt 2
  if (attempts === 2) return 2 * 60_000;     // wait 2min before attempt 3
  if (attempts === 3) return 10 * 60_000;    // wait 10min before attempt 4
  return 60 * 60_000;                        // plateau — wait 1h for attempts 4..7
}

/** Max attempts before dead-lettering. */
export const MAX_ATTEMPTS = 8;

// ---------------------------------------------------------------------------
// claimBatch — FOR UPDATE SKIP LOCKED
// ---------------------------------------------------------------------------

/**
 * Claim up to `batchSize` pending/failed-eligible rows atomically.
 *
 * Executes under a platform-admin context so the RLS policy allows the drainer
 * to see rows across all tenants. The UPDATE increments `attempts` in the
 * same CTE as the SELECT, ensuring the counter is accurate for the current
 * processing attempt before the consumer sees the row.
 *
 * The claim CTE pattern (drainer-design.md §2):
 *   1. Inner SELECT picks claimable rows (state IN ('pending','failed') AND
 *      next_attempt_at IS NULL OR <= now()) ordered by occurred_at ASC FOR
 *      UPDATE SKIP LOCKED LIMIT $batchSize.
 *   2. Outer UPDATE sets delivery_state='claimed', attempts+=1, claimed_at=now().
 *   3. RETURNING gives the drainer the data it needs to dispatch consumers.
 */
export async function claimBatch(
  pool: Pool,
  batchSize = 50,
): Promise<ClaimedOutboxEvent[]> {
  assertPositiveBatchSize(batchSize);
  return runWithTenantContext(
    pool,
    { tenantId: null, isPlatformAdmin: true },
    async (client) => {
      return _claimBatchOnClient(client, batchSize);
    },
  );
}

/** Recover expired claims in bounded batches. Attempts remain unchanged until re-claim. */
export async function reclaimStaleClaims(
  pool: Pool,
  leaseMs: number,
  batchSize = 50,
): Promise<number> {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new RangeError('reclaimStaleClaims: leaseMs must be a positive integer');
  }
  assertPositiveBatchSize(batchSize);
  return runWithTenantContext(
    pool,
    { tenantId: null, isPlatformAdmin: true },
    async (client) => {
      const res = await client.query(
        `WITH stale AS (
           SELECT event_id FROM outbox_events
            WHERE delivery_state = 'claimed'
              AND (claimed_at IS NULL OR claimed_at <= now() - ($1::bigint * interval '1 millisecond'))
            ORDER BY claimed_at NULLS FIRST
            LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         UPDATE outbox_events AS o
            SET delivery_state = CASE WHEN o.attempts >= $3 THEN 'dead_lettered' ELSE 'pending' END,
                processed_at = CASE WHEN o.attempts >= $3 THEN now() ELSE NULL END,
                claimed_at = NULL,
                last_error = 'ClaimLeaseExpired',
                updated_at = now()
           FROM stale WHERE o.event_id = stale.event_id`,
        [leaseMs, batchSize, MAX_ATTEMPTS],
      );
      return res.rowCount ?? 0;
    },
  );
}

/** Renew only the current claim generation; a reclaimed attempt cannot renew. */
export async function heartbeatClaim(pool: Pool, eventId: string, attempts: number): Promise<boolean> {
  return runWithTenantContext(
    pool,
    { tenantId: null, isPlatformAdmin: true },
    async (client) => {
      const res = await client.query(
        `UPDATE outbox_events SET claimed_at = now(), updated_at = now()
          WHERE event_id = $1 AND delivery_state = 'claimed' AND attempts = $2`,
        [eventId, attempts],
      );
      return res.rowCount === 1;
    },
  );
}

/**
 * Validate `batchSize` at the function boundary.
 *
 * Postgres's `LIMIT` rejects non-positive integers and `LIMIT NaN` is a
 * parse error, but failing fast with a clear JS error is much more
 * debuggable than a downstream `invalid input syntax` message that
 * surfaces inside the claim CTE under a wrapped runWithTenantContext.
 *
 * Throwing `RangeError` (a built-in) makes the cause obvious without
 * adding a new error class to the public surface for a guard-rail.
 */
function assertPositiveBatchSize(batchSize: number): void {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(
      `claimBatch: batchSize must be a positive integer, got ${String(batchSize)}.`,
    );
  }
}

/**
 * Internal: runs the claim CTE on an already-open, context-set `PoolClient`.
 *
 * Kept module-private — no consumer outside this file calls it. The
 * previous `export` made it part of `packages/db`'s public surface and
 * obligated us to maintain its signature for downstream callers; nothing
 * actually used it. Unit tests of the claim CTE shape go through
 * `claimBatch(pool, batchSize)` and rely on a real Pool (Testcontainers).
 */
async function _claimBatchOnClient(
  client: PoolClient,
  batchSize: number,
): Promise<ClaimedOutboxEvent[]> {
  const res = await client.query<{
    event_id: string;
    event_type: string;
    tenant_id: string;
    store_id: string | null;
    payload: unknown;
    correlation_id: string | null;
    occurred_at: Date;
    attempts: number;
  }>(
    `WITH claimed AS (
       UPDATE outbox_events
          SET delivery_state = 'claimed',
              attempts       = attempts + 1,
              claimed_at     = now(),
              updated_at     = now()
        WHERE event_id IN (
          SELECT event_id
            FROM outbox_events
           WHERE delivery_state IN ('pending', 'failed')
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           ORDER BY occurred_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
       RETURNING
          event_id,
          event_type,
          tenant_id,
          store_id,
          payload,
          correlation_id,
          occurred_at,
          attempts
     )
     SELECT * FROM claimed`,
    [batchSize],
  );

  return res.rows.map((r) => ({
    event_id: r.event_id,
    event_type: r.event_type,
    tenant_id: r.tenant_id,
    store_id: r.store_id,
    payload: r.payload,
    correlation_id: r.correlation_id,
    occurred_at: r.occurred_at,
    attempts: r.attempts,
  }));
}

// ---------------------------------------------------------------------------
// markDelivered
// ---------------------------------------------------------------------------

/**
 * Transition a claimed row to `delivered`. Sets `processed_at = now()`.
 *
 * Strict mode (state-machine invariant)
 * -------------------------------------
 * The UPDATE matches only rows whose current `delivery_state = 'claimed'`.
 * If the affected row count is not exactly 1, the function throws
 * `OutboxStateTransitionError`. Reasons that could trigger this:
 *   - someone else transitioned the row (delivered/failed/dead_lettered)
 *   - the row was deleted (retention purge)
 *   - the row never existed (caller programming error)
 *
 * Executed under platform-admin context so the drainer can update any tenant's row.
 * `last_error` is NOT cleared — it retains the last-known failure class for audit
 * context (per Slice 1A schema intent).
 */
export async function markDelivered(pool: Pool, eventId: string, attempts: number): Promise<void> {
  await runWithTenantContext(
    pool,
    { tenantId: null, isPlatformAdmin: true },
    async (client) => {
      const res = await client.query(
        `UPDATE outbox_events
            SET delivery_state = 'delivered',
                processed_at   = now(),
                claimed_at     = NULL,
                updated_at     = now()
          WHERE event_id = $1
            AND delivery_state = 'claimed' AND attempts = $2`,
        [eventId, attempts],
      );
      assertSingleRow(res.rowCount, "markDelivered", eventId);
    },
  );
}

// ---------------------------------------------------------------------------
// markFailed
// ---------------------------------------------------------------------------

/**
 * Transition a claimed row to `failed`. Sets `last_error` (redacted error class
 * only — never the full exception string, never PII) and schedules `next_attempt_at`
 * per the backoff schedule.
 *
 * Strict mode (state-machine invariants)
 * --------------------------------------
 * 1. Rejects `attempts >= MAX_ATTEMPTS` — the budget is exhausted at that
 *    point and the caller MUST invoke `markDeadLettered` instead. Throwing
 *    here is defence in depth in case the drainer's routing logic regresses.
 * 2. The UPDATE matches only rows whose current `delivery_state = 'claimed'`.
 *    Throws `OutboxStateTransitionError` if the affected row count is not
 *    exactly 1 (someone else moved the row, retention purged it, or the
 *    event_id never existed).
 */
export async function markFailed(
  pool: Pool,
  eventId: string,
  attempts: number,
  errorClass: string,
): Promise<void> {
  if (attempts >= MAX_ATTEMPTS) {
    throw new OutboxStateTransitionError(
      `markFailed: attempts=${attempts} has reached MAX_ATTEMPTS=${MAX_ATTEMPTS}; ` +
        `caller must invoke markDeadLettered. event_id=${eventId}`,
    );
  }

  const delayMs = nextAttemptDelayMs(attempts);
  const nextAttemptAt = new Date(Date.now() + delayMs);

  await runWithTenantContext(
    pool,
    { tenantId: null, isPlatformAdmin: true },
    async (client) => {
      const res = await client.query(
        `UPDATE outbox_events
            SET delivery_state  = 'failed',
                last_error      = $2,
                next_attempt_at = $3,
                claimed_at     = NULL,
                updated_at      = now()
          WHERE event_id = $1
            AND delivery_state = 'claimed' AND attempts = $4`,
        [eventId, errorClass, nextAttemptAt.toISOString(), attempts],
      );
      assertSingleRow(res.rowCount, "markFailed", eventId);
    },
  );
}

// ---------------------------------------------------------------------------
// markDeadLettered
// ---------------------------------------------------------------------------

/**
 * Transition a claimed row to `dead_lettered`. Sets `processed_at = now()`.
 *
 * Strict mode: matches only `delivery_state = 'claimed'`. Throws
 * `OutboxStateTransitionError` if the row count is not exactly 1.
 *
 * Called when `attempts` reaches `MAX_ATTEMPTS` (8) — the retry budget is
 * exhausted. The row remains in the table for 365-day retention (lifecycle.md
 * §3). No 9th claim will be made.
 */
export async function markDeadLettered(
  pool: Pool,
  eventId: string,
  errorClass: string,
  attempts: number,
): Promise<void> {
  await runWithTenantContext(
    pool,
    { tenantId: null, isPlatformAdmin: true },
    async (client) => {
      const res = await client.query(
        `UPDATE outbox_events
            SET delivery_state = 'dead_lettered',
                last_error     = $2,
                processed_at   = now(),
                claimed_at     = NULL,
                updated_at     = now()
          WHERE event_id = $1
            AND delivery_state = 'claimed' AND attempts = $3`,
        [eventId, errorClass, attempts],
      );
      assertSingleRow(res.rowCount, "markDeadLettered", eventId);
    },
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strict-mode invariant for the three state-transition functions: the UPDATE
 * must have matched exactly one row. Zero rows means the precondition failed
 * (row not in `claimed` state, deleted, or never existed). More than one is
 * impossible because `event_id` is the PRIMARY KEY, but we still assert it
 * defensively.
 */
function assertSingleRow(
  rowCount: number | null,
  op: "markDelivered" | "markFailed" | "markDeadLettered",
  eventId: string,
): void {
  if (rowCount === 1) return;
  throw new OutboxStateTransitionError(
    `${op}: expected exactly 1 'claimed' row for event_id=${eventId}, ` +
      `UPDATE affected ${rowCount ?? 0}. Row is not in 'claimed' state, ` +
      `was deleted, or never existed.`,
  );
}

// ===========================================================================
// T591 -- read-only dead-letter triage queries (slice 1C-C1).
// ===========================================================================
//
// Two functions back the read-only admin endpoint:
//   - listDeadLettered : list page with optional filters + opaque cursor
//   - getDeadLettered  : single-row detail; returns null when the event
//                        exists but is NOT in dead_lettered state (the
//                        controller maps null -> 404).
//
// Design contract
// ---------------
//   * Both run under runWithTenantContext({ tenantId: null, isPlatformAdmin
//     : true }) -- mirrors claimBatch / retention queries. The runtime
//     DB role does NOT bypass RLS (Constitution II); the GUC is the
//     allowed escape hatch.
//   * Both SELECT an explicit allowlist of columns -- NEVER `*`, NEVER
//     `payload`. The dead-letter triage doc lists the allowlist; the
//     `OutboxDeadLetterRecord` interface mirrors it 1:1.
//   * Both pin `delivery_state = 'dead_lettered'` in the predicate.
//   * Detail returns `null` (not throwing) when the row is in any other
//     state -- the controller translates that to 404. Behavioural intent
//     (dead-letter triage, not generic event lookup) is encoded in the
//     SQL predicate, not in the controller.
//   * `last_error` is projected verbatim from the column; the column
//     already stores only the redacted error class (T551/T552 spike
//     evidence + markFailed/markDeadLettered signatures accept a
//     `errorClass: string`). The API layer maps it to `last_error_class`
//     and re-validates with `sanitizeLastErrorClass` as defence-in-depth.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The strict allowlist of columns the dead-letter triage endpoint may
 * return. Matches docs/outbox/dead-letter-triage.md section 4.1.
 *
 * NEVER includes `payload`. NEVER includes the unredacted `last_error`
 * string -- the public field name `last_error_class` makes the contract
 * explicit, even though the column itself is named `last_error`.
 */
export interface OutboxDeadLetterRecord {
  readonly event_id: string;
  readonly event_type: string;
  readonly tenant_id: string;
  readonly store_id: string | null;
  readonly delivery_state: "dead_lettered";
  readonly attempts: number;
  readonly correlation_id: string | null;
  /**
   * Redacted error-class identifier. Null when the column was never set
   * OR when sanitisation rejected the stored value as unsafe (defence-
   * in-depth -- the column SHOULD only contain class identifiers).
   */
  readonly last_error_class: string | null;
  readonly occurred_at: Date;
  /**
   * Microsecond-precision UTC text projection of `occurred_at`, produced
   * by `to_char(... AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.
   *
   * Why this field exists: JS `Date` (and `Date.toISOString()`) operate
   * at millisecond resolution. Postgres `timestamptz` is microsecond-
   * precision, so two dead-letters seeded inside the same millisecond
   * bucket but at distinct microseconds are indistinguishable through
   * `occurred_at`. The cursor codec (`admin.query.schema.ts`) carries
   * this string verbatim so keyset pagination never gaps or duplicates
   * rows whose ms-truncated timestamps collide.
   */
  readonly occurred_at_text: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly processed_at: Date | null;
}

/**
 * Opaque pagination cursor. Encoded base64url by the controller as
 * `<occurredAtText>|<eventId>` -- the repository receives the decoded
 * tuple. The timestamp is a verbatim microsecond-precision text token
 * (NOT a JS `Date`) so the keyset predicate can compare via
 * `$N::timestamptz` without truncating to milliseconds.
 *
 * Note: this is intentionally tighter than the audit endpoint's cursor,
 * which still uses Date-precision. Dead-letter triage is operator-
 * scoped and benefits from deterministic ordering across sub-ms
 * timestamps; the audit endpoint will be tightened in a future pass.
 */
export interface OutboxDeadLetterCursor {
  readonly occurredAtText: string;
  readonly eventId: string;
}

export interface ListDeadLetteredInput {
  readonly eventType?: string;
  readonly tenantId?: string;
  readonly cursor?: OutboxDeadLetterCursor;
  /**
   * The caller is expected to pass `userLimit + 1` so the service can
   * detect end-of-page in one round trip. The repository does NOT add
   * the `+1` itself -- mirrors the audit repository contract.
   */
  readonly limit: number;
}

// ---------------------------------------------------------------------------
// last_error sanitisation
// ---------------------------------------------------------------------------

/**
 * Whitelist regex for a safe error-class identifier.
 *
 * Pattern intent: a bare TypeScript/JS class name -- letters, digits,
 * underscores, optionally followed by dotted namespaces (e.g.
 * `OutboxStateTransitionError`, `pg.QueryError`). NO whitespace, NO
 * quotes, NO braces, NO punctuation that could hint at a payload echo.
 *
 * Length cap (80 chars) prevents pathological inputs from leaking
 * size-side-channel info; class names in this repo are well under 60.
 */
const SAFE_ERROR_CLASS_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const SAFE_ERROR_CLASS_MAX_LEN = 80;

/**
 * Defensive sanitiser. The column SHOULD only ever contain a bare
 * class identifier (enforced by `markFailed` / `markDeadLettered`
 * signatures), but if a future code path regresses and stores a raw
 * exception string, this function refuses to leak it.
 *
 *   - null / undefined            -> null
 *   - non-string                  -> null
 *   - empty string                -> null
 *   - leading/trailing whitespace -> null (NOT trim-then-accept; a
 *     well-behaved producer never adds whitespace, so any whitespace
 *     is a red flag)
 *   - longer than the length cap  -> null
 *   - unsafe chars / quotes / braces / inner whitespace -> null
 *   - matches SAFE_ERROR_CLASS_RE -> the ORIGINAL value (untouched)
 *
 * Returning `null` (rather than a sentinel like "RedactedError") avoids
 * implying "an error class was here but we hid it" -- the absence is
 * already the contract. Strict equality `value !== value.trim()` is the
 * whitespace check (rather than trim-then-test) because we want to
 * reject -- not silently repair -- a column that should never have had
 * whitespace in the first place.
 */
export function sanitizeLastErrorClass(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  if (value.length === 0) return null;
  // Reject leading/trailing whitespace explicitly -- a well-behaved
  // producer (markFailed / markDeadLettered) never inserts it; presence
  // means the column was set via an out-of-band path that bypassed the
  // class-name contract, so we refuse to leak it.
  if (value !== value.trim()) return null;
  if (value.length > SAFE_ERROR_CLASS_MAX_LEN) return null;
  if (!SAFE_ERROR_CLASS_RE.test(value)) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Shared column-list -- the allowlist projected from `outbox_events`.
// ---------------------------------------------------------------------------
//
// Centralised so a future column addition (or removal) cannot accidentally
// leak through one of the two functions. The SELECT clause is byte-for-byte
// identical in list + detail; reviewers can audit a single string.
const DEAD_LETTER_COLUMNS = `
  event_id,
  event_type,
  tenant_id,
  store_id,
  delivery_state,
  attempts,
  correlation_id,
  last_error,
  occurred_at,
  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_text,
  created_at,
  updated_at,
  processed_at
`;

// Row shape that node-pg returns for the projection above. `last_error`
// is the raw column; the row mapper sanitises it into `last_error_class`.
// `occurred_at_text` is the microsecond-precision UTC projection used
// for keyset cursors -- node-pg returns it as a plain string because
// `to_char()` produces `text`, not `timestamptz` (the type oid the pg
// type-parser would convert to a JS `Date`).
interface DeadLetterDbRow {
  event_id: string;
  event_type: string;
  tenant_id: string;
  store_id: string | null;
  delivery_state: string; // always 'dead_lettered' -- predicate enforces it
  attempts: number;
  correlation_id: string | null;
  last_error: string | null;
  occurred_at: Date;
  occurred_at_text: string;
  created_at: Date;
  updated_at: Date;
  processed_at: Date | null;
}

function mapRow(row: DeadLetterDbRow): OutboxDeadLetterRecord {
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    tenant_id: row.tenant_id,
    store_id: row.store_id,
    delivery_state: "dead_lettered" as const,
    attempts: row.attempts,
    correlation_id: row.correlation_id,
    last_error_class: sanitizeLastErrorClass(row.last_error),
    occurred_at: row.occurred_at,
    occurred_at_text: row.occurred_at_text,
    created_at: row.created_at,
    updated_at: row.updated_at,
    processed_at: row.processed_at,
  };
}

// ---------------------------------------------------------------------------
// listDeadLettered
// ---------------------------------------------------------------------------

/**
 * Page through dead-lettered rows under platform-admin context.
 *
 * Ordering: `occurred_at DESC, event_id DESC` -- newest dead-letter first
 * (operator-friendly default; matches the typical alerting flow where the
 * most-recent failure is what the operator is paging on). `event_id` is
 * the deterministic tie-breaker for non-unique `occurred_at` values.
 *
 * Pagination: keyset on the same tuple. When a cursor is supplied, the
 * predicate is `(occurred_at, event_id) < (cursor.occurredAt, cursor.eventId)`
 * -- strict less-than so the cursor row itself is NOT re-emitted.
 *
 * RLS: the runtime DB role does NOT bypass RLS. The query runs under
 * `runWithTenantContext({ tenantId: null, isPlatformAdmin: true })` which
 * activates the `is_platform_admin = 'true'` OR-branch of the
 * `outbox_events_tenant_isolation` policy from migration 0006.
 *
 * No row locks. This is a read-only SELECT -- it MUST NOT block the
 * drainer worker's `FOR UPDATE SKIP LOCKED` claim path.
 */
export async function listDeadLettered(
  pool: Pool,
  input: ListDeadLetteredInput,
): Promise<OutboxDeadLetterRecord[]> {
  assertPositiveBatchSize(input.limit);

  return runWithTenantContext(
    pool,
    { tenantId: null, isPlatformAdmin: true },
    async (client) => {
      // Build the WHERE clause + parameter list incrementally so optional
      // filters never appear as `... AND NULL = NULL` (which would silently
      // match nothing). Each conditional appends to the same parameter list.
      // Two predicates ALWAYS apply, regardless of filters:
      //   1. `delivery_state = 'dead_lettered'` -- the endpoint contract
      //      is dead-letter triage; other states surface as a 404.
      //   2. `processed_at IS NOT NULL` -- CodeRabbit review on PR #240.
      //      `markDeadLettered` sets `processed_at = now()` as part of
      //      the transition, so every dead-lettered row in production
      //      should already have it set; the predicate is defence in
      //      depth against a future code path (e.g. a manual UPDATE or
      //      a backfill script) that could leave `processed_at` NULL.
      //      The OpenAPI documents `processed_at` as non-null for rows
      //      returned by this endpoint, so the contract is encoded in
      //      the SQL.
      const where: string[] = [
        "delivery_state = 'dead_lettered'",
        "processed_at IS NOT NULL",
      ];
      const params: unknown[] = [];

      if (input.eventType !== undefined) {
        params.push(input.eventType);
        where.push(`event_type = $${params.length}`);
      }
      if (input.tenantId !== undefined) {
        params.push(input.tenantId);
        where.push(`tenant_id = $${params.length}::uuid`);
      }
      if (input.cursor !== undefined) {
        // Keyset predicate on the (occurred_at, event_id) tuple.
        // Postgres supports row-value comparisons directly, but the
        // explicit OR-form makes the index choice unambiguous for the
        // planner and easier to read.
        //
        // The cursor's `occurredAtText` is a verbatim microsecond-
        // precision timestamptz literal (e.g. `2026-05-19T10:00:00.123456Z`)
        // produced by the row mapper's `to_char(... AT TIME ZONE 'UTC', ...)`
        // projection. We hand it to Postgres as a string and let the
        // `::timestamptz` cast parse it -- this preserves full µs
        // precision, unlike going through a JS `Date`.
        params.push(input.cursor.occurredAtText);
        const occIdx = params.length;
        params.push(input.cursor.eventId);
        const idIdx = params.length;
        where.push(
          `(occurred_at < $${occIdx}::timestamptz OR (occurred_at = $${occIdx}::timestamptz AND event_id < $${idIdx}::uuid))`,
        );
      }

      params.push(input.limit);
      const limitIdx = params.length;

      const sql = `
        SELECT ${DEAD_LETTER_COLUMNS}
          FROM outbox_events
         WHERE ${where.join(" AND ")}
         ORDER BY occurred_at DESC, event_id DESC
         LIMIT $${limitIdx}
      `;

      const res = await client.query<DeadLetterDbRow>(sql, params);
      return res.rows.map(mapRow);
    },
  );
}

// ---------------------------------------------------------------------------
// getDeadLettered
// ---------------------------------------------------------------------------

/**
 * Fetch a single dead-lettered row by `event_id`. Returns `null` when:
 *   - the row does not exist, OR
 *   - the row exists but is in a state OTHER than `dead_lettered`.
 *
 * Both cases are externally indistinguishable by design (FR-ISO-4-style
 * symmetry): an operator querying for a delivered/pending row gets the
 * same 404 they would get for a non-existent UUID. This narrows the
 * endpoint's contract to "dead-letter triage" rather than "generic
 * event lookup".
 *
 * Runs under platform-admin context, same as listDeadLettered.
 */
export async function getDeadLettered(
  pool: Pool,
  eventId: string,
): Promise<OutboxDeadLetterRecord | null> {
  return runWithTenantContext(
    pool,
    { tenantId: null, isPlatformAdmin: true },
    async (client) => {
      // `processed_at IS NOT NULL` mirrors the list query's guard --
      // see CodeRabbit review on PR #240 + list predicate above. The
      // OpenAPI documents `processed_at` as non-null for any row this
      // endpoint returns, so the contract is encoded in SQL rather
      // than relying on application invariants.
      const res = await client.query<DeadLetterDbRow>(
        `SELECT ${DEAD_LETTER_COLUMNS}
           FROM outbox_events
          WHERE event_id = $1::uuid
            AND delivery_state = 'dead_lettered'
            AND processed_at IS NOT NULL
          LIMIT 1`,
        [eventId],
      );
      const row = res.rows[0];
      return row ? mapRow(row) : null;
    },
  );
}
