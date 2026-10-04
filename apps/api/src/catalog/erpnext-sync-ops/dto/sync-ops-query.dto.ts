/**
 * sync-ops-query.dto.ts — Zod query schemas for the 025 read routes.
 *
 * Mirrors the 017 `list-backlog-query.dto` cursor-list convention:
 *   - `store_id`: optional in-scope store filter (uuid; within the session tenant).
 *   - `cursor`: optional opaque numeric pagination token (the last row's `sequence`
 *     for backlog, or an epoch/`started_at`-derived token for runs); unparseable →
 *     400, never a silent from-start.
 *   - `page_size`: optional integer 1..200, default 50 (the contract `PageSize`).
 *
 * Scope (tenant) is NEVER read here — it comes from the dashboard session
 * principal (§XII). `.strict()` rejects unknown query keys (mass-assignment ban),
 * so a smuggled `tenant_id` is a 400. The wire query param is snake_case
 * (`store_id`, `page_size`) per the contract; the DTO maps to camelCase.
 */
import { z } from "zod";

/** Summary route: only an optional store filter. */
export const SyncOpsSummaryQuerySchema = z
  .object({
    store_id: z.string().uuid().optional(),
  })
  .strict();

export type SyncOpsSummaryQuery = z.infer<typeof SyncOpsSummaryQuerySchema>;

/** List routes (posting-backlog, reconciliation-runs): store filter + cursor + page. */
export const SyncOpsListQuerySchema = z
  .object({
    store_id: z.string().uuid().optional(),
    cursor: z
      .string()
      .min(1)
      // Bound to 18 digits — a PG bigint maxes at 19; capping at 18 keeps the
      // `> $cursor::bigint` comparison in range (a too-long cursor is a clean 400,
      // never an unhandled 22003 → 500). Mirrors the 017 backlog DTO.
      .max(18, "cursor exceeds the maximum length")
      .regex(/^[0-9]+$/, "cursor must be an opaque numeric token")
      .optional(),
    page_size: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type SyncOpsListQuery = z.infer<typeof SyncOpsListQuerySchema>;

/**
 * Run-history cursor `<startedAtISO>|<runId>`, exactly as the read-model emits it:
 * `Date#toISOString()` (millisecond precision, `Z`) + `|` + the run UUID.
 */
const RUN_CURSOR_SHAPE =
  /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z)\|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * True when the cursor's timestamp is a real calendar instant (RT-180). The
 * shape regex alone admits `2000-02-30`, month 13, hour 24 or year 0000, which
 * Postgres rejects at `$2::timestamptz` (22007/22008). `Date` normalises an
 * overflowing field (Feb 30 → Mar 1) or returns NaN, so a round trip through
 * `toISOString()` only succeeds for a real instant. Year 0000 round-trips in
 * JS but has no Postgres equivalent, so it is rejected explicitly.
 * A token that fails the shape regex is left to that check's message.
 */
function isRealRunCursorInstant(cursor: string): boolean {
  const match = RUN_CURSOR_SHAPE.exec(cursor);
  if (!match) return true;
  const timestamp = match[1] as string;
  const instant = new Date(timestamp);
  return (
    !Number.isNaN(instant.getTime()) &&
    instant.toISOString() === timestamp &&
    instant.getUTCFullYear() >= 1
  );
}

/**
 * Run-history list: same as the list query but the cursor is a COMPOSITE keyset
 * token `<startedAtISO>|<runId>` (the run table has no monotonic sequence; the
 * cursor pairs the non-unique `started_at` with the unique UUIDv7 `id` for a
 * stable, gap-free page boundary). Validated to that exact shape AND to a real
 * calendar instant — a malformed or out-of-range cursor is a 400, never a silent
 * from-start and never a 500 from the `timestamptz` cast (RT-180).
 */
export const SyncOpsRunListQuerySchema = z
  .object({
    store_id: z.string().uuid().optional(),
    cursor: z
      .string()
      .min(1)
      .max(80, "cursor exceeds the maximum length")
      .regex(RUN_CURSOR_SHAPE, "cursor must be an opaque <timestamp>|<id> token")
      .refine(isRealRunCursorInstant, "cursor timestamp is not a valid instant")
      .optional(),
    page_size: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type SyncOpsRunListQuery = z.infer<typeof SyncOpsRunListQuerySchema>;
