/**
 * RT-366 (RT-287 F3) — the wire projection of the device lifecycle impact
 * preview (`devices.openapi.yaml` `DeviceImpactPreview`), from the one-statement
 * impact read (`DevicesService`, `IMPACT_SQL`) and the lifecycle evaluator's
 * verdict. Pure: no DB, no clock.
 *
 * Explicit wire shape, never a DB row (§IV): counts only for the cascade (no
 * token, session id or code), `users.id` only for the cashier, no note.
 */
import type {
  DeviceLifecycleState,
  ImpactBlockCode,
  ImpactRequirement,
  ImpactVerdict,
  LifecycleAction,
  LifecycleEvaluation,
  RevokeReason,
} from "./device-lifecycle.evaluator";
import { toDeviceSummary, type DeviceReadRow, type TrustState } from "./devices.projections";

/** One device with its open shift's facts and the cascade counts, read in one snapshot. */
export interface DeviceImpactRow extends DeviceReadRow {
  readonly open_shift_source: "cash_up" | "legacy" | null;
  readonly open_shift_opened_at: Date | null;
  readonly open_shift_cashier_user_id: string | null;
  /** The open plus the cash movements of an open cash-up shift; null otherwise. */
  readonly cash_fact_count: number | null;
  readonly cash_last_received_at: Date | null;
  /** The revoke cascade's predicates, counted (`DevicesService`). */
  readonly operator_session_count: number;
  readonly pending_pairing_code_count: number;
  readonly evaluated_at: Date;
}

export interface ImpactCashFacts {
  readonly view: "server_received";
  readonly receivedCount: number;
  readonly lastReceivedAt: string;
}

export interface ImpactOpenShift {
  readonly shiftId: string;
  readonly source: "cash_up" | "legacy";
  readonly openedAt: string;
  readonly openingCashierUserId: string;
  readonly cashFacts: ImpactCashFacts | null;
}

export interface ImpactCascade {
  readonly operatorSessionCount: number;
  readonly pendingPairingCodeCount: number;
}

export interface DeviceImpactPreview {
  readonly deviceId: string;
  readonly action: LifecycleAction;
  readonly revokeReason: RevokeReason;
  readonly trustState: TrustState;
  readonly verdict: ImpactVerdict;
  readonly blockCode: ImpactBlockCode | null;
  readonly requires: ImpactRequirement[];
  readonly openShift: ImpactOpenShift | null;
  readonly custodyExceptionShiftId: string | null;
  readonly cascade: ImpactCascade | null;
  readonly replacesDeviceId: string | null;
  readonly replacedByDeviceId: string | null;
  readonly evaluatedAt: string;
}

/** The evaluator's view of the row. Retired implies revoked (0040 CHECK). */
export function lifecycleStateOf(row: DeviceImpactRow): DeviceLifecycleState {
  return { revoked: row.revoked_at !== null, retired: row.retired_at !== null, openShiftId: row.open_shift_id };
}

function openShiftOf(row: DeviceImpactRow): ImpactOpenShift | null {
  if (row.open_shift_id === null || row.open_shift_source === null) return null;
  if (row.open_shift_opened_at === null || row.open_shift_cashier_user_id === null) return null;
  const cashFacts: ImpactCashFacts | null =
    row.open_shift_source === "cash_up" && row.cash_fact_count !== null && row.cash_last_received_at !== null
      ? { view: "server_received", receivedCount: row.cash_fact_count, lastReceivedAt: row.cash_last_received_at.toISOString() }
      : null;
  return {
    shiftId: row.open_shift_id,
    source: row.open_shift_source,
    openedAt: row.open_shift_opened_at.toISOString(),
    openingCashierUserId: row.open_shift_cashier_user_id,
    cashFacts,
  };
}

export function toDeviceImpactPreview(input: {
  readonly row: DeviceImpactRow;
  readonly action: LifecycleAction;
  readonly reason: RevokeReason;
  readonly evaluation: LifecycleEvaluation;
}): DeviceImpactPreview {
  const { row, evaluation } = input;
  const summary = toDeviceSummary(row);
  return {
    deviceId: row.id,
    action: input.action,
    revokeReason: input.reason,
    trustState: summary.trustState,
    verdict: evaluation.verdict,
    blockCode: evaluation.blockCode,
    requires: [...evaluation.requires],
    openShift: openShiftOf(row),
    custodyExceptionShiftId: summary.custodyExceptionShiftId,
    // A lifecycle action revokes only a device that is not revoked yet.
    cascade:
      row.revoked_at === null
        ? { operatorSessionCount: row.operator_session_count, pendingPairingCodeCount: row.pending_pairing_code_count }
        : null,
    replacesDeviceId: summary.replacesDeviceId,
    replacedByDeviceId: summary.replacedByDeviceId,
    evaluatedAt: row.evaluated_at.toISOString(),
  };
}
