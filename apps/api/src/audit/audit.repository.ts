/**
 * AuditRepository — read surface for `GET /api/v1/audit/events` (T235).
 *
 * Owns the Drizzle SELECT against `audit_events`. The production class
 * (`DrizzleAuditRepository`) opens its own `runWithTenantContext`
 * transaction per call so every read sets the tenant + platform-admin
 * GUCs that RLS expects. Tests substitute a fake implementing the
 * interface; the service itself never touches `pg`.
 *
 * Why an explicit `WHERE tenant_id = ctx.tenantId` predicate
 * ----------------------------------------------------------
 * The audit_events RLS policy (`drizzle/0000_initial.sql`) is:
 *
 *   USING (tenant_id IS NOT NULL AND tenant_id = current_setting(...)::uuid
 *          OR current_setting('app.is_platform_admin', true) = 'true')
 *
 * For a platform-admin caller, the `is_platform_admin = 'true'` OR-branch
 * permits SELECT on rows from EVERY tenant. RLS alone is insufficient
 * for tenant scoping when `isPlatformAdmin=true`. The repository adds
 * `eq(auditEvents.tenantId, input.tenantId)` as a defence-in-depth
 * predicate that closes the hole at the application layer.
 *
 * Pagination
 * ----------
 * Cursor-based on `(occurred_at, id)` DESC. The
 * `(occurred_at, id) < (cursor.occurred_at, cursor.id)` predicate uses
 * row-tuple comparison via a raw `sql\`...\`` fragment — Drizzle has no
 * native row-comparison operator and decomposing into `OR` would yield
 * three predicates (slower, harder to verify).
 *
 * To detect end-of-page cheaply the SERVICE asks for `limit + 1` rows
 * here; this repository just honours `input.limit` verbatim. The service
 * trims the extra row and emits `next_cursor` from the LAST kept row.
 *
 * Microsecond precision (RT-211)
 * ------------------------------
 * PG stores `timestamptz` at µs resolution; node-pg returns `Date`
 * (ms-truncated), so the cursor's `occurred_at` is the last row's value
 * FLOORED to the millisecond, i.e. at or below the real one. The `id`
 * tiebreaker only resolves EXACT `occurred_at` ties: comparing against the
 * floored value directly skips an older event in the same millisecond with
 * larger microseconds. So the keyset boundary is ANCHORED on the cursor's
 * own row: its full-precision `occurred_at` is read back by primary key
 * (a one-row InitPlan), restricted to rows this same list could have served
 * (same tenant via RLS + the explicit tenant predicate, same filters) and to
 * the cursor's own millisecond, so it only restores the sub-ms digits the
 * cursor dropped and never moves the page elsewhere. If no such row exists
 * (a hand-built cursor) the boundary falls back to the millisecond value.
 * Audit rows are append-only and never deleted (0034; retention only marks
 * them, and this list does not filter on the mark). A redundant plain
 * `occurred_at < cursorTs + 1ms` bound keeps the
 * `(tenant_id, occurred_at DESC)` index range scan. The cursor wire format
 * is unchanged.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, desc, eq, gte, lte, like, sql, type SQL } from "drizzle-orm";
import { alias, type BuildAliasTable } from "drizzle-orm/pg-core";
import { runWithTenantContext } from "@data-pulse-2/db";
import { auditEvents } from "@data-pulse-2/db/schema";

import { PG_POOL } from "../auth/auth.module";
import type { AuditCursor } from "./audit.query.schema";

/** Internal record shape returned by the repository (camelCase). */
export interface AuditEventRecord {
  readonly id: string;
  readonly occurredAt: Date;
  readonly actorUserId: string | null;
  readonly actorLabel: string | null;
  readonly tenantId: string;
  readonly storeId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly requestId: string | null;
  readonly metadata: Record<string, unknown>;
}

export interface ListPageInput {
  readonly tenantId: string;
  readonly isPlatformAdmin: boolean;
  readonly action?: string | undefined;
  readonly actorUserId?: string | undefined;
  readonly storeId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly cursor: AuditCursor | null;
  readonly limit: number;
}

export interface AuditRepository {
  /**
   * Read a page of audit events with the supplied filters / cursor.
   * Production implementation opens its own RLS-bound transaction;
   * tests substitute an in-memory fake.
   */
  listPage(input: ListPageInput): Promise<AuditEventRecord[]>;
}

/** DI token so the service depends on the interface, not the class. */
export const AUDIT_REPOSITORY = "AUDIT_REPOSITORY";

/**
 * Indirection seam: production passes the real `runWithTenantContext`;
 * tests can swap a passthrough that fabricates a `PoolClient` shape.
 * Mirrors the pattern used by `StoresService` / `TenantsService`.
 */
type TenantTxRunner = <T>(
  pool: Pool,
  ctx: { tenantId: string | null; isPlatformAdmin: boolean },
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;

@Injectable()
export class DrizzleAuditRepository implements AuditRepository {
  private readonly tx: TenantTxRunner;

  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
    /**
     * Optional injected runner for tests. Production callers omit it.
     * `@Optional()` is required (not just a `?` on the parameter type)
     * because Nest's DI resolver treats unmarked function-typed params
     * as required injections — same pattern as `StoresService.tx`.
     */
    @Optional() tx?: TenantTxRunner,
  ) {
    this.tx = tx ?? runWithTenantContext;
  }

  async listPage(input: ListPageInput): Promise<AuditEventRecord[]> {
    return this.tx(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: input.isPlatformAdmin },
      async (client) => this.runQuery(input, client),
    );
  }

  private async runQuery(
    input: ListPageInput,
    client: PoolClient,
  ): Promise<AuditEventRecord[]> {
    const db = drizzle(client);

    const predicates = filterPredicates(auditEvents, input);

    if (input.cursor !== null) {
      // Row-tuple keyset: (occurred_at, id) < (anchorTs, cursor.id), with an
      // `id` tiebreaker for exact `occurred_at` ties. `anchorTs` is the
      // cursor row's FULL-precision occurred_at (RT-211, see header), looked
      // up under the same scope + filters and only inside the cursor's own
      // millisecond; it falls back to the cursor's millisecond value.
      const cursorTs = input.cursor.occurredAt.toISOString();
      const cursorId = input.cursor.id;
      const anchor: AnchorTable = alias(auditEvents, ANCHOR_ALIAS);
      const anchorTs = db
        .select({ occurredAt: anchor.occurredAt })
        .from(anchor)
        .where(
          and(
            eq(anchor.id, cursorId),
            ...filterPredicates(anchor, input),
            sql`${anchor.occurredAt} >= ${cursorTs}::timestamptz`,
            sql`${anchor.occurredAt} < ${cursorTs}::timestamptz + interval '1 millisecond'`,
          ),
        );
      predicates.push(
        sql`(${auditEvents.occurredAt}, ${auditEvents.id}) < (COALESCE((${anchorTs}), ${cursorTs}::timestamptz), ${cursorId}::uuid)`,
      );
      // Redundant upper bound (the anchor is < cursorTs + 1ms): a plain range
      // on the bare column that the planner turns into an Index Cond on
      // (tenant_id, occurred_at DESC); the tuple compare against the
      // InitPlan anchor alone is only a Filter.
      predicates.push(
        sql`${auditEvents.occurredAt} < ${cursorTs}::timestamptz + interval '1 millisecond'`,
      );
    }

    const rows = await db
      .select()
      .from(auditEvents)
      .where(and(...predicates))
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
      .limit(input.limit);

    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt,
      actorUserId: row.actorUserId,
      actorLabel: row.actorLabel,
      // tenantId column is nullable, but the explicit predicate guarantees
      // a non-null value here; coerce defensively for the type system.
      tenantId: row.tenantId ?? input.tenantId,
      storeId: row.storeId,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      requestId: row.requestId,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
    }));
  }
}

const ANCHOR_ALIAS = "anchor";
type AnchorTable = BuildAliasTable<typeof auditEvents, typeof ANCHOR_ALIAS>;

/**
 * The list's scope + filter predicates, applied to `table` — the outer
 * `audit_events` or the cursor-anchor alias, so the anchor lookup sees
 * exactly the rows the list query sees (RT-211).
 */
function filterPredicates(
  table: typeof auditEvents | AnchorTable,
  input: ListPageInput,
): SQL[] {
  const predicates: SQL[] = [
    // Defence-in-depth tenant scope (closes the platform-admin RLS hole).
    eq(table.tenantId, input.tenantId),
  ];
  if (input.action !== undefined) {
    // Prefix match. `like` is safe — `action` is an internal-controlled
    // enum-ish string (e.g., `auth.signin.ok`); Drizzle parameterises
    // the value, and the `%` is server-appended (not user-supplied).
    predicates.push(like(table.action, `${input.action}%`));
  }
  if (input.actorUserId !== undefined) {
    predicates.push(eq(table.actorUserId, input.actorUserId));
  }
  if (input.storeId !== undefined) {
    predicates.push(eq(table.storeId, input.storeId));
  }
  if (input.from !== undefined) {
    predicates.push(gte(table.occurredAt, input.from));
  }
  if (input.to !== undefined) {
    predicates.push(lte(table.occurredAt, input.to));
  }
  return predicates;
}
