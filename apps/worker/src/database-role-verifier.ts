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
}

export async function verifyWorkerDatabaseRole(pool: Pool): Promise<void> {
  const result = await pool.query<RoleRow>(
    `SELECT current_user AS role_name,
            r.rolsuper AS is_superuser,
            r.rolbypassrls AS bypass_rls
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
}
