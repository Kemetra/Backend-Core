/**
 * Shared shapes of the inventory safety commands — Jira RT-449.
 *
 *   - command fingerprints (SHA-256 hex; the raw Idempotency-Key is never
 *     stored);
 *   - input normalization (machine reason codes, bounded notes);
 *   - the wire projection of a tracking hold (contract `TrackingHold`).
 */
import { createHash } from 'node:crypto';

import { BadRequestException, ConflictException } from '@nestjs/common';
import { SAFETY_REASON_CODE_PATTERN, type TrackingHoldKind } from '@data-pulse-2/db';

/** Alphabetical order of ids (a stable order to compare two id lists by). */
export function byText(a: string, b: string): number {
  return a.localeCompare(b);
}

/** The same Idempotency-Key reused for a different command (FR-030). */
export function idempotencyConflict(): ConflictException {
  return new ConflictException({
    code: 'idempotency_key_conflict',
    message: 'The Idempotency-Key was already used for a different command.',
  });
}

/** SHA-256 hex over the parts of a command's replay identity. */
export function fingerprint(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** A machine reason code (lower snake case, 1–64 characters), else 400. */
export function normalizeReasonCode(reasonCode: string): string {
  if (!SAFETY_REASON_CODE_PATTERN.test(reasonCode)) {
    throw new BadRequestException('reasonCode must be lower snake case, 1-64 characters');
  }
  return reasonCode;
}

/** A trimmed note of 1–500 characters, or null. */
export function normalizeNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? '';
  if (trimmed.length > 500) throw new BadRequestException('note must be at most 500 characters');
  return trimmed.length > 0 ? trimmed : null;
}

/** Wire projection of a hold (contract `TrackingHold`). */
export interface TrackingHoldBody {
  readonly id: string;
  readonly trackingIdentityId: string;
  readonly tenantProductRef: string;
  readonly kind: TrackingHoldKind;
  readonly reasonCode: string;
  readonly note: string | null;
  readonly recallId: string | null;
  readonly placedBy: string;
  readonly placedAt: string;
  readonly releasedBy: string | null;
  readonly releasedAt: string | null;
  readonly releaseNote: string | null;
  readonly active: boolean;
}

/** A hold and the Safety Revision its command produced. */
export interface TrackingHoldResult {
  readonly hold: TrackingHoldBody;
  readonly safetyRevision: number;
}

export interface HoldRow {
  id: string;
  tracking_identity_id: string;
  tenant_product_ref: string;
  kind: TrackingHoldKind;
  reason_code: string;
  note: string | null;
  recall_id: string | null;
  command_fingerprint: string | null;
  placed_by: string;
  placed_at: Date;
  released_by: string | null;
  released_at: Date | null;
  release_note: string | null;
}

export const HOLD_COLUMNS =
  'id, tracking_identity_id, tenant_product_ref, kind, reason_code, note, recall_id, ' +
  'command_fingerprint, placed_by, placed_at, released_by, released_at, release_note';

export function toHoldBody(row: HoldRow): TrackingHoldBody {
  return {
    id: row.id,
    trackingIdentityId: row.tracking_identity_id,
    tenantProductRef: row.tenant_product_ref,
    kind: row.kind,
    reasonCode: row.reason_code,
    note: row.note,
    recallId: row.recall_id,
    placedBy: row.placed_by,
    placedAt: row.placed_at.toISOString(),
    releasedBy: row.released_by,
    releasedAt: row.released_at ? row.released_at.toISOString() : null,
    releaseNote: row.release_note,
    active: row.released_at === null,
  };
}
