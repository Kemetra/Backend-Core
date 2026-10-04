/**
 * ErpnextSyncOpsReadModelService — 025 read-model (compute-on-read).
 *
 * Reads 015 `erpnext_posting_status` + 017 `erpnext_reconciliation_run`/`_result`
 * in place (READ-NOT-MIRROR), tenant-scoped under `runWithTenantContext`
 * (RLS fail-closed). No write, no new table. The 020 connector_health + 021
 * product_master domains are reported `not_available` (forward-compat stub) until
 * those specs ship. The 015/017 source tables carry NO money/valuation column, so
 * this read-model surfaces none.
 *
 * RT-192: every read is bound to the caller's membership store scope (the 017
 * reconciliation surface's rule, `context/operator-store-scope.ts`). The source
 * tables carry tenant-only RLS, so the scope is a SQL filter here; a `store_id`
 * outside it is the contract's non-disclosing 404.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import { MembershipRepository } from "../../context/membership.repository";
import type { StoreScope } from "../../context/store-scope";
import type { ResolvedContext } from "../../context/types";
import {
  callerStoreScope,
  inStoreScope,
  scopeStoreIds,
} from "../../context/operator-store-scope";

/** A sync-ops domain rollup (wire shape — mirrors the contract `DomainSummary`). */
export interface DomainSummary {
  readonly domain:
    | "posting"
    | "reconciliation"
    | "connector_health"
    | "product_master";
  readonly status: "ok" | "attention" | "not_available";
  readonly headlineCount: number | null;
  readonly detail: string | null;
}

export interface SyncOpsSummaryBody {
  readonly domains: readonly DomainSummary[];
}

/** The session context of a read; its store scope bounds the rows (RT-192). */
export interface ScopedReadInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
}

export interface SummaryInput extends ScopedReadInput {
  readonly storeId?: string;
}

/** US2 — one dead-letter backlog row (wire shape; mirrors the contract). */
export interface PostingBacklogItem {
  readonly postingStatusId: string;
  readonly kind: string;
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly status: "permanently_rejected";
  readonly rejectionClass: string | null;
  readonly deadLetteredAt: string;
}

/** US3 — one reconciliation run (wire shape; mirrors the contract). */
export interface ReconciliationRunView {
  readonly runId: string;
  readonly storeId: string;
  readonly kind: string;
  readonly trigger: string;
  readonly status: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly mismatchSummary: Record<string, number> | null;
}

export interface ListInput extends ScopedReadInput {
  readonly storeId?: string;
  readonly cursor: bigint | null;
  readonly limit: number;
}

/** Run-history uses a composite string cursor (`<startedAtISO>|<runId>`). */
export interface RunListInput extends ScopedReadInput {
  readonly storeId?: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

const LIST_MAX_PAGE = 200;

/** Thrown when a supplied `store_id` is not in the session tenant's scope. */
export class StoreNotInScopeError extends Error {
  constructor() {
    super("Store not found");
    this.name = "StoreNotInScopeError";
  }
}

@Injectable()
export class ErpnextSyncOpsReadModelService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /**
   * Assert a supplied `store_id` is one of the operator's accessible stores: in
   * the caller's membership store scope (RT-192) and in the session tenant (RLS —
   * a cross-tenant id returns no row). Otherwise `StoreNotInScopeError` (→
   * non-disclosing 404, FR-009/SC-002). A null storeId (no filter) is always in
   * scope. Call before any store-filtered read.
   */
  async assertStoreInScope(input: ScopedReadInput & { readonly storeId?: string }): Promise<void> {
    const { storeId } = input;
    if (!storeId) return;
    const found = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        if (!inStoreScope(await this.scopeOf(client, input), storeId)) return false;
        const r = await client.query<{ id: string }>(
          `SELECT id FROM stores WHERE id = $1::uuid`,
          [storeId],
        );
        return r.rows.length > 0;
      },
    );
    if (!found) throw new StoreNotInScopeError();
  }

  /**
   * US1 — the consolidated sync-ops summary. Aggregates 015 posting health
   * (dead-letter backlog count) + 017 reconciliation health (latest run + open
   * mismatch count); 020/021 are `not_available`. Tenant-scoped via RLS; optional
   * store filter. Compute-on-read — no mirror.
   */
  async getSummary(input: SummaryInput): Promise<SyncOpsSummaryBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        const storeId = input.storeId ?? null;
        const scoped = scopeStoreIds(await this.scopeOf(client, input));

        // --- posting health: dead-letter backlog size (015) -----------------
        const posting = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM erpnext_posting_status
            WHERE status = 'permanently_rejected'
              AND ($1::uuid IS NULL OR store_id = $1::uuid)
              AND ($2::uuid[] IS NULL OR store_id = ANY($2::uuid[]))`,
          [storeId, scoped],
        );
        const postingBacklog = Number(posting.rows[0]?.count ?? "0");

        // --- reconciliation health: open mismatch count + latest run (017) --
        // Store-scoped via a JOIN to the run (the result table has no store_id;
        // results are store-scoped through their run) — so a store-filtered
        // summary's mismatch count reflects only that store's slice (spec US1
        // acceptance scenario 3), consistent with the posting + latestRun legs.
        const openMismatches = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM erpnext_reconciliation_result r
             JOIN erpnext_reconciliation_run run ON run.id = r.run_id
            WHERE r.result_state = 'open'
              AND ($1::uuid IS NULL OR run.store_id = $1::uuid)
              AND ($2::uuid[] IS NULL OR run.store_id = ANY($2::uuid[]))`,
          [storeId, scoped],
        );
        const openMismatchCount = Number(openMismatches.rows[0]?.count ?? "0");

        const latestRun = await client.query<{
          status: string;
          started_at: string;
        }>(
          `SELECT status, started_at
             FROM erpnext_reconciliation_run
            WHERE ($1::uuid IS NULL OR store_id = $1::uuid)
              AND ($2::uuid[] IS NULL OR store_id = ANY($2::uuid[]))
            ORDER BY started_at DESC
            LIMIT 1`,
          [storeId, scoped],
        );
        const latest = latestRun.rows[0] ?? null;

        const domains: DomainSummary[] = [
          {
            domain: "posting",
            status: postingBacklog > 0 ? "attention" : "ok",
            headlineCount: postingBacklog,
            detail:
              postingBacklog > 0
                ? `${postingBacklog} posting(s) in the dead-letter backlog`
                : "No posting dead-letters",
          },
          {
            domain: "reconciliation",
            // Attention when there are open mismatches OR the latest run failed —
            // a failed run with zero recorded mismatches still needs operator eyes
            // (it produced no report), so count-only would mislead.
            status:
              openMismatchCount > 0 || latest?.status === "failed"
                ? "attention"
                : "ok",
            headlineCount: openMismatchCount,
            detail: latest
              ? `Latest run ${latest.status}`
              : "No reconciliation runs yet",
          },
          // 020/021 forward-compat stub — not yet built.
          {
            domain: "connector_health",
            status: "not_available",
            headlineCount: null,
            detail: "Connector health (020) not yet available",
          },
          {
            domain: "product_master",
            status: "not_available",
            headlineCount: null,
            detail: "Product-master reconciliation (021) not yet available",
          },
        ];

        return { domains };
      },
    );
  }

  /**
   * US2 — the posting dead-letter backlog (a read-projection over 015
   * `erpnext_posting_status` WHERE status='permanently_rejected'). Cursor on the
   * `sequence` (single global IDENTITY); newest scanned in `sequence` order so the
   * cursor is stable + gap-free. No new DB index (SC-007 — the existing pending
   * index does not back this scan; report-only perf note).
   */
  async listPostingBacklog(input: ListInput): Promise<Page<PostingBacklogItem>> {
    const limit = Math.min(Math.max(1, input.limit), LIST_MAX_PAGE);
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        const scoped = scopeStoreIds(await this.scopeOf(client, input));
        const rows = await client.query<{
          id: string;
          kind: string;
          source_system: string;
          external_id: string;
          rejection_category: string | null;
          updated_at: string;
          sequence: string;
        }>(
          `SELECT id, kind, source_system, external_id, rejection_category,
                  updated_at, sequence::text AS sequence
             FROM erpnext_posting_status
            WHERE status = 'permanently_rejected'
              AND ($1::bigint IS NULL OR sequence > $1::bigint)
              AND ($2::uuid IS NULL OR store_id = $2::uuid)
              AND ($4::uuid[] IS NULL OR store_id = ANY($4::uuid[]))
            ORDER BY sequence
            LIMIT $3`,
          [
            input.cursor !== null ? input.cursor.toString() : null,
            input.storeId ?? null,
            limit,
            scoped,
          ],
        );
        const items: PostingBacklogItem[] = rows.rows.map((r) => ({
          postingStatusId: r.id,
          kind: r.kind,
          sourceSystem: r.source_system,
          externalId: r.external_id,
          status: "permanently_rejected",
          rejectionClass: r.rejection_category,
          deadLetteredAt: new Date(r.updated_at).toISOString(),
        }));
        const nextCursor =
          rows.rows.length === limit
            ? rows.rows[rows.rows.length - 1]!.sequence
            : null;
        return { items, nextCursor };
      },
    );
  }

  /**
   * US3 — reconciliation run-history (a read-projection over 017
   * `erpnext_reconciliation_run`), newest-first, keyset-paged on
   * `(started_at, id)` (the table is indexed `(tenant_id, started_at DESC)`).
   * `mismatchSummary` comes from the run's `summary` jsonb (per-class counts).
   */
  async listReconciliationRuns(
    input: RunListInput,
  ): Promise<Page<ReconciliationRunView>> {
    const limit = Math.min(Math.max(1, input.limit), LIST_MAX_PAGE);
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        // Composite keyset cursor `<startedAtISO>|<runId>`. `started_at` is not
        // unique, so the unique `id` tiebreaker keeps a tie stable + gap-free;
        // tuple comparison `(started_at, id) < (anchorTs, cursorId)` pages
        // newer→older deterministically.
        //
        // RT-210 — precision. `started_at` is a MICROSECOND timestamptz, but the
        // cursor's timestamp is millisecond-precision (node-postgres yields a JS
        // `Date`, and the contract `RunCursor` pins `.sssZ`), i.e. it sits at or
        // below the last row's real `started_at`. Comparing against it directly
        // skips an older run in the same millisecond with larger microseconds.
        // So the boundary is ANCHORED on the cursor's run row: its full-precision
        // `started_at` is read back by primary key (a one-row InitPlan). Every
        // outer predicate and the ORDER BY use the bare `started_at` column, and
        // a plain `started_at < $2 + 1ms` bound keeps the
        // `(tenant_id, started_at DESC)` index range scan. The anchor must be
        // a row this same query could have served (same tenant via RLS, same
        // store filter + membership scope) AND lie inside the cursor's own
        // millisecond, so it only restores the sub-millisecond digits the cursor
        // dropped and never moves the page elsewhere. Runs are retained, never
        // deleted (0020 §XIV), so the ms-precision fallback is only reached by a
        // hand-built cursor.
        let cursorTs: string | null = null;
        let cursorId: string | null = null;
        if (input.cursor) {
          const sep = input.cursor.lastIndexOf("|");
          // A malformed cursor leaves both null → treated as "from the start"
          // ONLY if neither parsed; a half-parsed token is rejected upstream by
          // the DTO regex, so here we trust a well-formed `ts|uuid`.
          if (sep > 0) {
            cursorTs = input.cursor.slice(0, sep);
            cursorId = input.cursor.slice(sep + 1);
          }
        }
        const scoped = scopeStoreIds(await this.scopeOf(client, input));
        const rows = await client.query<{
          id: string;
          store_id: string;
          kind: string;
          trigger: string;
          status: string;
          started_at: string;
          finished_at: string | null;
          summary: Record<string, number> | null;
        }>(
          `SELECT id, store_id, kind, trigger, status,
                  started_at, finished_at, summary
             FROM erpnext_reconciliation_run
            WHERE ($1::uuid IS NULL OR store_id = $1::uuid)
              AND ($2::timestamptz IS NULL
                   OR (started_at, id) < (
                        COALESCE(
                          (SELECT anchor.started_at
                             FROM erpnext_reconciliation_run anchor
                            WHERE anchor.id = $3::uuid
                              AND ($1::uuid IS NULL OR anchor.store_id = $1::uuid)
                              AND ($5::uuid[] IS NULL OR anchor.store_id = ANY($5::uuid[]))
                              AND anchor.started_at >= $2::timestamptz
                              AND anchor.started_at < $2::timestamptz + interval '1 millisecond'),
                          $2::timestamptz),
                        $3::uuid))
              -- Redundant upper bound (the anchor is < $2 + 1ms): a plain range on
              -- the bare column that the planner turns into an Index Cond, which
              -- the tuple compare against the InitPlan anchor alone does not.
              AND ($2::timestamptz IS NULL
                   OR started_at < $2::timestamptz + interval '1 millisecond')
              AND ($5::uuid[] IS NULL OR store_id = ANY($5::uuid[]))
            ORDER BY started_at DESC, id DESC
            LIMIT $4`,
          [input.storeId ?? null, cursorTs, cursorId, limit, scoped],
        );
        const items: ReconciliationRunView[] = rows.rows.map((r) => ({
          runId: r.id,
          storeId: r.store_id,
          kind: r.kind,
          trigger: r.trigger,
          status: r.status,
          startedAt: new Date(r.started_at).toISOString(),
          finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
          mismatchSummary: r.summary ?? null,
        }));
        const last = rows.rows[rows.rows.length - 1];
        // The cursor timestamp is `started_at` FLOORED to the millisecond (pg's
        // `Date` truncates the microseconds), which is exactly the window the
        // anchor lookup above checks; the run id carries the rest (RT-210).
        const nextCursor =
          rows.rows.length === limit && last
            ? `${new Date(last.started_at).toISOString()}|${last.id}`
            : null;
        return { items, nextCursor };
      },
    );
  }

  /** The caller's store scope from its role in the tenant (RLS-scoped read; the 017 rule). */
  private scopeOf(client: PoolClient, input: ScopedReadInput): Promise<StoreScope> {
    return callerStoreScope(client, this.memberships, input);
  }
}
