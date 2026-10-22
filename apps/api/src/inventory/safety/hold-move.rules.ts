/**
 * Hold-move rules — Jira RT-449 (pure, no I/O).
 *
 * A tracking hold governs sellability by its record (G7-6, Q7); once positions
 * exist its quantity is represented by RT-435 status moves on the held
 * identity's positions. Which positions move, where to, and under which of
 * the reserved Reason Codes (`quality_hold`, `recall`; 0056) or
 * `hold_release`:
 *
 *   - placement: `sellable` and `return_inspection` move into the hold's
 *     status (G7-6). Negative and zero positions are never moved.
 *   - quality-hold release (H3): `quality_hold` returns to `sellable` — or,
 *     when the identity has EVER been under a recall hold (active or
 *     released; coordinator ruling B on RT-449), to `recall_hold`, so stock
 *     of a recalled lot leaves only through the Gate 8 disposition, whatever
 *     the order of the releases.
 *   - recall-hold release (H4): nothing moves; that stock leaves only through
 *     the Gate 8 disposition (RT-293).
 */
import type { InventoryReasonCode, InventoryStatus, TrackingHoldKind } from '@data-pulse-2/db';

/** The positions a hold command moves, their destination and Reason Code. */
export interface HoldMoves {
  readonly fromStatuses: readonly InventoryStatus[];
  readonly toStatus: InventoryStatus;
  readonly reasonCode: InventoryReasonCode;
}

const PLACEMENT_SOURCES: readonly InventoryStatus[] = ['sellable', 'return_inspection'];

/** G7-6: what placing a hold of `kind` moves. */
export function placementMoves(kind: TrackingHoldKind): HoldMoves {
  return kind === 'quality_hold'
    ? { fromStatuses: PLACEMENT_SOURCES, toStatus: 'quality_hold', reasonCode: 'quality_hold' }
    : { fromStatuses: PLACEMENT_SOURCES, toStatus: 'recall_hold', reasonCode: 'recall' };
}

/** H3 / H4 / ruling B: what releasing a hold of `kind` moves; null when nothing does. */
export function releaseMoves(
  kind: TrackingHoldKind,
  identity: { readonly everRecalled: boolean },
): HoldMoves | null {
  if (kind === 'recall_hold') return null;
  return identity.everRecalled
    ? { fromStatuses: ['quality_hold'], toStatus: 'recall_hold', reasonCode: 'recall' }
    : { fromStatuses: ['quality_hold'], toStatus: 'sellable', reasonCode: 'hold_release' };
}
