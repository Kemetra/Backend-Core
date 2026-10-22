/**
 * PosVersionPolicyService: `platformGetPosVersionPolicy` and
 * `platformSetPosVersionPolicy` (RT-327, AD-DEVICE-001 D-2;
 * `pos-device-health.openapi.yaml`).
 *
 * The policy is global (one row per channel, `pos_version_policy`): not
 * tenant-editable and not overridable per tenant. The table has no tenant
 * column; any context may read it (the heartbeat and the console reads join
 * it) and only the platform-admin context may write it (RLS). Both operations
 * run under `{ tenantId: null, isPlatformAdmin: true }`: platform scope, no
 * active tenant.
 *
 * The set is ONE transaction:
 *   1. a transaction-scoped advisory lock keyed by the channel, so two
 *      changes of a channel serialize (the first policy of a channel has no
 *      row to lock);
 *   2. read the stored policy;
 *   3. a body equal to the stored values is a no-op 200: no write, no audit
 *      row, whatever `expectedRevision` says (a retry after a lost response
 *      is safe);
 *   4. otherwise `expectedRevision` must be the stored revision (`null` when
 *      none exists): a mismatch is `PolicyRevisionConflictError` (409);
 *   5. write (insert at revision 1, or bump the revision) and one
 *      `pos.release_policy.changed` audit row, platform-scoped
 *      (`tenant_id` NULL), in the same transaction. Metadata is the allowlist
 *      `channel`, `old` and `new` (versions, grace instant and revision):
 *      no email, token, cookie or request body.
 *
 * The order of the versions (`min <= recommended <= latest` in semantic-version
 * precedence) is checked first, from the body alone: a body that is out of
 * order is `VersionOrderInvalidError` (422) and nothing is read or written.
 * A grace instant in the past is the platform admin's choice and is not
 * refused.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { UPDATE_CHANNELS, type PosVersionPolicyChange, type UpdateChannel } from "./dto";
import { isPolicyOrderValid, parseAppVersion, type ParsedVersion } from "./semver";

export const POLICY_CHANGED_ACTION = "pos.release_policy.changed";

/** `expectedRevision` is not the stored revision and the body differs from the stored values → 409. */
export class PolicyRevisionConflictError extends Error {
  constructor() {
    super("policy revision conflict");
    this.name = "PolicyRevisionConflictError";
  }
}

/** The versions are well-formed but not `min <= recommended <= latest` → 422. */
export class VersionOrderInvalidError extends Error {
  constructor() {
    super("version order invalid");
    this.name = "VersionOrderInvalidError";
  }
}

export interface PosVersionPolicyBody {
  readonly latestVersion: string;
  readonly recommendedVersion: string;
  readonly minSupportedVersion: string;
  readonly minSupportedGraceUntil: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly updatedByUserId: string;
}

export interface PosVersionPolicyEntryBody {
  readonly channel: UpdateChannel;
  readonly policy: PosVersionPolicyBody | null;
}

export interface SetPosVersionPolicyInput {
  readonly channel: UpdateChannel;
  readonly change: PosVersionPolicyChange;
  /** The session user (`users.id`): the change's actor. */
  readonly actorUserId: string;
  readonly requestId: string | null;
}

interface PolicyDbRow {
  channel: UpdateChannel;
  latest_version: string;
  recommended_version: string;
  min_supported_version: string;
  min_supported_grace_until: Date;
  revision: number;
  updated_at: Date;
  updated_by_user_id: string;
}

const COLUMNS = `channel, latest_version, recommended_version, min_supported_version,
                 min_supported_grace_until, revision, updated_at, updated_by_user_id`;

const PLATFORM = { tenantId: null, isPlatformAdmin: true } as const;

function toBody(row: PolicyDbRow): PosVersionPolicyBody {
  return {
    latestVersion: row.latest_version,
    recommendedVersion: row.recommended_version,
    minSupportedVersion: row.min_supported_version,
    minSupportedGraceUntil: row.min_supported_grace_until.toISOString(),
    revision: row.revision,
    updatedAt: row.updated_at.toISOString(),
    updatedByUserId: row.updated_by_user_id,
  };
}

/** The values an audit row records for one side of a change. */
function auditValues(body: PosVersionPolicyBody | null): Record<string, unknown> | null {
  if (body === null) return null;
  return {
    latestVersion: body.latestVersion,
    recommendedVersion: body.recommendedVersion,
    minSupportedVersion: body.minSupportedVersion,
    minSupportedGraceUntil: body.minSupportedGraceUntil,
    revision: body.revision,
  };
}

function sameValues(stored: PosVersionPolicyBody, change: PosVersionPolicyChange): boolean {
  return (
    stored.latestVersion === change.latestVersion &&
    stored.recommendedVersion === change.recommendedVersion &&
    stored.minSupportedVersion === change.minSupportedVersion &&
    Date.parse(stored.minSupportedGraceUntil) === Date.parse(change.minSupportedGraceUntil)
  );
}

/** The change's three versions parsed (min, recommended, latest), or null when any is not a valid version. */
function parseChangeVersions(change: PosVersionPolicyChange): { min: ParsedVersion; recommended: ParsedVersion; latest: ParsedVersion } | null {
  const min = parseAppVersion(change.minSupportedVersion);
  const recommended = parseAppVersion(change.recommendedVersion);
  const latest = parseAppVersion(change.latestVersion);
  return min === null || recommended === null || latest === null ? null : { min, recommended, latest };
}

function assertOrder(change: PosVersionPolicyChange): void {
  const versions = parseChangeVersions(change);
  if (versions === null || !isPolicyOrderValid(versions)) throw new VersionOrderInvalidError();
}

@Injectable()
export class PosVersionPolicyService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Every channel, in the order `lab`, `canary`, `stable`, each with its policy or null. */
  async list(): Promise<{ items: PosVersionPolicyEntryBody[] }> {
    return await runWithTenantContext(this.pool, PLATFORM, async (client) => {
      const res = await client.query<PolicyDbRow>(`SELECT ${COLUMNS} FROM pos_version_policy`);
      const byChannel = new Map(res.rows.map((row) => [row.channel, toBody(row)] as const));
      return { items: UPDATE_CHANNELS.map((channel) => ({ channel, policy: byChannel.get(channel) ?? null })) };
    });
  }

  /** Replace one channel's policy (compare-and-set); an effective change is audited. */
  async set(input: SetPosVersionPolicyInput): Promise<PosVersionPolicyEntryBody> {
    assertOrder(input.change);
    return await runWithTenantContext(this.pool, PLATFORM, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [`pos_version_policy:${input.channel}`]);
      const stored = await this.readChannel(client, input.channel);
      if (stored !== null && sameValues(stored, input.change)) return { channel: input.channel, policy: stored };
      if ((stored?.revision ?? null) !== input.change.expectedRevision) throw new PolicyRevisionConflictError();
      const written = await this.write(client, input, stored);
      await this.audit(client, input, stored, written);
      return { channel: input.channel, policy: written };
    });
  }

  private async readChannel(client: PoolClient, channel: UpdateChannel): Promise<PosVersionPolicyBody | null> {
    const res = await client.query<PolicyDbRow>(`SELECT ${COLUMNS} FROM pos_version_policy WHERE channel = $1::text`, [channel]);
    const row = res.rows[0];
    return row === undefined ? null : toBody(row);
  }

  private async write(client: PoolClient, input: SetPosVersionPolicyInput, stored: PosVersionPolicyBody | null): Promise<PosVersionPolicyBody> {
    const values = [
      input.channel,
      input.change.latestVersion,
      input.change.recommendedVersion,
      input.change.minSupportedVersion,
      input.change.minSupportedGraceUntil,
      input.actorUserId,
    ];
    const res =
      stored === null
        ? await client.query<PolicyDbRow>(
            `INSERT INTO pos_version_policy
               (channel, latest_version, recommended_version, min_supported_version,
                min_supported_grace_until, revision, updated_at, updated_by_user_id)
             VALUES ($1::text, $2::text, $3::text, $4::text, $5::timestamptz, 1, now(), $6::uuid)
             RETURNING ${COLUMNS}`,
            values,
          )
        : await client.query<PolicyDbRow>(
            `UPDATE pos_version_policy
                SET latest_version = $2::text, recommended_version = $3::text,
                    min_supported_version = $4::text, min_supported_grace_until = $5::timestamptz,
                    revision = revision + 1, updated_at = now(), updated_by_user_id = $6::uuid
              WHERE channel = $1::text
              RETURNING ${COLUMNS}`,
            values,
          );
    const row = res.rows[0];
    if (row === undefined) throw new Error("setPosVersionPolicy: write returned no row");
    return toBody(row);
  }

  private async audit(
    client: PoolClient,
    input: SetPosVersionPolicyInput,
    before: PosVersionPolicyBody | null,
    after: PosVersionPolicyBody,
  ): Promise<void> {
    const metadata = { channel: input.channel, old: auditValues(before), new: auditValues(after) };
    await client.query(
      `INSERT INTO audit_events (id, actor_user_id, tenant_id, store_id, action, target_type, target_id, request_id, metadata)
       VALUES ($1, $2, NULL, NULL, $3, 'pos_version_policy', NULL, $4, $5::jsonb)`,
      [newId(), input.actorUserId, POLICY_CHANGED_ACTION, input.requestId, JSON.stringify(metadata)],
    );
  }
}
