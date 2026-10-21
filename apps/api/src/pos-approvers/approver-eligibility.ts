/**
 * Approver eligibility for the device's tenant and store (RT-788, RT-114
 * MA-BC2; contract `pos-approvers.openapi.yaml`, "V1 eligibility").
 *
 * A user is eligible iff, in the device's tenant and store:
 *
 *   1. the user exists and is not deleted;
 *   2. the user has an ACTIVE membership in the tenant (not revoked, not
 *      soft-deleted);
 *   3. that membership's role is in `{owner, tenant_admin, store_manager}`,
 *      the set the RT-17 shift-variance and RT-530 void approvers use;
 *   4. that membership can access the store: `store_access_kind = 'all'`, or
 *      a `store_access` row for it.
 *
 * Every requested id is evaluated in ONE read on the caller's tenant-scoped
 * client (RLS), so the response time does not depend on which predicate
 * failed. RLS isolates tenants only: the store predicate (4) is enforced here
 * and nowhere else. The tenant is also matched explicitly.
 *
 * The aggregate columns are cumulative (each implies the one before, on the
 * SAME membership row), so `eligible` holds only when one membership meets
 * all four predicates, and the first false column names the server-side
 * cause. Several membership rows of one user collapse to one row per id.
 */
import type { PoolClient } from "pg";

import { APPROVER_ROLE_CODES } from "../pos-shifts/shift-close-approver";
import type { DeviceScope } from "../pos-cashier-admissions/device-scope";

export { APPROVER_ROLE_CODES };

/** Server-side ineligibility causes. Logged; never returned. */
export type IneligibleCause = "membership_inactive" | "user_deleted" | "role_ineligible" | "store_not_accessible";

export type ApproverVerdict =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly cause: IneligibleCause };

/** One row per requested id (canonical lowercase `user_id`). */
export interface ApproverRow {
  readonly user_id: string;
  /** An active membership in the device's tenant. */
  readonly membership_active: boolean;
  /** ... and the user is not deleted. */
  readonly user_live: boolean;
  /** ... and the membership's role is manager-eligible. */
  readonly role_eligible: boolean;
  /** ... and the membership can access the device's store. */
  readonly eligible: boolean;
}

const RULES: ReadonlyArray<readonly [IneligibleCause, (row: ApproverRow) => boolean]> = [
  ["membership_inactive", (row) => row.membership_active],
  ["user_deleted", (row) => row.user_live],
  ["role_ineligible", (row) => row.role_eligible],
  ["store_not_accessible", (row) => row.eligible],
];

/** Classify a row; no row (an unknown or other-tenant id) is an inactive membership. */
export function classifyApprover(row: ApproverRow | undefined): ApproverVerdict {
  if (!row) return { eligible: false, cause: "membership_inactive" };
  const failed = RULES.find(([, passes]) => !passes(row));
  return failed ? { eligible: false, cause: failed[0] } : { eligible: true };
}

// `u.id IS NOT NULL`: a user row the read cannot see is not live (fail closed).
const LIVE_USER = `m.id IS NOT NULL AND u.id IS NOT NULL AND u.deleted_at IS NULL`;
const ROLE_ELIGIBLE = `${LIVE_USER} AND r.code = ANY($4::text[])`;
const STORE_ACCESSIBLE = `(
  m.store_access_kind = 'all'
  OR EXISTS (SELECT 1 FROM store_access sa WHERE sa.membership_id = m.id AND sa.store_id = $2)
)`;

const ELIGIBILITY_SQL = `
  SELECT req.user_id::text                                                    AS user_id,
         COALESCE(bool_or(m.id IS NOT NULL), false)                           AS membership_active,
         COALESCE(bool_or(${LIVE_USER}), false)                               AS user_live,
         COALESCE(bool_or(${ROLE_ELIGIBLE}), false)                           AS role_eligible,
         COALESCE(bool_or(${ROLE_ELIGIBLE} AND ${STORE_ACCESSIBLE}), false)   AS eligible
    FROM unnest($3::uuid[]) AS req(user_id)
    LEFT JOIN memberships m
           ON m.user_id = req.user_id
          AND m.tenant_id = $1
          AND m.revoked_at IS NULL
          AND m.deleted_at IS NULL
    LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN roles r ON r.id = m.role_id
   GROUP BY req.user_id`;

export interface ApproverEligibilityReader {
  evaluate(client: PoolClient, scope: DeviceScope, userIds: readonly string[]): Promise<ApproverRow[]>;
}

export class ApproverEligibilityRepository implements ApproverEligibilityReader {
  async evaluate(client: PoolClient, scope: DeviceScope, userIds: readonly string[]): Promise<ApproverRow[]> {
    const r = await client.query<ApproverRow>(ELIGIBILITY_SQL, [
      scope.tenantId,
      scope.storeId,
      userIds,
      [...APPROVER_ROLE_CODES],
    ]);
    return r.rows;
  }
}
