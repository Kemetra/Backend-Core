/**
 * `insertAuditEvent` — tenant-aware audit event writer.
 *
 * Wraps `runWithTenantContext` to correctly set RLS GUCs before inserting
 * into `audit_events`, covering both the tenant path and the platform path.
 *
 * Tenant path (tenant_id !== null)
 * --------------------------------
 * Sets `app.current_tenant = row.tenant_id` and `app.is_platform_admin =
 * false`. Uses `withTenant(db, tenantId).auditEvents.insert(...)` which
 * enforces the application-level tenant match check in addition to RLS.
 *
 * Platform path (tenant_id === null)
 * ------------------------------------
 * Must NOT pass `null` directly to `runWithTenantContext` — that would set
 * `app.current_tenant = ''` (empty string), and the RLS `WITH CHECK` clause
 * contains `... ::uuid` which may fail-cast on empty string if the
 * OR short-circuit is not guaranteed by the planner.
 *
 * Instead, we pass NIL_UUID (`00000000-0000-0000-0000-000000000000`) as the
 * context tenantId. This is a valid UUID string, avoids the cast hazard, and
 * still fails the `tenant_id IS NOT NULL` check in the policy's USING clause.
 * The policy's `is_platform_admin = 'true'` OR-branch covers the insert.
 * The row itself stores `tenantId: undefined` (maps to DB NULL).
 *
 * `tenant_id` is required — pass `null` explicitly for platform-scoped
 * inserts. Omitting it (undefined from an untyped caller) throws at runtime
 * rather than silently producing a platform-scoped insert.
 *
 * Seam
 * -----
 * `_makeInsertAuditEvent` is the internal factory used by unit tests.
 * It is NOT exported from `packages/db/src/index.ts` (the barrel), so
 * package consumers cannot depend on it. Import it directly from this file
 * in tests only.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { auditEvents, type NewAuditEventRow } from "../schema";
import { withTenant } from "./with-tenant";
import { runWithTenantContext } from "../middleware/tenant-context";

/** NIL UUID — used as the context tenantId for platform-scoped inserts only. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Snake_case insert shape — mirrors `AuditEventInsertRow` in
 * `apps/worker/src/audit/audit-fanout.processor.ts`. Defined here so
 * `packages/db` can expose a stable public type without cross-app imports.
 *
 * All fields are required. Pass `null` explicitly for absent optional values.
 * `tenant_id: null` signals a platform-scoped insert; omitting `tenant_id`
 * (undefined) is a programming error and throws at runtime.
 */
export interface AuditEventInsertRow {
  id: string;
  actor_user_id: string | null;
  actor_label: string | null;
  tenant_id: string | null;
  store_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
}

function toNewAuditEventRow(row: AuditEventInsertRow): NewAuditEventRow {
  return {
    id: row.id,
    actorUserId: row.actor_user_id ?? undefined,
    actorLabel: row.actor_label ?? undefined,
    tenantId: row.tenant_id ?? undefined,
    storeId: row.store_id ?? undefined,
    action: row.action,
    targetType: row.target_type ?? undefined,
    targetId: row.target_id ?? undefined,
    metadata: row.metadata,
    requestId: row.request_id ?? undefined,
    // occurredAt omitted — DB default owns the timestamp
  };
}

/** Internal seam types for unit testing. */
export type RunCtxFn = typeof runWithTenantContext;
export type InsertFn = (
  pool: Pool,
  row: AuditEventInsertRow,
) => Promise<void>;

/**
 * Factory used by unit tests only — inject fake `runCtx` and `rawInsertFn`
 * to avoid requiring a real database connection. NOT exported from index.ts.
 */
export function _makeInsertAuditEvent(
  runCtx: RunCtxFn,
  rawInsertFn?: (
    pool: Pool,
    newRow: NewAuditEventRow,
    isPlatformAdmin: boolean,
  ) => Promise<void>,
): (pool: Pool, row: AuditEventInsertRow) => Promise<void> {
  return async function insertAuditEventInner(
    pool: Pool,
    row: AuditEventInsertRow,
  ): Promise<void> {
    // Guard against untyped JS callers passing undefined for tenant_id.
    // undefined would silently produce a platform-scoped insert — throw instead.
    if ((row.tenant_id as unknown) === undefined) {
      throw new Error(
        "insertAuditEvent: tenant_id must be a UUID string or explicit null (platform-scoped). undefined is not allowed.",
      );
    }

    const newRow = toNewAuditEventRow(row);
    const isPlatformAdmin = row.tenant_id === null;
    // NIL_UUID for platform path — avoids empty-string ::uuid cast hazard in RLS
    const ctxTenantId = isPlatformAdmin ? NIL_UUID : row.tenant_id;

    await runCtx(pool, { tenantId: ctxTenantId, isPlatformAdmin }, async (client) => {
      if (rawInsertFn) {
        // Test seam: rawInsertFn is the leaf insert, called inside runCtx so
        // capturedCtx (from fake runCtx) and capturedRow (from rawInsertFn) both
        // populate in the same test. Fake runCtx MUST invoke work() for this path.
        await rawInsertFn(pool, newRow, isPlatformAdmin);
        return;
      }
      const db = drizzle(client);
      // ON CONFLICT (id) DO NOTHING: a retried delivery of the same audit fact
      // (same stable id, RT-124) is a no-op instead of a duplicate row.
      if (isPlatformAdmin) {
        // Platform path: row stores tenant_id: undefined (DB NULL), not NIL_UUID.
        await db.insert(auditEvents).values(newRow).onConflictDoNothing({ target: auditEvents.id });
      } else {
        // Tenant path: withTenant enforces application-level tenant match.
        await withTenant(db, row.tenant_id!)
          .auditEvents.insert(newRow)
          .onConflictDoNothing({ target: auditEvents.id });
      }
    });
  };
}

/**
 * Insert a single audit event into `audit_events`, respecting RLS.
 *
 * For tenant rows (`tenant_id` is a UUID string): sets tenant GUCs and uses
 * the `withTenant` application guard.
 * For platform rows (`tenant_id` is explicit `null`): sets NIL_UUID +
 * platform-admin GUCs and inserts directly (bypassing `withTenant`'s guard).
 *
 * Each call acquires and releases its own pool connection. Do not call from
 * inside an existing `runWithTenantContext` transaction.
 */
export const insertAuditEvent: (
  pool: Pool,
  row: AuditEventInsertRow,
) => Promise<void> = _makeInsertAuditEvent(runWithTenantContext);
