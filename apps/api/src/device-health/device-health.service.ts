/**
 * DeviceHealthService: the Console reads `consoleListDeviceHealth` and
 * `consoleGetDeviceHealth` (RT-327, AD-DEVICE-001 D-4, D-5, D-7;
 * `pos-device-health.openapi.yaml`).
 *
 * DATA ACCESS: raw parameterized SQL under `runWithTenantContext`, as the
 * devices reads do (`DevicesService`).
 *
 * Invariants:
 *   - Tenant: RLS on `devices` and `device_health` plus an explicit
 *     `tenant_id` predicate. The tenant is the session's, never the
 *     request's (§II, §XII).
 *   - Store: the operator-surface store scope (`operator-store-scope.ts`) is a
 *     `store_id` predicate (RLS isolates tenants only), so an out-of-scope
 *     device reads as absent; an empty scope matches nothing (fail closed). A
 *     `store_id` filter outside the scope, or of another tenant, is the
 *     non-disclosing 404.
 *   - One row per device in scope, including devices that never sent a
 *     heartbeat (`liveness: unknown`, `compliance: unknown`): the health row
 *     and the channel's policy are LEFT JOINs. The policy is the CURRENT one:
 *     compliance is derived at this read and never stored.
 *   - `liveness` and `compliance` filters match the derived values. The
 *     version comparison is in code, not SQL, so a filtered list reads keyset
 *     batches of devices (ordered by device id) and keeps the matches until a
 *     page and one more row are collected, or until `maxScanned` devices have
 *     been read: then the page is short and the cursor is at the last device
 *     scanned (see `collect`).
 *   - Nothing is written, audited or locked.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { MembershipRepository } from "../context/membership.repository";
import { scopeStoreIds } from "../context/operator-store-scope";
import type { StoreScope } from "../context/store-scope";
import { resolveDeviceCaller, storeInCallerScope, type ScopedInput } from "../devices/device-caller";
import type { Compliance } from "./compliance";
import {
  decodeDeviceHealthCursor,
  deriveVerdicts,
  encodeDeviceHealthCursor,
  toDeviceHealthView,
  type DeviceHealthPage,
  type DeviceHealthReadRow,
  type DeviceHealthViewBody,
  type TrustState,
} from "./device-health.projections";
import type { Liveness } from "./liveness";

export type { ScopedInput } from "../devices/device-caller";

/** A device that is absent, foreign or out of scope → the non-disclosing 404. */
export class DeviceHealthNotFoundError extends Error {
  constructor() {
    super("device not found");
    this.name = "DeviceHealthNotFoundError";
  }
}

/** A `store_id` filter outside the caller's scope, or of another tenant → 404. */
export class DeviceHealthStoreNotInScopeError extends Error {
  constructor() {
    super("store not found");
    this.name = "DeviceHealthStoreNotInScopeError";
  }
}

export interface ListDeviceHealthInput extends ScopedInput {
  readonly storeId?: string;
  readonly trustState?: TrustState;
  readonly appVersion?: string;
  readonly updateChannel?: string;
  readonly compliance?: Compliance;
  readonly liveness?: Liveness;
  /** Opaque cursor from a prior page, or null for the first page. */
  readonly cursor: string | null;
  readonly limit: number;
}

/** DI token of the derived-filter scan limits (a test passes small ones). */
export const DEVICE_HEALTH_SCAN = "DEVICE_HEALTH_SCAN";

export interface DeviceHealthScanLimits {
  /** Devices read per statement when a derived filter makes the page a scan. */
  readonly batchSize: number;
  /** Devices one request may scan before it returns a cursor at the last one scanned. */
  readonly maxScanned: number;
}

const DEFAULT_SCAN_LIMITS: DeviceHealthScanLimits = { batchSize: 200, maxScanned: 1000 };

const TRUST_STATE_SQL = `CASE WHEN d.retired_at IS NOT NULL THEN 'retired'
                            WHEN d.revoked_at IS NOT NULL THEN 'revoked'
                            ELSE 'active' END`;

const SELECT_SQL = `
  SELECT d.id AS device_id, d.store_id, d.label,
         ${TRUST_STATE_SQL} AS trust_state,
         d.last_seen_at AS activity_last_seen_at,
         h.last_seen_at AS heartbeat_at,
         h.app_version, h.update_channel, h.update_state, h.pending_version,
         h.schema_head, h.source_clock_at,
         p.min_supported_version, p.min_supported_grace_until
    FROM devices d
    LEFT JOIN device_health h ON h.device_id = d.id AND h.tenant_id = d.tenant_id
    LEFT JOIN pos_version_policy p ON p.channel = h.update_channel`;

/**
 * $1 tenant, $2 scoped store ids (null = tenant-wide), $3 store filter,
 * $4 trust state, $5 app version, $6 update channel, $7 after device id,
 * $8 limit.
 */
const LIST_SQL = `${SELECT_SQL}
   WHERE d.tenant_id = $1::uuid
     AND ($2::uuid[] IS NULL OR d.store_id = ANY($2::uuid[]))
     AND ($3::uuid IS NULL OR d.store_id = $3::uuid)
     AND (($4::text IS NULL AND d.retired_at IS NULL)
          OR ($4::text = 'active' AND d.revoked_at IS NULL)
          OR ($4::text = 'revoked' AND d.revoked_at IS NOT NULL AND d.retired_at IS NULL)
          OR ($4::text = 'retired' AND d.retired_at IS NOT NULL))
     AND ($5::text IS NULL OR h.app_version = $5::text)
     AND ($6::text IS NULL OR h.update_channel = $6::text)
     AND ($7::uuid IS NULL OR d.id > $7::uuid)
   ORDER BY d.id
   LIMIT $8`;

/** $1 tenant, $2 scoped store ids (null = tenant-wide), $3 device id. */
const GET_SQL = `${SELECT_SQL}
   WHERE d.tenant_id = $1::uuid
     AND ($2::uuid[] IS NULL OR d.store_id = ANY($2::uuid[]))
     AND d.id = $3::uuid`;

@Injectable()
export class DeviceHealthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
    @Optional() @Inject(DEVICE_HEALTH_SCAN) private readonly limits: DeviceHealthScanLimits = DEFAULT_SCAN_LIMITS,
  ) {}

  /** One page of device health by device id. A foreign cursor is a 400 before any read. */
  async list(input: ListDeviceHealthInput): Promise<DeviceHealthPage> {
    const after = input.cursor === null ? null : decodeDeviceHealthCursor({ tenantId: input.tenantId, cursor: input.cursor });
    return this.inTenant(input, async (client) => {
      const { scope } = await resolveDeviceCaller(this.memberships, client, input);
      if (input.storeId !== undefined) await this.assertStoreInScope(client, input, scope, input.storeId);
      const now = new Date();
      const { matches, resumeAfter } = await this.collect({ client, input, scope, now }, after);
      const page = matches.slice(0, input.limit);
      const last = page.at(-1);
      // Another page follows when a match was left over, or when the scan stopped at its cap.
      const cursorDevice = matches.length > input.limit && last !== undefined ? last.device_id : resumeAfter;
      return {
        items: page.map((row) => toDeviceHealthView(row, now)),
        nextCursor: cursorDevice === null ? null : encodeDeviceHealthCursor({ tenantId: input.tenantId, deviceId: cursorDevice }),
      };
    });
  }

  /** One device's health. Absent, foreign or out of scope → `DeviceHealthNotFoundError`. */
  async get(input: ScopedInput, deviceId: string): Promise<DeviceHealthViewBody> {
    return this.inTenant(input, async (client) => {
      const { scope } = await resolveDeviceCaller(this.memberships, client, input);
      const res = await client.query<DeviceHealthReadRow>(GET_SQL, [input.tenantId, scopeStoreIds(scope), deviceId]);
      const row = res.rows[0];
      if (row === undefined) throw new DeviceHealthNotFoundError();
      return toDeviceHealthView(row, new Date());
    });
  }

  /**
   * Up to `limit + 1` rows after `after` that match every filter, in device id
   * order (the extra row tells whether another page follows). A derived filter
   * scans at most `maxScanned` devices: past that, `resumeAfter` is the last
   * device scanned, so the client resumes there without re-reading anything
   * and a selective filter never reads a whole fleet in one request.
   */
  private async collect(scan: ScanContext, after: string | null): Promise<{ matches: DeviceHealthReadRow[]; resumeAfter: string | null }> {
    const wanted = scan.input.limit + 1;
    const scanning = hasDerivedFilter(scan.input);
    const matches: DeviceHealthReadRow[] = [];
    let cursor = after;
    let scanned = 0;
    while (matches.length < wanted) {
      const size = scanning ? Math.min(this.limits.batchSize, this.limits.maxScanned - scanned) : wanted;
      const rows = await this.fetchBatch(scan, cursor, size);
      scanned += rows.length;
      const fresh = rows.filter((row) => matchesDerived(row, scan.input, scan.now));
      matches.push(...fresh.slice(0, wanted - matches.length));
      cursor = rows.at(-1)?.device_id ?? null;
      if (rows.length < size || cursor === null) break;
      if (scanning && scanned >= this.limits.maxScanned && matches.length < wanted) return { matches, resumeAfter: cursor };
    }
    return { matches, resumeAfter: null };
  }

  private async fetchBatch(scan: ScanContext, after: string | null, size: number): Promise<DeviceHealthReadRow[]> {
    const { input } = scan;
    const res = await scan.client.query<DeviceHealthReadRow>(LIST_SQL, [
      input.tenantId,
      scopeStoreIds(scan.scope),
      input.storeId ?? null,
      input.trustState ?? null,
      input.appVersion ?? null,
      input.updateChannel ?? null,
      after,
      size,
    ]);
    return res.rows;
  }

  private async assertStoreInScope(client: PoolClient, input: ScopedInput, scope: StoreScope, storeId: string): Promise<void> {
    if (!(await storeInCallerScope(client, { tenantId: input.tenantId, scope, storeId }))) {
      throw new DeviceHealthStoreNotInScopeError();
    }
  }

  private inTenant<T>(input: ScopedInput, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, work);
  }
}

/** What one list scan reads under: the transaction, the filters, the caller's store scope and the read clock. */
interface ScanContext {
  readonly client: PoolClient;
  readonly input: ListDeviceHealthInput;
  readonly scope: StoreScope;
  readonly now: Date;
}

function hasDerivedFilter(input: ListDeviceHealthInput): boolean {
  return input.liveness !== undefined || input.compliance !== undefined;
}

function matchesDerived(row: DeviceHealthReadRow, input: ListDeviceHealthInput, now: Date): boolean {
  if (!hasDerivedFilter(input)) return true;
  const verdicts = deriveVerdicts(row, now);
  return (
    (input.liveness === undefined || verdicts.liveness === input.liveness) &&
    (input.compliance === undefined || verdicts.compliance === input.compliance)
  );
}
