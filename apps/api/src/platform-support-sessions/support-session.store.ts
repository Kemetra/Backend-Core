/**
 * Platform support-session state and its audit rows (Jira RT-414, RT-391 D2).
 *
 * Plain functions over one `PoolClient`, so callers compose the state change
 * and its audit row in ONE transaction (the `ai_entitlement.*` /
 * `cash_variance_policy.changed` precedent). Every call must run inside a
 * platform-admin RLS context (`app.is_platform_admin = 'true'`): migration
 * 0062 admits no other context on `platform_support_sessions`.
 *
 * Audit rows go straight into `audit_events`, never through the async
 * interceptor: the contract requires exactly one `platform.cross_tenant.accessed`
 * row per covered request, and an `opened` / `renewed` / `ended` row with each
 * state change. If the row cannot be written, the request fails (fail closed).
 * Metadata is the contract allowlist only (`SupportSessionAuditMetadata`,
 * `CrossTenantAccessAuditMetadata`): ids, enum values, timestamps, the HTTP
 * method and the route TEMPLATE. Never an email, token, cookie, path value,
 * query string or body. `actor_label` is the fixed `platform_support`.
 */
import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";
import type { SupportPurpose, SupportSessionEndReason } from "@data-pulse-2/db";

/** 60 minutes per open / renew (RT-391 D2). */
export const SUPPORT_SESSION_TTL_MINUTES = 60;
/** Renewal cap after opening (RT-414 decision 2); also pinned by 0062's CHECK. */
export const SUPPORT_SESSION_CAP_HOURS = 8;

export const SUPPORT_ACTOR_LABEL = "platform_support";

export const SUPPORT_SESSION_OPENED = "platform.support_session.opened";
export const SUPPORT_SESSION_RENEWED = "platform.support_session.renewed";
export const SUPPORT_SESSION_ENDED = "platform.support_session.ended";
export const CROSS_TENANT_ACCESSED = "platform.cross_tenant.accessed";

export type SupportSessionStatus = "active" | "expired" | "ended";

export interface SupportSessionRecord {
  readonly id: string;
  readonly authSessionId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly purpose: SupportPurpose;
  readonly ticketRef: string | null;
  readonly openedAt: Date;
  readonly renewedAt: Date | null;
  readonly expiresAt: Date;
  readonly renewalCapAt: Date;
  readonly endedAt: Date | null;
  readonly endReason: SupportSessionEndReason | null;
  /** Computed against the database clock in the same statement. */
  readonly status: SupportSessionStatus;
}

/** The `SupportSession` wire shape (platform-support-sessions.openapi.yaml). */
export interface SupportSessionBody {
  readonly id: string;
  readonly tenant_id: string;
  readonly purpose: SupportPurpose;
  readonly ticket_ref: string | null;
  readonly status: SupportSessionStatus;
  readonly opened_at: string;
  readonly renewed_at: string | null;
  readonly expires_at: string;
  readonly renewal_cap_at: string;
  readonly ended_at: string | null;
  readonly end_reason: SupportSessionEndReason | null;
}

/** The `SupportSessionSummary` banner shape on `ContextResponse`. */
export interface SupportSessionSummaryBody {
  readonly id: string;
  readonly tenant_id: string;
  readonly purpose: SupportPurpose;
  readonly ticket_ref: string | null;
  readonly status: "active" | "expired";
  readonly expires_at: string;
  readonly renewal_cap_at: string;
}

const COLUMNS = `id, auth_session_id, user_id, tenant_id, purpose, ticket_ref,
  opened_at, renewed_at, expires_at, renewal_cap_at, ended_at, end_reason,
  CASE WHEN ended_at IS NOT NULL THEN 'ended'
       WHEN expires_at > now() THEN 'active'
       ELSE 'expired' END AS status`;

interface Row {
  id: string;
  auth_session_id: string;
  user_id: string;
  tenant_id: string;
  purpose: SupportPurpose;
  ticket_ref: string | null;
  opened_at: Date;
  renewed_at: Date | null;
  expires_at: Date;
  renewal_cap_at: Date;
  ended_at: Date | null;
  end_reason: SupportSessionEndReason | null;
  status: SupportSessionStatus;
}

function toRecord(row: Row): SupportSessionRecord {
  return {
    id: row.id,
    authSessionId: row.auth_session_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    purpose: row.purpose,
    ticketRef: row.ticket_ref,
    openedAt: row.opened_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at,
    renewalCapAt: row.renewal_cap_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    status: row.status,
  };
}

export function toSupportSessionBody(record: SupportSessionRecord): SupportSessionBody {
  return {
    id: record.id,
    tenant_id: record.tenantId,
    purpose: record.purpose,
    ticket_ref: record.ticketRef,
    status: record.status,
    opened_at: record.openedAt.toISOString(),
    renewed_at: record.renewedAt?.toISOString() ?? null,
    expires_at: record.expiresAt.toISOString(),
    renewal_cap_at: record.renewalCapAt.toISOString(),
    ended_at: record.endedAt?.toISOString() ?? null,
    end_reason: record.endReason,
  };
}

export function toSupportSessionSummary(
  record: SupportSessionRecord,
): SupportSessionSummaryBody | null {
  if (record.status === "ended") return null;
  return {
    id: record.id,
    tenant_id: record.tenantId,
    purpose: record.purpose,
    ticket_ref: record.ticketRef,
    status: record.status,
    expires_at: record.expiresAt.toISOString(),
    renewal_cap_at: record.renewalCapAt.toISOString(),
  };
}

/** The live (not ended) support session of an auth session, if any. */
export async function findLiveSupportSession(
  client: PoolClient,
  authSessionId: string,
  options: { forUpdate?: boolean } = {},
): Promise<SupportSessionRecord | null> {
  const lock = options.forUpdate === true ? "FOR UPDATE" : "";
  const { rows } = await client.query<Row>(
    `SELECT ${COLUMNS} FROM platform_support_sessions
      WHERE auth_session_id = $1 AND ended_at IS NULL ${lock}`,
    [authSessionId],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export interface OpenInput {
  readonly authSessionId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly purpose: SupportPurpose;
  readonly ticketRef: string | null;
  /** The auth session's absolute expiry: no support session outlives it. */
  readonly authAbsoluteExpiresAt: Date;
}

export async function insertSupportSession(
  client: PoolClient,
  input: OpenInput,
): Promise<SupportSessionRecord> {
  const { rows } = await client.query<Row>(
    `INSERT INTO platform_support_sessions
       (id, auth_session_id, user_id, tenant_id, purpose, ticket_ref,
        opened_at, expires_at, renewal_cap_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(),
             LEAST(now() + make_interval(mins => $7::int), $8::timestamptz),
             now() + make_interval(hours => $9::int))
     RETURNING ${COLUMNS}`,
    [
      newId(),
      input.authSessionId,
      input.userId,
      input.tenantId,
      input.purpose,
      input.ticketRef,
      SUPPORT_SESSION_TTL_MINUTES,
      input.authAbsoluteExpiresAt,
      SUPPORT_SESSION_CAP_HOURS,
    ],
  );
  return toRecord(rows[0]!);
}

/**
 * Renew to the earliest of now + 60 min, the cap and the auth session's
 * absolute expiry. Returns null when that would not move `expires_at`
 * later (`support_session_renewal_cap_reached`).
 */
export async function renewSupportSession(
  client: PoolClient,
  id: string,
  authAbsoluteExpiresAt: Date,
): Promise<SupportSessionRecord | null> {
  const { rows } = await client.query<Row>(
    `UPDATE platform_support_sessions
        SET renewed_at = now(),
            expires_at = LEAST(now() + make_interval(mins => $2::int), renewal_cap_at, $3::timestamptz)
      WHERE id = $1 AND ended_at IS NULL
        AND LEAST(now() + make_interval(mins => $2::int), renewal_cap_at, $3::timestamptz) > expires_at
      RETURNING ${COLUMNS}`,
    [id, SUPPORT_SESSION_TTL_MINUTES, authAbsoluteExpiresAt],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function endSupportSessionRow(
  client: PoolClient,
  id: string,
  reason: SupportSessionEndReason,
): Promise<SupportSessionRecord | null> {
  const { rows } = await client.query<Row>(
    `UPDATE platform_support_sessions
        SET ended_at = now(), end_reason = $2
      WHERE id = $1 AND ended_at IS NULL
      RETURNING ${COLUMNS}`,
    [id, reason],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** End every live support session of the given auth sessions, or of every auth session of a user. */
export async function endLiveSupportSessions(
  client: PoolClient,
  owner: { readonly authSessionId: string } | { readonly userId: string },
  reason: SupportSessionEndReason,
): Promise<SupportSessionRecord[]> {
  const [column, value] =
    "authSessionId" in owner ? ["auth_session_id", owner.authSessionId] : ["user_id", owner.userId];
  const { rows } = await client.query<Row>(
    `UPDATE platform_support_sessions
        SET ended_at = now(), end_reason = $2
      WHERE ${column} = $1 AND ended_at IS NULL
      RETURNING ${COLUMNS}`,
    [value, reason],
  );
  return rows.map(toRecord);
}

// ----- Audit rows ----------------------------------------------------------

async function insertAuditRow(
  client: PoolClient,
  row: {
    readonly tenantId: string | null;
    readonly actorUserId: string;
    readonly action: string;
    readonly requestId: string | null;
    readonly metadata: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (id, actor_user_id, actor_label, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, $3, $4, NULL, $5, NULL, NULL, $6, $7::jsonb)`,
    [
      newId(),
      row.actorUserId,
      SUPPORT_ACTOR_LABEL,
      row.tenantId,
      row.action,
      row.requestId,
      JSON.stringify(row.metadata),
    ],
  );
}

/** `platform.support_session.{opened,renewed,ended}` — `SupportSessionAuditMetadata`. */
export async function recordSupportSessionChange(
  client: PoolClient,
  action:
    | typeof SUPPORT_SESSION_OPENED
    | typeof SUPPORT_SESSION_RENEWED
    | typeof SUPPORT_SESSION_ENDED,
  record: SupportSessionRecord,
  requestId: string | null,
): Promise<void> {
  const tail =
    action === SUPPORT_SESSION_ENDED
      ? { end_reason: record.endReason }
      : { expires_at: record.expiresAt.toISOString() };
  await insertAuditRow(client, {
    tenantId: record.tenantId,
    actorUserId: record.userId,
    action,
    requestId,
    metadata: {
      actor_kind: "platform_admin",
      outcome: "succeeded",
      support_session_id: record.id,
      purpose: record.purpose,
      ticket_ref: record.ticketRef,
      ...tail,
    },
  });
}

export type CrossTenantRefusal =
  | "support_session_required"
  | "support_session_expired"
  | "support_session_read_only"
  | "origin_rejected";

export interface CrossTenantAccess {
  /** The target tenant; null only for an unresolvable path tenant. */
  readonly tenantId: string | null;
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly method: string;
  readonly route: string;
  readonly session: SupportSessionRecord | null;
  /** Absent when admitted. */
  readonly reason?: CrossTenantRefusal;
}

const AUDIT_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

/** `platform.cross_tenant.accessed` — `CrossTenantAccessAuditMetadata`. */
export async function recordCrossTenantAccess(
  client: PoolClient,
  access: CrossTenantAccess,
): Promise<void> {
  const method = access.method.toUpperCase();
  const outcome = access.reason === undefined ? "succeeded" : "rejected";
  // A `support_session_required` row names no session: the caller's live one,
  // if any, belongs to another tenant, and this tenant's owner must not see it.
  const session = access.reason === "support_session_required" ? null : access.session;
  await insertAuditRow(client, {
    tenantId: access.tenantId,
    actorUserId: access.actorUserId,
    action: CROSS_TENANT_ACCESSED,
    requestId: access.requestId,
    metadata: {
      actor_kind: "platform_admin",
      outcome,
      ...(access.reason === undefined ? {} : { reason: access.reason }),
      support_session_id: session?.id ?? null,
      purpose: session?.purpose ?? null,
      method: AUDIT_METHODS.has(method) ? method : "GET",
      route: access.route.slice(0, 256) || "unknown",
    },
  });
}
