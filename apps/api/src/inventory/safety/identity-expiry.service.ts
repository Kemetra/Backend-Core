/**
 * IdentityExpiryService — Jira RT-449 (RT-50 G7-2 / G7-7; owner ruling H7,
 * RT-449 comment 13434).
 *
 * An identity's `expiry_date` is corrected only by this governed command,
 * with history: one `tracking_identity_expiry_corrections` row (old, new,
 * reason, actor), then the identity UPDATE, then one Safety Revision step
 * (`expiry_corrected`) — in one transaction. 0072's identity guard refuses any
 * expiry change without its same-transaction correction row, so no other
 * writer can change it silently.
 *
 * Refusals, all before the first write: another tenant's identity (a
 * non-disclosing 404), the current expiry again (409 `expiry_unchanged`), an
 * expiry before the identity's manufacture date (400).
 *
 * Replay: the fingerprint is SHA-256 over (actor, Idempotency-Key), UNIQUE
 * per tenant; the same command returns the recorded correction and its
 * revision.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../../auth/auth.module';
import { writeAudit } from '../position-events/position-event.writer';
import { bumpSafetyRevision, lockTenantSafety, recordedRevision, recordSafetyChange } from './safety-revision';
import { fingerprint, idempotencyConflict, normalizeNote, normalizeReasonCode } from './safety.common';

export interface CorrectExpiryInput {
  readonly tenantId: string;
  readonly userId: string;
  /** The request's Idempotency-Key; only its fingerprint is stored. */
  readonly idempotencyKey: string;
  readonly trackingIdentityId: string;
  /** `YYYY-MM-DD`, or null to clear the expiry. */
  readonly expiryDate: string | null;
  readonly reasonCode: string;
  readonly note: string | null;
}

/** Wire projection of a correction (contract `TrackingIdentityExpiryCorrection`). */
export interface ExpiryCorrectionBody {
  readonly id: string;
  readonly trackingIdentityId: string;
  readonly tenantProductRef: string;
  readonly oldExpiryDate: string | null;
  readonly newExpiryDate: string | null;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface ExpiryCorrectionResult {
  readonly correction: ExpiryCorrectionBody;
  readonly safetyRevision: number;
}

interface CorrectionRow {
  id: string;
  tracking_identity_id: string;
  tenant_product_ref: string;
  old_expiry_date: string | null;
  new_expiry_date: string | null;
  reason_code: string;
  note: string | null;
  created_by: string;
  created_at: Date;
}

const CORRECTION_COLUMNS =
  'id, tracking_identity_id, tenant_product_ref, old_expiry_date::text AS old_expiry_date, ' +
  'new_expiry_date::text AS new_expiry_date, reason_code, note, created_by, created_at';

interface IdentityRow {
  id: string;
  tenant_product_ref: string;
  expiry_date: string | null;
  manufactured_on: string | null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

@Injectable()
export class IdentityExpiryService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async correctExpiry(input: CorrectExpiryInput): Promise<ExpiryCorrectionResult> {
    const expiryDate = normalizeDate(input.expiryDate);
    const reasonCode = normalizeReasonCode(input.reasonCode);
    const note = normalizeNote(input.note);
    const commandFingerprint = fingerprint(['expiry_correction', input.userId.toLowerCase(), input.idempotencyKey]);
    return await runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) => {
      await lockTenantSafety(client, input.tenantId);
      const replay = await this.findByFingerprint(client, commandFingerprint);
      if (replay) {
        assertSameCorrection(replay, { trackingIdentityId: input.trackingIdentityId, expiryDate, reasonCode, note });
        return this.recordedResult(client, replay);
      }
      const identity = await this.lockIdentity(client, input.trackingIdentityId);
      if (!identity) throw new NotFoundException('Not Found');
      assertCorrectable(identity, expiryDate);

      const revision = await bumpSafetyRevision(client, input.tenantId);
      const correction = await this.insertCorrection(client, input, {
        identity,
        newExpiryDate: expiryDate,
        reasonCode,
        note,
        commandFingerprint,
      });
      await client.query(`UPDATE tracking_identities SET expiry_date = $2::date WHERE id = $1`, [
        identity.id,
        expiryDate,
      ]);
      await recordSafetyChange(client, {
        tenantId: input.tenantId,
        revision,
        kind: 'expiry_corrected',
        tenantProductRef: identity.tenant_product_ref,
        trackingIdentityId: identity.id,
        createdBy: input.userId,
      });
      await writeAudit(client, {
        tenantId: input.tenantId,
        userId: input.userId,
        action: 'inventory.tracking_identity.expiry_correct',
        targetType: 'tracking_identity',
        targetId: identity.id,
        metadata: {
          correctionId: correction.id,
          oldExpiryDate: correction.old_expiry_date,
          newExpiryDate: correction.new_expiry_date,
          safetyRevision: revision,
        },
      });
      return { correction: toCorrectionBody(correction), safetyRevision: revision };
    });
  }

  private async lockIdentity(client: PoolClient, identityId: string): Promise<IdentityRow | undefined> {
    const r = await client.query<IdentityRow>(
      `SELECT id, tenant_product_ref, expiry_date::text AS expiry_date, manufactured_on::text AS manufactured_on
         FROM tracking_identities WHERE id = $1 FOR UPDATE`,
      [identityId],
    );
    return r.rows[0];
  }

  private async insertCorrection(
    client: PoolClient,
    input: CorrectExpiryInput,
    c: {
      readonly identity: IdentityRow;
      readonly newExpiryDate: string | null;
      readonly reasonCode: string;
      readonly note: string | null;
      readonly commandFingerprint: string;
    },
  ): Promise<CorrectionRow> {
    const r = await client.query<CorrectionRow>(
      `INSERT INTO tracking_identity_expiry_corrections
         (tenant_id, tracking_identity_id, tenant_product_ref, old_expiry_date, new_expiry_date,
          reason_code, note, command_fingerprint, created_by)
       VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9)
       RETURNING ${CORRECTION_COLUMNS}`,
      [
        input.tenantId,
        c.identity.id,
        c.identity.tenant_product_ref,
        c.identity.expiry_date,
        c.newExpiryDate,
        c.reasonCode,
        c.note,
        c.commandFingerprint,
        input.userId,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new Error('IdentityExpiryService: correction INSERT returned no row');
    return row;
  }

  private async findByFingerprint(client: PoolClient, commandFingerprint: string): Promise<CorrectionRow | undefined> {
    const r = await client.query<CorrectionRow>(
      `SELECT ${CORRECTION_COLUMNS} FROM tracking_identity_expiry_corrections WHERE command_fingerprint = $1`,
      [commandFingerprint],
    );
    return r.rows[0];
  }

  private async recordedResult(client: PoolClient, row: CorrectionRow): Promise<ExpiryCorrectionResult> {
    return {
      correction: toCorrectionBody(row),
      safetyRevision: await recordedRevision(client, { kind: 'expiry_corrected', correctionId: row.id }),
    };
  }
}

/** A replayed correction must be the same command; else 409 (FR-030). */
function assertSameCorrection(
  recorded: CorrectionRow,
  requested: {
    readonly trackingIdentityId: string;
    readonly expiryDate: string | null;
    readonly reasonCode: string;
    readonly note: string | null;
  },
): void {
  const recordedCommand = [recorded.tracking_identity_id, recorded.new_expiry_date, recorded.reason_code, recorded.note];
  const requestedCommand = [
    requested.trackingIdentityId.toLowerCase(),
    requested.expiryDate,
    requested.reasonCode,
    requested.note,
  ];
  if (JSON.stringify(recordedCommand) !== JSON.stringify(requestedCommand)) throw idempotencyConflict();
}

/** The current expiry again is a 409; an expiry before manufacture a 400. */
function assertCorrectable(identity: IdentityRow, expiryDate: string | null): void {
  if (identity.expiry_date === expiryDate) {
    throw new ConflictException({ code: 'expiry_unchanged', message: 'The identity already has this expiry date.' });
  }
  const beforeManufacture = expiryDate !== null && identity.manufactured_on !== null
    ? expiryDate < identity.manufactured_on
    : false;
  if (beforeManufacture) {
    throw new BadRequestException('expiryDate must not be before the identity was manufactured');
  }
}

/** A real `YYYY-MM-DD` day in years 0001–9999 (the 0045 range), or null; else 400. */
function normalizeDate(value: string | null): string | null {
  if (value === null) return null;
  if (!isRealDay(value)) throw new BadRequestException('expiryDate must be a real YYYY-MM-DD date');
  return value;
}

/** True when `YYYY-MM-DD` names a day that exists (no 2027-02-30), year >= 1. */
function isRealDay(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const parsed = new Date(`${value}T00:00:00Z`);
  const roundTrip = [parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate()];
  return year >= 1 && JSON.stringify(roundTrip) === JSON.stringify([year, month, day]);
}

function toCorrectionBody(row: CorrectionRow): ExpiryCorrectionBody {
  return {
    id: row.id,
    trackingIdentityId: row.tracking_identity_id,
    tenantProductRef: row.tenant_product_ref,
    oldExpiryDate: row.old_expiry_date,
    newExpiryDate: row.new_expiry_date,
    reasonCode: row.reason_code,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}
