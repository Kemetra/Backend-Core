/**
 * ShiftCashUpRepository — RT-17 slice 2a persistence for the thin cash-up.
 * STUB (RED commit): signatures only; the implementation lands in GREEN.
 */
import type { PoolClient } from "pg";

import type { DeviceScope } from "../pos-cashier-admissions/device-scope";

export type ShiftLifecycleState = "open" | "closed" | "closed_forced";
export type CashMovementKind = "pay_in" | "pay_out";
export type CashMovementReason = "bank_drop" | "float_top_up" | "petty_expense" | "other";
export type ShiftCloseKind = "normal" | "forced";

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

export interface NewCashUpShift {
  readonly shiftId: string;
  readonly openedAt: string;
  readonly openingUserId: string;
  readonly currencyCode: string;
  readonly openingFloat: string;
  readonly recordedByUserId: string;
  readonly payloadHash: Buffer;
}

export type InsertShiftOutcome =
  | { readonly kind: "inserted"; readonly shift: CashUpShiftRow }
  | { readonly kind: "shift_id_taken" }
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

export interface NewCashMovement {
  readonly movementId: string;
  readonly kind: CashMovementKind;
  readonly amount: string;
  readonly reasonCode: CashMovementReason;
  readonly note: string | null;
  readonly occurredAt: string;
  readonly recordedByUserId: string;
  readonly payloadHash: Buffer;
}

export interface ShiftCloseFact {
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

export interface RefundRefRow {
  readonly returnId: string;
  readonly currencyCode: string;
  readonly hasCashRefund: boolean;
  readonly claimedByShiftId: string | null;
}

export class RefundRefAlreadyClaimedError extends Error {
  constructor() {
    super("a cash refund return is already claimed by another shift's close");
    this.name = "RefundRefAlreadyClaimedError";
  }
}

const notImplemented = (): never => {
  throw new Error("ShiftCashUpRepository: not implemented (RT-17 slice 2a RED)");
};

export class ShiftCashUpRepository {
  async findShift(
    _client: PoolClient,
    _scope: DeviceScope,
    _shiftId: string,
    _opts: { readonly forUpdate?: boolean } = {},
  ): Promise<CashUpShiftRow | null> {
    return notImplemented();
  }

  async findOpenShiftOnDevice(_client: PoolClient, _scope: DeviceScope): Promise<CashUpShiftRow | null> {
    return notImplemented();
  }

  async insertShift(
    _client: PoolClient,
    _scope: DeviceScope,
    _shift: NewCashUpShift,
  ): Promise<InsertShiftOutcome> {
    return notImplemented();
  }

  async findMovement(
    _client: PoolClient,
    _scope: DeviceScope,
    _movementId: string,
  ): Promise<CashMovementRow | null> {
    return notImplemented();
  }

  async insertMovement(
    _client: PoolClient,
    _shift: CashUpShiftRow,
    _movement: NewCashMovement,
  ): Promise<CashMovementRow | null> {
    return notImplemented();
  }

  async findClose(_client: PoolClient, _shift: CashUpShiftRow): Promise<ShiftCloseRow | null> {
    return notImplemented();
  }

  async readRefundRefs(
    _client: PoolClient,
    _scope: Pick<DeviceScope, "tenantId" | "storeId">,
    _returnIds: ReadonlyArray<string>,
  ): Promise<RefundRefRow[]> {
    return notImplemented();
  }

  async insertClose(
    _client: PoolClient,
    _shift: CashUpShiftRow,
    _close: ShiftCloseFact,
  ): Promise<ShiftCloseRow> {
    return notImplemented();
  }
}
