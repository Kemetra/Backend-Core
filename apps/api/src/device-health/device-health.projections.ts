/**
 * Console projections of the RT-327 device health reads
 * (`DeviceHealthView`, `DeviceHealthPage`): the row shape the read SQL
 * returns, the derived values (`liveness`, `compliance`, `lastSeenAt` with its
 * source) computed at read time against the server clock, and the keyset
 * cursor. Identity, label and trust state come from the device row; the
 * self-reported fields are the last STORED heartbeat; nothing derived is
 * stored. No tenant id, no health-row id, no secret.
 */
import { z } from "zod";

import { deriveCompliance, type Compliance } from "./compliance";
import { deriveLiveness, lastSeenOf, secondsSince, type LastSeenSource, type Liveness } from "./liveness";

export const TRUST_STATES = ["active", "revoked", "retired"] as const;
export type TrustState = (typeof TRUST_STATES)[number];

/** One device joined with its health row and its channel's policy, as the SQL returns it. */
export interface DeviceHealthReadRow {
  readonly device_id: string;
  readonly store_id: string;
  readonly label: string | null;
  readonly trust_state: TrustState;
  readonly activity_last_seen_at: Date | null;
  readonly heartbeat_at: Date | null;
  readonly app_version: string | null;
  readonly update_channel: string | null;
  readonly update_state: string | null;
  readonly pending_version: string | null;
  readonly schema_head: string | null;
  readonly source_clock_at: Date | null;
  readonly min_supported_version: string | null;
  readonly min_supported_grace_until: Date | null;
}

export interface DeviceHealthViewBody {
  readonly deviceId: string;
  readonly storeId: string;
  readonly label: string | null;
  readonly trustState: TrustState;
  readonly appVersion: string | null;
  readonly updateChannel: string | null;
  readonly updateState: string | null;
  readonly pendingVersion: string | null;
  readonly schemaHead: string | null;
  readonly sourceClockAt: string | null;
  readonly heartbeatAt: string | null;
  readonly secondsSinceHeartbeat: number | null;
  readonly liveness: Liveness;
  readonly compliance: Compliance;
  readonly minSupportedVersion: string | null;
  readonly minSupportedGraceUntil: string | null;
  readonly activityLastSeenAt: string | null;
  readonly lastSeenAt: string | null;
  readonly lastSeenSource: LastSeenSource | null;
}

export interface DeviceHealthPage {
  readonly items: DeviceHealthViewBody[];
  readonly nextCursor: string | null;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** The derived verdicts of a row at `now`: what the `liveness` / `compliance` filters match. */
export function deriveVerdicts(row: DeviceHealthReadRow, now: Date): { liveness: Liveness; compliance: Compliance } {
  return {
    liveness: deriveLiveness(row.heartbeat_at, now),
    compliance: deriveCompliance({
      appVersion: row.app_version,
      updateChannel: row.update_channel,
      minSupportedVersion: row.min_supported_version,
    }),
  };
}

export function toDeviceHealthView(row: DeviceHealthReadRow, now: Date): DeviceHealthViewBody {
  const { liveness, compliance } = deriveVerdicts(row, now);
  const seen = lastSeenOf(row.heartbeat_at, row.activity_last_seen_at);
  return {
    deviceId: row.device_id,
    storeId: row.store_id,
    label: row.label,
    trustState: row.trust_state,
    appVersion: row.app_version,
    updateChannel: row.update_channel,
    updateState: row.update_state,
    pendingVersion: row.pending_version,
    schemaHead: row.schema_head,
    sourceClockAt: iso(row.source_clock_at),
    heartbeatAt: iso(row.heartbeat_at),
    secondsSinceHeartbeat: secondsSince(row.heartbeat_at, now),
    liveness,
    compliance,
    minSupportedVersion: row.min_supported_version,
    minSupportedGraceUntil: iso(row.min_supported_grace_until),
    activityLastSeenAt: iso(row.activity_last_seen_at),
    lastSeenAt: iso(seen.lastSeenAt),
    lastSeenSource: seen.lastSeenSource,
  };
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** Raised for a cursor this operation did not issue, or for another tenant → 400. */
export class InvalidDeviceHealthCursorError extends Error {
  constructor() {
    super("cursor is not a valid continuation token for this operation");
    this.name = "InvalidDeviceHealthCursorError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CursorSchema = z.object({ k: z.literal("device_health"), t: z.string().regex(UUID_RE), d: z.string().regex(UUID_RE) }).strict();

/** The opaque keyset cursor: the last `deviceId` of a page, bound to the tenant. */
export function encodeDeviceHealthCursor(input: { readonly tenantId: string; readonly deviceId: string }): string {
  const payload = { k: "device_health", t: input.tenantId.toLowerCase(), d: input.deviceId.toLowerCase() };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** The `deviceId` after which the next page starts. */
export function decodeDeviceHealthCursor(input: { readonly tenantId: string; readonly cursor: string }): string {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidDeviceHealthCursorError();
  }
  const parsed = CursorSchema.safeParse(raw);
  if (!parsed.success || parsed.data.t !== input.tenantId.toLowerCase()) throw new InvalidDeviceHealthCursorError();
  return parsed.data.d;
}
