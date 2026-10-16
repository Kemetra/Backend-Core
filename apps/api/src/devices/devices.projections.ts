/**
 * RT-365 — pure helpers of the Console device registry
 * (`devices.openapi.yaml`): the revoke decision (RT-287 D-Q4 as amended, on
 * the RT-366 lifecycle evaluator), the keyset cursor and the wire
 * projections. No DB, no clock.
 *
 * Cursor. Repo convention (`shift-closes.projections.ts`): unsigned base64url
 * JSON, bound to the operation and the tenant it was issued under; any other
 * token is a 400. It carries only the keyset position: the exception-first
 * rank, `expires_at` at microsecond precision (never through a JS Date) and
 * the device id. A hand-built token can only reposition the keyset inside rows
 * the caller may already read: scope and RLS are applied to the query, never
 * taken from the cursor.
 *
 * Projections. Explicit wire shapes, never DB rows (§IV): no tenant id, token
 * hash, previous token or rotation window. Every key is present; an unrecorded
 * value is `null`. The revoke note is on the detail only.
 */
import { z } from "zod";

import { evaluateLifecycle, type LifecycleEvaluation, type RevokeReason } from "./device-lifecycle.evaluator";

export { REVOKE_REASONS, type RevokeReason } from "./device-lifecycle.evaluator";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const TRUST_STATES = ["active", "revoked", "retired"] as const;

/** The signal behind `lastSeenAt`: the last authenticated request (RT-138 L7). */
export type LastSeenSource = "activity";
export type TrustState = (typeof TRUST_STATES)[number];

// ---------------------------------------------------------------------------
// Revoke decision
// ---------------------------------------------------------------------------

export interface RevokeDecisionInput {
  /** The locked row is already revoked (or retired). */
  readonly alreadyRevoked: boolean;
  /** An open shift opened on the device, or null. */
  readonly openShiftId: string | null;
  readonly reason: RevokeReason;
  /** The caller's role code in the tenant. */
  readonly callerRole: string | null;
  readonly note: string | undefined;
  readonly acknowledgeCustodyException: boolean | undefined;
}

export type RevokeRefusalCode =
  | "recovery_revoke_forbidden"
  | "recovery_note_required"
  | "custody_exception_not_acknowledged"
  | "unresolved_cash_session";

export type RevokeDecision =
  | { readonly kind: "already_revoked" }
  | { readonly kind: "revoke"; readonly custodyExceptionShiftId: string | null }
  | { readonly kind: "refuse"; readonly status: 403 | 409 | 422; readonly code: RevokeRefusalCode };

/**
 * The revoke decision: the lifecycle evaluator's verdict for this revoke
 * (`evaluateRevokeInput`, the same one the impact preview reports), then the
 * body's requirements in the contract's order: an already-revoked device
 * answers its current state; without an open shift any reason revokes; with
 * one, a security reason revokes (the shift becomes the custody exception), a
 * `hardware_failure` is a recovery revoke (owner / tenant_admin, a note, the
 * acknowledgement — checked in that order), and every other reason is 409.
 */
export function decideRevoke(input: RevokeDecisionInput): RevokeDecision {
  return decisionOf(evaluateRevokeInput(input), input);
}

/** The evaluator's verdict for a revoke: state and authority only, never the body. */
export function evaluateRevokeInput(
  input: Pick<RevokeDecisionInput, "alreadyRevoked" | "openShiftId" | "reason" | "callerRole">,
): LifecycleEvaluation {
  return evaluateLifecycle({
    action: "revoke",
    reason: input.reason,
    // Retired implies revoked (0040 CHECK), so the revoke needs only the one flag.
    state: { revoked: input.alreadyRevoked, retired: false, openShiftId: input.openShiftId },
    callerRole: input.callerRole,
  });
}

/** The verdict → revoke outcome table of the contract ("Impact preview"). */
function decisionOf(evaluation: LifecycleEvaluation, input: RevokeDecisionInput): RevokeDecision {
  switch (evaluation.verdict) {
    case "no_change":
      return { kind: "already_revoked" };
    case "allowed":
      return { kind: "revoke", custodyExceptionShiftId: input.openShiftId };
    case "forbidden_recovery":
      return refuse(403, "recovery_revoke_forbidden");
    case "blocked":
      // A revoke is only ever blocked by its open shift (evaluateRevoke).
      return refuse(409, "unresolved_cash_session");
    case "allowed_with_custody_exception":
      return requirementRefusal(evaluation, input) ?? { kind: "revoke", custodyExceptionShiftId: input.openShiftId };
  }
}

/** The first unmet body requirement, in order: note, then acknowledgement (the role is the verdict's). */
function requirementRefusal(evaluation: LifecycleEvaluation, input: RevokeDecisionInput): RevokeDecision | null {
  if (evaluation.requires.includes("note") && input.note === undefined) return refuse(422, "recovery_note_required");
  if (evaluation.requires.includes("acknowledge_custody_exception") && input.acknowledgeCustodyException !== true) {
    return refuse(422, "custody_exception_not_acknowledged");
  }
  return null;
}

function refuse(status: 403 | 409 | 422, code: RevokeRefusalCode): RevokeDecision {
  return { kind: "refuse", status, code };
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** Raised for a cursor this operation did not issue → 400 validation_error. */
export class InvalidDeviceCursorError extends Error {
  constructor() {
    super("cursor is not a valid continuation token for this operation");
    this.name = "InvalidDeviceCursorError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `expires_at` as rendered by `EXPIRES_AT_KEY_SQL`: UTC, exactly six fractional digits. */
const INSTANT_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Renders `expires_at` as the cursor key: UTC with microseconds, exact on the cast back. */
export const EXPIRES_AT_KEY_SQL = `to_char(d.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const CursorSchema = z
  .object({
    k: z.literal("devices"),
    t: z.string().regex(UUID_RE),
    r: z.number().int().min(0).max(3),
    e: z.string().regex(INSTANT_KEY_RE),
    d: z.string().regex(UUID_RE),
  })
  .strict();

/** The keyset position after which the next page starts. */
export interface DeviceKeyset {
  /** The exception-first rank, 0..3. */
  readonly rank: number;
  /** `expires_at` at microsecond precision (`INSTANT_KEY_RE`). */
  readonly expiresAtKey: string;
  readonly deviceId: string;
}

export function encodeDeviceCursor(input: { readonly tenantId: string } & DeviceKeyset): string {
  const payload = { k: "devices", t: input.tenantId.toLowerCase(), r: input.rank, e: input.expiresAtKey, d: input.deviceId };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** The keyset position, if `cursor` was issued by this operation for `tenantId`. */
export function decodeDeviceCursor(input: { readonly tenantId: string; readonly cursor: string }): DeviceKeyset {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidDeviceCursorError();
  }
  const parsed = CursorSchema.safeParse(raw);
  if (!parsed.success || parsed.data.t !== input.tenantId.toLowerCase()) throw new InvalidDeviceCursorError();
  if (!isCalendarInstant(parsed.data.e)) throw new InvalidDeviceCursorError();
  return { rank: parsed.data.r, expiresAtKey: parsed.data.e, deviceId: parsed.data.d };
}

/** True when the key names a real UTC instant (`Date.parse` rolls "02-31" over; Postgres refuses it). */
function isCalendarInstant(key: string): boolean {
  const ms = Date.parse(key);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 19) === key.slice(0, 19);
}

// ---------------------------------------------------------------------------
// Rows and projections
// ---------------------------------------------------------------------------

/** One `devices` row as the service reads it, with its derived links. */
export interface DeviceReadRow {
  readonly id: string;
  readonly store_id: string;
  readonly label: string | null;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly expires_at_key: string;
  readonly last_seen_at: Date | null;
  readonly revoked_at: Date | null;
  readonly revoked_by: string | null;
  readonly revoke_reason: RevokeReason | null;
  readonly revoke_note: string | null;
  readonly retired_at: Date | null;
  readonly retired_by: string | null;
  readonly retire_reason: string | null;
  readonly replaces_device_id: string | null;
  readonly replaced_by_device_id: string | null;
  /** The most recently opened open shift on the device, or null. */
  readonly open_shift_id: string | null;
  readonly rank: number;
}

export interface DeviceSummary {
  readonly deviceId: string;
  readonly storeId: string;
  readonly label: string | null;
  readonly trustState: TrustState;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string | null;
  /** Where `lastSeenAt` comes from; null exactly when it is null (RT-287 D-Q6). */
  readonly lastSeenSource: LastSeenSource | null;
  readonly revokedAt: string | null;
  readonly revokedByUserId: string | null;
  readonly revokeReason: RevokeReason | null;
  readonly retiredAt: string | null;
  readonly replacesDeviceId: string | null;
  readonly replacedByDeviceId: string | null;
  readonly custodyExceptionShiftId: string | null;
}

export interface DeviceDetail extends DeviceSummary {
  readonly revokeNote: string | null;
  readonly retiredByUserId: string | null;
  readonly retireReason: string | null;
}

export interface DevicePage {
  readonly items: DeviceSummary[];
  readonly nextCursor: string | null;
}

export interface DeviceRevokeResult {
  readonly outcome: "revoked" | "already_revoked";
  readonly device: DeviceDetail;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function trustStateOf(row: DeviceReadRow): TrustState {
  if (row.retired_at !== null) return "retired";
  return row.revoked_at !== null ? "revoked" : "active";
}

export function toDeviceSummary(row: DeviceReadRow): DeviceSummary {
  return {
    deviceId: row.id,
    storeId: row.store_id,
    label: row.label,
    trustState: trustStateOf(row),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastSeenAt: iso(row.last_seen_at),
    // Only the activity signal exists (RT-138 L7); a heartbeat source comes with AD-DEVICE-001.
    lastSeenSource: row.last_seen_at === null ? null : "activity",
    revokedAt: iso(row.revoked_at),
    revokedByUserId: row.revoked_by,
    revokeReason: row.revoke_reason,
    retiredAt: iso(row.retired_at),
    replacesDeviceId: row.replaces_device_id,
    replacedByDeviceId: row.replaced_by_device_id,
    // An open shift on a live till is normal; only a revoked one is an exception.
    custodyExceptionShiftId: row.revoked_at === null ? null : row.open_shift_id,
  };
}

export function toDeviceDetail(row: DeviceReadRow): DeviceDetail {
  return {
    ...toDeviceSummary(row),
    revokeNote: row.revoke_note,
    retiredByUserId: row.retired_by,
    retireReason: row.retire_reason,
  };
}
