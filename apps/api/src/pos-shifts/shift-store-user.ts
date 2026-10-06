/**
 * Envelope-path check of a stated user (RT-17 slice 2b; #711 review note 1).
 *
 * On the manager-envelope (repair) path the envelope operator is the actor,
 * and a stated `openingUserId` / `closingUserId` is recorded as stated. It
 * must still be a user of the caller's tenant with access to the store
 * (`pos-shifts.openapi.yaml`, "Attribution"), else 403 `refused`:
 *
 *   - an active membership in the tenant (not revoked, not soft-deleted);
 *   - the user is not deleted;
 *   - store access: `store_access_kind = 'all'`, or a `store_access` row for
 *     the store.
 *
 * No role rule: the closing user may be a manager. On the device path the
 * stated user must equal the verified cashier instead (the guard), so this
 * check is not needed there. Runs on the caller's tenant-scoped client
 * (RLS); scope comes from the credential only.
 *
 * The close's `varianceApprovedByUserId` (RT-17 slice 2b-2) is checked more
 * loosely, on both paths: it must name a user of the caller's tenant (a
 * membership of any state: the approving manager may have left since the
 * offline close), else 400 `validation_error`. Its role never refuses the
 * close (10919 decision 1). Once the close is recorded, `approverStanding`
 * reads the approver's current standing for the ingest signal (RT-17
 * comment 10955, option A; `shift-close-approver.ts`): detected, never
 * refused.
 */
import type { PoolClient } from "pg";

import type { DeviceScope } from "../pos-cashier-admissions/device-scope";

const STORE_USER_SQL = `
  SELECT EXISTS (
    SELECT 1
      FROM memberships m
      JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = $1
       AND m.user_id = $3
       AND m.revoked_at IS NULL
       AND m.deleted_at IS NULL
       AND u.deleted_at IS NULL
       AND (m.store_access_kind = 'all'
            OR EXISTS (SELECT 1 FROM store_access sa
                        WHERE sa.membership_id = m.id AND sa.store_id = $2))
  ) AS ok`;

const TENANT_USER_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM memberships m WHERE m.tenant_id = $1 AND m.user_id = $2
  ) AS ok`;

/**
 * The approver's standing: the tenant's live membership row if there is one
 * (else its most recent past one), its role code, and its access to the
 * store. RLS scopes it to the caller's tenant; `tenant_id` is also matched.
 */
const APPROVER_STANDING_SQL = `
  SELECT (m.revoked_at IS NULL AND m.deleted_at IS NULL AND u.deleted_at IS NULL) AS active,
         r.code AS role_code,
         (m.store_access_kind = 'all'
          OR EXISTS (SELECT 1 FROM store_access sa
                      WHERE sa.membership_id = m.id AND sa.store_id = $2)) AS store_access
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    JOIN roles r ON r.id = m.role_id
   WHERE m.tenant_id = $1
     AND m.user_id = $3
   ORDER BY (m.revoked_at IS NULL AND m.deleted_at IS NULL) DESC, m.created_at DESC, m.id
   LIMIT 1`;

/** An approver's standing in the tenant and store (see APPROVER_STANDING_SQL). */
export interface ApproverStanding {
  /** The membership is not revoked or deleted, and the user is not deleted. */
  readonly active: boolean;
  /** The membership's role code (`roles.code`). */
  readonly roleCode: string;
  /** `store_access_kind = 'all'`, or a `store_access` row for the store. */
  readonly storeAccess: boolean;
}

/** A stated user and the credential's scope it must belong to. */
export interface StoreUser {
  readonly scope: DeviceScope;
  readonly userId: string;
}

export class ShiftStoreUserReader {
  /** True iff the user is an active user of the scope's tenant with access to its store. */
  async isStoreUser(client: PoolClient, user: StoreUser): Promise<boolean> {
    const r = await client.query<{ ok: boolean }>(STORE_USER_SQL, [
      user.scope.tenantId,
      user.scope.storeId,
      user.userId,
    ]);
    return r.rows[0]?.ok === true;
  }

  /** The user's standing in the scope's tenant and store; null when no membership row resolves. */
  async approverStanding(client: PoolClient, user: StoreUser): Promise<ApproverStanding | null> {
    const r = await client.query<{ active: boolean; role_code: string; store_access: boolean }>(APPROVER_STANDING_SQL, [
      user.scope.tenantId,
      user.scope.storeId,
      user.userId,
    ]);
    const row = r.rows[0];
    return row === undefined ? null : { active: row.active, roleCode: row.role_code, storeAccess: row.store_access };
  }

  /** True iff the user has (or had) a membership of the scope's tenant; no store or role rule. */
  async isTenantUser(client: PoolClient, user: StoreUser): Promise<boolean> {
    const r = await client.query<{ ok: boolean }>(TENANT_USER_SQL, [user.scope.tenantId, user.userId]);
    return r.rows[0]?.ok === true;
  }
}
