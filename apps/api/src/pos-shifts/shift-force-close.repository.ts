/**
 * ShiftForceCloseRepository — persistence for RT-742 `forceCloseShift`
 * (`pos-shifts.openapi.yaml` 1.4.0-draft).
 *
 * Every method takes the caller's tenant-scoped client (`runWithTenantContext`
 * on the NOBYPASSRLS domain pool), so every statement also runs under the
 * tenant policies of `shifts`, `devices`, `auth_tokens` and
 * `shift_forced_closes`. RLS isolates tenants only, so the STORE predicate is
 * in every query (Constitution §II, §XII).
 *
 * Scope. Unlike the cash-up writes, the shift resolves on ANY device of the
 * envelope's tenant and store, legacy rows included (contract, Scope);
 * another store, another tenant and an unknown id are all "no row".
 */
import type { PoolClient } from "pg";

import { hasForcedClose, type ShiftLifecycleState } from "./shift-cash-up.repository";

/** A shift of the envelope's store, as the force close needs it. */
export interface StoreShiftRow {
  readonly shiftId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly openingDeviceId: string;
  readonly openingUserId: string;
  readonly openedAt: Date;
  readonly lifecycleState: ShiftLifecycleState;
  readonly source: "legacy" | "cash_up";
  /** Null for a legacy shift (no cash-up open). */
  readonly currencyCode: string | null;
  readonly openingFloat: string | null;
  readonly receivedAt: Date | null;
  /** The opening terminal's label; null when it has none. */
  readonly openedOnTerminalLabel: string | null;
  /**
   * True when a force close is recorded (`shift_forced_closes`); the shift is
   * then `closed_forced` with no `shift_closes` row. A `closed_forced` shift
   * without one was closed on its terminal by a counted forced close.
   */
  readonly notCounted: boolean;
}

/** The force close to record; the time is the server clock. */
export interface NewForcedClose {
  readonly closedByUserId: string;
  readonly closedFromDeviceId: string;
  readonly forcedReason: string;
  /** sha256 of the natural key (32 bytes). */
  readonly payloadHash: Buffer;
}

/** A recorded force close, with both terminals named by label. */
export interface ForcedCloseRow extends NewForcedClose {
  readonly shiftId: string;
  readonly closedAt: Date;
  readonly closedFromTerminalLabel: string | null;
  readonly openedOnTerminalLabel: string | null;
}

/** The stuck rule's inputs beyond the shift. */
export interface StuckRule {
  /** The caller's own envelope session, which never makes the drawer look live. */
  readonly callerTokenId: string;
  readonly thresholdMinutes: number;
}

/**
 * The force close's shift UPDATE did not move exactly one open row. Thrown
 * so the caller's transaction rolls back: nothing is recorded.
 */
export class ForceCloseNotAppliedError extends Error {
  constructor() {
    super("the force close transition did not apply to exactly one open shift");
    this.name = "ForceCloseNotAppliedError";
  }
}

interface StoreShiftDbRow {
  shift_id: string;
  tenant_id: string;
  store_id: string;
  opening_device_id: string;
  opening_cashier_user_id: string;
  opened_at: Date;
  lifecycle_state: ShiftLifecycleState;
  source: "legacy" | "cash_up";
  currency_code: string | null;
  opening_float: string | null;
  received_at: Date | null;
  opened_on_terminal_label: string | null;
}

interface ForcedCloseDbRow {
  shift_id: string;
  closed_by_user_id: string;
  closed_at: Date;
  closed_from_device_id: string;
  closed_from_terminal_label: string | null;
  opened_on_terminal_label: string | null;
  forced_reason: string;
  payload_hash: Buffer;
}

/** $1 shift, $2 tenant, $3 store. The shift row is locked; the device row is not. */
const FIND_STORE_SHIFT_SQL = `
  SELECT s.shift_id, s.tenant_id, s.store_id, s.opening_device_id, s.opening_cashier_user_id,
         s.opened_at, s.lifecycle_state, s.source, s.currency_code,
         s.opening_float::text AS opening_float, s.received_at,
         d.label AS opened_on_terminal_label
    FROM shifts s
    LEFT JOIN devices d ON d.id = s.opening_device_id AND d.tenant_id = s.tenant_id
   WHERE s.shift_id = $1 AND s.tenant_id = $2 AND s.store_id = $3
     FOR UPDATE OF s`;

/**
 * The `GET /shifts/stuck` predicate minus the caller's own session (contract,
 * Eligibility): opened longer ago than the threshold, and no active
 * `pos_operator` session of the opening cashier on the store other than the
 * caller's. $1 openedAt, $2 threshold minutes, $3 opening cashier, $4 store,
 * $5 the caller's token.
 */
const IS_STUCK_SQL = `
  SELECT ($1::timestamptz < now() - ($2::int * INTERVAL '1 minute'))
         AND NOT EXISTS (
           SELECT 1 FROM auth_tokens t
            WHERE t.scope = 'pos_operator'
              AND t.user_id = $3
              AND t.store_id = $4
              AND t.revoked_at IS NULL
              AND t.expires_at > now()
              AND t.id <> $5::uuid) AS stuck`;

/** $1 shift, $2 tenant, $3 store. Both terminals by their current label. */
const FIND_FORCED_CLOSE_SQL = `
  SELECT f.shift_id, f.closed_by_user_id, f.closed_at, f.closed_from_device_id,
         cd.label AS closed_from_terminal_label, od.label AS opened_on_terminal_label,
         f.forced_reason, f.payload_hash
    FROM shift_forced_closes f
    LEFT JOIN devices cd ON cd.id = f.closed_from_device_id AND cd.tenant_id = f.tenant_id
    LEFT JOIN devices od ON od.id = f.opening_device_id AND od.tenant_id = f.tenant_id
   WHERE f.shift_id = $1 AND f.tenant_id = $2 AND f.store_id = $3`;

function toStoreShift(row: StoreShiftDbRow, notCounted: boolean): StoreShiftRow {
  return {
    shiftId: row.shift_id,
    tenantId: row.tenant_id,
    storeId: row.store_id,
    openingDeviceId: row.opening_device_id,
    openingUserId: row.opening_cashier_user_id,
    openedAt: row.opened_at,
    lifecycleState: row.lifecycle_state,
    source: row.source,
    currencyCode: row.currency_code,
    openingFloat: row.opening_float,
    receivedAt: row.received_at,
    openedOnTerminalLabel: row.opened_on_terminal_label,
    notCounted,
  };
}

function toForcedClose(row: ForcedCloseDbRow): ForcedCloseRow {
  return {
    shiftId: row.shift_id,
    closedByUserId: row.closed_by_user_id,
    closedAt: row.closed_at,
    closedFromDeviceId: row.closed_from_device_id,
    closedFromTerminalLabel: row.closed_from_terminal_label,
    openedOnTerminalLabel: row.opened_on_terminal_label,
    forcedReason: row.forced_reason,
    payloadHash: row.payload_hash,
  };
}

export class ShiftForceCloseRepository {
  /**
   * The shift `shiftId` of THIS tenant and store, on any device, locked FOR
   * UPDATE; or null. Whether it is force-closed is read after the lock
   * (`hasForcedClose`), so a force close committed while this waited is seen.
   */
  async findStoreShift(
    client: PoolClient,
    scope: { readonly tenantId: string; readonly storeId: string },
    shiftId: string,
  ): Promise<StoreShiftRow | null> {
    const r = await client.query<StoreShiftDbRow>(FIND_STORE_SHIFT_SQL, [shiftId, scope.tenantId, scope.storeId]);
    const row = r.rows[0];
    if (row === undefined) return null;
    const notCounted =
      row.lifecycle_state === "closed_forced" && (await hasForcedClose(client, { shiftId, tenantId: scope.tenantId }));
    return toStoreShift(row, notCounted);
  }

  /** Whether the open `shift` is stuck now, the caller's own session excluded. */
  async isStuck(client: PoolClient, shift: StoreShiftRow, rule: StuckRule): Promise<boolean> {
    const r = await client.query<{ stuck: boolean }>(IS_STUCK_SQL, [
      shift.openedAt,
      rule.thresholdMinutes,
      shift.openingUserId,
      shift.storeId,
      rule.callerTokenId,
    ]);
    return r.rows[0]?.stuck === true;
  }

  /** The recorded force close of `shift`, or null. */
  async findForcedClose(client: PoolClient, shift: StoreShiftRow): Promise<ForcedCloseRow | null> {
    const r = await client.query<ForcedCloseDbRow>(FIND_FORCED_CLOSE_SQL, [shift.shiftId, shift.tenantId, shift.storeId]);
    const row = r.rows[0];
    return row === undefined ? null : toForcedClose(row);
  }

  /**
   * Records the force close of the locked, open `shift` (server clock) and
   * moves it to `closed_forced` (the state a counted forced close also takes;
   * the `shift_forced_closes` row is what says "not counted"). A shift UPDATE that does not move exactly one
   * open row throws ForceCloseNotAppliedError, so the transaction rolls back.
   */
  async insertForcedClose(client: PoolClient, shift: StoreShiftRow, close: NewForcedClose): Promise<ForcedCloseRow> {
    await client.query(
      `INSERT INTO shift_forced_closes
         (shift_id, tenant_id, store_id, opening_device_id, closed_from_device_id, closed_by_user_id,
          closed_at, forced_reason, payload_hash)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8)`,
      [
        shift.shiftId,
        shift.tenantId,
        shift.storeId,
        shift.openingDeviceId,
        close.closedFromDeviceId,
        close.closedByUserId,
        close.forcedReason,
        close.payloadHash,
      ],
    );
    const moved = await client.query(
      `UPDATE shifts SET lifecycle_state = 'closed_forced'
        WHERE shift_id = $1 AND tenant_id = $2 AND store_id = $3 AND opening_device_id = $4
          AND lifecycle_state = 'open'`,
      [shift.shiftId, shift.tenantId, shift.storeId, shift.openingDeviceId],
    );
    if (moved.rowCount !== 1) throw new ForceCloseNotAppliedError();
    const recorded = await this.findForcedClose(client, shift);
    if (recorded === null) throw new ForceCloseNotAppliedError();
    return recorded;
  }
}
