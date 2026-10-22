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
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  runWithTenantContext,
  type InventoryPositionEventKind,
  type InventoryReasonCode,
  type InventoryStatus,
  type ReturnLandingStatus,
} from '@data-pulse-2/db';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../../auth/auth.module';
import { MembershipRepository } from '../../context/membership.repository';
import { formatQuantity, parseQuantity } from '../decimal-quantity';
import {
  PositionEventRuleError,
  assertRelocationAllowed,
  assertStatusMoveAllowed,
  isSensitiveMove,
  maySensitiveMove,
} from './position-event.rules';
import {
  recordPositionEvent,
  writeAudit,
  type InventoryPositionEventBody,
  type PositionCommand,
} from './position-event.writer';

export type { InventoryPositionEventBody } from './position-event.writer';

/** Q6: where a return lands without a tenant setting. */
const DEFAULT_RETURN_LANDING: ReturnLandingStatus = 'sellable';

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

/** Wire projection of the return landing policy (contract `ReturnLandingPolicy`). */
export interface ReturnLandingPolicyBody {
  readonly returnLandingStatus: ReturnLandingStatus;
  /** Null while the tenant runs on the default. */
  readonly updatedAt: string | null;
}

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
    const base = untrackedCommand(input, 'status_move', note);

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        if (isSensitiveMove(input.fromStatus)) {
          await this.assertMaySensitiveMove(client, input);
        }
        await this.assertStoreAndProduct(client, input.storeId, input.tenantProductRef);
        const locationId = await this.resolveLocation(client, input.storeId, input.stockLocationId);
        return recordPositionEvent(client, {
          ...base,
          fromLocationId: locationId,
          toLocationId: locationId,
          fromStatus: input.fromStatus,
          toStatus: input.toStatus,
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
    const base = untrackedCommand(input, 'relocation', note);
    const status = input.inventoryStatus ?? 'sellable';

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        await this.assertStoreAndProduct(client, input.storeId, input.tenantProductRef);
        const fromLocationId = await this.resolveLocation(client, input.storeId, input.fromLocationId);
        const toLocationId = await this.resolveLocation(client, input.storeId, input.toLocationId);
        return recordPositionEvent(client, { ...base, fromLocationId, toLocationId, fromStatus: status, toStatus: status });
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
        await writeAudit(client, {
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
}

/**
 * The fields a status move and a relocation share, normalized: what the
 * caller and the product name, the command's replay fingerprint, and no
 * tracking identity (RT-435 moves are untracked; G7-4).
 */
function untrackedCommand(
  input: StatusMoveInput | RelocationInput,
  kind: InventoryPositionEventKind,
  note: string | null,
): Omit<PositionCommand, 'fromLocationId' | 'toLocationId' | 'fromStatus' | 'toStatus'> {
  return {
    kind,
    tenantId: input.tenantId,
    storeId: input.storeId,
    userId: input.userId,
    tenantProductRef: input.tenantProductRef,
    // Unit before quantity: the RT-435 refusal order.
    stockingUnit: normalizeUnit(input.stockingUnit),
    quantity: normalizePositiveQuantity(input.quantity),
    reasonCode: input.reasonCode,
    note,
    trackingIdentityId: null,
    fingerprint: commandFingerprint({ ...input, kind }),
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
