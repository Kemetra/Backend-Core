/**
 * RT-414 — enter a tenant as a NON-member platform admin in a test.
 *
 * Since RT-414 a platform admin who is not a member of a tenant reaches its
 * tenant-scoped routes only through an active support session, and
 * `POST /context/tenant` refuses them (403 `support_session_required`).
 * Specs that exercise platform-admin behavior inside a tenant (RT-142,
 * RT-669 D-a, store scope, …) call this instead of switching tenant: it does
 * what `openSupportSession` does, directly in SQL, so a spec need not mount
 * `PlatformSupportSessionsModule`. The support-session runtime itself is
 * covered by platform-support-sessions.http.integration.spec.ts.
 *
 * `admin` must bypass RLS (the Testcontainers superuser pool). The user's
 * most recently issued live auth session is used: sign in first.
 */
import type { Pool } from "pg";

export async function enterTenantAsPlatformAdmin(
  admin: Pool,
  userId: string,
  tenantId: string,
): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `SELECT id FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND absolute_expires_at > now()
      ORDER BY issued_at DESC LIMIT 1`,
    [userId],
  );
  const authSessionId = rows[0]?.id;
  if (!authSessionId) throw new Error("enterTenantAsPlatformAdmin: sign the user in first");
  const id = await grantSupportSession(admin, authSessionId, userId, tenantId);
  await admin.query(
    `UPDATE sessions SET active_tenant_id = $2, active_store_id = NULL WHERE id = $1`,
    [authSessionId, tenantId],
  );
  return id;
}

/**
 * Give an existing auth session (already pointing at `tenantId`) an active
 * support session for it. For fixtures that seed `sessions` rows directly.
 */
export async function grantSupportSession(
  admin: Pool,
  authSessionId: string,
  userId: string,
  tenantId: string,
): Promise<string> {
  await admin.query(
    `UPDATE platform_support_sessions SET ended_at = now(), end_reason = 'replaced'
      WHERE auth_session_id = $1 AND ended_at IS NULL`,
    [authSessionId],
  );
  const opened = await admin.query<{ id: string }>(
    `INSERT INTO platform_support_sessions
       (id, auth_session_id, user_id, tenant_id, purpose, opened_at, expires_at, renewal_cap_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'customer_support', now(),
             now() + interval '60 minutes', now() + interval '8 hours')
     RETURNING id`,
    [authSessionId, userId, tenantId],
  );
  return opened.rows[0]!.id;
}
