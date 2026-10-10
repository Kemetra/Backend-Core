/**
 * Worker database role posture check (RT-143).
 *
 * The worker's DATABASE_URL is the domain runtime role: tenant data is
 * reached only through `runWithTenantContext`, and FORCE RLS is the
 * boundary. A superuser or BYPASSRLS credential would silently disable
 * that boundary, so in production the worker refuses to start with one —
 * the same rule the API's `DatabasePoolBoundaryVerifier` enforces
 * (docs/operations/database-roles.md). `WorkerDatabaseRoleVerifier` in
 * worker.module.ts runs it at boot.
 */
import type { Pool } from "pg";

interface RoleRow {
  role_name: string;
  is_superuser: boolean;
  bypass_rls: boolean;
  can_mark_retention?: boolean;
}

export async function verifyWorkerDatabaseRole(pool: Pool): Promise<void> {
  const result = await pool.query<RoleRow>(
    `SELECT current_user AS role_name,
            r.rolsuper AS is_superuser,
            r.rolbypassrls AS bypass_rls,
            (has_column_privilege('audit_events', 'retention_marked_at', 'UPDATE')
              -- has_column_privilege counts inherited privileges only; a
              -- NOINHERIT membership is still reachable through SET ROLE.
              OR EXISTS (
                SELECT 1
                  FROM pg_roles g
                 WHERE g.oid <> r.oid
                   AND pg_has_role(current_user, g.oid, 'MEMBER')
                   AND has_column_privilege(g.oid, 'audit_events', 'retention_marked_at', 'UPDATE')
              )) AS can_mark_retention
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  );
  const role = result.rows[0];
  if (!role) throw new Error("WorkerModule: database role could not be resolved");
  if (role.is_superuser || role.bypass_rls) {
    throw new Error(
      "WorkerModule: DATABASE_URL role must be non-superuser and must not have BYPASSRLS",
    );
  }
  // RT-353: the API shares this role, and the retention decision record (§8)
  // keeps it INSERT-only on audit_events. Only the retention role may mark.
  if (role.can_mark_retention) {
    throw new Error(
      "WorkerModule: DATABASE_URL role must not hold UPDATE on audit_events.retention_marked_at; " +
        "only the AUDIT_RETENTION_DATABASE_URL role may mark retention (RT-353)",
    );
  }
}

interface RetentionRoleRow {
  role_name: string;
  is_superuser: boolean;
  bypass_rls: boolean;
  can_select: boolean;
  can_mark: boolean;
  extra_privilege: boolean;
}

/**
 * RT-353 — the audit retention role (`audit_retention_worker`, migration 0005)
 * must be a distinct, non-superuser, NOBYPASSRLS role holding exactly
 * `SELECT` and `UPDATE (retention_marked_at)` on `audit_events`. The sweep
 * reaches every tenant through the platform-admin RLS branch, so the column
 * grant is its only write boundary; any other privilege on the table fails boot.
 */
export async function verifyAuditRetentionRole(
  retentionPool: Pool,
  domainPool: Pool,
): Promise<void> {
  const result = await retentionPool.query<RetentionRoleRow>(
    `SELECT current_user AS role_name,
            r.rolsuper AS is_superuser,
            r.rolbypassrls AS bypass_rls,
            has_table_privilege('audit_events', 'SELECT') AS can_select,
            has_column_privilege('audit_events', 'retention_marked_at', 'UPDATE') AS can_mark,
            (has_table_privilege('audit_events', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
              OR has_any_column_privilege('audit_events', 'INSERT, REFERENCES')
              OR EXISTS (
                SELECT 1
                  FROM pg_attribute a
                 WHERE a.attrelid = 'audit_events'::regclass
                   AND a.attnum > 0
                   AND NOT a.attisdropped
                   AND a.attname <> 'retention_marked_at'
                   AND has_column_privilege('audit_events', a.attname, 'UPDATE')
              )
              -- MAINTAIN (PG17+) includes LOCK TABLE. PG16 rejects the name,
              -- and CASE keeps it from being evaluated there.
              OR CASE WHEN current_setting('server_version_num')::int >= 170000
                      THEN has_table_privilege('audit_events', 'MAINTAIN')
                      ELSE false END
              -- has_*_privilege counts inherited privileges only: a NOINHERIT
              -- membership could still reach more through SET ROLE, so the
              -- retention role may be a member of no role at all.
              OR EXISTS (
                SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid
              )) AS extra_privilege
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  );
  const role = result.rows[0];
  if (!role) {
    throw new Error("WorkerModule: AUDIT_RETENTION_DATABASE_URL role could not be resolved");
  }
  if (role.is_superuser || role.bypass_rls) {
    throw new Error(
      "WorkerModule: AUDIT_RETENTION_DATABASE_URL role must be non-superuser and must not have BYPASSRLS",
    );
  }
  const domain = await domainPool.query<{ role_name: string }>("SELECT current_user AS role_name");
  if (domain.rows[0]?.role_name === role.role_name) {
    throw new Error(
      "WorkerModule: AUDIT_RETENTION_DATABASE_URL role must be a different role from DATABASE_URL",
    );
  }
  const missing = [
    ...(role.can_select ? [] : ["SELECT ON audit_events"]),
    ...(role.can_mark ? [] : ["UPDATE (retention_marked_at) ON audit_events"]),
  ];
  if (missing.length > 0) {
    throw new Error(
      `WorkerModule: AUDIT_RETENTION_DATABASE_URL role is missing required grants: ${missing.join(", ")}`,
    );
  }
  if (role.extra_privilege) {
    throw new Error(
      "WorkerModule: AUDIT_RETENTION_DATABASE_URL role may hold only SELECT and " +
        "UPDATE (retention_marked_at) on audit_events, and no role membership",
    );
  }
}
