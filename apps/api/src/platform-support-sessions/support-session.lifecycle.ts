/**
 * Ending support sessions from outside the support-session surface (RT-414):
 * a tenant switch (`tenant_switched`) and sign-out or revocation of the auth
 * session (`signed_out`). Each ended row and its `platform.support_session.ended`
 * audit row are written in one transaction under the platform-admin GUC.
 *
 * Plain functions over the domain pool, so `AuthService` and `ContextService`
 * can call them without a module dependency on the support-session surface.
 */
import type { Pool, PoolClient } from "pg";

import { runWithTenantContext, type SupportSessionEndReason } from "@data-pulse-2/db";

import {
  SUPPORT_SESSION_ENDED,
  endLiveSupportSessions,
  findLiveSupportSession,
  recordSupportSessionChange,
  type SupportSessionRecord,
} from "./support-session.store";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** The bootstrap RLS context: platform-admin GUC, no tenant. */
export function withSupportSessionCtx<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return runWithTenantContext(pool, { tenantId: NIL_UUID, isPlatformAdmin: true }, work);
}

export type SupportSessionOwner = { readonly authSessionId: string } | { readonly userId: string };

/** End and audit every live support session of `owner`. No-op when none is live. */
export async function endSupportSessions(
  pool: Pool,
  owner: SupportSessionOwner,
  reason: SupportSessionEndReason,
  requestId: string | null,
): Promise<void> {
  await withSupportSessionCtx(pool, async (client) => {
    const ended = await endLiveSupportSessions(client, owner, reason);
    // One client: pg runs these in order; Promise.all only avoids awaiting in a loop.
    await Promise.all(
      ended.map((record) => recordSupportSessionChange(client, SUPPORT_SESSION_ENDED, record, requestId)),
    );
  });
}

/** The live support session of an auth session (for `ContextResponse.support_session`). */
export function readLiveSupportSession(
  pool: Pool,
  authSessionId: string,
): Promise<SupportSessionRecord | null> {
  return withSupportSessionCtx(pool, (client) => findLiveSupportSession(client, authSessionId));
}
