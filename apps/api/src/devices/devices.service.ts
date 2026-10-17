/**
 * DevicesService — RT-365 (RT-287 F2): the Console device registry
 * (`devices.openapi.yaml`): the fleet list, a device's detail and the revoke.
 *
 * DATA ACCESS — raw parameterized SQL under `runWithTenantContext`, as on the
 * sibling Console reads (`ShiftClosesReadService`).
 *
 * Invariants:
 *   - Tenant: RLS on `devices`, `shifts`, `pairing_codes`, `auth_tokens` plus
 *     an explicit `tenant_id` predicate on every statement. The tenant is the
 *     session's, never the request's (§II, §XII).
 *   - Store: the operator-surface store scope (`operator-store-scope.ts`,
 *     RT-51 D6 / RT-131 / RT-132) is a `store_id` predicate on the reads and a
 *     check on the locked row for the revoke, so an out-of-scope device reads
 *     as absent. An empty scope matches nothing (fail closed).
 *   - Open shift: any `shifts` row opened on the device with
 *     `lifecycle_state = 'open'` (legacy or cash_up), the predicate
 *     `StoresRepository.countOpenShifts` uses for a store. The custody
 *     exception is derived from it on a revoked device; nothing is stored.
 *   - Revoke is ONE transaction: it takes the device lifecycle lock
 *     (`device-lifecycle-lock.ts`), which every shift open also takes before
 *     re-reading `revoked_at`, so a shift never opens on a device after its
 *     revoke commits and a shift that opened first is seen; then it locks
 *     the device row `FOR UPDATE` (two revokes serialize, the second answers
 *     `already_revoked`). Then the D-Q4 decision (`decideRevoke`), the
 *     revoke fields, the operator-session and pending-code cascade and the
 *     `pos.device.revoked` audit row. A refusal
 *     changes nothing. No shift or cash fact is ever written here.
 *   - Audit metadata is the RT-135 allowlist: reason, counts, custody flag and
 *     shift id. Never the note, a token, a hash or a code.
 *   - Impact preview (RT-366): ONE statement (`IMPACT_SQL` in
 *     `device-lifecycle.store.ts`, one snapshot) reads
 *     the device, its open shift with its server-received cash-up facts, and
 *     the cascade counts over the same predicates the revoke applies
 *     (`LIVE_OPERATOR_SESSIONS`, `PENDING_PAIRING_CODES`); the lifecycle
 *     evaluator decides. It takes no lock and writes nothing. The revoke
 *     decides from the same read, taken under its locks, so its verdict and
 *     its 409 `error.details` are the preview of the state it refused.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { evaluateLifecycle, revokeReasonOf, type LifecycleAction } from "./device-lifecycle.evaluator";
import {
  applyDeviceRevoke,
  DETAIL_SQL,
  DEVICE_COLUMNS,
  linksCte,
  lockDeviceForLifecycle,
  readDeviceImpact,
} from "./device-lifecycle.store";
import {
  lifecycleStateOf,
  toDeviceImpactPreview,
  type DeviceImpactPreview,
  type DeviceImpactRow,
} from "./device-impact.projections";
import { MembershipRepository } from "../context/membership.repository";
import { resolveDeviceCaller, storeInCallerScope, type DeviceCaller, type ScopedInput } from "./device-caller";
import { inStoreScope, scopeStoreIds } from "../context/operator-store-scope";
import type { StoreScope } from "../context/store-scope";
import {
  decideRevoke,
  decodeDeviceCursor,
  encodeDeviceCursor,
  evaluateRevokeInput,
  toDeviceDetail,
  toDeviceSummary,
  type DeviceDetail,
  type DevicePage,
  type DeviceReadRow,
  type DeviceRevokeResult,
  type RevokeReason,
  type RevokeRefusalCode,
  type TrustState,
} from "./devices.projections";

/** A device that is absent, foreign or out of scope → the non-disclosing 404. */
export class DeviceNotFoundError extends Error {
  constructor() {
    super("device not found");
    this.name = "DeviceNotFoundError";
  }
}

/** A `store_id` filter outside the caller's scope, or of another tenant → 404. */
export class DeviceStoreNotInScopeError extends Error {
  constructor() {
    super("store not found");
    this.name = "DeviceStoreNotInScopeError";
  }
}

/**
 * A revoke refused by the Cash Session rule (403 / 409 / 422); nothing changed.
 * A 409 carries the refused revoke's impact preview (RT-366).
 */
export class DeviceRevokeRefusedError extends Error {
  constructor(
    readonly status: 403 | 409 | 422,
    readonly code: RevokeRefusalCode,
    readonly impact?: DeviceImpactPreview,
  ) {
    super(code);
    this.name = "DeviceRevokeRefusedError";
  }
}

export type { ScopedInput } from "./device-caller";

export interface ListDevicesInput extends ScopedInput {
  readonly storeId?: string;
  readonly trustState?: TrustState;
  /** Opaque cursor from a prior page, or null for the first page. */
  readonly cursor: string | null;
  readonly limit: number;
}

export interface RevokeDeviceInput extends ScopedInput {
  /** The session user (`users.id`): the revoke's actor. */
  readonly actorUserId: string;
  readonly deviceId: string;
  readonly reason: RevokeReason;
  readonly note?: string;
  readonly acknowledgeCustodyException?: boolean;
}

export interface DeviceImpactInput extends ScopedInput {
  readonly deviceId: string;
  readonly action: LifecycleAction;
  /** The revoke reason; given exactly when `action` is `revoke` (the query schema). */
  readonly reason?: RevokeReason;
}

/** The most recently opened open shift per device of the tenant ($1), computed once for a list. */
const OPEN_SHIFTS_CTE = `
  open_shifts AS (
    SELECT DISTINCT ON (s.opening_device_id) s.opening_device_id, s.shift_id
      FROM shifts s
     WHERE s.tenant_id = $1::uuid AND s.lifecycle_state = 'open'
     ORDER BY s.opening_device_id, s.opened_at DESC, s.shift_id DESC
  )`;

/**
 * $1 tenant, $2 scoped store ids (null = tenant-wide), $3 store filter,
 * $4 trust state, $5 / $6 / $7 keyset (rank, expires_at, id), $8 limit.
 */
const LIST_SQL = `
  WITH ${OPEN_SHIFTS_CTE}, ${linksCte("$2")},
  ranked AS (
    SELECT ${DEVICE_COLUMNS}
      FROM devices d
      LEFT JOIN open_shifts os ON os.opening_device_id = d.id
     WHERE d.tenant_id = $1::uuid
       AND ($2::uuid[] IS NULL OR d.store_id = ANY($2::uuid[]))
       AND ($3::uuid IS NULL OR d.store_id = $3::uuid)
       AND ($4::text IS NULL
            OR ($4::text = 'active' AND d.revoked_at IS NULL)
            OR ($4::text = 'revoked' AND d.revoked_at IS NOT NULL AND d.retired_at IS NULL)
            OR ($4::text = 'retired' AND d.retired_at IS NOT NULL))
  )
  SELECT * FROM ranked
   WHERE ($5::int IS NULL OR (rank, expires_at, id) > ($5::int, $6::timestamptz, $7::uuid))
   ORDER BY rank, expires_at, id
   LIMIT $8`;

@Injectable()
export class DevicesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /**
   * One page of devices, exception-first. The cursor is decoded (400 on a
   * foreign token) before any read. One row beyond `limit` is read to tell
   * whether another page follows.
   */
  async list(input: ListDevicesInput): Promise<DevicePage> {
    const keyset = input.cursor === null ? null : decodeDeviceCursor({ tenantId: input.tenantId, cursor: input.cursor });
    return this.inTenant(input, async (client) => {
      const { scope } = await this.callerOf(client, input);
      if (input.storeId !== undefined) await this.assertStoreInScope(client, input.tenantId, scope, input.storeId);
      const r = await client.query<DeviceReadRow>(LIST_SQL, [
        input.tenantId,
        scopeStoreIds(scope),
        input.storeId ?? null,
        input.trustState ?? null,
        keyset?.rank ?? null,
        keyset?.expiresAtKey ?? null,
        keyset?.deviceId ?? null,
        input.limit + 1,
      ]);
      const rows = r.rows.slice(0, input.limit);
      const last = rows[rows.length - 1];
      const nextCursor =
        r.rows.length > input.limit && last !== undefined
          ? encodeDeviceCursor({
              tenantId: input.tenantId,
              rank: last.rank,
              expiresAtKey: last.expires_at_key,
              deviceId: last.id,
            })
          : null;
      return { items: rows.map(toDeviceSummary), nextCursor };
    });
  }

  /** One device. Absent, foreign or out of scope → `DeviceNotFoundError`. */
  async get(input: ScopedInput, deviceId: string): Promise<DeviceDetail> {
    return this.inTenant(input, async (client) => {
      const { scope } = await this.callerOf(client, input);
      return this.readDetail(client, input.tenantId, deviceId, scopeStoreIds(scope));
    });
  }

  /**
   * Revoke one device under the Cash Session rule (see the class header).
   * Idempotent: an already revoked device answers `already_revoked` with its
   * current state and nothing changes.
   */
  async revoke(input: RevokeDeviceInput): Promise<DeviceRevokeResult> {
    return this.inTenant(input, async (client) => {
      const caller = await this.callerOf(client, input);
      const device = await this.lockInScope(client, input, caller.scope);
      // The impact read, under the locks: the decision and a 409's impact see one state.
      const facts = await this.readImpact(client, input.tenantId, input.deviceId, scopeStoreIds(caller.scope));
      const decisionInput = {
        alreadyRevoked: device.revokedAt !== null,
        openShiftId: facts.open_shift_id,
        reason: input.reason,
        callerRole: caller.roleCode,
        note: input.note,
        acknowledgeCustodyException: input.acknowledgeCustodyException,
      };
      const decision = decideRevoke(decisionInput);
      if (decision.kind === "refuse") {
        const impact =
          decision.status === 409
            ? toDeviceImpactPreview({
                row: facts,
                action: "revoke",
                reason: input.reason,
                evaluation: evaluateRevokeInput(decisionInput),
              })
            : undefined;
        throw new DeviceRevokeRefusedError(decision.status, decision.code, impact);
      }
      const revoked = decision.kind === "revoke";
      if (revoked) {
        await applyDeviceRevoke(client, {
          tenantId: input.tenantId,
          deviceId: input.deviceId,
          storeId: device.storeId,
          actorUserId: input.actorUserId,
          reason: input.reason,
          note: input.note ?? null,
          custodyExceptionShiftId: decision.custodyExceptionShiftId,
        });
      }
      return {
        outcome: revoked ? "revoked" : "already_revoked",
        device: await this.readDetail(client, input.tenantId, input.deviceId, scopeStoreIds(caller.scope)),
      };
    });
  }

  /**
   * The impact preview of one lifecycle action (RT-366): read-only, no lock.
   * Absent, foreign or out of scope → `DeviceNotFoundError`.
   */
  async impact(input: DeviceImpactInput): Promise<DeviceImpactPreview> {
    return this.inTenant(input, async (client) => {
      const caller = await this.callerOf(client, input);
      const row = await this.readImpact(client, input.tenantId, input.deviceId, scopeStoreIds(caller.scope));
      const reason = revokeReasonOf(input.action, input.reason);
      const evaluation = evaluateLifecycle({
        action: input.action,
        reason,
        state: lifecycleStateOf(row),
        callerRole: caller.roleCode,
      });
      return toDeviceImpactPreview({ row, action: input.action, reason, evaluation });
    });
  }

  /**
   * Take the device lifecycle lock and the device row `FOR UPDATE` (see the
   * class header) and check it is in the caller's scope; absent, foreign or
   * out of scope → `DeviceNotFoundError`.
   */
  private async lockInScope(
    client: PoolClient,
    input: RevokeDeviceInput,
    scope: StoreScope,
  ): Promise<{ readonly storeId: string; readonly revokedAt: Date | null }> {
    const row = await lockDeviceForLifecycle(client, input);
    if (row === null || !inStoreScope(scope, row.storeId)) throw new DeviceNotFoundError();
    return row;
  }

  /** The impact read. Absent, foreign or out of scope → `DeviceNotFoundError`. */
  private async readImpact(
    client: PoolClient,
    tenantId: string,
    deviceId: string,
    scopedStoreIds: readonly string[] | null,
  ): Promise<DeviceImpactRow> {
    const row = await readDeviceImpact(client, tenantId, deviceId, scopedStoreIds);
    if (row === null) throw new DeviceNotFoundError();
    return row;
  }

  private async readDetail(
    client: PoolClient,
    tenantId: string,
    deviceId: string,
    scopedStoreIds: readonly string[] | null,
  ): Promise<DeviceDetail> {
    const r = await client.query<DeviceReadRow>(DETAIL_SQL, [tenantId, deviceId, scopedStoreIds]);
    const row = r.rows[0];
    if (row === undefined) throw new DeviceNotFoundError();
    return toDeviceDetail(row);
  }

  private inTenant<T>(input: ScopedInput, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, work);
  }

  /** The caller's role in the tenant and its operator store scope (RLS-scoped read). */
  private callerOf(client: PoolClient, input: ScopedInput): Promise<DeviceCaller> {
    return resolveDeviceCaller(this.memberships, client, input);
  }

  /** A `store_id` filter must name a store in the caller's scope and tenant. */
  private async assertStoreInScope(
    client: PoolClient,
    tenantId: string,
    scope: StoreScope,
    storeId: string,
  ): Promise<void> {
    if (!(await storeInCallerScope(client, { tenantId, scope, storeId }))) throw new DeviceStoreNotInScopeError();
  }
}
