/**
 * ShiftCashUpRepository — persistence for the RT-17 thin, cash-only shift
 * cash-up (slice 2a; [GATED] approval: Jira RT-17 comments 10760 + 10919 +
 * 10920; schema `0036_shift_cash_up`).
 *
 * Every method takes the caller's tenant-scoped client (`runWithTenantContext`
 * on the NOBYPASSRLS domain pool), so every statement also runs under the
 * 0002 / 0036 tenant policies. The repository holds no business rule beyond
 * the scope of each read; the service (slice 2b) owns validation, the
 * arithmetic 422, replay / conflict decisions and the projections.
 *
 * Scope (Constitution §II, §XII; Codex P2, RT-17 comment 10925). A shift or
 * a movement resolves ONLY within the credential's tenant + store + device
 * (`DeviceScope`, taken from the device row or the envelope's bound device,
 * never from the request) and only as a `cash_up` row. Another device's,
 * store's or tenant's row — or a legacy audit-ingest row with the same id —
 * never resolves: the caller answers it with a non-disclosing response and
 * never sees its projection. Re-using such an id on insert reports only that
 * the id is taken (`shift_id_taken` / `null`).
 *
 * Amounts are returned as the exact `numeric(19,4)` text Postgres sends
 * (never a JS number); timestamps as `Date`; `business_date` as `YYYY-MM-DD`.
 */
import type { PoolClient } from "pg";

import type { DeviceScope } from "../pos-cashier-admissions/device-scope";

export type ShiftLifecycleState = "open" | "closed" | "closed_forced";
export type CashMovementKind = "pay_in" | "pay_out";
export type CashMovementReason = "bank_drop" | "float_top_up" | "petty_expense" | "other";
export type ShiftCloseKind = "normal" | "forced";

/** A recorded cash-up shift (a `shifts` row with `source = 'cash_up'`). */
export interface CashUpShiftRow {
  readonly shiftId: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly deviceId: string;
  readonly openingUserId: string;
  readonly openedAt: Date;
  readonly lifecycleState: ShiftLifecycleState;
  readonly currencyCode: string;
  readonly openingFloat: string;
  readonly businessDate: string;
  readonly receivedAt: Date;
  readonly recordedByUserId: string;
  readonly payloadHash: Buffer;
}

/** The ShiftOpened fact to record; scope comes from the `DeviceScope`. */
export interface NewCashUpShift {
  readonly shiftId: string;
  /** RFC 3339 instant (POS clock). */
  readonly openedAt: string;
  readonly openingUserId: string;
  readonly currencyCode: string;
  /** Exact decimal string. */
  readonly openingFloat: string;
  /** The verified actor (device-path cashier or envelope operator). */
  readonly recordedByUserId: string;
  /** sha256 of the canonical open fact (32 bytes). */
  readonly payloadHash: Buffer;
}

export type InsertShiftOutcome =
  /** Recorded; `adoptedLegacy` when an open legacy row of this scope became it. */
  | { readonly kind: "inserted"; readonly shift: CashUpShiftRow; readonly adoptedLegacy: boolean }
  /** The shiftId is already recorded — in scope or not. Never its row. */
  | { readonly kind: "shift_id_taken" }
  /** The device already has another open cash-up shift. */
  | { readonly kind: "device_has_open_shift" };

export interface CashMovementRow {
  readonly movementId: string;
  readonly shiftId: string;
  readonly kind: CashMovementKind;
  readonly amount: string;
  readonly currencyCode: string;
  readonly reasonCode: CashMovementReason;
  readonly note: string | null;
  readonly occurredAt: Date;
  readonly recordedByUserId: string;
  readonly receivedAt: Date;
  readonly payloadHash: Buffer;
}

/** The CashMovement fact; shift, scope and currency come from the shift row. */
export interface NewCashMovement {
  readonly movementId: string;
  readonly kind: CashMovementKind;
  /** Exact decimal string, > 0. */
  readonly amount: string;
  readonly reasonCode: CashMovementReason;
  readonly note: string | null;
  /** RFC 3339 instant (POS clock). */
  readonly occurredAt: string;
  readonly recordedByUserId: string;
  readonly payloadHash: Buffer;
}

/** The ShiftClosed fact, recorded verbatim (amounts as exact decimal strings). */
export interface ShiftCloseFact {
  /** RFC 3339 instant (POS clock). */
  readonly closedAt: string;
  readonly closingUserId: string;
  readonly closeKind: ShiftCloseKind;
  readonly forcedReason: string | null;
  readonly openingFloat: string;
  readonly cashSalesTotal: string;
  readonly cashRefundsTotal: string;
  readonly payInTotal: string;
  readonly payOutTotal: string;
  readonly expectedCash: string;
  readonly countedCash: string;
  readonly variance: string;
  readonly saleCount: number;
  /** Return ids, claimed in this order. */
  readonly cashRefundReturnRefs: ReadonlyArray<string>;
  readonly varianceApprovedByUserId: string | null;
  readonly recordedByUserId: string;
  readonly payloadHash: Buffer;
}

export interface ShiftCloseRow extends Omit<ShiftCloseFact, "closedAt"> {
  readonly shiftId: string;
  readonly closedAt: Date;
  readonly receivedAt: Date;
}

/** A refund ref as the close validation needs it. */
export interface RefundRefRow {
  readonly returnId: string;
  /** The return's (refund) currency. */
  readonly currencyCode: string;
  /** The return has a cash refund tender. */
  readonly hasCashRefund: boolean;
  /** The shift whose close already claimed it, if any. */
  readonly claimedByShiftId: string | null;
}

/**
 * A ref was claimed by another shift's close between the caller's
 * validation and the insert (a concurrent close). Thrown so the caller's
 * transaction rolls back: nothing of the close is recorded.
 */
export class RefundRefAlreadyClaimedError extends Error {
  constructor() {
    super("a cash refund return is already claimed by another shift's close");
    this.name = "RefundRefAlreadyClaimedError";
  }
}

/**
 * The close's shift UPDATE did not move exactly one row to closed. Thrown so
 * the caller's transaction rolls back: nothing of the close is recorded.
 */
export class ShiftCloseNotAppliedError extends Error {
  constructor() {
    super("the shift close transition did not apply to exactly one shift");
    this.name = "ShiftCloseNotAppliedError";
  }
}

/** The one-open-per-device partial UNIQUE index (0036). */
export const OPEN_DEVICE_INDEX = "uq_shifts_cash_up_open_device";

const SHIFT_COLUMNS = `
  shift_id, tenant_id, store_id, opening_device_id, opening_cashier_user_id, opened_at,
  lifecycle_state, currency_code, opening_float::text AS opening_float,
  business_date::text AS business_date, received_at, recorded_by_user_id, payload_hash`;

const MOVEMENT_COLUMNS = `
  id, shift_id, kind, amount::text AS amount, currency_code, reason_code, note, occurred_at,
  recorded_by_user_id, received_at, payload_hash`;

const CLOSE_COLUMNS = `
  shift_id, closed_at, closing_user_id, close_kind, forced_reason,
  opening_float::text AS opening_float, cash_sales_total::text AS cash_sales_total,
  cash_refunds_total::text AS cash_refunds_total, pay_in_total::text AS pay_in_total,
  pay_out_total::text AS pay_out_total, expected_cash::text AS expected_cash,
  counted_cash::text AS counted_cash, variance::text AS variance, sale_count,
  variance_approved_by_user_id, recorded_by_user_id, received_at, payload_hash`;

/**
 * $1 shift, $2 tenant, $3 store, $4 device, $5 opening user, $6 openedAt,
 * $7 currency, $8 opening float, $9 recording actor, $10 payload hash.
 */
const INSERT_SHIFT_SQL = `
  INSERT INTO shifts
    (shift_id, tenant_id, store_id, opening_device_id, opening_cashier_user_id, opened_at,
     source, currency_code, opening_float, business_date, received_at, recorded_by_user_id,
     payload_hash)
  VALUES ($1, $2, $3, $4, $5, $6::timestamptz, 'cash_up', $7, $8::numeric,
          (SELECT ($6::timestamptz AT TIME ZONE s.timezone)::date
             FROM stores s WHERE s.id = $3 AND s.tenant_id = $2),
          now(), $9, $10)
  ON CONFLICT (shift_id) DO NOTHING
  RETURNING ${SHIFT_COLUMNS}`;

/** Same parameters: adopt an open legacy row of this scope, opened_at and opening user. */
const ADOPT_LEGACY_SHIFT_SQL = `
  UPDATE shifts
     SET source = 'cash_up',
         currency_code = $7,
         opening_float = $8::numeric,
         business_date = (SELECT (shifts.opened_at AT TIME ZONE s.timezone)::date
                            FROM stores s WHERE s.id = shifts.store_id AND s.tenant_id = shifts.tenant_id),
         received_at = now(),
         recorded_by_user_id = $9,
         payload_hash = $10
   WHERE shift_id = $1
     AND tenant_id = $2
     AND store_id = $3
     AND opening_device_id = $4
     AND opening_cashier_user_id = $5
     AND opened_at = $6::timestamptz
     AND source = 'legacy'
     AND lifecycle_state = 'open'
  RETURNING ${SHIFT_COLUMNS}`;

interface ShiftDbRow {
  shift_id: string;
  tenant_id: string;
  store_id: string;
  opening_device_id: string;
  opening_cashier_user_id: string;
  opened_at: Date;
  lifecycle_state: ShiftLifecycleState;
  currency_code: string;
  opening_float: string;
  business_date: string;
  received_at: Date;
  recorded_by_user_id: string;
  payload_hash: Buffer;
}

interface MovementDbRow {
  id: string;
  shift_id: string;
  kind: CashMovementKind;
  amount: string;
  currency_code: string;
  reason_code: CashMovementReason;
  note: string | null;
  occurred_at: Date;
  recorded_by_user_id: string;
  received_at: Date;
  payload_hash: Buffer;
}

interface CloseDbRow {
  shift_id: string;
  closed_at: Date;
  closing_user_id: string;
  close_kind: ShiftCloseKind;
  forced_reason: string | null;
  opening_float: string;
  cash_sales_total: string;
  cash_refunds_total: string;
  pay_in_total: string;
  pay_out_total: string;
  expected_cash: string;
  counted_cash: string;
  variance: string;
  sale_count: number;
  variance_approved_by_user_id: string | null;
  recorded_by_user_id: string;
  received_at: Date;
  payload_hash: Buffer;
}

function toShift(row: ShiftDbRow): CashUpShiftRow {
  return {
    shiftId: row.shift_id,
    tenantId: row.tenant_id,
    storeId: row.store_id,
    deviceId: row.opening_device_id,
    openingUserId: row.opening_cashier_user_id,
    openedAt: row.opened_at,
    lifecycleState: row.lifecycle_state,
    currencyCode: row.currency_code,
    openingFloat: row.opening_float,
    businessDate: row.business_date,
    receivedAt: row.received_at,
    recordedByUserId: row.recorded_by_user_id,
    payloadHash: row.payload_hash,
  };
}

function toMovement(row: MovementDbRow): CashMovementRow {
  return {
    movementId: row.id,
    shiftId: row.shift_id,
    kind: row.kind,
    amount: row.amount,
    currencyCode: row.currency_code,
    reasonCode: row.reason_code,
    note: row.note,
    occurredAt: row.occurred_at,
    recordedByUserId: row.recorded_by_user_id,
    receivedAt: row.received_at,
    payloadHash: row.payload_hash,
  };
}

function toClose(row: CloseDbRow, refs: ReadonlyArray<string>): ShiftCloseRow {
  return {
    shiftId: row.shift_id,
    closedAt: row.closed_at,
    closingUserId: row.closing_user_id,
    closeKind: row.close_kind,
    forcedReason: row.forced_reason,
    openingFloat: row.opening_float,
    cashSalesTotal: row.cash_sales_total,
    cashRefundsTotal: row.cash_refunds_total,
    payInTotal: row.pay_in_total,
    payOutTotal: row.pay_out_total,
    expectedCash: row.expected_cash,
    countedCash: row.counted_cash,
    variance: row.variance,
    saleCount: row.sale_count,
    cashRefundReturnRefs: refs,
    varianceApprovedByUserId: row.variance_approved_by_user_id,
    recordedByUserId: row.recorded_by_user_id,
    receivedAt: row.received_at,
    payloadHash: row.payload_hash,
  };
}

/** True for the one-open-per-device refusal (23505 on OPEN_DEVICE_INDEX). */
export function isOpenDeviceConflict(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === "23505" && e.constraint === OPEN_DEVICE_INDEX;
}

export class ShiftCashUpRepository {
  /**
   * The cash-up shift `shiftId` of THIS tenant, store and device, or null.
   * `forUpdate` takes the row lock that serialises a movement against a close.
   */
  async findShift(
    client: PoolClient,
    scope: DeviceScope,
    shiftId: string,
    opts: { readonly forUpdate?: boolean } = {},
  ): Promise<CashUpShiftRow | null> {
    const r = await client.query<ShiftDbRow>(
      `SELECT ${SHIFT_COLUMNS}
         FROM shifts
        WHERE shift_id = $1
          AND tenant_id = $2
          AND store_id = $3
          AND opening_device_id = $4
          AND source = 'cash_up'
        ${opts.forUpdate === true ? "FOR UPDATE" : ""}`,
      [shiftId, scope.tenantId, scope.storeId, scope.deviceId],
    );
    const row = r.rows[0];
    return row === undefined ? null : toShift(row);
  }

  /**
   * The device's open cash-up shift, or null. Legacy rows never count.
   *
   * Keyed exactly like `uq_shifts_cash_up_open_device` — (tenant, device),
   * no store (RT-17 comment 10929, P3-7). The index is the authority on
   * "one open shift per device", so this read must agree with it: a device
   * whose `devices.store_id` was changed while a shift was open still has
   * that open shift (the index refuses a second one), and a store-filtered
   * read would wrongly answer "none". Nothing in the API changes a device's
   * store, but nothing in the schema forbids it either, so this does not
   * rely on it. The row is the same device's own shift; it is never
   * projected to another device.
   */
  async findOpenShiftOnDevice(
    client: PoolClient,
    scope: Pick<DeviceScope, "tenantId" | "deviceId">,
  ): Promise<CashUpShiftRow | null> {
    const r = await client.query<ShiftDbRow>(
      `SELECT ${SHIFT_COLUMNS}
         FROM shifts
        WHERE tenant_id = $1
          AND opening_device_id = $2
          AND source = 'cash_up'
          AND lifecycle_state = 'open'`,
      [scope.tenantId, scope.deviceId],
    );
    const row = r.rows[0];
    return row === undefined ? null : toShift(row);
  }

  /**
   * Records an open. The business date is the store-local day of `openedAt`
   * (store timezone, RT-63 P2); `received_at` is the server's now().
   *
   * When `shiftId` is already a LEGACY row (written by the audit-ingest
   * `shift.open` writer) of THIS tenant, store and device, still open, with
   * the same `opened_at` and opening user, the open ADOPTS it: the row
   * becomes the cash-up shift (RT-17 review P2-1, option b; the 0036 guard
   * allows exactly this legacy → cash_up shape). Any other existing row —
   * another scope, closed, a different opened_at or opening user, or already
   * cash-up — is `shift_id_taken`, and is never changed or disclosed.
   *
   * A concurrent open of another shift on the same device trips the partial
   * UNIQUE index; that refusal is rolled back to a savepoint so the caller's
   * transaction stays usable. Any other error is rethrown.
   */
  async insertShift(
    client: PoolClient,
    scope: DeviceScope,
    shift: NewCashUpShift,
  ): Promise<InsertShiftOutcome> {
    const params = [
      shift.shiftId,
      scope.tenantId,
      scope.storeId,
      scope.deviceId,
      shift.openingUserId,
      shift.openedAt,
      shift.currencyCode,
      shift.openingFloat,
      shift.recordedByUserId,
      shift.payloadHash,
    ];
    await client.query("SAVEPOINT shift_cash_up_open");
    let outcome: InsertShiftOutcome;
    try {
      const inserted = await client.query<ShiftDbRow>(INSERT_SHIFT_SQL, params);
      const adopted =
        inserted.rows[0] === undefined
          ? await client.query<ShiftDbRow>(ADOPT_LEGACY_SHIFT_SQL, params)
          : null;
      const row = inserted.rows[0] ?? adopted?.rows[0];
      outcome =
        row === undefined
          ? { kind: "shift_id_taken" }
          : { kind: "inserted", shift: toShift(row), adoptedLegacy: adopted !== null };
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT shift_cash_up_open");
      if (isOpenDeviceConflict(err)) return { kind: "device_has_open_shift" };
      throw err;
    }
    await client.query("RELEASE SAVEPOINT shift_cash_up_open");
    return outcome;
  }

  /**
   * The movement `movementId` recorded on `shift` (a row the caller resolved
   * in scope), or null. Scoped to that ONE shift and its tenant, store and
   * device (RT-17 comment 10929, P3-5): a movement of any other shift — even
   * one of the same device — never resolves, so a replay through another
   * shift's path is never answered with it.
   */
  async findMovement(
    client: PoolClient,
    shift: CashUpShiftRow,
    movementId: string,
  ): Promise<CashMovementRow | null> {
    const r = await client.query<MovementDbRow>(
      `SELECT ${MOVEMENT_COLUMNS}
         FROM shift_cash_movements
        WHERE id = $1
          AND shift_id = $2
          AND tenant_id = $3
          AND store_id = $4
          AND device_id = $5`,
      [movementId, shift.shiftId, shift.tenantId, shift.storeId, shift.deviceId],
    );
    const row = r.rows[0];
    return row === undefined ? null : toMovement(row);
  }

  /**
   * Records a movement on `shift` (its tenant, store, device and currency).
   * Returns null when `movementId` is already recorded, on this shift or any
   * other; the caller resolves a replay on this shift with `findMovement`. The database
   * refuses a movement on a shift that is no longer open (55000).
   */
  async insertMovement(
    client: PoolClient,
    shift: CashUpShiftRow,
    movement: NewCashMovement,
  ): Promise<CashMovementRow | null> {
    const r = await client.query<MovementDbRow>(
      `INSERT INTO shift_cash_movements
         (id, shift_id, tenant_id, store_id, device_id, currency_code, kind, amount, reason_code,
          note, occurred_at, recorded_by_user_id, received_at, payload_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11::timestamptz, $12, now(), $13)
       ON CONFLICT (id) DO NOTHING
       RETURNING ${MOVEMENT_COLUMNS}`,
      [
        movement.movementId,
        shift.shiftId,
        shift.tenantId,
        shift.storeId,
        shift.deviceId,
        shift.currencyCode,
        movement.kind,
        movement.amount,
        movement.reasonCode,
        movement.note,
        movement.occurredAt,
        movement.recordedByUserId,
        movement.payloadHash,
      ],
    );
    const row = r.rows[0];
    return row === undefined ? null : toMovement(row);
  }

  /** The recorded close of `shift` with its refund refs in claim order, or null. */
  async findClose(client: PoolClient, shift: CashUpShiftRow): Promise<ShiftCloseRow | null> {
    const r = await client.query<CloseDbRow>(
      `SELECT ${CLOSE_COLUMNS}
         FROM shift_closes
        WHERE shift_id = $1 AND tenant_id = $2 AND store_id = $3 AND device_id = $4`,
      [shift.shiftId, shift.tenantId, shift.storeId, shift.deviceId],
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    const refs = await client.query<{ return_id: string }>(
      `SELECT return_id FROM shift_refund_claims
        WHERE shift_id = $1 AND tenant_id = $2 AND store_id = $3
        ORDER BY ordinal`,
      [shift.shiftId, shift.tenantId, shift.storeId],
    );
    return toClose(row, refs.rows.map((ref) => ref.return_id));
  }

  /**
   * The given returns of THIS tenant and store, with their currency, whether
   * they carry a cash refund tender, and the shift that already claimed them.
   * Unknown, foreign and other-store ids are simply absent.
   */
  async readRefundRefs(
    client: PoolClient,
    scope: Pick<DeviceScope, "tenantId" | "storeId">,
    returnIds: ReadonlyArray<string>,
  ): Promise<RefundRefRow[]> {
    if (returnIds.length === 0) return [];
    const r = await client.query<{
      return_id: string;
      currency_code: string;
      has_cash_refund: boolean;
      claimed_by_shift_id: string | null;
    }>(
      `SELECT r.id AS return_id,
              r.currency_code,
              EXISTS (SELECT 1 FROM sale_return_tenders t
                       WHERE t.return_id = r.id
                         AND t.tenant_id = r.tenant_id
                         AND t.method = 'cash') AS has_cash_refund,
              c.shift_id AS claimed_by_shift_id
         FROM sale_returns r
         LEFT JOIN shift_refund_claims c
           ON c.return_id = r.id AND c.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1
          AND r.store_id = $2
          AND r.id = ANY($3::uuid[])`,
      [scope.tenantId, scope.storeId, [...returnIds]],
    );
    return r.rows.map((row) => ({
      returnId: row.return_id,
      currencyCode: row.currency_code,
      hasCashRefund: row.has_cash_refund,
      claimedByShiftId: row.claimed_by_shift_id,
    }));
  }

  /**
   * Records the close of `shift` (its tenant, store, device and currency),
   * claims its refund refs in order and moves the shift to `closed` /
   * `closed_forced`. The caller holds the shift row lock and has validated
   * the fact (arithmetic, opening float, refs); the database re-checks the
   * arithmetic and the float. The claims are inserted in `return_id` order
   * (PR #714 round 1, Codex P2): every close takes the claims' key locks in
   * one global order, so two closes claiming the same returns in opposite
   * request orders wait on each other instead of deadlocking. The stored
   * `ordinal` stays the request order, so a replay echoes the refs as sent. A ref claimed meanwhile by another close throws
   * RefundRefAlreadyClaimedError, and a shift UPDATE that does not move
   * exactly one row throws ShiftCloseNotAppliedError, so the caller's
   * transaction rolls back.
   */
  async insertClose(
    client: PoolClient,
    shift: CashUpShiftRow,
    close: ShiftCloseFact,
  ): Promise<ShiftCloseRow> {
    const r = await client.query<CloseDbRow>(
      `INSERT INTO shift_closes
         (shift_id, tenant_id, store_id, device_id, currency_code, closed_at, closing_user_id,
          close_kind, forced_reason, opening_float, cash_sales_total, cash_refunds_total,
          pay_in_total, pay_out_total, expected_cash, counted_cash, variance, sale_count,
          variance_approved_by_user_id, recorded_by_user_id, received_at, payload_hash)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10::numeric, $11::numeric,
               $12::numeric, $13::numeric, $14::numeric, $15::numeric, $16::numeric,
               $17::numeric, $18, $19, $20, now(), $21)
       RETURNING ${CLOSE_COLUMNS}`,
      [
        shift.shiftId,
        shift.tenantId,
        shift.storeId,
        shift.deviceId,
        shift.currencyCode,
        close.closedAt,
        close.closingUserId,
        close.closeKind,
        close.forcedReason,
        close.openingFloat,
        close.cashSalesTotal,
        close.cashRefundsTotal,
        close.payInTotal,
        close.payOutTotal,
        close.expectedCash,
        close.countedCash,
        close.variance,
        close.saleCount,
        close.varianceApprovedByUserId,
        close.recordedByUserId,
        close.payloadHash,
      ],
    );
    const row = r.rows[0] as CloseDbRow;

    const refs = [...close.cashRefundReturnRefs];
    if (refs.length > 0) {
      const claimed = await client.query(
        `INSERT INTO shift_refund_claims (return_id, shift_id, tenant_id, store_id, ordinal)
         SELECT ref.return_id, $1, $2, $3, (ref.ord - 1)::int
           FROM unnest($4::uuid[]) WITH ORDINALITY AS ref(return_id, ord)
          ORDER BY ref.return_id
         ON CONFLICT (return_id) DO NOTHING`,
        [shift.shiftId, shift.tenantId, shift.storeId, refs],
      );
      if (claimed.rowCount !== refs.length) throw new RefundRefAlreadyClaimedError();
    }

    const moved = await client.query(
      `UPDATE shifts SET lifecycle_state = $2
        WHERE shift_id = $1 AND tenant_id = $3 AND store_id = $4 AND opening_device_id = $5`,
      [
        shift.shiftId,
        close.closeKind === "forced" ? "closed_forced" : "closed",
        shift.tenantId,
        shift.storeId,
        shift.deviceId,
      ],
    );
    if (moved.rowCount !== 1) throw new ShiftCloseNotAppliedError();
    return toClose(row, refs);
  }
}
