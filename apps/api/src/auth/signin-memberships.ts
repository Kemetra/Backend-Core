/**
 * RT-343 — the memberships `POST /api/v1/auth/signin` returns
 * (`SignInResponse.memberships`, OpenAPI `MembershipSummary`).
 *
 * Reads on the DOMAIN pool, never the auth-lookup pool: the lookup role may
 * hold no privilege on `tenants` (RT-213) and none on `memberships`. The
 * tables are row-level secured and no tenant is active yet at sign-in, so the
 * read runs in the same platform-admin bootstrap context that
 * `ContextService` uses for `GET /api/v1/context/me` (nil tenant id +
 * `is_platform_admin`), filtered to the signing-in user's own memberships,
 * in a single query (no per-membership store-id lookups).
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";
import { MembershipRepository } from "../context/membership.repository";
import type { SignInMembership } from "./dto";

export type SignInMembershipsReader = (userId: string) => Promise<readonly SignInMembership[]>;

export function signInMembershipsReader(domainPool: Pool): SignInMembershipsReader {
  const memberships = new MembershipRepository(domainPool);
  return async (userId) => {
    // tenantId null maps to the nil tenant id; access comes from the
    // platform-admin flag, and the query itself is limited to `userId`.
    const summaries = await runWithTenantContext(
      domainPool,
      { tenantId: null, isPlatformAdmin: true },
      (client) => memberships.listTenantRolesForUser(userId, client),
    );
    return summaries.map((m) => ({
      tenant_id: m.tenantId,
      tenant_name: m.tenantName,
      role_code: m.roleCode,
      store_access_kind: m.storeAccessKind,
    }));
  };
}
