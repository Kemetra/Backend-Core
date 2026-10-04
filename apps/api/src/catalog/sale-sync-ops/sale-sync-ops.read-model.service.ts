/**
 * SaleSyncOpsReadModelService — 032 §9 read/repair model (T016/T017/T019/T020).
 *
 * The server-authoritative sale-sync READ/REPAIR model the later Console
 * consumes. Reads the 0012 `sales` row's 032 `sync_status` column + the 0026
 * `sale_sync_deadletters` quarantine in place, tenant-scoped under
 * `runWithTenantContext` (RLS fail-closed). The ONLY write is the
 * server-mediated repair (§9): it touches the SaaS-owned `sync_status` + the
 * deadletter resolution — it performs NO sale-fact rewrite (the immutable
 * `sales` / `sale_lines` / terminal-event rows are untouched) and there is NO
 * POS-local override path (repair authority is Console-mediated only — DP3 /
 * §13 item 3; 028 OQ-2).
 *
 * DATA ACCESS — raw parameterized SQL under `runWithTenantContext`, matching
 * the DIRECT sibling this surface mirrors (`ErpnextSyncOpsReadModelService`,
 * 025) and the rest of the sync-ops family. CodeRabbit suggested a Drizzle
 * conversion; that was declined to stay consistent with the 025 sibling (which
 * is raw SQL) — converting only this file would be the inconsistent move, and
 * Drizzle's positional rowMode would also move this service's Docker-free
 * branch coverage onto Testcontainers. See the slice notes.
 *
 * Invariants:
 *   - Object-level authz: a sale outside the (tenant, store) scope reads as
 *     absent (non-disclosing 404) — RLS scopes the tenant; the caller's
 *     membership store scope (RT-193, `context/operator-store-scope.ts`, the
 *     RT-191/RT-192 rule) is a `store_id` predicate on every read, the list and
 *     the repair's gate. owner / tenant_admin get their membership's scope, not
 *     narrowed by the active store; an empty scope matches no sale.
 *   - Keyset pagination on the UUIDv7 `id` (time-ordered, newest-first) — no
 *     extra timestamp column; the cursor is the last row's `id`.
 *   - Repair acts ONLY on an OPEN `failed-needs-repair` item; anything else is
 *     a `RepairConflictError` (→ 409), DISTINCT from the live provenance 409
 *     (F-3, untouched).
 *   - Never rewrites a sale fact; never invents server settlement (F-2).
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import { MembershipRepository } from "../../context/membership.repository";
import {
  callerStoreScope,
  inStoreScope,
  scopeStoreIds,
} from "../../context/operator-store-scope";
import type { StoreScope } from "../../context/store-scope";
import type { ResolvedContext } from "../../context/types";
import {
  SALE_SYNC_STATUS,
  type SaleSyncStatus,
} from "../sales/sale-sync-status";

const LIST_MAX_PAGE = 200;

/** Thrown when a sale ref does not resolve within the operator's scope. */
export class SaleSyncNotFoundError extends Error {
  constructor() {
    super("sale not found");
    this.name = "SaleSyncNotFoundError";
  }
}

/** Thrown when a supplied `store_id` is not one of the caller's accessible stores. */
export class StoreNotInScopeError extends Error {
  constructor() {
    super("Store not found");
    this.name = "StoreNotInScopeError";
  }
}

/**
 * Thrown when a repair targets an item not in an OPEN `failed-needs-repair`
 * state (→ 409 `repair_conflict`). DISTINCT from the live provenance-conflict
 * 409 on the POS terminal surface (F-3) — that one is not touched here.
 */
export class RepairConflictError extends Error {
  constructor() {
    super("sale is not in a repairable state");
    this.name = "RepairConflictError";
  }
}

/** §8 dead-letter detail attached to a sale's status (open row only). */
export interface DeadLetterDetail {
  readonly classification: "retryable" | "needs-repair";
  readonly reasonCode: string;
  readonly retryCount: number;
  readonly quarantinedAt: string;
  readonly resolvedAt: string | null;
}

/** Wire projection of a sale's server-authoritative sync-status (§7). */
export interface SaleSyncStatusBody {
  readonly saleRef: string;
  readonly storeId: string;
  readonly syncStatus: SaleSyncStatus;
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly processedAt: string | null;
  readonly deadLetter: DeadLetterDetail | null;
}

/** One NEEDS_REPAIR queue row (newest-first list projection). */
export interface NeedsRepairItem {
  readonly saleRef: string;
  readonly storeId: string;
  readonly syncStatus: SaleSyncStatus;
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly reasonCode: string;
  readonly retryCount: number;
  readonly quarantinedAt: string;
}

export interface AuditTimelineEntry {
  readonly at: string;
  readonly event: string;
  readonly correlationId: string | null;
}

export interface SaleAuditTimelineBody {
  readonly saleRef: string;
  readonly entries: readonly AuditTimelineEntry[];
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** The session context of a read or repair; its store scope bounds the sales (RT-193). */
export interface ScopedReadInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
}

export interface ListNeedsRepairInput extends ScopedReadInput {
  readonly storeId?: string;
  /** Keyset cursor — the last page's last sale `id` (UUIDv7). */
  readonly cursor: string | null;
  readonly limit: number;
}

interface SaleStatusRow {
  id: string;
  store_id: string;
  sync_status: SaleSyncStatus;
  source_system: string;
  external_id: string;
  processed_at: Date | null;
  received_at: Date;
}

interface DeadLetterRow {
  classification: "retryable" | "needs-repair";
  reason_code: string;
  retry_count: number;
  quarantined_at: Date;
  resolved_at: Date | null;
}

@Injectable()
export class SaleSyncOpsReadModelService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /**
   * Assert a supplied `store_id` is one of the caller's accessible stores: in
   * the caller's membership store scope (RT-193) and in the session tenant (RLS
   * — a cross-tenant id returns no row). Otherwise `StoreNotInScopeError` (→
   * non-disclosing 404). Null is always in scope. Mirrors
   * ErpnextSyncOpsReadModelService.
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
   * T016 — read one sale's server-authoritative sync-status + any OPEN
   * dead-letter detail. Object-level authz: RLS scopes the tenant and the
   * caller's store scope bounds the sale's store (RT-193). An out-of-scope or
   * absent sale throws `SaleSyncNotFoundError` (→ non-disclosing 404). The
   * sale's own store is returned in the projection.
   */
  async getSaleSyncStatus(
    input: ScopedReadInput,
    saleId: string,
  ): Promise<SaleSyncStatusBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        const row = await this.readScopedSale(client, input, saleId);
        const dl = await this.readOpenDeadLetter(client, saleId);
        return this.toStatusBody(row, dl);
      },
    );
  }

  /**
   * T017 — the NEEDS_REPAIR queue: tenant-scoped (RLS), bounded to the
   * caller's store scope in SQL (RT-193 — pages stay full and the keyset cursor
   * gap-free while out-of-scope rows are skipped) + optional store filter,
   * newest-first by the time-ordered sale `id`, keyset paginated. Joins the OPEN
   * `needs-repair` deadletter rows to their sale; the sale's `sync_status` is
   * the authoritative state (`failed-needs-repair`). Resolved rows are excluded
   * (retained for audit, not listed).
   */
  async listNeedsRepair(
    input: ListNeedsRepairInput,
  ): Promise<Page<NeedsRepairItem>> {
    const limit = Math.min(Math.max(1, input.limit), LIST_MAX_PAGE);
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        const scoped = scopeStoreIds(await this.scopeOf(client, input));
        const rows = await client.query<{
          sale_id: string;
          store_id: string;
          sync_status: SaleSyncStatus;
          source_system: string;
          external_id: string;
          reason_code: string;
          retry_count: number;
          quarantined_at: Date;
        }>(
          // Newest-first keyset on the UUIDv7 sale id (`d.sale_id < $cursor`).
          // OPEN needs-repair deadletters only, joined to their sale for the
          // authoritative status + provenance. Store-filtered (and store-scoped,
          // RT-193) via the sale.
          `SELECT d.sale_id, s.store_id, s.sync_status,
                  d.source_system, d.external_id, d.reason_code,
                  d.retry_count, d.quarantined_at
             FROM sale_sync_deadletters d
             JOIN sales s ON s.id = d.sale_id
            WHERE d.classification = 'needs-repair'
              AND d.resolved_at IS NULL
              AND ($1::uuid IS NULL OR s.store_id = $1::uuid)
              AND ($2::uuid IS NULL OR d.sale_id < $2::uuid)
              AND ($4::uuid[] IS NULL OR s.store_id = ANY($4::uuid[]))
            ORDER BY d.sale_id DESC
            LIMIT $3`,
          [input.storeId ?? null, input.cursor, limit, scoped],
        );
        const items: NeedsRepairItem[] = rows.rows.map((r) => ({
          saleRef: r.sale_id,
          storeId: r.store_id,
          syncStatus: r.sync_status,
          sourceSystem: r.source_system,
          externalId: r.external_id,
          reasonCode: r.reason_code,
          retryCount: r.retry_count,
          quarantinedAt: r.quarantined_at.toISOString(),
        }));
        const last = rows.rows[rows.rows.length - 1];
        const nextCursor =
          rows.rows.length === limit && last ? last.sale_id : null;
        return { items, nextCursor };
      },
    );
  }

  /**
   * T019 — the read-only correlation/audit timeline for one sale. Object-level
   * authz first (non-disclosing 404), then a redacted timeline built from the
   * server-owned facts available without disclosing raw payload (Principle
   * XIII/XIV): the initial CAPTURE event (always present — the sale's
   * server-received clock), the synced transition, and any dead-letter
   * quarantine / resolution events. The full 028 audit-event join is a
   * follow-up; this surfaces the sync-lifecycle entries the Console needs
   * without leaking.
   */
  async getSaleAuditTimeline(
    input: ScopedReadInput,
    saleId: string,
  ): Promise<SaleAuditTimelineBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        const row = await this.readScopedSale(client, input, saleId);
        const entries: AuditTimelineEntry[] = [];
        const deadletters = await client.query<{
          classification: string;
          quarantined_at: Date;
          resolved_at: Date | null;
          correlation_id: string | null;
        }>(
          `SELECT classification, quarantined_at, resolved_at, correlation_id
             FROM sale_sync_deadletters
            WHERE sale_id = $1
            ORDER BY quarantined_at ASC`,
          [saleId],
        );
        // The sale exists in scope → a CAPTURE entry is ALWAYS present, stamped
        // on the sale's server-received clock (`received_at`, NOT NULL). A
        // capture-only sale (never processed, never dead-lettered) therefore
        // returns a one-entry timeline rather than an empty one (CodeRabbit #2).
        entries.push({
          at: row.received_at.toISOString(),
          event: "sale.captured",
          correlationId: null,
        });
        if (row.processed_at) {
          entries.push({
            at: row.processed_at.toISOString(),
            event: "sync.synced",
            correlationId: null,
          });
        }
        for (const d of deadletters.rows) {
          entries.push({
            at: d.quarantined_at.toISOString(),
            event:
              d.classification === "needs-repair"
                ? "sync.needs_repair"
                : "sync.retryable",
            correlationId: d.correlation_id,
          });
          if (d.resolved_at) {
            entries.push({
              at: d.resolved_at.toISOString(),
              event: "repair.resolved",
              correlationId: d.correlation_id,
            });
          }
        }
        entries.sort((a, b) => a.at.localeCompare(b.at));
        return { saleRef: row.id, entries };
      },
    );
  }

  /**
   * T020 — the SERVER-MEDIATED repair/retry op. Acts ONLY on an OPEN
   * `failed-needs-repair` item; re-queues it by resolving the deadletter and
   * moving the status to `failed-retryable` (re-eligible for a drain) — the
   * allowed transition (sale-sync-status.ts). NO sale-fact rewrite. Audited at
   * the controller (`@Auditable`). Idempotency-Key enforced at the route.
   *
   * Anything not in the repairable state → `RepairConflictError` (409,
   * deterministic, no side effect). An out-of-scope/absent sale →
   * `SaleSyncNotFoundError` (404), decided by the store-scoped read that opens
   * the transaction — before any write (RT-193).
   *
   * Atomicity: `runWithTenantContext` wraps the whole callback in ONE
   * transaction (BEGIN/COMMIT), so the deadletter resolution + the `sales`
   * status mutation commit or roll back together.
   */
  async repairSaleSync(
    input: ScopedReadInput,
    saleId: string,
  ): Promise<SaleSyncStatusBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        // Object-safety gate first (non-disclosing 404), before any write: RLS
        // scopes the tenant, the caller's store scope the sale's store (RT-193).
        const row = await this.readScopedSale(client, input, saleId);
        if (row.sync_status !== SALE_SYNC_STATUS.FAILED_NEEDS_REPAIR) {
          // Not in a repairable state — deterministic conflict, no side effect.
          throw new RepairConflictError();
        }

        // Resolve the OPEN needs-repair deadletter (retained, not deleted) and
        // re-queue by moving the status to failed-retryable (the allowed
        // transition). Guarded by `resolved_at IS NULL` so a concurrent repair
        // is idempotent — only the first resolves.
        const resolved = await client.query<{ id: string }>(
          `UPDATE sale_sync_deadletters
              SET resolved_at = now(), retry_count = retry_count + 1
            WHERE sale_id = $1
              AND classification = 'needs-repair'
              AND resolved_at IS NULL
            RETURNING id`,
          [saleId],
        );
        if (resolved.rows.length === 0) {
          // The status said needs-repair but no open deadletter — inconsistent
          // state; treat as a conflict rather than a false success.
          throw new RepairConflictError();
        }

        await client.query(
          `UPDATE sales
              SET sync_status = $2
            WHERE id = $1`,
          [saleId, SALE_SYNC_STATUS.FAILED_RETRYABLE],
        );

        const after = await this.readSaleStatusRow(client, saleId);
        const dl = await this.readOpenDeadLetter(client, saleId);
        return this.toStatusBody(after, dl);
      },
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** The caller's store scope from its role in the tenant (RLS-scoped read; the RT-192 rule). */
  private scopeOf(client: PoolClient, input: ScopedReadInput): Promise<StoreScope> {
    return callerStoreScope(client, this.memberships, input);
  }

  /** The sale, if it is in the caller's store scope; else `SaleSyncNotFoundError`. */
  private async readScopedSale(
    client: PoolClient,
    input: ScopedReadInput,
    saleId: string,
  ): Promise<SaleStatusRow> {
    const scoped = scopeStoreIds(await this.scopeOf(client, input));
    return this.readSaleStatusRow(client, saleId, scoped);
  }

  private async readSaleStatusRow(
    client: PoolClient,
    saleId: string,
    scoped: readonly string[] | null = null,
  ): Promise<SaleStatusRow> {
    // RLS scopes the tenant; `scoped` (null = tenant-wide, empty = none) bounds
    // the sale's store, so an out-of-scope sale reads as absent. The store +
    // received_at (the capture clock for the audit timeline) are returned in
    // the row.
    const r = await client.query<SaleStatusRow>(
      `SELECT id, store_id, sync_status, source_system, external_id,
              processed_at, received_at
         FROM sales
        WHERE id = $1
          AND ($2::uuid[] IS NULL OR store_id = ANY($2::uuid[]))`,
      [saleId, scoped],
    );
    const row = r.rows[0];
    if (!row) {
      throw new SaleSyncNotFoundError();
    }
    return row;
  }

  private async readOpenDeadLetter(
    client: PoolClient,
    saleId: string,
  ): Promise<DeadLetterRow | null> {
    const r = await client.query<DeadLetterRow>(
      `SELECT classification, reason_code, retry_count, quarantined_at, resolved_at
         FROM sale_sync_deadletters
        WHERE sale_id = $1 AND resolved_at IS NULL
        ORDER BY quarantined_at DESC
        LIMIT 1`,
      [saleId],
    );
    return r.rows[0] ?? null;
  }

  private toStatusBody(
    row: SaleStatusRow,
    dl: DeadLetterRow | null,
  ): SaleSyncStatusBody {
    return {
      saleRef: row.id,
      storeId: row.store_id,
      syncStatus: row.sync_status,
      sourceSystem: row.source_system,
      externalId: row.external_id,
      processedAt: row.processed_at ? row.processed_at.toISOString() : null,
      deadLetter: dl
        ? {
            classification: dl.classification,
            reasonCode: dl.reason_code,
            retryCount: dl.retry_count,
            quarantinedAt: dl.quarantined_at.toISOString(),
            resolvedAt: dl.resolved_at ? dl.resolved_at.toISOString() : null,
          }
        : null,
    };
  }
}
