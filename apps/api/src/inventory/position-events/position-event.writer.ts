/**
 * Position-event writer — Jira RT-435, shared with RT-449.
 *
 * Writes one status move or relocation: the `inventory_position_events`
 * record, its two `stock_movements` effects (`-q` from, `+q` to; the DC-1 key
 * `<kind>:<eventId>:from|to`), their `erp_neutral` integration records (M-5,
 * Q10), the audit row and the outbox event — all on the caller's
 * tenant-context transaction. A replay of the same command (same fingerprint)
 * returns the recorded event and writes nothing; the same fingerprint with a
 * different command is a 409 `idempotency_key_conflict`.
 *
 * Two callers: the RT-435 commands (`tracking_identity_id` NULL; a tracked
 * product is refused, G7-4) and RT-449's hold-driven moves, which carry the
 * held identity and so may move a tracked product's identity-grain position.
 */
import { ConflictException } from '@nestjs/common';
import {
  emit,
  OUTBOX_EVENT_TYPES,
  type InventoryPositionEventKind,
  type InventoryReasonCode,
  type InventoryStatus,
} from '@data-pulse-2/db';
import { newId } from '@data-pulse-2/shared';
import type { PoolClient } from 'pg';

import { formatQuantity, parseQuantity } from '../decimal-quantity';
import {
  CrossUnitError,
  MOVEMENT_COLUMNS,
  isUnitExclusionViolation,
  toMovementBody,
  type MovementRow,
  type StockMovementBody,
} from '../inventory.service';
import { netsToZeroPerBucket, v1MappingBucket } from './position-event.rules';

/** Q10: the integration state of an effect whose event nets to zero per bucket. */
const ERP_NEUTRAL = 'erp_neutral';
/** DC-1: the provenance system of a Retail event leg. */
const RETAIL_SOURCE_SYSTEM = 'retail';

const AUDIT_ACTION: Readonly<Record<InventoryPositionEventKind, string>> = {
  status_move: 'inventory.status_move.create',
  relocation: 'inventory.relocation.create',
};
const AUDIT_TARGET_TYPE_EVENT = 'inventory_position_event';

/** Wire projection of an event (contract `InventoryPositionEvent`). */
export interface InventoryPositionEventBody {
  readonly id: string;
  readonly kind: InventoryPositionEventKind;
  readonly storeId: string;
  readonly tenantProductRef: string;
  readonly quantity: string;
  readonly stockingUnit: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly fromStatus: InventoryStatus;
  readonly toStatus: InventoryStatus;
  readonly reasonCode: InventoryReasonCode | null;
  readonly note: string | null;
  readonly trackingIdentityId: string | null;
  readonly createdBy: string;
  readonly occurredAt: string;
  /** The `-quantity` effect at the from position. */
  readonly fromEffect: StockMovementBody;
  /** The `+quantity` effect at the to position. */
  readonly toEffect: StockMovementBody;
}

/** The command, normalized: what the event record stores. */
export interface PositionCommand {
  readonly kind: InventoryPositionEventKind;
  readonly tenantId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly tenantProductRef: string;
  readonly quantity: string;
  readonly stockingUnit: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly fromStatus: InventoryStatus;
  readonly toStatus: InventoryStatus;
  readonly reasonCode: InventoryReasonCode | null;
  readonly note: string | null;
  /** The identity both effects carry; null refuses a tracked product (G7-4). */
  readonly trackingIdentityId: string | null;
  readonly fingerprint: string;
}

interface EventRow {
  id: string;
  kind: InventoryPositionEventKind;
  store_id: string;
  tenant_product_ref: string;
  quantity: string;
  stocking_unit: string;
  from_location_id: string;
  to_location_id: string;
  from_status: InventoryStatus;
  to_status: InventoryStatus;
  reason_code: InventoryReasonCode | null;
  note: string | null;
  tracking_identity_id: string | null;
  created_by: string;
  occurred_at: Date;
}

/** The effect columns, qualified by the `m` alias of `stock_movements`. */
const MOVEMENT_COLUMNS_M = MOVEMENT_COLUMNS.split(', ')
  .map((c) => 'm.' + c)
  .join(', ');

const EVENT_COLUMNS =
  'id, kind, store_id, tenant_product_ref, quantity::text AS quantity, stocking_unit, ' +
  'from_location_id, to_location_id, from_status, to_status, reason_code, note, ' +
  'tracking_identity_id, created_by, occurred_at';

/** One audit row, in the caller's transaction. */
export async function writeAudit(
  client: PoolClient,
  a: {
    readonly tenantId: string;
    readonly userId: string;
    readonly action: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly metadata: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [newId(), a.userId, a.tenantId, a.action, a.targetType, a.targetId, JSON.stringify(a.metadata)],
  );
}

/**
 * Write the event record, its two effects and their `erp_neutral`
 * integration records, the audit row and the outbox event — or, for a
 * replay, return the recorded event and write nothing.
 */
export async function recordPositionEvent(
  client: PoolClient,
  cmd: PositionCommand,
): Promise<InventoryPositionEventBody> {
  const replayed = await findReplay(client, cmd);
  if (replayed) return replayed;

  const fromQuantity = formatQuantity(-parseQuantity(cmd.quantity));
  assertErpNeutral(cmd, fromQuantity);
  if (cmd.trackingIdentityId === null) await assertUntracked(client, cmd.tenantProductRef);
  await assertUnitMatchesEstablished(client, cmd);

  const event = await insertEvent(client, cmd);
  if (!event) {
    // A concurrent request with the same command committed first.
    const raced = await findReplay(client, cmd);
    if (raced) return raced;
    throw new Error('PositionEventWriter: fingerprint conflict without a recorded event');
  }

  const fromEffect = await insertEffect(client, cmd, event, 'from', fromQuantity);
  const toEffect = await insertEffect(client, cmd, event, 'to', cmd.quantity);
  await recordEffectsWritten(client, cmd, event, [fromEffect.id, toEffect.id]);
  return toEventBody(event, fromEffect, toEffect);
}

/** Insert the event record; undefined when the fingerprint already exists (a racing replay). */
async function insertEvent(client: PoolClient, cmd: PositionCommand): Promise<EventRow | undefined> {
  const inserted = await client.query<EventRow>(
    `INSERT INTO inventory_position_events
       (id, tenant_id, store_id, kind, tenant_product_ref, quantity, stocking_unit,
        from_location_id, to_location_id, from_status, to_status, reason_code, note,
        tracking_identity_id, command_fingerprint, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::numeric(19,4), $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (tenant_id, command_fingerprint) DO NOTHING
     RETURNING ${EVENT_COLUMNS}`,
    [
      newId(),
      cmd.tenantId,
      cmd.storeId,
      cmd.kind,
      cmd.tenantProductRef,
      cmd.quantity,
      cmd.stockingUnit,
      cmd.fromLocationId,
      cmd.toLocationId,
      cmd.fromStatus,
      cmd.toStatus,
      cmd.reasonCode,
      cmd.note,
      cmd.trackingIdentityId,
      cmd.fingerprint,
      cmd.userId,
    ],
  );
  return inserted.rows[0];
}

/**
 * The effects' `erp_neutral` integration records (Q10), the audit row and
 * the outbox event, in the event's transaction.
 */
async function recordEffectsWritten(
  client: PoolClient,
  cmd: PositionCommand,
  event: EventRow,
  effectIds: readonly string[],
): Promise<void> {
  await client.query(
    `INSERT INTO inventory_effect_integration (effect_id, tenant_id, state)
     SELECT effect_id, $1, $3 FROM unnest($2::uuid[]) AS effect_id`,
    [cmd.tenantId, effectIds, ERP_NEUTRAL],
  );
  await writeAudit(client, {
    tenantId: cmd.tenantId,
    userId: cmd.userId,
    action: AUDIT_ACTION[cmd.kind],
    targetType: AUDIT_TARGET_TYPE_EVENT,
    targetId: event.id,
    metadata: { storeId: cmd.storeId, effectIds },
  });
  await emit(client, {
    eventType: OUTBOX_EVENT_TYPES.INVENTORY_MOVEMENT_CREATED,
    tenantId: cmd.tenantId,
    storeId: cmd.storeId,
    payload: {
      movementIds: effectIds,
      movementType: cmd.kind,
      tenantProductRef: cmd.tenantProductRef,
      positionEventId: event.id,
    },
    correlationId: null,
  });
}

/**
 * The recorded event of this command, or null. The same fingerprint with a
 * different command is a 409 (FR-030).
 */
async function findReplay(client: PoolClient, cmd: PositionCommand): Promise<InventoryPositionEventBody | null> {
  const found = await client.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM inventory_position_events
      WHERE tenant_id = $1 AND command_fingerprint = $2`,
    [cmd.tenantId, cmd.fingerprint],
  );
  const event = found.rows[0];
  if (!event) return null;
  if (!sameCommand(event, cmd)) {
    throw new ConflictException({
      code: 'idempotency_key_conflict',
      message: 'The Idempotency-Key was already used for a different command.',
    });
  }
  const effects = await client.query<MovementRow>(
    `SELECT ${MOVEMENT_COLUMNS_M},
            i.state AS integration_state, i.erp_confirmed_at, m.external_id
       FROM stock_movements m
       LEFT JOIN inventory_effect_integration i ON i.effect_id = m.id
      WHERE m.tenant_id = $1 AND m.source_system = $2 AND m.external_id = ANY($3::text[])`,
    [cmd.tenantId, RETAIL_SOURCE_SYSTEM, [effectKey(event, 'from'), effectKey(event, 'to')]],
  );
  const byKey = new Map(effects.rows.map((r) => [(r as MovementRow & { external_id: string }).external_id, r]));
  const fromRow = byKey.get(effectKey(event, 'from'));
  const toRow = byKey.get(effectKey(event, 'to'));
  if (!fromRow || !toRow) {
    throw new Error(`PositionEventWriter: event ${event.id} is missing an effect`);
  }
  return toEventBody(event, toMovementBody(fromRow), toMovementBody(toRow));
}

/** Append one effect of the event (DC-1 key `<kind>:<eventId>:<side>`). */
async function insertEffect(
  client: PoolClient,
  cmd: PositionCommand,
  event: EventRow,
  side: 'from' | 'to',
  quantity: string,
): Promise<StockMovementBody> {
  const [locationId, status] =
    side === 'from' ? [cmd.fromLocationId, cmd.fromStatus] : [cmd.toLocationId, cmd.toStatus];
  let rows: MovementRow[];
  try {
    rows = (
      await client.query<MovementRow>(
        `INSERT INTO stock_movements
           (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
            tenant_product_ref, reason, occurred_at, created_by, source_system, external_id,
            event_type, event_ref_id, stock_location_id, inventory_status, tracking_identity_id)
         VALUES ($1, $2, $3, 'adjustment', $4::numeric(19,4), $5, $6, $7, $8, $9, $10, $11,
                 'adjustment', $12, $13, $14, $15)
         RETURNING ${MOVEMENT_COLUMNS}`,
        [
          newId(),
          cmd.tenantId,
          cmd.storeId,
          quantity,
          cmd.stockingUnit,
          cmd.tenantProductRef,
          cmd.note ?? cmd.reasonCode,
          event.occurred_at,
          cmd.userId,
          RETAIL_SOURCE_SYSTEM,
          effectKey(event, side),
          event.id,
          locationId,
          status,
          event.tracking_identity_id,
        ],
      )
    ).rows;
  } catch (err: unknown) {
    if (isUnitExclusionViolation(err)) {
      // A concurrent first movement established another unit (0016).
      throw new CrossUnitError((await establishedUnit(client, cmd)) ?? cmd.stockingUnit, cmd.stockingUnit);
    }
    throw err;
  }
  const row = rows[0];
  if (!row) throw new Error('PositionEventWriter: effect INSERT returned no row');
  return toMovementBody({ ...row, integration_state: ERP_NEUTRAL, erp_confirmed_at: null });
}

/**
 * G7-4: an adjustment of a tracked product fails closed without an identity.
 * Identity-carrying moves are RT-449's hold moves (and RT-451's tracked moves).
 */
async function assertUntracked(client: PoolClient, tenantProductRef: string): Promise<void> {
  const r = await client.query<{ tracking_mode: string }>(
    `SELECT tracking_mode FROM tenant_products WHERE id = $1`,
    [tenantProductRef],
  );
  if (r.rows[0]?.tracking_mode !== 'none') {
    throw new ConflictException({
      code: 'tracking_identity_required',
      message: 'A tracked product needs a tracking identity, which this move does not support yet.',
    });
  }
}

/** FR-022: the unit must be the product's established unit at this store. */
async function assertUnitMatchesEstablished(client: PoolClient, cmd: PositionCommand): Promise<void> {
  const established = await establishedUnit(client, cmd);
  if (established !== null && established !== cmd.stockingUnit) {
    throw new CrossUnitError(established, cmd.stockingUnit);
  }
}

async function establishedUnit(client: PoolClient, cmd: PositionCommand): Promise<string | null> {
  const r = await client.query<{ stocking_unit: string }>(
    `SELECT stocking_unit FROM stock_movements
      WHERE store_id = $1 AND tenant_product_ref = $2
      ORDER BY received_at ASC, id ASC
      LIMIT 1`,
    [cmd.storeId, cmd.tenantProductRef],
  );
  return r.rows[0]?.stocking_unit ?? null;
}

/** The DC-1 provenance key of one leg. */
function effectKey(event: Pick<EventRow, 'id' | 'kind'>, side: 'from' | 'to'): string {
  return `${event.kind}:${event.id}:${side}`;
}

function leg(cmd: PositionCommand, bucket: string, quantity: string) {
  return {
    bucket,
    tenantProductRef: cmd.tenantProductRef,
    trackingIdentityId: cmd.trackingIdentityId,
    quantity,
  };
}

/**
 * M-5 under the V1 profile (Q2): both effects map to the store's bucket. A
 * non-zero net needs the Gate 8 (RT-293) transfer intent; until then nothing
 * is written.
 */
function assertErpNeutral(cmd: PositionCommand, fromQuantity: string): void {
  const bucket = v1MappingBucket(cmd.storeId);
  if (!netsToZeroPerBucket([leg(cmd, bucket, fromQuantity), leg(cmd, bucket, cmd.quantity)])) {
    throw new ConflictException({
      code: 'erp_transfer_intent_required',
      message: 'This move crosses ERP mapping buckets, which is not supported yet.',
    });
  }
}

/** True when a recorded event is the same command as `cmd` (replay, not conflict). */
function sameCommand(e: EventRow, cmd: PositionCommand): boolean {
  const recorded = [
    e.kind, e.store_id, e.tenant_product_ref, formatQuantity(parseQuantity(e.quantity)),
    e.stocking_unit, e.from_location_id, e.to_location_id, e.from_status, e.to_status,
    e.reason_code, e.note,
  ];
  const requested = [
    cmd.kind, cmd.storeId.toLowerCase(), cmd.tenantProductRef.toLowerCase(), cmd.quantity,
    cmd.stockingUnit, cmd.fromLocationId, cmd.toLocationId, cmd.fromStatus, cmd.toStatus,
    cmd.reasonCode, cmd.note,
  ];
  return JSON.stringify(recorded) === JSON.stringify(requested);
}

function toEventBody(
  e: EventRow,
  fromEffect: StockMovementBody,
  toEffect: StockMovementBody,
): InventoryPositionEventBody {
  return {
    id: e.id,
    kind: e.kind,
    storeId: e.store_id,
    tenantProductRef: e.tenant_product_ref,
    quantity: formatQuantity(parseQuantity(e.quantity)),
    stockingUnit: e.stocking_unit,
    fromLocationId: e.from_location_id,
    toLocationId: e.to_location_id,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    reasonCode: e.reason_code,
    note: e.note,
    trackingIdentityId: e.tracking_identity_id,
    createdBy: e.created_by,
    occurredAt: e.occurred_at.toISOString(),
    fromEffect,
    toEffect,
  };
}
