/**
 * Persistence for cashier admissions (RT-113 BC2; tables from migration
 * 0035_cashier_admissions).
 *
 * Every method runs on the caller's tenant-scoped `PoolClient` (inside
 * `runWithTenantContext`), so RLS applies to every statement and each query
 * also names `tenant_id` explicitly. Times come from the database clock
 * (`now()`, the transaction start): the server clock decides every outcome.
 *
 * Serialisation: `lockCashier` takes a transaction-scoped advisory lock per
 * (tenant, store, user), so at most one transaction at a time decides for a
 * cashier — concurrent takeovers resolve to exactly one winner and lazy
 * expiry cannot race a renewal. `lockRequestKey` does the same per
 * (tenant, device, key digest), so two concurrent requests with one key are
 * processed one after the other and the second sees the first's outcome. The
 * partial UNIQUE index `uq_cashier_admissions_live` is the database backstop
 * for the single-active rule.
 */
import type { PoolClient } from "pg";

import type { LiveAdmission } from "./admission-request";
import type { DeviceScope } from "./device-scope";
import type { AdmittedBody } from "./dto";

export type AdmissionMode = "online" | "reconcile_offline";
export type EndReason = "device_end" | "takeover" | "expired";

export interface AdmissionRecord {
  readonly id: string;
  /** When the admission was granted or last renewed (the `server_time`). */
  readonly renewedAt: Date;
}

export interface NewAdmission {
  readonly id: string;
  readonly scope: DeviceScope;
  readonly userId: string;
  readonly mode: AdmissionMode;
  readonly offlineAdmittedAt: string | null;
  readonly takeoverOf: string | null;
  readonly ttlSeconds: number;
}

export interface StoredRequest {
  readonly requestHash: Buffer;
  readonly admissionId: string;
  readonly responseBody: AdmittedBody;
}

export interface SavedRequest {
  readonly keyHash: Buffer;
  readonly requestHash: Buffer;
  readonly admissionId: string;
  readonly responseBody: AdmittedBody;
  /** The replay window; never longer than the admission TTL. */
  readonly ttlSeconds: number;
}

export interface OwnedAdmission {
  readonly id: string;
  readonly userId: string;
}

export interface AdmissionStore {
  lockRequestKey(client: PoolClient, scope: DeviceScope, keyHash: Buffer): Promise<void>;
  findRequest(client: PoolClient, scope: DeviceScope, keyHash: Buffer): Promise<StoredRequest | null>;
  lockCashier(client: PoolClient, scope: DeviceScope, userId: string): Promise<void>;
  /** End the cashier's expired live admission(s); returns the ended ids. */
  expireStale(client: PoolClient, scope: DeviceScope, userId: string): Promise<string[]>;
  isLiveOnDevice(client: PoolClient, scope: DeviceScope, admissionId: string): Promise<boolean>;
  findLive(client: PoolClient, scope: DeviceScope, userId: string): Promise<LiveAdmission | null>;
  create(client: PoolClient, input: NewAdmission): Promise<AdmissionRecord>;
  renew(client: PoolClient, scope: DeviceScope, admissionId: string, ttlSeconds: number): Promise<AdmissionRecord>;
  end(client: PoolClient, scope: DeviceScope, admissionId: string, reason: EndReason): Promise<void>;
  saveRequest(client: PoolClient, scope: DeviceScope, input: SavedRequest): Promise<void>;
  /** This device's live admission `admissionId`, if any. */
  findOwned(client: PoolClient, scope: DeviceScope, admissionId: string): Promise<OwnedAdmission | null>;
  /** End this device's live admission `admissionId`; false when nothing changed. */
  endOwned(client: PoolClient, scope: DeviceScope, admissionId: string): Promise<boolean>;
}

async function advisoryLock(client: PoolClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

function toRecord(row: { id: string; renewed_at: Date } | undefined): AdmissionRecord {
  if (!row) throw new Error("cashier admission write returned no row");
  return { id: row.id, renewedAt: row.renewed_at };
}

export class CashierAdmissionsRepository implements AdmissionStore {
  async lockRequestKey(client: PoolClient, scope: DeviceScope, keyHash: Buffer): Promise<void> {
    await advisoryLock(client, `cashier_admission_key:${scope.tenantId}:${scope.deviceId}:${keyHash.toString("hex")}`);
  }

  async findRequest(client: PoolClient, scope: DeviceScope, keyHash: Buffer): Promise<StoredRequest | null> {
    const r = await client.query<{ request_hash: Buffer; admission_id: string; response_body: AdmittedBody }>(
      `SELECT request_hash, admission_id, response_body
         FROM cashier_admission_requests
        WHERE tenant_id = $1 AND device_id = $2 AND key_hash = $3 AND expires_at > now()`,
      [scope.tenantId, scope.deviceId, keyHash],
    );
    const row = r.rows[0];
    return row
      ? { requestHash: row.request_hash, admissionId: row.admission_id, responseBody: row.response_body }
      : null;
  }

  async lockCashier(client: PoolClient, scope: DeviceScope, userId: string): Promise<void> {
    await advisoryLock(client, `cashier_admission:${scope.tenantId}:${scope.storeId}:${userId}`);
  }

  async expireStale(client: PoolClient, scope: DeviceScope, userId: string): Promise<string[]> {
    const r = await client.query<{ id: string }>(
      `UPDATE cashier_admissions
          SET ended_at = now(), end_reason = 'expired'
        WHERE tenant_id = $1 AND store_id = $2 AND user_id = $3
          AND ended_at IS NULL AND expires_at <= now()
        RETURNING id`,
      [scope.tenantId, scope.storeId, userId],
    );
    return r.rows.map((row) => row.id);
  }

  async isLiveOnDevice(client: PoolClient, scope: DeviceScope, admissionId: string): Promise<boolean> {
    const r = await client.query(
      `SELECT 1 FROM cashier_admissions
        WHERE id = $1 AND tenant_id = $2 AND device_id = $3 AND ended_at IS NULL`,
      [admissionId, scope.tenantId, scope.deviceId],
    );
    return r.rows.length > 0;
  }

  async findLive(client: PoolClient, scope: DeviceScope, userId: string): Promise<LiveAdmission | null> {
    const r = await client.query<{ id: string; device_id: string }>(
      `SELECT id, device_id FROM cashier_admissions
        WHERE tenant_id = $1 AND store_id = $2 AND user_id = $3 AND ended_at IS NULL`,
      [scope.tenantId, scope.storeId, userId],
    );
    const row = r.rows[0];
    return row ? { id: row.id, deviceId: row.device_id } : null;
  }

  async create(client: PoolClient, input: NewAdmission): Promise<AdmissionRecord> {
    const r = await client.query<{ id: string; renewed_at: Date }>(
      `INSERT INTO cashier_admissions
         (id, tenant_id, store_id, user_id, device_id, mode, offline_admitted_at,
          takeover_of, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + $9::int * interval '1 second')
       RETURNING id, renewed_at`,
      [
        input.id,
        input.scope.tenantId,
        input.scope.storeId,
        input.userId,
        input.scope.deviceId,
        input.mode,
        input.offlineAdmittedAt,
        input.takeoverOf,
        input.ttlSeconds,
      ],
    );
    return toRecord(r.rows[0]);
  }

  async renew(
    client: PoolClient,
    scope: DeviceScope,
    admissionId: string,
    ttlSeconds: number,
  ): Promise<AdmissionRecord> {
    const r = await client.query<{ id: string; renewed_at: Date }>(
      `UPDATE cashier_admissions
          SET renewed_at = now(), expires_at = now() + $4::int * interval '1 second'
        WHERE id = $1 AND tenant_id = $2 AND device_id = $3 AND ended_at IS NULL
        RETURNING id, renewed_at`,
      [admissionId, scope.tenantId, scope.deviceId, ttlSeconds],
    );
    return toRecord(r.rows[0]);
  }

  async end(client: PoolClient, scope: DeviceScope, admissionId: string, reason: EndReason): Promise<void> {
    await client.query(
      `UPDATE cashier_admissions SET ended_at = now(), end_reason = $3
        WHERE id = $1 AND tenant_id = $2 AND ended_at IS NULL`,
      [admissionId, scope.tenantId, reason],
    );
  }

  async saveRequest(client: PoolClient, scope: DeviceScope, input: SavedRequest): Promise<void> {
    // The replay store is a cache: drop this device's expired entries first.
    await client.query(
      `DELETE FROM cashier_admission_requests
        WHERE tenant_id = $1 AND device_id = $2 AND expires_at <= now()`,
      [scope.tenantId, scope.deviceId],
    );
    await client.query(
      `INSERT INTO cashier_admission_requests
         (tenant_id, device_id, key_hash, request_hash, admission_id, response_body, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, now() + $7::int * interval '1 second')
       ON CONFLICT (tenant_id, device_id, key_hash) DO UPDATE
         SET request_hash = EXCLUDED.request_hash,
             admission_id = EXCLUDED.admission_id,
             response_body = EXCLUDED.response_body,
             created_at = EXCLUDED.created_at,
             expires_at = EXCLUDED.expires_at`,
      [
        scope.tenantId,
        scope.deviceId,
        input.keyHash,
        input.requestHash,
        input.admissionId,
        JSON.stringify(input.responseBody),
        input.ttlSeconds,
      ],
    );
  }

  async findOwned(client: PoolClient, scope: DeviceScope, admissionId: string): Promise<OwnedAdmission | null> {
    const r = await client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM cashier_admissions
        WHERE id = $1 AND tenant_id = $2 AND device_id = $3 AND ended_at IS NULL`,
      [admissionId, scope.tenantId, scope.deviceId],
    );
    const row = r.rows[0];
    return row ? { id: row.id, userId: row.user_id } : null;
  }

  async endOwned(client: PoolClient, scope: DeviceScope, admissionId: string): Promise<boolean> {
    const r = await client.query(
      `UPDATE cashier_admissions
          SET ended_at = now(),
              end_reason = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'device_end' END
        WHERE id = $1 AND tenant_id = $2 AND device_id = $3 AND ended_at IS NULL
        RETURNING id`,
      [admissionId, scope.tenantId, scope.deviceId],
    );
    return r.rows.length > 0;
  }
}
