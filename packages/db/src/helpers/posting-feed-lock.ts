/**
 * RT-456 (RT-447 F01) — commit-ordered ERPNext posting-feed sequence, per tenant.
 *
 * `erpnext_posting_status.sequence` is a GENERATED ALWAYS identity: Postgres
 * hands the value out when the row is written, not when the transaction
 * commits. The connector's posting feed reads `sequence > $since` and advances
 * its cursor to the last row served, so a row whose LOWER sequence commits
 * AFTER a higher one was served is skipped for good (it stays `pending`, is
 * never re-offered, and no repair path sees it).
 *
 * Every transaction that assigns a posting-feed sequence (the worker's intent
 * insert, the transient-ack re-head, repair and re-resolve) takes this
 * transaction-scoped advisory lock FIRST — before any row lock — and holds it
 * until COMMIT/ROLLBACK. Within a tenant (the feed is tenant-scoped by RLS)
 * sequence order is then commit order, so a snapshot that sees sequence N+1
 * also sees N.
 *
 * Lock order rule: take this lock as the first statement of the transaction.
 * Taking it after a row lock (e.g. the ack's `FOR UPDATE`, or the reversal
 * consumer's `FOR SHARE` on its sale_post row) could deadlock against a
 * transaction that took it first.
 */
import type { PoolClient } from "pg";

/** Advisory-lock key namespace; the tenant id is appended. */
export const POSTING_FEED_LOCK_NAMESPACE = "erpnext-posting-feed";

/** Take the tenant's posting-feed sequence lock for the rest of the transaction. */
export async function lockPostingFeedSequence(
  client: Pick<PoolClient, "query">,
  tenantId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2::text, 0))`,
    [POSTING_FEED_LOCK_NAMESPACE, tenantId],
  );
}
