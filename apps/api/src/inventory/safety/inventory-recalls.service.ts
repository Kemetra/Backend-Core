/**
 * InventoryRecallsService — Jira RT-449 (RT-50 G7-6, 860–863; owner rulings
 * H1 / H2, RT-449 comment 13434).
 *
 * A Recall is an Inventory safety Business Event: tenant, reason code,
 * external reference (e.g. an authority notice), product, listed identities
 * and `effective_at` (not in the future). It creates a `recall_hold` on each
 * listed identity and moves each identity's positive `sellable` /
 * `return_inspection` positions into `recall_hold` — all under ONE Safety
 * Revision step (`recall_created`). The product is never retired (861).
 *
 * Refusals, all before the first write: duplicate identities (400), a future
 * `effectiveAt` (400), a product or an identity that is not of this tenant
 * and product (non-disclosing 404), an identity already under an active
 * recall hold (409 `hold_already_active`).
 *
 * Replay: the fingerprint is SHA-256 over (actor, Idempotency-Key), UNIQUE
 * per tenant; the same command returns the recorded recall and its revision.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import { newId } from '@data-pulse-2/shared';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../../auth/auth.module';
import { writeAudit } from '../position-events/position-event.writer';
import { placementMoves } from './hold-move.rules';
import { moveHeldPositions } from './hold-quantity';
import { bumpSafetyRevision, lockTenantSafety, recordedRevision, recordSafetyChange } from './safety-revision';
import {
  fingerprint,
  idempotencyConflict,
  normalizeNote,
  normalizeReasonCode,
  toHoldBody,
  type TrackingHoldBody,
} from './safety.common';
import {
  holdsOfRecall,
  identitiesWithActiveHold,
  insertHold,
  lockIdentities,
  type LockedIdentity,
} from './tracking-holds.store';

export interface CreateRecallInput {
  readonly tenantId: string;
  readonly userId: string;
  /** The request's Idempotency-Key; only its fingerprint is stored. */
  readonly idempotencyKey: string;
  readonly tenantProductRef: string;
  readonly trackingIdentityIds: readonly string[];
  readonly reasonCode: string;
  readonly reference: string;
  readonly note: string | null;
  /** ISO 8601; defaults to now. Never in the future. */
  readonly effectiveAt: string | null;
}

/** Wire projection of a recall (contract `InventoryRecall`). */
export interface InventoryRecallBody {
  readonly id: string;
  readonly tenantProductRef: string;
  readonly reasonCode: string;
  readonly reference: string;
  readonly note: string | null;
  readonly effectiveAt: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly holds: TrackingHoldBody[];
}

export interface InventoryRecallResult {
  readonly recall: InventoryRecallBody;
  readonly safetyRevision: number;
}

interface RecallRow {
  id: string;
  tenant_product_ref: string;
  reason_code: string;
  reference: string;
  note: string | null;
  effective_at: Date;
  created_by: string;
  created_at: Date;
}

const RECALL_COLUMNS = 'id, tenant_product_ref, reason_code, reference, note, effective_at, created_by, created_at';

/** The normalized command. */
interface RecallCommand {
  readonly tenantProductRef: string;
  readonly identityIds: readonly string[];
  readonly reasonCode: string;
  readonly reference: string;
  readonly note: string | null;
  readonly effectiveAt: Date | null;
  readonly fingerprint: string;
}

@Injectable()
export class InventoryRecallsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async createRecall(input: CreateRecallInput): Promise<InventoryRecallResult> {
    const cmd = normalizeRecall(input);
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) => {
      await lockTenantSafety(client, input.tenantId);
      const replay = await this.findByFingerprint(client, cmd.fingerprint);
      if (replay) return this.replayResult(client, replay, cmd);

      const identities = await lockRecallableIdentities(client, cmd);

      const revision = await bumpSafetyRevision(client, input.tenantId);
      const recall = await this.insertRecall(client, input, cmd);
      await recordSafetyChange(client, {
        tenantId: input.tenantId,
        revision,
        kind: 'recall_created',
        tenantProductRef: recall.tenant_product_ref,
        inventoryRecallId: recall.id,
        createdBy: input.userId,
      });
      const { holds, positionEventIds } = await placeRecallHolds(client, input, recall, identities);
      await writeAudit(client, {
        tenantId: input.tenantId,
        userId: input.userId,
        action: 'inventory.recall.create',
        targetType: 'inventory_recall',
        targetId: recall.id,
        metadata: { trackingIdentityIds: cmd.identityIds, safetyRevision: revision, positionEventIds },
      });
      return { recall: toRecallBody(recall, holds), safetyRevision: revision };
    });
  }

  /** One recall of the tenant with its holds; another tenant's id is a non-disclosing 404. */
  getRecall(tenantId: string, recallId: string): Promise<InventoryRecallBody> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      const r = await client.query<RecallRow>(`SELECT ${RECALL_COLUMNS} FROM inventory_recalls WHERE id = $1`, [
        recallId,
      ]);
      const recall = r.rows[0];
      if (!recall) throw new NotFoundException('Not Found');
      return toRecallBody(recall, (await holdsOfRecall(client, recall.id)).map(toHoldBody));
    });
  }

  private async insertRecall(client: PoolClient, input: CreateRecallInput, cmd: RecallCommand): Promise<RecallRow> {
    const r = await client.query<RecallRow>(
      `INSERT INTO inventory_recalls
         (id, tenant_id, tenant_product_ref, reason_code, reference, note, effective_at,
          command_fingerprint, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8, $9)
       RETURNING ${RECALL_COLUMNS}`,
      [
        newId(),
        input.tenantId,
        cmd.tenantProductRef,
        cmd.reasonCode,
        cmd.reference,
        cmd.note,
        cmd.effectiveAt,
        cmd.fingerprint,
        input.userId,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new Error('InventoryRecallsService: recall INSERT returned no row');
    return row;
  }

  private async findByFingerprint(client: PoolClient, commandFingerprint: string): Promise<RecallRow | undefined> {
    const r = await client.query<RecallRow>(
      `SELECT ${RECALL_COLUMNS} FROM inventory_recalls WHERE command_fingerprint = $1`,
      [commandFingerprint],
    );
    return r.rows[0];
  }

  /** The recorded recall when `cmd` is the same command; else a 409. */
  private async replayResult(client: PoolClient, recall: RecallRow, cmd: RecallCommand): Promise<InventoryRecallResult> {
    const holds = await holdsOfRecall(client, recall.id);
    const recorded = [
      recall.tenant_product_ref, recall.reason_code, recall.reference, recall.note,
      holds.map((h) => h.tracking_identity_id).sort(),
    ];
    const requested = [cmd.tenantProductRef, cmd.reasonCode, cmd.reference, cmd.note, [...cmd.identityIds].sort()];
    const sameTime = cmd.effectiveAt === null || cmd.effectiveAt.getTime() === recall.effective_at.getTime();
    if (!sameTime || JSON.stringify(recorded) !== JSON.stringify(requested)) throw idempotencyConflict();
    return {
      recall: toRecallBody(recall, holds.map(toHoldBody)),
      safetyRevision: await recordedRevision(client, { kind: 'recall_created', inventoryRecallId: recall.id }),
    };
  }
}

/**
 * Lock the listed identities, refusing before any write: a product or an
 * identity not of this tenant and product is a non-disclosing 404, an
 * identity already under an active recall hold a 409.
 */
async function lockRecallableIdentities(client: PoolClient, cmd: RecallCommand): Promise<LockedIdentity[]> {
  const product = await client.query(`SELECT 1 FROM tenant_products WHERE id = $1`, [cmd.tenantProductRef]);
  if (product.rowCount === 0) throw new NotFoundException('Not Found');
  const identities = await lockIdentities(client, cmd.identityIds, cmd.tenantProductRef);
  if (identities.length !== cmd.identityIds.length) throw new NotFoundException('Not Found');
  if ((await identitiesWithActiveHold(client, cmd.identityIds, 'recall_hold')).length > 0) {
    throw new ConflictException({
      code: 'hold_already_active',
      message: 'A listed tracking identity already has an active recall hold.',
    });
  }
  return identities;
}

/** One recall hold per identity, each with its placement moves (G7-6). */
async function placeRecallHolds(
  client: PoolClient,
  input: CreateRecallInput,
  recall: RecallRow,
  identities: readonly LockedIdentity[],
): Promise<{ holds: TrackingHoldBody[]; positionEventIds: string[] }> {
  const holds: TrackingHoldBody[] = [];
  const positionEventIds: string[] = [];
  for (const identity of identities) {
    const hold = await insertHold(client, {
      tenantId: input.tenantId,
      trackingIdentityId: identity.id,
      tenantProductRef: recall.tenant_product_ref,
      kind: 'recall_hold',
      reasonCode: recall.reason_code,
      note: null,
      recallId: recall.id,
      commandFingerprint: null,
      placedBy: input.userId,
    });
    holds.push(toHoldBody(hold));
    const moved = await moveHeldPositions(client, {
      tenantId: input.tenantId,
      userId: input.userId,
      holdId: hold.id,
      phase: 'place',
      trackingIdentityId: identity.id,
      tenantProductRef: recall.tenant_product_ref,
      moves: placementMoves('recall_hold'),
    });
    positionEventIds.push(...moved);
  }
  return { holds, positionEventIds };
}

function normalizeRecall(input: CreateRecallInput): RecallCommand {
  const identityIds = input.trackingIdentityIds.map((id) => id.toLowerCase());
  if (identityIds.length === 0) throw new BadRequestException('trackingIdentityIds must not be empty');
  if (new Set(identityIds).size !== identityIds.length) {
    throw new BadRequestException('trackingIdentityIds must not repeat an identity');
  }
  const reference = input.reference.trim();
  if (reference.length === 0 || reference.length > 200) {
    throw new BadRequestException('reference must be 1-200 characters');
  }
  return {
    tenantProductRef: input.tenantProductRef.toLowerCase(),
    identityIds: [...identityIds].sort(),
    reasonCode: normalizeReasonCode(input.reasonCode),
    reference,
    note: normalizeNote(input.note),
    effectiveAt: normalizeEffectiveAt(input.effectiveAt),
    fingerprint: fingerprint(['recall', input.userId.toLowerCase(), input.idempotencyKey]),
  };
}

function normalizeEffectiveAt(effectiveAt: string | null): Date | null {
  if (effectiveAt === null) return null;
  const at = new Date(effectiveAt);
  if (Number.isNaN(at.getTime())) throw new BadRequestException('effectiveAt must be an ISO 8601 date-time');
  if (at.getTime() > Date.now()) throw new BadRequestException('effectiveAt must not be in the future');
  return at;
}

function toRecallBody(row: RecallRow, holds: TrackingHoldBody[]): InventoryRecallBody {
  return {
    id: row.id,
    tenantProductRef: row.tenant_product_ref,
    reasonCode: row.reason_code,
    reference: row.reference,
    note: row.note,
    effectiveAt: row.effective_at.toISOString(),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    holds,
  };
}
