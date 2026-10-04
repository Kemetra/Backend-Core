/**
 * Cashier eligibility and roster for the device's store (RT-113 BC2, D2 /
 * D11).
 *
 * A cashier may be admitted — and appears in the roster — iff, in the
 * device's tenant and store:
 *
 *   - the membership is active (not revoked, not soft-deleted);
 *   - the user is not deleted;
 *   - the role is the POS-eligible cashier role, `store_staff` (the role the
 *     operator roster maps to POS `cashier`, FR-015);
 *   - the store is active (not soft-deleted, `is_active`);
 *   - the user can access the store (`store_access_kind = 'all'`, or a
 *     `store_access` row for it);
 *   - the user has a provider subject and a display name (the roster's
 *     `operator_id` / `display_name` are required on the wire).
 *
 * These are the existing predicates of `PosOperatorsService` (membership /
 * store access / the store_staff roster query) applied to the device's scope.
 * Both queries run on the caller's tenant-scoped client, under RLS. The
 * roster and the admission check share one predicate set so the roster is
 * exactly the admissible set.
 */
import type { PoolClient } from "pg";

import type { RosterEntry } from "./dto";
import type { DeviceScope } from "./device-scope";

/** The POS-eligible cashier role (the roster's `cashier`). */
export const CASHIER_ROLE_CODE = "store_staff";

/** Server-side refusal categories. Logged and audited; never returned. */
export type RefusalReason =
  | "membership_inactive"
  | "user_deleted"
  | "role_ineligible"
  | "store_inactive"
  | "store_not_accessible"
  | "profile_incomplete";

export type Eligibility =
  | { readonly eligible: true; readonly displayName: string; readonly operatorId: string }
  | { readonly eligible: false; readonly reason: RefusalReason };

/** One row per active membership of the user in the device's tenant. */
export interface EligibilityRow {
  readonly user_deleted: boolean;
  readonly display_name: string | null;
  readonly operator_id: string | null;
  readonly role_eligible: boolean;
  readonly store_active: boolean;
  readonly store_accessible: boolean;
}

const RULES: ReadonlyArray<readonly [RefusalReason, (row: EligibilityRow) => boolean]> = [
  ["user_deleted", (row) => !row.user_deleted],
  ["role_ineligible", (row) => row.role_eligible],
  ["store_inactive", (row) => row.store_active],
  ["store_not_accessible", (row) => row.store_accessible],
  ["profile_incomplete", (row) => row.operator_id !== null && row.display_name !== null],
];

/** Classify an eligibility row; the first failing rule names the cause. */
export function classifyEligibility(row: EligibilityRow | undefined): Eligibility {
  if (!row) return { eligible: false, reason: "membership_inactive" };
  const failed = RULES.find(([, passes]) => !passes(row));
  if (failed) return { eligible: false, reason: failed[0] };
  return { eligible: true, displayName: row.display_name!, operatorId: row.operator_id! };
}

/** Store access for membership `m` and store `$store`. */
const STORE_ACCESSIBLE_SQL = `(
  m.store_access_kind = 'all'
  OR EXISTS (SELECT 1 FROM store_access sa WHERE sa.membership_id = m.id AND sa.store_id = $2)
)`;

/** Store `$store` of tenant `$tenant` is live. */
const STORE_ACTIVE_SQL = `EXISTS (
  SELECT 1 FROM stores s
   WHERE s.id = $2 AND s.tenant_id = $1 AND s.deleted_at IS NULL AND s.is_active
)`;

const ACTIVE_MEMBERSHIP_SQL = `m.tenant_id = $1 AND m.revoked_at IS NULL AND m.deleted_at IS NULL`;

const ELIGIBILITY_SQL = `
  SELECT u.deleted_at IS NOT NULL                AS user_deleted,
         u.display_name                          AS display_name,
         u.clerk_user_id                         AS operator_id,
         r.code = '${CASHIER_ROLE_CODE}'         AS role_eligible,
         ${STORE_ACTIVE_SQL}                     AS store_active,
         ${STORE_ACCESSIBLE_SQL}                 AS store_accessible
    FROM memberships m
    JOIN roles r ON r.id = m.role_id
    JOIN users u ON u.id = m.user_id
   WHERE ${ACTIVE_MEMBERSHIP_SQL}
     AND m.user_id = $3
   LIMIT 1`;

const ROSTER_SQL = `
  SELECT u.id AS user_id, u.clerk_user_id AS operator_id, u.display_name AS display_name
    FROM memberships m
    JOIN roles r ON r.id = m.role_id
    JOIN users u ON u.id = m.user_id
   WHERE ${ACTIVE_MEMBERSHIP_SQL}
     AND r.code = '${CASHIER_ROLE_CODE}'
     AND u.deleted_at IS NULL
     AND u.clerk_user_id IS NOT NULL
     AND u.display_name IS NOT NULL
     AND ${STORE_ACTIVE_SQL}
     AND ${STORE_ACCESSIBLE_SQL}
   ORDER BY u.display_name, u.id`;

export interface CashierEligibilityReader {
  check(client: PoolClient, scope: DeviceScope, userId: string): Promise<Eligibility>;
  roster(client: PoolClient, scope: DeviceScope): Promise<RosterEntry[]>;
}

export class CashierEligibilityRepository implements CashierEligibilityReader {
  async check(client: PoolClient, scope: DeviceScope, userId: string): Promise<Eligibility> {
    const r = await client.query<EligibilityRow>(ELIGIBILITY_SQL, [scope.tenantId, scope.storeId, userId]);
    return classifyEligibility(r.rows[0]);
  }

  async roster(client: PoolClient, scope: DeviceScope): Promise<RosterEntry[]> {
    const r = await client.query<RosterEntry>(ROSTER_SQL, [scope.tenantId, scope.storeId]);
    return r.rows.map((row) => ({
      user_id: row.user_id,
      operator_id: row.operator_id,
      display_name: row.display_name,
    }));
  }
}
