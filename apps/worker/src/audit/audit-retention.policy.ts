/**
 * audit-retention.policy.ts — T311
 *
 * Pure policy functions for the audit retention sweep.
 *
 * This module is stateless and has no imports from NestJS, BullMQ, or any
 * database adapter. It contains only the documented constants and the cutoff
 * computation. Tests can import and exercise these values directly without
 * any framework overhead.
 *
 * Retention policy (decided in audit-retention-decision.md §3):
 *   - Window : 365 days from audit_events.occurred_at
 *   - Action : mark-only (retention_marked_at = now()); no deletion
 *   - Batch  : 1000 rows per UPDATE to keep transactions short
 */

/** Retention window in days (decision record §3). */
export const RETENTION_DAYS = 365;

/** Number of rows processed per UPDATE batch (decision record §7). */
export const BATCH_SIZE = 1000;

/**
 * Compute the retention cutoff for a given reference instant.
 *
 * Returns a Date that is exactly `RETENTION_DAYS` UTC days before `now`.
 * Rows with `occurred_at < computeCutoff(now)` are past the retention window
 * and eligible for marking.
 *
 * The predicate is strict `<` (not `<=`), so a row whose `occurred_at`
 * equals the cutoff is NOT yet eligible — it is evaluated on the next day's
 * sweep when it crosses the boundary.
 *
 * @param now  The reference instant (typically the start of the sweep run).
 * @returns    A new Date exactly RETENTION_DAYS UTC days before `now`.
 */
export function computeCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  return cutoff;
}

// RT-582 probe: worker-only change
