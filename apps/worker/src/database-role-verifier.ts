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
              -- NOINHERIT membership can still be reached through SET ROLE
              -- (unless granted WITH SET FALSE, PG16+). Refuse any membership.
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

/**
 * The database a connection reached: name and OID within the server, and the
 * server's start time, which tells two servers (say production and a staging
 * copy with the same roles) apart. All three are readable by any role. The
 * start time is compared as an epoch: its text form follows each session's
 * TimeZone and DateStyle.
 */
const DB_IDENTITY_COLUMNS = `current_database() AS db_name,
            (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())::text AS db_oid,
            extract(epoch FROM pg_postmaster_start_time())::text AS server_started`;

interface DbIdentity {
  db_name: string;
  db_oid: string;
  server_started: string;
}

interface RetentionLoginRow extends DbIdentity {
  role_name: string;
  session_role: string;
  is_superuser: boolean;
  bypass_rls: boolean;
}

interface RetentionGrantRow {
  can_select: boolean;
  can_mark: boolean;
  extra_privilege: boolean;
}

/**
 * RT-353 — the audit retention role (`audit_retention_worker`, migration 0005)
 * must be a distinct, non-superuser, NOBYPASSRLS role holding exactly
 * `SELECT` and `UPDATE (retention_marked_at)` on `audit_events`, in the same
 * database as `DATABASE_URL`. The sweep reaches every tenant through the
 * platform-admin RLS branch, so the column grant is its only write boundary;
 * any other privilege on the table fails boot.
 */
export async function verifyAuditRetentionRole(
  retentionPool: Pool,
  domainPool: Pool,
): Promise<void> {
  const login = (
    await retentionPool.query<RetentionLoginRow>(
      `SELECT current_user AS role_name,
            session_user AS session_role,
            r.rolsuper AS is_superuser,
            r.rolbypassrls AS bypass_rls,
            ${DB_IDENTITY_COLUMNS}
       FROM pg_roles r
      WHERE r.rolname = current_user`,
    )
  ).rows[0];
  if (!login) {
    throw new Error("WorkerModule: AUDIT_RETENTION_DATABASE_URL role could not be resolved");
  }
  // A URL can log in as a privileged role and switch with `options=-c role=…`:
  // current_user is then the retention role, but RESET ROLE restores the
  // login's own privileges. Every check below is about current_user, so the
  // login itself must be the retention role.
  if (login.session_role !== login.role_name) {
    throw new Error(
      "WorkerModule: AUDIT_RETENTION_DATABASE_URL role must log in as itself, " +
        "not switch to it from another login",
    );
  }
  if (login.is_superuser || login.bypass_rls) {
    throw new Error(
      "WorkerModule: AUDIT_RETENTION_DATABASE_URL role must be non-superuser and must not have BYPASSRLS",
    );
  }
  const domain = (
    await domainPool.query<DbIdentity & { role_name: string }>(
      `SELECT current_user AS role_name,
            ${DB_IDENTITY_COLUMNS}`,
    )
  ).rows[0];
  // A URL pointing at another migrated database (a staging copy has the same
  // role and grants) would pass every check below and mark the wrong rows.
  if (
    !domain ||
    domain.db_name !== login.db_name ||
    domain.db_oid !== login.db_oid ||
    domain.server_started !== login.server_started
  ) {
    throw new Error(
      "WorkerModule: AUDIT_RETENTION_DATABASE_URL must connect to the same database as DATABASE_URL",
    );
  }
  if (domain.role_name === login.role_name) {
    throw new Error(
      "WorkerModule: AUDIT_RETENTION_DATABASE_URL role must be a different role from DATABASE_URL",
    );
  }
  const grants = (
    await retentionPool.query<RetentionGrantRow>(
      `SELECT has_table_privilege('audit_events', 'SELECT') AS can_select,
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
              -- membership can still reach more through SET ROLE (unless granted
              -- WITH SET FALSE, PG16+). As a conservative rule, the retention
              -- role may be a member of no role at all.
              OR EXISTS (
                SELECT 1
                  FROM pg_auth_members m
                  JOIN pg_roles r ON r.oid = m.member
                 WHERE r.rolname = current_user
              )) AS extra_privilege`,
    )
  ).rows[0];
  const missing = [
    ...(grants?.can_select ? [] : ["SELECT ON audit_events"]),
    ...(grants?.can_mark ? [] : ["UPDATE (retention_marked_at) ON audit_events"]),
  ];
  if (missing.length > 0) {
    throw new Error(
      `WorkerModule: AUDIT_RETENTION_DATABASE_URL role is missing required grants: ${missing.join(", ")}`,
    );
  }
  if (grants?.extra_privilege) {
    throw new Error(
      "WorkerModule: AUDIT_RETENTION_DATABASE_URL role may hold only SELECT and " +
        "UPDATE (retention_marked_at) on audit_events, and no role membership",
    );
  }
}
