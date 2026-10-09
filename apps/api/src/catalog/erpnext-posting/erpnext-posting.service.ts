/**
 * ErpnextPostingService — 015-US1-FEED (T031).
 *
 * The DP2-side read of the fixed 012 posting-feed contract:
 *   - `pullPostings()` — a PURE READ of `pending` `erpnext_posting_status` rows
 *     for the connector principal's tenant, cursor-ordered by the row `sequence`,
 *     each projected into a 012 `PostingWorkItem` (lines carry the DP2-resolved
 *     `erpnextItemRef`). NO status mutation → re-pulling the same `since` cursor
 *     yields the same logical set (012 idempotent replay).
 *
 * The COMPLEMENTARY write — resolving eligibility and inserting the `pending` /
 * `permanently_rejected` row — happens at row CREATION in the worker-side
 * `erpnext.posting.requested` consumer (NOT here, NOT at pull). See
 * `posting-work-item.projection.ts` for the two-moment split.
 *
 * All queries run under the caller's tenant GUC via `runWithTenantContext`
 * (tenant from the connector principal, never the body — §XII); RLS scopes rows.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import { runWithTenantContext } from "@data-pulse-2/db";
import { recordErpnextPostingReconciliation } from "../../observability/metrics/api.metrics";
import {
  buildWorkItem,
  type PostingWorkItem,
} from "./posting-work-item.projection";

/**
 * Hard ceiling on a single pull page — the 012 contract `Limit.maximum` (500),
 * aligning with the 009 backfill ceiling. The contract `default` is 100; the
 * controller applies that default, this caps the upper bound.
 */
export const POSTING_FEED_MAX_PAGE = 500;

/**
 * DP2-side retry budget for `failed_transient` re-offers (012: "bounded by a
 * retry budget"). A `failed_transient` ack re-heads the row's `sequence` so it
 * re-appears on the feed past the connector's advanced cursor; once `retry_count`
 * reaches this ceiling, a further `failed_transient` flips the row to
 * `permanently_rejected` (category `retry_budget_exhausted`) instead of
 * re-offering forever. Tuneable; the actionable end state (a dead-lettered row
 * the 017 reconciliation surface drains) is the contract, not the exact number.
 */
export const POSTING_RETRY_BUDGET = 5;

/** A `posted` ack carries the ERPNext document reference (012 ErpnextDocumentRef). */
export interface AckDocumentRef {
  readonly doctype: string;
  readonly name: string;
}

/** A `permanently_rejected` ack carries a structured reason (012 RejectionReason). */
export interface AckRejectionReason {
  readonly category: string;
  readonly message: string;
}

export type AckOutcomeKind =
  | "posted"
  | "failed_transient"
  | "permanently_rejected";

export interface AckOutcomeInput {
  readonly tenantId: string;
  readonly workItemRef: string;
  readonly outcome: AckOutcomeKind;
  readonly documentRef?: AckDocumentRef;
  readonly reason?: AckRejectionReason;
}

/** The 012 RecordedOutcome wire projection (DP2 → connector). */
export interface RecordedOutcome {
  readonly workItemRef: string;
  readonly outcome: AckOutcomeKind;
  readonly documentRef: AckDocumentRef | null;
  readonly recordedAt: string;
  readonly dlqueued: boolean;
}

export interface AckOutcomeResult {
  readonly outcome: RecordedOutcome;
  /**
   * True when this ack hit the SERVICE-level O-3 echo path (the row was already
   * terminal under the SAME logical outcome) — the controller surfaces it as a
   * 200 with `Idempotent-Replayed: true`. False on a first-time transition (201).
   */
  readonly replayed: boolean;
}

/**
 * The work-item ref does not resolve within the connector principal's tenant
 * scope (RLS returns 0 rows). Non-disclosing — identical for cross-tenant,
 * out-of-scope, and genuinely-absent refs (§II/§XII → 404 `not_found`).
 */
export class AckNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "AckNotFoundError";
  }
}

/**
 * The row is already terminal under a DIFFERENT logical outcome than the one
 * being acked (O-3: the stored document wins; a contradicting re-ack is rejected,
 * never an overwrite). Surfaced as 409 `idempotency_key_conflict`.
 */
export class AckConflictError extends Error {
  constructor() {
    super("idempotency key conflict");
    this.name = "AckConflictError";
  }
}

/**
 * A malformed ack reached the service past the DTO (an internal/direct caller
 * with no `documentRef` on a `posted` outcome). Surfaced as 400 — NOT a 409
 * conflict (a missing conditional field is a validation error, 012). Unreachable
 * over HTTP (the strict DTO guards it); a defensive guard for direct callers.
 */
export class AckValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AckValidationError";
  }
}

/** A posted document_ref is stored as canonical JSON text in the TEXT column. */
function serializeDocRef(doc: AckDocumentRef): string {
  return JSON.stringify({ doctype: doc.doctype, name: doc.name });
}

/** Parse a stored document_ref back to the structured wire shape (null-safe). */
function parseDocRef(stored: string | null): AckDocumentRef | null {
  if (stored === null) return null;
  try {
    const v = JSON.parse(stored) as Partial<AckDocumentRef>;
    if (typeof v.doctype === "string" && typeof v.name === "string") {
      return { doctype: v.doctype, name: v.name };
    }
  } catch {
    // Legacy / non-JSON stored value (e.g. a bare fixture string) — wrap it so
    // the echo still surfaces a structured ref rather than throwing.
    return { doctype: "Sales Invoice", name: stored };
  }
  return { doctype: "Sales Invoice", name: stored };
}

export interface PullPostingsInput {
  readonly tenantId: string;
  /** Opaque cursor — the last `sequence` the connector saw. null = from start. */
  readonly since: bigint | null;
  readonly limit: number;
}

export interface PullPostingsResult {
  readonly items: readonly PostingWorkItem[];
  /** The advanced opaque cursor (the last item's sequence), as a string. */
  readonly cursor: string | null;
  /** Next-page token (the same advanced cursor) when the page was full. */
  readonly nextPageToken: string | null;
}

@Injectable()
export class ErpnextPostingService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Pull a cursor-ordered page of pending posting work-items. Read-only; orders
   * by the monotonic `sequence` (> `since`); caps at `POSTING_FEED_MAX_PAGE`.
   */
  async pullPostings(input: PullPostingsInput): Promise<PullPostingsResult> {
    const limit = Math.min(Math.max(1, input.limit), POSTING_FEED_MAX_PAGE);

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        // Pending rows only, after the `since` cursor, ordered + capped. RLS
        // scopes to the connector principal's tenant; the partial index
        // idx_erpnext_posting_status_pending backs this scan. ORDER BY names the
        // table column: a bare `sequence` would resolve to the ::text alias and
        // sort "10" before "9", advancing the cursor past unsent rows (RT-325).
        const rows = await client.query<{
          id: string;
          kind: "sale_post" | "reversal";
          sale_id: string;
          source_ref_id: string;
          source_system: string;
          external_id: string;
          payload_hash: string;
          sequence: string;
        }>(
          `SELECT id, kind, sale_id, source_ref_id, source_system, external_id,
                  payload_hash, sequence::text AS sequence
             FROM erpnext_posting_status
            WHERE status = 'pending'
              AND ($1::bigint IS NULL OR sequence > $1::bigint)
            ORDER BY erpnext_posting_status.sequence
            LIMIT $2`,
          [input.since !== null ? input.since.toString() : null, limit],
        );

        const items: PostingWorkItem[] = [];
        for (const row of rows.rows) {
          const item = await buildWorkItem(client, {
            id: row.id,
            kind: row.kind,
            saleId: row.sale_id,
            sourceRefId: row.source_ref_id,
            sourceSystem: row.source_system,
            externalId: row.external_id,
            payloadHash: row.payload_hash,
            sequence: row.sequence,
          });
          if (item) items.push(item);
        }

        const advanced =
          rows.rows.length > 0
            ? rows.rows[rows.rows.length - 1]!.sequence
            : null;
        const nextPageToken = rows.rows.length === limit ? advanced : null;

        return { items, cursor: advanced, nextPageToken };
      },
    );
  }

  /**
   * Record a connector posting OUTCOME on `erpnext_posting_status` (the 012
   * `connectorAckOutcome`). NEVER mutates the 008 sale fact (§IX) — only this
   * status row advances. All work runs under the caller's tenant GUC; RLS scopes
   * the row, so a cross-tenant `workItemRef` reads 0 rows → `AckNotFoundError`
   * (non-disclosing, §XII).
   *
   * Lifecycle (only a `pending` row transitions):
   *   - posted             → status='posted' + document_ref (the CHECK biconditional);
   *   - failed_transient   → re-head `sequence` (so the row re-appears on the feed
   *                          past the connector's advanced cursor), retry_count++;
   *                          at `POSTING_RETRY_BUDGET` → permanently_rejected
   *                          (category `retry_budget_exhausted`) — bounded re-offer;
   *   - permanently_rejected → rejection_category stored, dead-lettered (dlqueued).
   *
   * Service-level O-3 idempotency (a FRESH idempotency key re-acking an
   * already-TERMINAL row, which the HTTP interceptor cannot dedupe):
   *   - same logical outcome (e.g. posted + same documentRef) → echo the stored
   *     RecordedOutcome, no re-transition (`replayed: true`);
   *   - a different/contradicting outcome → `AckConflictError` (the stored
   *     document wins; never an overwrite).
   */
  async ackOutcome(input: AckOutcomeInput): Promise<AckOutcomeResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<AckOutcomeResult> => {
        // FOR UPDATE: serialize concurrent acks on the same row (the terminal-
        // state check + transition must be atomic). RLS scopes the row to the
        // tenant; a foreign ref reads nothing.
        const cur = await client.query<{
          status: string;
          document_ref: string | null;
          rejection_category: string | null;
          retry_count: number;
          updated_at: Date;
        }>(
          `SELECT status, document_ref, rejection_category, retry_count, updated_at
             FROM erpnext_posting_status
            WHERE id = $1
            FOR UPDATE`,
          [input.workItemRef],
        );
        const row = cur.rows[0];
        if (!row) throw new AckNotFoundError();

        // --- Already-TERMINAL row (posted / permanently_rejected): O-3 echo or
        // conflict, NO re-transition. `recordedAt` echoes the STORED updated_at
        // so an idempotent re-ack returns a STABLE body (does not drift). ------
        if (row.status === "posted" || row.status === "permanently_rejected") {
          if (this.sameLogicalOutcome(row, input)) {
            return {
              replayed: true,
              outcome: this.project(input.workItemRef, row),
            };
          }
          throw new AckConflictError();
        }

        // --- Re-offerable row (status = 'pending'; a stored 'failed_transient'
        // is never produced by 015 — applyTransient always resets to 'pending' —
        // but is treated as re-offerable too for forward-compat). -------------
        switch (input.outcome) {
          case "posted":
            return {
              replayed: false,
              outcome: await this.applyPosted(client, input),
            };
          case "permanently_rejected":
            return {
              replayed: false,
              outcome: await this.applyRejected(
                client,
                input.workItemRef,
                input.reason?.category ?? "other",
              ),
            };
          case "failed_transient":
            return {
              replayed: false,
              outcome: await this.applyTransient(
                client,
                input.workItemRef,
                row.retry_count,
              ),
            };
        }
      },
    );
  }

  /** True when an already-terminal row matches the incoming ack (O-3 echo). */
  private sameLogicalOutcome(
    row: { status: string; document_ref: string | null; updated_at: Date },
    input: AckOutcomeInput,
  ): boolean {
    if (row.status !== input.outcome) return false;
    if (row.status === "posted") {
      const stored = parseDocRef(row.document_ref);
      return (
        stored !== null &&
        input.documentRef !== undefined &&
        stored.doctype === input.documentRef.doctype &&
        stored.name === input.documentRef.name
      );
    }
    return true; // permanently_rejected same-outcome re-ack — echo
  }

  private async applyPosted(
    client: PoolClient,
    input: AckOutcomeInput,
  ): Promise<RecordedOutcome> {
    if (!input.documentRef) {
      // Defensive — the strict DTO requires documentRef on posted, so this is
      // unreachable over HTTP. A direct caller omitting it is a VALIDATION error
      // (400), not an idempotency conflict (409).
      throw new AckValidationError(
        "documentRef is required when outcome is 'posted'",
      );
    }
    const r = await client.query<{ updated_at: Date }>(
      `UPDATE erpnext_posting_status
          SET status='posted', document_ref=$2, updated_at=now()
        WHERE id=$1
        RETURNING updated_at`,
      [input.workItemRef, serializeDocRef(input.documentRef)],
    );
    return {
      workItemRef: input.workItemRef,
      outcome: "posted",
      documentRef: input.documentRef,
      recordedAt: r.rows[0]!.updated_at.toISOString(),
      dlqueued: false,
    };
  }

  private async applyRejected(
    client: PoolClient,
    workItemRef: string,
    category: string,
  ): Promise<RecordedOutcome> {
    const r = await client.query<{ updated_at: Date }>(
      `UPDATE erpnext_posting_status
          SET status='permanently_rejected', rejection_category=$2, updated_at=now()
        WHERE id=$1
        RETURNING updated_at`,
      [workItemRef, category],
    );
    // §VII reconciliation / DLQ signal — a posting row just dead-lettered. A
    // SIGNAL: it never alters the ack outcome (the row is already updated above).
    recordErpnextPostingReconciliation();
    return {
      workItemRef,
      outcome: "permanently_rejected",
      documentRef: null,
      recordedAt: r.rows[0]!.updated_at.toISOString(),
      dlqueued: true,
    };
  }

  /**
   * `failed_transient`: re-offer the row by re-heading its `sequence` to a fresh
   * (globally-ahead) value so a connector that already advanced its cursor past
   * the old sequence sees the row again — `UPDATE ... SET sequence = DEFAULT`
   * draws `nextval` (the sanctioned exception for a GENERATED ALWAYS identity).
   * Bounded: at `POSTING_RETRY_BUDGET` the row dead-letters instead of looping.
   */
  private async applyTransient(
    client: PoolClient,
    workItemRef: string,
    retryCount: number,
  ): Promise<RecordedOutcome> {
    if (retryCount >= POSTING_RETRY_BUDGET) {
      return this.applyRejected(client, workItemRef, "retry_budget_exhausted");
    }
    const r = await client.query<{ updated_at: Date }>(
      `UPDATE erpnext_posting_status
          SET status='pending', retry_count=retry_count+1,
              sequence=DEFAULT, updated_at=now()
        WHERE id=$1
        RETURNING updated_at`,
      [workItemRef],
    );
    return {
      workItemRef,
      outcome: "failed_transient",
      documentRef: null,
      recordedAt: r.rows[0]!.updated_at.toISOString(),
      dlqueued: false,
    };
  }

  /**
   * Project a stored TERMINAL row into the 012 RecordedOutcome (the O-3 echo
   * path). `recordedAt` echoes the row's STORED `updated_at`, so a repeated
   * idempotent re-ack returns a byte-stable body (the contract's replay
   * guarantee) rather than a fresh wall-clock stamp on each call.
   */
  private project(
    workItemRef: string,
    row: { status: string; document_ref: string | null; updated_at: Date },
  ): RecordedOutcome {
    return {
      workItemRef,
      outcome: row.status as AckOutcomeKind,
      documentRef: parseDocRef(row.document_ref),
      recordedAt: row.updated_at.toISOString(),
      dlqueued: row.status === "permanently_rejected",
    };
  }
}
