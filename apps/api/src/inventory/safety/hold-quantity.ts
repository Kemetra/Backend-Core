/**
 * Hold-driven quantity moves — Jira RT-449 (G7-6; M-5 via RT-435).
 *
 * Moves every POSITIVE position of a held identity whose status is one of
 * `moves.fromStatuses` into `moves.toStatus`, one RT-435 status move per
 * (store, location, status, unit) position: an `inventory_position_events`
 * record carrying the identity and its `erp_neutral` effect pair. Negative and
 * zero positions are never moved (they stay findings). Physical on-hand is
 * unchanged.
 *
 * Each move's fingerprint is derived from (hold, phase, position), so the
 * moves of one hold command are recorded once. The caller holds the tenant's
 * safety lock and the identity's row lock (`FOR UPDATE` blocks new
 * identity-grain effects, whose FK takes KEY SHARE on it), so the positions
 * read here are the positions moved.
 */
import type { InventoryStatus } from '@data-pulse-2/db';
import type { PoolClient } from 'pg';

import { formatQuantity, parseQuantity } from '../decimal-quantity';
import { recordPositionEvent } from '../position-events/position-event.writer';
import type { HoldMoves } from './hold-move.rules';
import { fingerprint } from './safety.common';

export interface HeldIdentityMove {
  readonly tenantId: string;
  readonly userId: string;
  readonly holdId: string;
  readonly phase: 'place' | 'release';
  readonly trackingIdentityId: string;
  readonly tenantProductRef: string;
  readonly moves: HoldMoves;
}

interface PositionRow {
  store_id: string;
  stock_location_id: string;
  inventory_status: InventoryStatus;
  stocking_unit: string;
  quantity: string;
}

/** Move the identity's positive source positions; returns the position event ids. */
export async function moveHeldPositions(client: PoolClient, move: HeldIdentityMove): Promise<string[]> {
  const positions = await client.query<PositionRow>(
    `SELECT store_id, stock_location_id, inventory_status, stocking_unit, SUM(quantity)::text AS quantity
       FROM stock_movements
      WHERE tenant_product_ref = $1 AND tracking_identity_id = $2
        AND stock_location_id IS NOT NULL AND inventory_status = ANY($3::text[])
      GROUP BY store_id, stock_location_id, inventory_status, stocking_unit
     HAVING SUM(quantity) > 0
      ORDER BY store_id, stock_location_id, inventory_status, stocking_unit`,
    [move.tenantProductRef, move.trackingIdentityId, move.moves.fromStatuses],
  );
  const eventIds: string[] = [];
  for (const p of positions.rows) {
    const event = await recordPositionEvent(client, {
      kind: 'status_move',
      tenantId: move.tenantId,
      storeId: p.store_id,
      userId: move.userId,
      tenantProductRef: move.tenantProductRef,
      quantity: formatQuantity(parseQuantity(p.quantity)),
      stockingUnit: p.stocking_unit,
      fromLocationId: p.stock_location_id,
      toLocationId: p.stock_location_id,
      fromStatus: p.inventory_status,
      toStatus: move.moves.toStatus,
      reasonCode: move.moves.reasonCode,
      note: null,
      trackingIdentityId: move.trackingIdentityId,
      fingerprint: fingerprint([
        'hold-move',
        move.holdId,
        move.phase,
        p.store_id,
        p.stock_location_id,
        p.inventory_status,
        p.stocking_unit,
      ]),
    });
    eventIds.push(event.id);
  }
  return eventIds;
}
