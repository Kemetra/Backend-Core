/**
 * DeviceRepository — read-side lookups against `devices` for sign-in.
 *
 * Wave 1 sign-in resolves the terminal scope (tenant + branch) by hashing
 * the operator-supplied `device_token_attestation` and matching the
 * `devices.token_hash` column. The plaintext attestation is never logged
 * or persisted (ADR 0001 D7, FR-POS-AUTH-2).
 *
 * The lookup is intentionally direct against the pre-tenant lookup pool: at
 * sign-in time the request has no established tenant context (the device is
 * the source of that context). Tenant/store consistency between the device
 * and the resolved operator is enforced by the service layer
 * (PosOperatorsService.signIn) not by RLS, per ADR D9 final paragraph.
 *
 * Tenant status (RT-213)
 * ----------------------
 * Every device route resolves its device here: the PosDeviceAuthGuard
 * (read-down, cashier admissions), operator sign-in and takeover, POS
 * audit-event sync, and the live reverifier behind the operator envelope
 * (sales capture, settlement). So the tenant check lives here, once: a
 * device is "active" only while its tenant is active, i.e. `status =
 * 'active'` (the `tenants_status_valid` CHECK allows active, suspended and
 * pending) AND `deleted_at IS NULL`. A device of a suspended, pending or
 * soft-deleted tenant resolves to null, exactly like a revoked device, so
 * every caller refuses it with the response it already gives a revoked
 * device and nothing about the tenant is disclosed.
 *
 * The tenant row is read on the DOMAIN pool inside the device's own tenant
 * context (constitution §II), not on the lookup pool: the lookup role holds
 * no grant on `tenants` (docs/operations/database-roles.md), and the domain
 * role reads its own tenant row through the `tenants_tenant_isolation`
 * policy. No grant or migration is needed. A row that is not visible fails
 * closed.
 *
 * Columns (RT-365)
 * ----------------
 * The lookup selects `AUTH_DEVICE_COLUMNS` only: columns present since
 * migration 0001. `packages/db` also declares the 0040 lifecycle columns, and
 * a bare `select()` would name them, so every till's authentication would
 * fail on a database where 0040 is not applied yet (or was rolled back).
 * Since RT-369 the lookup's predicate reads the 0040 rotation columns
 * (`previous_token_hash`, `previous_valid_until`), so it needs 0040, which
 * every environment has had since RT-365 shipped.
 *
 * Expiry and activity (RT-370)
 * ----------------------------
 * With `DEVICE_TOKEN_EXPIRY_ENFORCED` on (default off), `findActive*` also
 * requires `expires_at > now()` (database clock), so an expired device
 * resolves to null and every caller refuses it with the response it gives a
 * revoked device. `findForRotation` is not affected: rotation applies its own
 * 7-day grace (RT-369). Every device `findActive*` resolves is recorded as
 * activity (`devices.last_seen_at`, throttled, best effort; see
 * `device-activity.ts`), so a refused device is never recorded.
 */
import { Injectable } from "@nestjs/common";
import { hashToken } from "@data-pulse-2/auth";
import { runWithTenantContext } from "@data-pulse-2/db";
import { devices, type DeviceRow } from "@data-pulse-2/db/schema";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, gt, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Pool } from "pg";

import type { RotationDeviceState } from "../pos-terminal-pairing/rotation-decision";
import { deviceActivity, type ActiveDevice } from "./device-activity";
import { isDeviceTokenExpiryEnforced } from "./device-token-expiry-gate";

type DrizzleClient = NodePgDatabase;

function db(client: Pool): DrizzleClient {
  return drizzle(client);
}

/**
 * The row whose current token hash, or in-window previous hash (RT-369 overlap),
 * is `rawAttestation`'s.
 */
function attestationMatch(hash: Buffer): SQL {
  return or(
    eq(devices.tokenHash, hash),
    and(eq(devices.previousTokenHash, hash), gt(devices.previousValidUntil, sql`now()`)),
  )!;
}

/** Not revoked; and, with `DEVICE_TOKEN_EXPIRY_ENFORCED` on, not expired (database clock). */
function liveDevice(): SQL | undefined {
  return isDeviceTokenExpiryEnforced()
    ? and(isNull(devices.revokedAt), gt(devices.expiresAt, sql`now()`))
    : isNull(devices.revokedAt);
}

/** The device columns the auth lookup reads: all present since 0001, none from 0040. */
const AUTH_DEVICE_COLUMNS = {
  id: devices.id,
  tenantId: devices.tenantId,
  storeId: devices.storeId,
  label: devices.label,
  tokenHash: devices.tokenHash,
  revokedAt: devices.revokedAt,
  createdAt: devices.createdAt,
  updatedAt: devices.updatedAt,
};

/** A device as the auth lookup returns it. */
export type AuthDeviceRow = Pick<DeviceRow, keyof typeof AUTH_DEVICE_COLUMNS>;

/**
 * RT-639: the auth lookup's device plus what the rotate-soon hint needs.
 * `presentedPreviousUntil` is when the rotation overlap closes if the request
 * presented the PREVIOUS token (inside its window), else null: that token stops
 * working then, whatever the device's fresh `expiresAt` says.
 */
export type AuthDeviceRowWithExpiry = AuthDeviceRow &
  Pick<DeviceRow, "expiresAt"> & { readonly presentedPreviousUntil: Date | null };

interface TenantStatusRow {
  status: string;
  deleted_at: Date | null;
}

interface RotationLookupRow {
  id: string;
  tenant_id: string;
  store_id: string;
  token_hash: Buffer;
  previous_token_hash: Buffer | null;
  previous_valid_until: Date | null;
  revoked_at: Date | null;
  retired_at: Date | null;
  expires_at: Date;
  db_now: Date;
}

/** A device as the RT-369 rotation guard sees it (any lifecycle state). */
export interface RotationLookup {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly state: RotationDeviceState;
}

@Injectable()
export class DeviceRepository {
  /**
   * @param pool       the pre-tenant lookup pool (AUTH_LOOKUP_POOL): resolves
   *                   the device before any tenant context exists.
   * @param domainPool the domain pool (PG_POOL): reads the device's tenant
   *                   status under that tenant's RLS context.
   */
  constructor(
    private readonly pool: Pool,
    private readonly domainPool: Pool,
  ) {}

  /**
   * Resolve a device by its raw token attestation. Returns the row when
   * the hash matches, `revoked_at IS NULL` and the device's tenant is
   * active; returns null otherwise.
   *
   * The hash matches the current `token_hash`, or (RT-369 rotation overlap)
   * the `previous_token_hash` while `previous_valid_until` is in the future
   * on the database clock. Both columns are UNIQUE (the previous one through
   * a partial index), so the lookup is two index probes returning at most
   * one row regardless of input; the hash is never compared in JS here.
   */
  async findActiveByAttestation(rawAttestation: string): Promise<AuthDeviceRow | null> {
    if (rawAttestation.length === 0) return null;
    return this.findActive(attestationMatch(hashToken(rawAttestation)));
  }

  /**
   * RT-639 — `findActiveByAttestation` for the one caller that also needs the
   * credential's expiry: `PosDeviceAuthGuard`, for the rotate-soon hint. Same
   * match, same live predicate, same tenant gate and activity record; the only
   * difference is `expires_at` and `presentedPreviousUntil` in the select list,
   * in the same single query.
   * It is a separate method so every other device lookup keeps its select list
   * (see "Columns" above) and reads `expires_at` only when the expiry flag is on.
   */
  async findActiveByAttestationWithExpiry(
    rawAttestation: string,
  ): Promise<AuthDeviceRowWithExpiry | null> {
    if (rawAttestation.length === 0) return null;
    const hash = hashToken(rawAttestation);
    const rows = await db(this.pool)
      .select({
        ...AUTH_DEVICE_COLUMNS,
        expiresAt: devices.expiresAt,
        presentedPreviousUntil: sql<Date | null>`case when ${eq(devices.previousTokenHash, hash)} then ${devices.previousValidUntil} end`.mapWith(
          devices.previousValidUntil,
        ),
      })
      .from(devices)
      .where(and(attestationMatch(hash), liveDevice()))
      .limit(1);
    return this.admit(rows[0]);
  }

  /**
   * RT-369 — the rotation guard's lookup: the device whose current OR
   * previous hash matches, whatever its window, revoke, retire or expiry
   * state (the rotation decision classifies it), with the database clock.
   * Null when no row matches or the device's tenant is not active (RT-213),
   * so an inactive tenant is refused like an unknown token.
   */
  async findForRotation(rawAttestation: string): Promise<RotationLookup | null> {
    if (rawAttestation.length === 0) return null;
    const res = await this.pool.query<RotationLookupRow>(
      `SELECT id, tenant_id, store_id, token_hash, previous_token_hash, previous_valid_until,
              revoked_at, retired_at, expires_at, now() AS db_now
         FROM devices
        WHERE token_hash = $1 OR previous_token_hash = $1
        LIMIT 1`,
      [hashToken(rawAttestation)],
    );
    const row = res.rows[0];
    if (!row) return null;
    if (!(await this.tenantIsActive(row.tenant_id))) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      storeId: row.store_id,
      state: {
        tokenHash: row.token_hash,
        previousTokenHash: row.previous_token_hash,
        previousValidUntil: row.previous_valid_until,
        revokedAt: row.revoked_at,
        retiredAt: row.retired_at,
        expiresAt: row.expires_at,
        now: row.db_now,
      },
    };
  }

  /**
   * Resolve a device by id, with the same rules as `findActiveByAttestation`
   * (not revoked, tenant active). Used by the live reverifier, which knows
   * the device id from the operator envelope's `auth_tokens` row.
   */
  async findActiveById(deviceId: string): Promise<AuthDeviceRow | null> {
    return this.findActive(eq(devices.id, deviceId));
  }

  /**
   * RT-370 — record that `device` authenticated (throttled, best effort; never
   * throws or waits). For a device route that resolves its device without
   * `findActive*`: the rotate guard, after `decideRotation` allows it.
   */
  recordActivity(device: ActiveDevice): void {
    deviceActivity.record(this.domainPool, device);
  }

  private async findActive(match: SQL): Promise<AuthDeviceRow | null> {
    const rows = await db(this.pool)
      .select(AUTH_DEVICE_COLUMNS)
      .from(devices)
      .where(and(match, liveDevice()))
      .limit(1);
    return this.admit(rows[0]);
  }

  /** The tenant gate and the activity record every resolved device goes through. */
  private async admit<T extends AuthDeviceRow>(device: T | undefined): Promise<T | null> {
    if (!device) return null;
    if (!(await this.tenantIsActive(device.tenantId))) return null;
    this.recordActivity(device);
    return device;
  }

  private async tenantIsActive(tenantId: string): Promise<boolean> {
    const row = await runWithTenantContext(
      this.domainPool,
      { tenantId, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<TenantStatusRow>(
          `SELECT status, deleted_at FROM tenants WHERE id = $1 LIMIT 1`,
          [tenantId],
        );
        return r.rows[0];
      },
    );
    return row !== undefined && row.status === "active" && row.deleted_at === null;
  }
}
