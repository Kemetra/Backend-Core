/**
 * RT-343 — the memberships `POST /api/v1/auth/signin` returns
 * (`SignInResponse.memberships`, OpenAPI `MembershipSummary`).
 *
 * Reads on the DOMAIN pool, never the auth-lookup pool: the lookup role may
 * hold no privilege on `tenants` (RT-213) and none on `memberships`. The
 * tables are row-level secured and no tenant is active yet at sign-in, so the
 * read runs in the same platform-admin bootstrap context that
 * `ContextService` uses for `GET /api/v1/context/me` (nil tenant id +
 * `is_platform_admin`), filtered to the signing-in user's own memberships.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";
import { MembershipRepository } from "../context/membership.repository";
import type { SignInMembership } from "./dto";

const NIL_TENANT_ID = "00000000-0000-0000-0000-000000000000";

export type SignInMembershipsReader = (userId: string) => Promise<readonly SignInMembership[]>;

export function signInMembershipsReader(domainPool: Pool): SignInMembershipsReader {
  const memberships = new MembershipRepository(domainPool);
  return async (userId) => {
    const summaries = await runWithTenantContext(
      domainPool,
      { tenantId: NIL_TENANT_ID, isPlatformAdmin: true },
      (client) => memberships.listForUser(userId, client),
    );
    return summaries.map((m) => ({
      tenant_id: m.tenantId,
      tenant_name: m.tenantName,
      role_code: m.roleCode,
      store_access_kind: m.storeAccessKind,
    }));
  };
}
