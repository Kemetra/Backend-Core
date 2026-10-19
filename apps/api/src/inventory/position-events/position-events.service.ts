/**
 * InventoryPositionEventsService — Jira RT-435 (RT-290 Gate 4: G4-2, G4-6,
 * M-1, M-5, Q2, Q6, Q10; RT-435 owner decisions D1–D4, comment 12993).
 *
 * The two position-changing Retail events, each an `adjustment` Business
 * Event (G2-1, 838) with an `inventory_position_events` record (0056) and
 * exactly two effects under it:
 *
 *   - status move (842–844): `-q` at (location, from_status) and `+q` at
 *     (location, to_status). A Reason Code is required and must allow the
 *     pair (839, D1).
 *   - relocation (800): `-q` at (from_location, status) and `+q` at
 *     (to_location, status), both active locations of the path store.
 *
 * The event shape (stable; RT-449 and RT-451 build on it):
 *   - event record: id, kind, store, product, quantity (> 0), unit,
 *     from/to location, from/to status, reason code, note,
 *     tracking_identity_id (NULL until RT-451), actor, command fingerprint;
 *   - effects: `stock_movements` rows with movement_type `adjustment`,
 *     event_type `adjustment`, event_ref_id = the event id, the event's
 *     tracking_identity_id, and the DC-1 provenance pair
 *     (source_system `retail`, external_id `<kind>:<eventId>:from|to`);
 *   - integration: one `erp_neutral` record per effect (Q10), written in the
 *     same transaction, because under the V1 profile (Q2) both effects of
 *     either event are in the store's one bucket and net to zero (M-5). A
 *     non-zero net in any bucket fails closed before anything is written.
 *
 * Physical on-hand is unchanged by either event (the effects sum to zero);
 * Sellable On Hand changes by exactly `q` when one side is `sellable`.
 *
 * Replay (DC-1): the command fingerprint is SHA-256 over (kind, store, actor,
 * Idempotency-Key) and is UNIQUE per tenant. A replay of the same command
 * returns the recorded event and writes nothing; the same key with a
 * different command is a 409 `idempotency_key_conflict`. The HTTP interceptor
 * (`@Idempotent`) answers most replays first; this is the durable backstop.
 *
 * Return landing policy (Q6, 849): `tenant_inventory_settings` holds
 * `return_landing_status` (`sellable` default | `return_inspection`).
 * `resolveReturnLandingStatus` is the read RT-427's return effects use; until
 * RT-427 lands nothing writes a return effect, so the default changes nothing.
 *
 * Tenant isolation: every statement runs inside `runWithTenantContext` (FORCE
 * RLS). Store scope and the role gate are enforced at the controller; the
 * sensitive-move gate (D2) needs the caller's role code and is checked here.
 */
import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  emit,
  OUTBOX_EVENT_TYPES,
  runWithTenantContext,
  type InventoryPositionEventKind,
  type InventoryReasonCode,
  type InventoryStatus,
  type ReturnLandingStatus,
} from '@data-pulse-2/db';
import { newId } from '@data-pulse-2/shared';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../../auth/auth.module';
import { MembershipRepository } from '../../context/membership.repository';
import { formatQuantity, parseQuantity } from '../decimal-quantity';
import {
  CrossUnitError,
  MOVEMENT_COLUMNS,
  isUnitExclusionViolation,
  toMovementBody,
  type MovementRow,
  type StockMovementBody,
} from '../inventory.service';
import {
  PositionEventRuleError,
  assertRelocationAllowed,
  assertStatusMoveAllowed,
  isSensitiveMove,
  maySensitiveMove,
  netsToZeroPerBucket,
  v1MappingBucket,
} from './position-event.rules';

/** Q10: the integration state of an effect whose event nets to zero per bucket. */
const ERP_NEUTRAL = 'erp_neutral';
/** DC-1: the provenance system of a Retail event leg. */
const RETAIL_SOURCE_SYSTEM = 'retail';
/** Q6: where a return lands without a tenant setting. */
const DEFAULT_RETURN_LANDING: ReturnLandingStatus = 'sellable';

const AUDIT_ACTION: Readonly<Record<InventoryPositionEventKind, string>> = {
  status_move: 'inventory.status_move.create',
  relocation: 'inventory.relocation.create',
};
const AUDIT_TARGET_TYPE_EVENT = 'inventory_position_event';
const AUDIT_ACTION_RETURN_LANDING = 'inventory.return_landing.update';
const AUDIT_TARGET_TYPE_SETTINGS = 'tenant_inventory_settings';

/** The caller of a position command, resolved server-side (FR-052). */
export interface PositionCommandActor {
  readonly tenantId: string;
  readonly userId: string;
  readonly isPlatformAdmin: boolean;
  /** The request's Idempotency-Key; only its fingerprint is stored. */
  readonly idempotencyKey: string;
}

export interface StatusMoveInput extends PositionCommandActor {
  readonly storeId: string;
  readonly tenantProductRef: string;
  readonly quantity: string;
  readonly stockingUnit: string;
  /** Defaults to the store's primary location. */
  readonly stockLocationId: string | null;
  readonly fromStatus: InventoryStatus;
  readonly toStatus: InventoryStatus;
  readonly reasonCode: InventoryReasonCode;
  readonly note: string | null;
}

export interface RelocationInput extends PositionCommandActor {
  readonly storeId: string;
  readonly tenantProductRef: string;
  readonly quantity: string;
  readonly stockingUnit: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  /** Defaults to `sellable`. */
  readonly inventoryStatus: InventoryStatus | null;
  readonly reasonCode: InventoryReasonCode | null;
  readonly note: string | null;
}

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

/** Wire projection of the return landing policy (contract `ReturnLandingPolicy`). */
export interface ReturnLandingPolicyBody {
  readonly returnLandingStatus: ReturnLandingStatus;
  /** Null while the tenant runs on the default. */
  readonly updatedAt: string | null;
}

/** The command, normalized: what the event record stores. */
interface PositionCommand {
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

const EVENT_COLUMNS =
  'id, kind, store_id, tenant_product_ref, quantity::text AS quantity, stocking_unit, ' +
  'from_location_id, to_location_id, from_status, to_status, reason_code, note, ' +
  'tracking_identity_id, created_by, occurred_at';

/** SHA-256 hex of the command's replay identity; the raw key is never stored. */
export function commandFingerprint(input: {
  readonly kind: InventoryPositionEventKind;
  readonly storeId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
}): string {
  return createHash('sha256')
    .update(
      [input.kind, input.storeId.toLowerCase(), input.userId.toLowerCase(), input.idempotencyKey].join(
        '\n',
      ),
    )
    .digest('hex');
}

/**
 * Q6: the status a tenant's return effects land in. Runs on the caller's
 * tenant-context client (RT-427 calls it inside its write transaction).
 */
export async function resolveReturnLandingStatus(
  client: PoolClient,
  tenantId: string,
): Promise<ReturnLandingStatus> {
  const r = await client.query<{ return_landing_status: ReturnLandingStatus }>(
    `SELECT return_landing_status FROM tenant_inventory_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0]?.return_landing_status ?? DEFAULT_RETURN_LANDING;
}

@Injectable()
export class InventoryPositionEventsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /** Record a status move (G4-2, 842–844). */
  async createStatusMove(input: StatusMoveInput): Promise<InventoryPositionEventBody> {
    const note = normalizeNote(input.note);
    runRule(() =>
      assertStatusMoveAllowed({
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        reasonCode: input.reasonCode,
        note,
      }),
    );
    const unit = normalizeUnit(input.stockingUnit);
    const quantity = normalizePositiveQuantity(input.quantity);

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        if (isSensitiveMove(input.fromStatus)) {
          await this.assertMaySensitiveMove(client, input);
        }
        await this.assertStoreAndProduct(client, input.storeId, input.tenantProductRef);
        const locationId = await this.resolveLocation(client, input.storeId, input.stockLocationId);
        return this.record(client, {
          kind: 'status_move',
          tenantId: input.tenantId,
          storeId: input.storeId,
          userId: input.userId,
          tenantProductRef: input.tenantProductRef,
          quantity,
          stockingUnit: unit,
          fromLocationId: locationId,
          toLocationId: locationId,
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
          reasonCode: input.reasonCode,
          note,
          trackingIdentityId: null,
          fingerprint: commandFingerprint({ ...input, kind: 'status_move' }),
        });
      },
    );
  }

  /** Record a relocation between two locations of one store (800). */
  async createRelocation(input: RelocationInput): Promise<InventoryPositionEventBody> {
    const note = normalizeNote(input.note);
    runRule(() =>
      assertRelocationAllowed({
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        reasonCode: input.reasonCode,
        note,
      }),
    );
    const unit = normalizeUnit(input.stockingUnit);
    const quantity = normalizePositiveQuantity(input.quantity);
    const status = input.inventoryStatus ?? 'sellable';

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        await this.assertStoreAndProduct(client, input.storeId, input.tenantProductRef);
        const fromLocationId = await this.resolveLocation(client, input.storeId, input.fromLocationId);
        const toLocationId = await this.resolveLocation(client, input.storeId, input.toLocationId);
        return this.record(client, {
          kind: 'relocation',
          tenantId: input.tenantId,
          storeId: input.storeId,
          userId: input.userId,
          tenantProductRef: input.tenantProductRef,
          quantity,
          stockingUnit: unit,
          fromLocationId,
          toLocationId,
          fromStatus: status,
          toStatus: status,
          reasonCode: input.reasonCode,
          note,
          trackingIdentityId: null,
          fingerprint: commandFingerprint({ ...input, kind: 'relocation' }),
        });
      },
    );
  }

  /** The tenant's return landing policy (Q6); the default when unset. */
  getReturnLandingPolicy(tenantId: string): Promise<ReturnLandingPolicyBody> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      const r = await client.query<{ return_landing_status: ReturnLandingStatus; updated_at: Date }>(
        `SELECT return_landing_status, updated_at FROM tenant_inventory_settings WHERE tenant_id = $1`,
        [tenantId],
      );
      const row = r.rows[0];
      return {
        returnLandingStatus: row?.return_landing_status ?? DEFAULT_RETURN_LANDING,
        updatedAt: row ? row.updated_at.toISOString() : null,
      };
    });
  }

  /** Set the tenant's return landing policy (Q6), audited in the same transaction. */
  setReturnLandingPolicy(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly returnLandingStatus: ReturnLandingStatus;
  }): Promise<ReturnLandingPolicyBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        // Serialize writers per tenant, then lock the row: FOR UPDATE alone
        // cannot lock a row that does not exist yet (a tenant on the default),
        // so two first PUTs could both read the default. Under the advisory
        // lock the audit `old` is exact and a repeat is always a no-op.
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('tenant_inventory_settings:' || $1::text, 0))`,
          [input.tenantId],
        );
        const current = await client.query<{ return_landing_status: ReturnLandingStatus; updated_at: Date }>(
          `SELECT return_landing_status, updated_at FROM tenant_inventory_settings
            WHERE tenant_id = $1 FOR UPDATE`,
          [input.tenantId],
        );
        const existing = current.rows[0];
        const before = existing?.return_landing_status ?? DEFAULT_RETURN_LANDING;
        if (before === input.returnLandingStatus) {
          // The current value again (the default included): no write, no audit.
          return {
            returnLandingStatus: before,
            updatedAt: existing ? existing.updated_at.toISOString() : null,
          };
        }
        const r = await client.query<{ return_landing_status: ReturnLandingStatus; updated_at: Date }>(
          `INSERT INTO tenant_inventory_settings (tenant_id, return_landing_status, updated_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id) DO UPDATE
             SET return_landing_status = EXCLUDED.return_landing_status,
                 updated_by = EXCLUDED.updated_by
           RETURNING return_landing_status, updated_at`,
          [input.tenantId, input.returnLandingStatus, input.userId],
        );
        const row = r.rows[0];
        if (!row) throw new Error('InventoryPositionEventsService: settings upsert returned no row');
        await this.audit(client, {
          tenantId: input.tenantId,
          userId: input.userId,
          action: AUDIT_ACTION_RETURN_LANDING,
          targetType: AUDIT_TARGET_TYPE_SETTINGS,
          targetId: input.tenantId,
          metadata: { old: before, new: row.return_landing_status },
        });
        return {
          returnLandingStatus: row.return_landing_status,
          updatedAt: row.updated_at.toISOString(),
        };
      },
    );
  }

  /**
   * Write the event record, its two effects and their `erp_neutral`
   * integration records, the audit row and the outbox event — or, for a
   * replay, return the recorded event and write nothing.
   */
  private async record(
    client: PoolClient,
    cmd: PositionCommand,
  ): Promise<InventoryPositionEventBody> {
    const replayed = await this.findReplay(client, cmd);
    if (replayed) return replayed;

    const fromQuantity = formatQuantity(-parseQuantity(cmd.quantity));
    assertErpNeutral(cmd, fromQuantity);
    await this.assertUntracked(client, cmd.tenantProductRef);
    await this.assertUnitMatchesEstablished(client, cmd);

    const event = await this.insertEvent(client, cmd);
    if (!event) {
      // A concurrent request with the same command committed first.
      const raced = await this.findReplay(client, cmd);
      if (raced) return raced;
      throw new Error('InventoryPositionEventsService: fingerprint conflict without a recorded event');
    }

    const fromEffect = await this.insertEffect(client, cmd, event, 'from', fromQuantity);
    const toEffect = await this.insertEffect(client, cmd, event, 'to', cmd.quantity);
    await this.recordEffectsWritten(client, cmd, event, [fromEffect.id, toEffect.id]);
    return toEventBody(event, fromEffect, toEffect);
  }

  /** Insert the event record; null when the fingerprint already exists (a racing replay). */
  private async insertEvent(client: PoolClient, cmd: PositionCommand): Promise<EventRow | undefined> {
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
  private async recordEffectsWritten(
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
    await this.audit(client, {
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
  private async findReplay(
    client: PoolClient,
    cmd: PositionCommand,
  ): Promise<InventoryPositionEventBody | null> {
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
      `SELECT ${MOVEMENT_COLUMNS.split(', ').map((c) => `m.${c}`).join(', ')},
              i.state AS integration_state, i.erp_confirmed_at, m.external_id
         FROM stock_movements m
         LEFT JOIN inventory_effect_integration i ON i.effect_id = m.id
        WHERE m.tenant_id = $1 AND m.source_system = $2 AND m.external_id = ANY($3::text[])`,
      [cmd.tenantId, RETAIL_SOURCE_SYSTEM, [effectKey(event, 'from'), effectKey(event, 'to')]],
    );
    const byKey = new Map(
      effects.rows.map((r) => [(r as MovementRow & { external_id: string }).external_id, r]),
    );
    const fromRow = byKey.get(effectKey(event, 'from'));
    const toRow = byKey.get(effectKey(event, 'to'));
    if (!fromRow || !toRow) {
      throw new Error(`InventoryPositionEventsService: event ${event.id} is missing an effect`);
    }
    return toEventBody(event, toMovementBody(fromRow), toMovementBody(toRow));
  }

  /** Append one effect of the event (DC-1 key `<kind>:<eventId>:<side>`). */
  private async insertEffect(
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
        throw new CrossUnitError(await this.establishedUnit(client, cmd) ?? cmd.stockingUnit, cmd.stockingUnit);
      }
      throw err;
    }
    const row = rows[0];
    if (!row) throw new Error('InventoryPositionEventsService: effect INSERT returned no row');
    return toMovementBody({ ...row, integration_state: ERP_NEUTRAL, erp_confirmed_at: null });
  }

  /** D2: a move out of a sensitive status needs owner / tenant_admin (or platform admin). */
  private async assertMaySensitiveMove(client: PoolClient, input: StatusMoveInput): Promise<void> {
    if (input.isPlatformAdmin) return;
    const role = await this.memberships.findRoleCodeForUserInTenant(input.userId, input.tenantId, client);
    if (!maySensitiveMove(role, false)) {
      throw new ForbiddenException({
        code: 'sensitive_move_forbidden',
        message: 'Only an owner or tenant admin may move stock out of this status.',
      });
    }
  }

  /** The store and the product resolve in the tenant (FR-051): else a non-disclosing 404. */
  private async assertStoreAndProduct(
    client: PoolClient,
    storeId: string,
    tenantProductRef: string,
  ): Promise<void> {
    const store = await client.query(`SELECT 1 FROM stores WHERE id = $1 AND deleted_at IS NULL`, [
      storeId,
    ]);
    if (store.rowCount === 0) throw new NotFoundException('Not Found');
    const product = await client.query(`SELECT 1 FROM tenant_products WHERE id = $1`, [
      tenantProductRef,
    ]);
    if (product.rowCount === 0) throw new NotFoundException('Not Found');
  }

  /**
   * An active location of the path store (the primary when `locationId` is
   * null). A location of another store or tenant is a non-disclosing 404, an
   * inactive one a 400 (as RT-432's resolvePosition); the composite FKs are the
   * database backstop.
   */
  private async resolveLocation(
    client: PoolClient,
    storeId: string,
    locationId: string | null,
  ): Promise<string> {
    const r = locationId
      ? await client.query<{ id: string; is_active: boolean }>(
          `SELECT id, is_active FROM stock_locations WHERE id = $1 AND store_id = $2`,
          [locationId, storeId],
        )
      : await client.query<{ id: string; is_active: boolean }>(
          `SELECT id, is_active FROM stock_locations WHERE store_id = $1 AND kind = 'primary'`,
          [storeId],
        );
    const row = r.rows[0];
    if (!row) throw new NotFoundException('Not Found');
    if (!row.is_active) throw new BadRequestException('the stock location is inactive');
    return row.id;
  }

  /**
   * G7-4: an adjustment of a tracked product fails closed without an identity.
   * Tracked moves arrive with RT-451.
   */
  private async assertUntracked(client: PoolClient, tenantProductRef: string): Promise<void> {
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
  private async assertUnitMatchesEstablished(client: PoolClient, cmd: PositionCommand): Promise<void> {
    const established = await this.establishedUnit(client, cmd);
    if (established !== null && established !== cmd.stockingUnit) {
      throw new CrossUnitError(established, cmd.stockingUnit);
    }
  }

  private async establishedUnit(client: PoolClient, cmd: PositionCommand): Promise<string | null> {
    const r = await client.query<{ stocking_unit: string }>(
      `SELECT stocking_unit FROM stock_movements
        WHERE store_id = $1 AND tenant_product_ref = $2
        ORDER BY received_at ASC, id ASC
        LIMIT 1`,
      [cmd.storeId, cmd.tenantProductRef],
    );
    return r.rows[0]?.stocking_unit ?? null;
  }

  private async audit(
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

function runRule(check: () => void): void {
  try {
    check();
  } catch (err: unknown) {
    if (err instanceof PositionEventRuleError) throw new BadRequestException(err.message);
    throw err;
  }
}

function normalizeNote(note: string | null): string | null {
  const trimmed = note?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUnit(unit: string): string {
  const trimmed = unit.trim();
  if (trimmed.length === 0) throw new BadRequestException('stockingUnit is required');
  return trimmed;
}

/** A strictly positive numeric(19,4) magnitude, in canonical form. */
function normalizePositiveQuantity(quantity: string): string {
  const q = parseQuantity(quantity);
  if (q <= 0n) throw new BadRequestException('quantity must be strictly positive');
  return formatQuantity(q);
}
