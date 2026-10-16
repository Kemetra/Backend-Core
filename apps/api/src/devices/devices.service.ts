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
 *   - Impact preview (RT-366): ONE statement (`IMPACT_SQL`, one snapshot) reads
 *     the device, its open shift with its server-received cash-up facts, and
 *     the cascade counts over the same predicates the revoke applies
 *     (`LIVE_OPERATOR_SESSIONS`, `PENDING_PAIRING_CODES`); the lifecycle
 *     evaluator decides. It takes no lock and writes nothing. The revoke
 *     decides from the same read, taken under its locks, so its verdict and
 *     its 409 `error.details` are the preview of the state it refused.
 */
import { Inject, Injectable } from "@nestjs/common";
import { newId } from "@data-pulse-2/shared";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { lockDeviceLifecycle } from "./device-lifecycle-lock";
import { evaluateLifecycle, revokeReasonOf, type LifecycleAction } from "./device-lifecycle.evaluator";
import {
  lifecycleStateOf,
  toDeviceImpactPreview,
  type DeviceImpactPreview,
  type DeviceImpactRow,
} from "./device-impact.projections";
import { MembershipRepository } from "../context/membership.repository";
import { inStoreScope, readScope, scopeStoreIds } from "../context/operator-store-scope";
import type { StoreScope } from "../context/store-scope";
import type { ResolvedContext } from "../context/types";
import {
  decideRevoke,
  decodeDeviceCursor,
  encodeDeviceCursor,
  evaluateRevokeInput,
  EXPIRES_AT_KEY_SQL,
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

/** The session context of a call; its role and store scope bound it. */
export interface ScopedInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
}

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

/**
 * The revoke cascade's targets over the tenant ($1) and the device ($2): its
 * live operator sessions, and its pending pairing codes plus the pending
 * replacement codes for it. The revoke updates exactly these rows and the
 * impact preview counts them, so the two cannot drift.
 */
const LIVE_OPERATOR_SESSIONS = `
  tenant_id = $1::uuid AND device_id = $2::uuid AND scope = 'pos_operator'
  AND revoked_at IS NULL AND expires_at > now()`;
const PENDING_PAIRING_CODES = `
  tenant_id = $1::uuid AND status = 'pending'
  AND (terminal_id = $2::uuid OR replaces_device_id = $2::uuid)`;

/**
 * The used pairing codes that link a replacement to the device it replaced
 * (RT-367), over the tenant ($1), kept only when BOTH devices are in the
 * caller's store scope (`scopeParam`, null = tenant-wide): the other side of
 * a cross-store move reads as absent, like every out-of-scope device.
 */
const linksCte = (scopeParam: string): string => `
  links AS (
    SELECT pc.device_id, pc.replaces_device_id, pc.used_at, pc.id
      FROM pairing_codes pc
      JOIN devices nd ON nd.id = pc.device_id AND nd.tenant_id = pc.tenant_id
      JOIN devices od ON od.id = pc.replaces_device_id AND od.tenant_id = pc.tenant_id
     WHERE pc.tenant_id = $1::uuid AND pc.status = 'used'
       AND (${scopeParam}::uuid[] IS NULL
            OR (nd.store_id = ANY(${scopeParam}::uuid[]) AND od.store_id = ANY(${scopeParam}::uuid[])))
  )`;

/** The most recently opened open shift per device of the tenant ($1), computed once for a list. */
const OPEN_SHIFTS_CTE = `
  open_shifts AS (
    SELECT DISTINCT ON (s.opening_device_id) s.opening_device_id, s.shift_id
      FROM shifts s
     WHERE s.tenant_id = $1::uuid AND s.lifecycle_state = 'open'
     ORDER BY s.opening_device_id, s.opened_at DESC, s.shift_id DESC
  )`;

const DEVICE_COLUMNS = `
  d.id, d.store_id, d.label, d.created_at, d.expires_at,
  ${EXPIRES_AT_KEY_SQL} AS expires_at_key,
  d.last_seen_at, d.revoked_at, d.revoked_by, d.revoke_reason, d.revoke_note,
  d.retired_at, d.retired_by, d.retire_reason,
  os.shift_id AS open_shift_id,
  (SELECT l.replaces_device_id FROM links l WHERE l.device_id = d.id
    ORDER BY l.used_at DESC NULLS LAST, l.id DESC LIMIT 1) AS replaces_device_id,
  (SELECT l.device_id FROM links l WHERE l.replaces_device_id = d.id
    ORDER BY l.used_at DESC NULLS LAST, l.id DESC LIMIT 1) AS replaced_by_device_id,
  CASE WHEN d.revoked_at IS NOT NULL AND os.shift_id IS NOT NULL THEN 0
       WHEN d.revoked_at IS NULL THEN 1
       WHEN d.retired_at IS NULL THEN 2
       ELSE 3 END AS rank`;

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

/**
 * One device's most recently opened open shift (the Cash Session rule's
 * input), looked up for that device only (no tenant-wide CTE).
 */
const OPEN_SHIFT_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT s.shift_id, s.source, s.opened_at, s.opening_cashier_user_id, s.received_at FROM shifts s
     WHERE s.tenant_id = d.tenant_id AND s.opening_device_id = d.id AND s.lifecycle_state = 'open'
     ORDER BY s.opened_at DESC, s.shift_id DESC
     LIMIT 1
  ) os ON true`;

/** $1 tenant, $2 device, $3 scoped store ids (null = tenant-wide). */
const ONE_DEVICE_WHERE = `
   WHERE d.tenant_id = $1::uuid
     AND d.id = $2::uuid
     AND ($3::uuid[] IS NULL OR d.store_id = ANY($3::uuid[]))`;

const DETAIL_SQL = `
  WITH ${linksCte("$3")}
  SELECT ${DEVICE_COLUMNS}
    FROM devices d
    ${OPEN_SHIFT_LATERAL}
  ${ONE_DEVICE_WHERE}`;

/**
 * The impact read: the detail columns plus the open shift's facts, its
 * server-received cash-up facts (the open and its movements; none for a legacy
 * shift) and the cascade counts. One statement, so one snapshot. Parameters as
 * `DETAIL_SQL`.
 */
const IMPACT_SQL = `
  WITH ${linksCte("$3")}
  SELECT ${DEVICE_COLUMNS},
    os.source AS open_shift_source,
    os.opened_at AS open_shift_opened_at,
    os.opening_cashier_user_id AS open_shift_cashier_user_id,
    CASE WHEN os.source = 'cash_up' THEN 1 + mv.n END AS cash_fact_count,
    CASE WHEN os.source = 'cash_up' THEN GREATEST(os.received_at, mv.last_received_at) END AS cash_last_received_at,
    (SELECT count(*)::int FROM auth_tokens WHERE ${LIVE_OPERATOR_SESSIONS}) AS operator_session_count,
    (SELECT count(*)::int FROM pairing_codes WHERE ${PENDING_PAIRING_CODES}) AS pending_pairing_code_count,
    now() AS evaluated_at
    FROM devices d
    ${OPEN_SHIFT_LATERAL}
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n, max(m.received_at) AS last_received_at FROM shift_cash_movements m
       WHERE m.tenant_id = d.tenant_id AND m.shift_id = os.shift_id
    ) mv ON true
  ${ONE_DEVICE_WHERE}`;

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
      await lockDeviceLifecycle(client, input);
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
      if (revoked) await this.applyRevoke(client, input, device.storeId, decision.custodyExceptionShiftId);
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
   * Lock the device row `FOR UPDATE` (see the class header) and check it is in
   * the caller's scope; absent, foreign or out of scope → `DeviceNotFoundError`.
   */
  private async lockInScope(
    client: PoolClient,
    input: RevokeDeviceInput,
    scope: StoreScope,
  ): Promise<{ readonly storeId: string; readonly revokedAt: Date | null }> {
    const locked = await client.query<{ store_id: string; revoked_at: Date | null }>(
      `SELECT store_id, revoked_at FROM devices
        WHERE id = $1::uuid AND tenant_id = $2::uuid
        FOR UPDATE`,
      [input.deviceId, input.tenantId],
    );
    const row = locked.rows[0];
    if (row === undefined || !inStoreScope(scope, row.store_id)) throw new DeviceNotFoundError();
    return { storeId: row.store_id, revokedAt: row.revoked_at };
  }

  /** The revoke fields, the cascade and the audit row, inside the caller's transaction. */
  private async applyRevoke(
    client: PoolClient,
    input: RevokeDeviceInput,
    storeId: string,
    custodyExceptionShiftId: string | null,
  ): Promise<void> {
    await client.query(
      `UPDATE devices
          SET revoked_at = now(), revoked_by = $3::uuid, revoke_reason = $4, revoke_note = $5
        WHERE id = $1::uuid AND tenant_id = $2::uuid AND revoked_at IS NULL`,
      [input.deviceId, input.tenantId, input.actorUserId, input.reason, input.note ?? null],
    );
    const sessions = await client.query(
      `UPDATE auth_tokens SET revoked_at = now() WHERE ${LIVE_OPERATOR_SESSIONS} RETURNING id`,
      [input.tenantId, input.deviceId],
    );
    // The device's own pending codes and the pending replacement codes for it.
    // A code issued after this revoke is untouched (RT-367 replace / move).
    const codes = await client.query(
      `UPDATE pairing_codes SET status = 'cancelled' WHERE ${PENDING_PAIRING_CODES} RETURNING id`,
      [input.tenantId, input.deviceId],
    );
    const metadata: Record<string, unknown> = {
      reason: input.reason,
      revoked_session_count: sessions.rowCount ?? 0,
      cancelled_pairing_code_count: codes.rowCount ?? 0,
      custody_exception: custodyExceptionShiftId !== null,
      ...(custodyExceptionShiftId !== null ? { shift_id: custodyExceptionShiftId } : {}),
    };
    await client.query(
      `INSERT INTO audit_events (id, actor_user_id, tenant_id, store_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, 'pos.device.revoked', 'device', $5, $6::jsonb)`,
      [newId(), input.actorUserId, input.tenantId, storeId, input.deviceId, JSON.stringify(metadata)],
    );
  }

  /** The impact read (`IMPACT_SQL`). Absent, foreign or out of scope → `DeviceNotFoundError`. */
  private async readImpact(
    client: PoolClient,
    tenantId: string,
    deviceId: string,
    scopedStoreIds: readonly string[] | null,
  ): Promise<DeviceImpactRow> {
    const r = await client.query<DeviceImpactRow>(IMPACT_SQL, [tenantId, deviceId, scopedStoreIds]);
    const row = r.rows[0];
    if (row === undefined) throw new DeviceNotFoundError();
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
  private async callerOf(
    client: PoolClient,
    input: ScopedInput,
  ): Promise<{ readonly roleCode: string | null; readonly scope: StoreScope }> {
    const userId = input.context.userId;
    const roleCode =
      userId !== null ? await this.memberships.findRoleCodeForUserInTenant(userId, input.tenantId, client) : null;
    return { roleCode, scope: readScope({ context: input.context, roleCode }) };
  }

  /** A `store_id` filter must name a store in the caller's scope and tenant. */
  private async assertStoreInScope(
    client: PoolClient,
    tenantId: string,
    scope: StoreScope,
    storeId: string,
  ): Promise<void> {
    if (!inStoreScope(scope, storeId)) throw new DeviceStoreNotInScopeError();
    const r = await client.query<{ id: string }>(`SELECT id FROM stores WHERE id = $1::uuid AND tenant_id = $2::uuid`, [
      storeId,
      tenantId,
    ]);
    if (r.rows.length === 0) throw new DeviceStoreNotInScopeError();
  }
}
