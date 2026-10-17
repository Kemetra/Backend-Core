/**
 * The caller of a Console device-registry operation (RT-365 / RT-367): its
 * role in the session's tenant and its operator store scope
 * (`operator-store-scope.ts`, RT-51 D6 / RT-131 / RT-132). Shared by
 * `DevicesService` and `PairingCodesService`, so both bound a call the same way.
 */
import type { PoolClient } from "pg";

import type { MembershipRepository } from "../context/membership.repository";
import { inStoreScope, readScope } from "../context/operator-store-scope";
import type { StoreScope } from "../context/store-scope";
import type { ResolvedContext } from "../context/types";

/** The session context of a call; its role and store scope bound it. */
export interface ScopedInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
}

export interface DeviceCaller {
  readonly roleCode: string | null;
  readonly scope: StoreScope;
}

/** The caller's role in the tenant and its operator store scope (RLS-scoped read). */
export async function resolveDeviceCaller(
  memberships: MembershipRepository,
  client: PoolClient,
  input: ScopedInput,
): Promise<DeviceCaller> {
  const userId = input.context.userId;
  const roleCode =
    userId !== null ? await memberships.findRoleCodeForUserInTenant(userId, input.tenantId, client) : null;
  return { roleCode, scope: readScope({ context: input.context, roleCode }) };
}

/**
 * True when `storeId` is in the caller's scope and is a store of the tenant
 * (`liveOnly`: and not soft-deleted). A store outside either reads as absent.
 */
export async function storeInCallerScope(
  client: PoolClient,
  input: { readonly tenantId: string; readonly scope: StoreScope; readonly storeId: string; readonly liveOnly?: boolean },
): Promise<boolean> {
  if (!inStoreScope(input.scope, input.storeId)) return false;
  const r = await client.query<{ id: string }>(
    `SELECT id FROM stores WHERE id = $1::uuid AND tenant_id = $2::uuid AND ($3::boolean IS FALSE OR deleted_at IS NULL)`,
    [input.storeId, input.tenantId, input.liveOnly === true],
  );
  return r.rows.length > 0;
}
