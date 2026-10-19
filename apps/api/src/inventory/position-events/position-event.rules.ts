/**
 * Position-event rules — Jira RT-435 (pure, no I/O).
 *
 *   - Reason Codes (839; RT-435 D1): which (from_status -> to_status) pairs each
 *     governed code allows on a status move, and which codes a relocation may
 *     carry.
 *   - Sensitivity (960 / 961; RT-435 D2): a status move out of `damaged`,
 *     `expired`, `quality_hold` or `recall_hold` is sensitive and is limited to
 *     owner and tenant_admin.
 *   - The per-bucket net rule (RT-290 M-5, Q10): an event's ERP stock intent is
 *     the net of its effects per (bucket, product, tracking). All-zero nets ⇒
 *     every effect is `erp_neutral`; any non-zero net needs an ERP transfer
 *     intent that Gate 8 (RT-293) has not defined, so the event fails closed.
 */
import type { InventoryReasonCode, InventoryStatus } from '@data-pulse-2/db';

import { parseQuantity } from '../decimal-quantity';

/**
 * The (from -> to) pairs each Reason Code allows on a status move.
 *
 *   - `damage`, `expiry`: sellable -> damaged / expired (843, 844, G7-5).
 *   - `inspection_restock`, `inspection_damage`: the disposition of a return
 *     out of `return_inspection` (849, 850).
 *   - `hold_release`: quality_hold -> sellable. Recall-hold stock leaves only
 *     through the Gate 8 disposition (G7-6), never by a release.
 *   - `correction`: any pair outside the two hold statuses, with a note.
 *   - `quality_hold`, `recall`: reserved for the tracking-hold workflow
 *     (RT-449). Holds are records on an identity (G7-6), so a plain status
 *     move never places or lifts one.
 */
type TransitionRule = (from: InventoryStatus, to: InventoryStatus) => boolean;

// A Map, not an object: a code outside the table finds no rule (never a
// prototype member), and is refused.
const REASON_TRANSITIONS: ReadonlyMap<InventoryReasonCode, TransitionRule> = new Map<
  InventoryReasonCode,
  TransitionRule
>([
  ['damage', (from, to) => from === 'sellable' && to === 'damaged'],
  ['expiry', (from, to) => from === 'sellable' && to === 'expired'],
  ['inspection_restock', (from, to) => from === 'return_inspection' && to === 'sellable'],
  ['inspection_damage', (from, to) => from === 'return_inspection' && to === 'damaged'],
  ['hold_release', (from, to) => from === 'quality_hold' && to === 'sellable'],
  ['correction', (from, to) => !HOLD_STATUSES.has(from) && !HOLD_STATUSES.has(to)],
]);

const HOLD_STATUSES: ReadonlySet<InventoryStatus> = new Set(['quality_hold', 'recall_hold']);

/** Reason Codes no RT-435 command accepts (the RT-449 hold workflow owns them). */
export const RESERVED_REASON_CODES: ReadonlySet<InventoryReasonCode> = new Set([
  'quality_hold',
  'recall',
]);

/** The statuses whose stock only an owner or tenant_admin may move out (D2). */
export const SENSITIVE_SOURCE_STATUSES: ReadonlySet<InventoryStatus> = new Set([
  'damaged',
  'expired',
  'quality_hold',
  'recall_hold',
]);

/** The roles that may move stock (D2); a store_manager only within its store scope. */
export const POSITION_MOVE_ROLES = ['owner', 'tenant_admin', 'store_manager'] as const;

/** The roles that may make a sensitive move (D2). */
const SENSITIVE_MOVE_ROLES: ReadonlySet<string> = new Set(['owner', 'tenant_admin']);

/** A refused command, mapped to a 400 by the controller. */
export class PositionEventRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PositionEventRuleError';
  }
}

/**
 * Validate a status move's statuses and Reason Code (G4-2, 839, D1). Throws
 * `PositionEventRuleError` on a same-status move, a reserved code, a code that
 * does not allow the pair, or a `correction` without a note.
 */
export function assertStatusMoveAllowed(input: {
  readonly fromStatus: InventoryStatus;
  readonly toStatus: InventoryStatus;
  readonly reasonCode: InventoryReasonCode;
  readonly note: string | null;
}): void {
  if (input.fromStatus === input.toStatus) {
    throw new PositionEventRuleError('fromStatus and toStatus must differ');
  }
  if (RESERVED_REASON_CODES.has(input.reasonCode)) {
    throw new PositionEventRuleError(
      `reasonCode '${input.reasonCode}' is reserved for the tracking-hold workflow`,
    );
  }
  const allows = REASON_TRANSITIONS.get(input.reasonCode);
  if (allows === undefined || !allows(input.fromStatus, input.toStatus)) {
    throw new PositionEventRuleError(
      `reasonCode '${input.reasonCode}' does not allow ${input.fromStatus} -> ${input.toStatus}`,
    );
  }
  assertCorrectionNote(input.reasonCode, input.note);
}

/**
 * Validate a relocation's locations and optional Reason Code (800, D1): the
 * locations differ, a reserved code is refused and a `correction` needs a note.
 */
export function assertRelocationAllowed(input: {
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly reasonCode: InventoryReasonCode | null;
  readonly note: string | null;
}): void {
  if (input.fromLocationId.toLowerCase() === input.toLocationId.toLowerCase()) {
    throw new PositionEventRuleError('fromLocationId and toLocationId must differ');
  }
  if (input.reasonCode !== null && RESERVED_REASON_CODES.has(input.reasonCode)) {
    throw new PositionEventRuleError(
      `reasonCode '${input.reasonCode}' is reserved for the tracking-hold workflow`,
    );
  }
  if (input.reasonCode !== null) assertCorrectionNote(input.reasonCode, input.note);
}

function assertCorrectionNote(reasonCode: InventoryReasonCode, note: string | null): void {
  if (reasonCode === 'correction' && note === null) {
    throw new PositionEventRuleError("reasonCode 'correction' requires a note");
  }
}

/** True when moving stock out of `fromStatus` is a sensitive move (D2). */
export function isSensitiveMove(fromStatus: InventoryStatus): boolean {
  return SENSITIVE_SOURCE_STATUSES.has(fromStatus);
}

/** True when `roleCode` (or platform-admin authority) may make a sensitive move. */
export function maySensitiveMove(roleCode: string | null, isPlatformAdmin: boolean): boolean {
  return isPlatformAdmin || (roleCode !== null && SENSITIVE_MOVE_ROLES.has(roleCode));
}

/** One effect of an event, as the net rule sees it. */
export interface NetRuleEffect {
  /** The ERP mapping bucket of the effect's (location, status) (M-1). */
  readonly bucket: string;
  readonly tenantProductRef: string;
  readonly trackingIdentityId: string | null;
  /** Signed exact-decimal quantity. */
  readonly quantity: string;
}

/**
 * M-5: true when the event nets to zero in every (bucket, product, tracking).
 * Such an event needs no ERP stock intent and its effects are `erp_neutral`.
 */
export function netsToZeroPerBucket(effects: readonly NetRuleEffect[]): boolean {
  const nets = new Map<string, bigint>();
  for (const e of effects) {
    const key = JSON.stringify([e.bucket, e.tenantProductRef, e.trackingIdentityId]);
    nets.set(key, (nets.get(key) ?? 0n) + parseQuantity(e.quantity));
  }
  for (const net of nets.values()) {
    if (net !== 0n) return false;
  }
  return true;
}

/**
 * The V1 mapping profile (RT-290 Q2, approved): one ERP mapping bucket per
 * store — every location and status of the store maps to the store's `stock`
 * warehouse by the implicit rule. A second bucket per store (with Gate 8's
 * transfer intent) replaces this resolver.
 */
export function v1MappingBucket(storeId: string): string {
  return `store:${storeId.toLowerCase()}`;
}
