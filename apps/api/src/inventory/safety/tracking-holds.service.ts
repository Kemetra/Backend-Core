/**
 * TrackingHoldsService — Jira RT-449 (RT-50 G7-6 / G7-7; owner rulings H1–H4,
 * RT-449 comment 13434).
 *
 *   - placeQualityHold: a `quality_hold` record on a tracking identity of the
 *     tenant, one Safety Revision step (`hold_placed`), and the identity's
 *     positive `sellable` / `return_inspection` positions moved into
 *     `quality_hold` (G7-6).
 *   - releaseHold: sets the release once (a released hold is final; a second
 *     release answers the recorded release and writes nothing), one revision
 *     step (`hold_released`), and the release moves of H3 / H4.
 *   - getHold: one hold of the tenant.
 *
 * Who may call (H1 / H2) is enforced at the controller: owner and
 * tenant_admin place, only the owner releases; the commands are tenant-level
 * (a hold reaches the identity at every store), so a store_manager is refused.
 *
 * Replay: a placement's fingerprint is SHA-256 over (kind, actor,
 * Idempotency-Key), UNIQUE per tenant. The same command again returns the
 * recorded hold and its revision and writes nothing; the same key for another
 * command is a 409 `idempotency_key_conflict`.
 *
 * Every refusal (404 non-disclosing, 409 `hold_already_active`) is raised
 * before the first write, under the tenant's safety lock: nothing is written.
 */
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../../auth/auth.module';
import { writeAudit } from '../position-events/position-event.writer';
import { placementMoves, releaseMoves } from './hold-move.rules';
import { moveHeldPositions } from './hold-quantity';
import {
  bumpSafetyRevision,
  lockTenantSafety,
  recordedRevision,
  recordSafetyChange,
} from './safety-revision';
import {
  HOLD_COLUMNS,
  fingerprint,
  idempotencyConflict,
  normalizeNote,
  normalizeReasonCode,
  toHoldBody,
  type HoldRow,
  type TrackingHoldBody,
  type TrackingHoldResult,
} from './safety.common';
import {
  findHold,
  identitiesWithActiveHold,
  insertHold,
  lockIdentities,
  type LockedIdentity,
} from './tracking-holds.store';

const AUDIT_TARGET_TYPE_HOLD = 'tracking_hold';

export interface PlaceQualityHoldInput {
  readonly tenantId: string;
  readonly userId: string;
  /** The request's Idempotency-Key; only its fingerprint is stored. */
  readonly idempotencyKey: string;
  readonly trackingIdentityId: string;
  readonly reasonCode: string;
  readonly note: string | null;
}

export interface ReleaseHoldInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly holdId: string;
  readonly note: string | null;
}

@Injectable()
export class TrackingHoldsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async placeQualityHold(input: PlaceQualityHoldInput): Promise<TrackingHoldResult> {
    const reasonCode = normalizeReasonCode(input.reasonCode);
    const note = normalizeNote(input.note);
    const commandFingerprint = fingerprint(['quality_hold', input.userId.toLowerCase(), input.idempotencyKey]);
    return await runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) => {
      await lockTenantSafety(client, input.tenantId);
      const replay = await this.findPlacement(client, commandFingerprint);
      if (replay) {
        assertSamePlacement(replay, { trackingIdentityId: input.trackingIdentityId, reasonCode, note });
        return this.recordedResult(client, replay, 'hold_placed');
      }
      const identity = await lockUnheldIdentity(client, input.trackingIdentityId);

      const revision = await bumpSafetyRevision(client, input.tenantId);
      const hold = await insertHold(client, {
        tenantId: input.tenantId,
        trackingIdentityId: identity.id,
        tenantProductRef: identity.tenant_product_ref,
        kind: 'quality_hold',
        reasonCode,
        note,
        recallId: null,
        commandFingerprint,
        placedBy: input.userId,
      });
      await recordSafetyChange(client, {
        tenantId: input.tenantId,
        revision,
        kind: 'hold_placed',
        tenantProductRef: hold.tenant_product_ref,
        trackingHoldId: hold.id,
        trackingIdentityId: hold.tracking_identity_id,
        createdBy: input.userId,
      });
      const positionEventIds = await moveHeldPositions(client, {
        tenantId: input.tenantId,
        userId: input.userId,
        holdId: hold.id,
        phase: 'place',
        trackingIdentityId: hold.tracking_identity_id,
        tenantProductRef: hold.tenant_product_ref,
        moves: placementMoves('quality_hold'),
      });
      await writeAudit(client, {
        tenantId: input.tenantId,
        userId: input.userId,
        action: 'inventory.tracking_hold.place',
        targetType: AUDIT_TARGET_TYPE_HOLD,
        targetId: hold.id,
        metadata: { trackingIdentityId: hold.tracking_identity_id, safetyRevision: revision, positionEventIds },
      });
      return { hold: toHoldBody(hold), safetyRevision: revision };
    });
  }

  async releaseHold(input: ReleaseHoldInput): Promise<TrackingHoldResult> {
    const note = normalizeNote(input.note);
    return await runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) => {
      await lockTenantSafety(client, input.tenantId);
      const current = await findHold(client, input.holdId, true);
      if (!current) throw new NotFoundException('Not Found');
      // A released hold is final: answer the recorded release, write nothing.
      if (current.released_at !== null) return this.recordedResult(client, current, 'hold_released');
      await lockIdentities(client, [current.tracking_identity_id], null);

      const revision = await bumpSafetyRevision(client, input.tenantId);
      const hold = await this.setRelease(client, { ...input, holdId: current.id, note });
      await recordSafetyChange(client, {
        tenantId: input.tenantId,
        revision,
        kind: 'hold_released',
        tenantProductRef: hold.tenant_product_ref,
        trackingHoldId: hold.id,
        trackingIdentityId: hold.tracking_identity_id,
        createdBy: input.userId,
      });
      const recallActive =
        (await identitiesWithActiveHold(client, [hold.tracking_identity_id], 'recall_hold')).length > 0;
      const moves = releaseMoves(hold.kind, { recallActive });
      const positionEventIds = moves
        ? await moveHeldPositions(client, {
            tenantId: input.tenantId,
            userId: input.userId,
            holdId: hold.id,
            phase: 'release',
            trackingIdentityId: hold.tracking_identity_id,
            tenantProductRef: hold.tenant_product_ref,
            moves,
          })
        : [];
      await writeAudit(client, {
        tenantId: input.tenantId,
        userId: input.userId,
        action: 'inventory.tracking_hold.release',
        targetType: AUDIT_TARGET_TYPE_HOLD,
        targetId: hold.id,
        metadata: { trackingIdentityId: hold.tracking_identity_id, safetyRevision: revision, positionEventIds },
      });
      return { hold: toHoldBody(hold), safetyRevision: revision };
    });
  }

  /** One hold of the tenant; another tenant's id is a non-disclosing 404. */
  getHold(tenantId: string, holdId: string): Promise<TrackingHoldBody> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      const hold = await findHold(client, holdId, false);
      if (!hold) throw new NotFoundException('Not Found');
      return toHoldBody(hold);
    });
  }

  private async findPlacement(client: PoolClient, commandFingerprint: string): Promise<HoldRow | undefined> {
    const r = await client.query<HoldRow>(
      `SELECT ${HOLD_COLUMNS} FROM tracking_holds WHERE command_fingerprint = $1`,
      [commandFingerprint],
    );
    return r.rows[0];
  }

  private async setRelease(client: PoolClient, release: ReleaseHoldInput): Promise<HoldRow> {
    const r = await client.query<HoldRow>(
      `UPDATE tracking_holds SET released_by = $2, released_at = now(), release_note = $3
        WHERE id = $1
        RETURNING ${HOLD_COLUMNS}`,
      [release.holdId, release.userId, release.note],
    );
    const row = r.rows[0];
    if (!row) throw new Error('TrackingHoldsService: release UPDATE returned no row');
    return row;
  }

  private async recordedResult(
    client: PoolClient,
    hold: HoldRow,
    kind: 'hold_placed' | 'hold_released',
  ): Promise<TrackingHoldResult> {
    return {
      hold: toHoldBody(hold),
      safetyRevision: await recordedRevision(client, { kind, trackingHoldId: hold.id }),
    };
  }
}

/** A replayed placement must be the same command; else 409 (FR-030). */
function assertSamePlacement(
  recorded: HoldRow,
  requested: { readonly trackingIdentityId: string; readonly reasonCode: string; readonly note: string | null },
): void {
  const recordedCommand = [recorded.tracking_identity_id, recorded.reason_code, recorded.note];
  const requestedCommand = [requested.trackingIdentityId.toLowerCase(), requested.reasonCode, requested.note];
  if (JSON.stringify(recordedCommand) !== JSON.stringify(requestedCommand)) throw idempotencyConflict();
}

/** Lock a tenant identity with no active quality hold: else 404 (non-disclosing) or 409. */
async function lockUnheldIdentity(client: PoolClient, identityId: string): Promise<LockedIdentity> {
  const [identity] = await lockIdentities(client, [identityId], null);
  if (!identity) throw new NotFoundException('Not Found');
  if ((await identitiesWithActiveHold(client, [identity.id], 'quality_hold')).length > 0) {
    throw new ConflictException({
      code: 'hold_already_active',
      message: 'The tracking identity already has an active quality hold.',
    });
  }
  return identity;
}
