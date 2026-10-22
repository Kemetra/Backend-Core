/**
 * DeviceBuildsService: `consoleGetFleetBaseline` (RT-719,
 * `console-device-builds.openapi.yaml`).
 *
 * DATA ACCESS: raw parameterized SQL under `runWithTenantContext`, as the
 * sibling devices reads. Invariants:
 *   - Tenant: RLS on `devices` plus an explicit `tenant_id` predicate; the
 *     tenant is the session's, never the request's (§II, §XII).
 *   - Store: the operator-surface store scope (`operator-store-scope.ts`) is a
 *     `store_id` predicate (RLS isolates tenants only). A `store_id` outside
 *     the scope, of another tenant, or absent is the non-disclosing 404; an
 *     empty scope matches no device and fails closed.
 *   - Scope of the count: the ACTIVE devices (`revoked_at IS NULL`; a retired
 *     device is revoked). A revoked or retired device cannot authenticate or
 *     sync and is no compatibility risk, so it is not counted; its last
 *     identity stays readable on the device's `buildIdentity`.
 *   - ONE statement, so one database snapshot: the groups are computed by the
 *     server and a client never derives them by counting `buildIdentity` keys
 *     across pages. Ordered by commit, version, pin in plain code-unit order
 *     (`COLLATE "C"`), nulls last, so the order never depends on the database
 *     locale.
 *   - Nothing is written. The audit event is the controller's.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { MembershipRepository } from "../context/membership.repository";
import { scopeStoreIds } from "../context/operator-store-scope";
import { resolveDeviceCaller, storeInCallerScope, type ScopedInput } from "./device-caller";
import { toFleetBaseline, type FleetBaseline, type FleetBuildGroupRow } from "./device-builds.projections";
import { DeviceStoreNotInScopeError } from "./devices.service";

export interface FleetBaselineInput extends ScopedInput {
  readonly storeId?: string;
}

/** $1 tenant, $2 scoped store ids (null = tenant-wide), $3 store filter. */
const BASELINE_SQL = `
  SELECT d.reported_build_commit AS build_commit,
         d.reported_app_version AS app_version,
         d.reported_contract_pin AS contract_pin,
         count(*)::int AS device_count,
         min(d.build_reported_at) AS oldest_reported_at,
         max(d.build_reported_at) AS latest_reported_at
    FROM devices d
   WHERE d.tenant_id = $1::uuid
     AND d.revoked_at IS NULL
     AND ($2::uuid[] IS NULL OR d.store_id = ANY($2::uuid[]))
     AND ($3::uuid IS NULL OR d.store_id = $3::uuid)
   GROUP BY d.reported_build_commit, d.reported_app_version, d.reported_contract_pin
   ORDER BY d.reported_build_commit COLLATE "C" NULLS LAST,
            d.reported_app_version COLLATE "C" NULLS LAST,
            d.reported_contract_pin COLLATE "C" NULLS LAST`;

@Injectable()
export class DeviceBuildsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /** The baseline of the caller's scope (or of the one `storeId`). A store out of scope → `DeviceStoreNotInScopeError`. */
  async baseline(input: FleetBaselineInput): Promise<FleetBaseline> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) => {
      const { scope } = await resolveDeviceCaller(this.memberships, client, input);
      if (input.storeId !== undefined && !(await storeInCallerScope(client, { tenantId: input.tenantId, scope, storeId: input.storeId }))) {
        throw new DeviceStoreNotInScopeError();
      }
      const res = await client.query<FleetBuildGroupRow>(BASELINE_SQL, [input.tenantId, scopeStoreIds(scope), input.storeId ?? null]);
      return toFleetBaseline({ rows: res.rows, storeId: input.storeId ?? null, generatedAt: new Date() });
    });
  }
}
