/**
 * Persistence for cashier admissions (RT-113 BC2; tables from migration
 * 0035_cashier_admissions).
 *
 * Every method runs on the caller's tenant-scoped `PoolClient` (inside
 * `runWithTenantContext`), so RLS applies to every statement and each query
 * also names `tenant_id` explicitly. Times come from the database clock,
 * read ONCE per request with `clock()` (`clock_timestamp()`) AFTER the locks
 * are held, and passed as `at` to every expiry comparison and every
 * timestamp write. `now()` is not used: it is fixed at transaction start,
 * and a request may wait on the locks, so an admission that expired while
 * it waited would look live and a new TTL would be shortened by the wait.
 *
 * Serialisation: `lockCashier` takes a transaction-scoped advisory lock per
 * (tenant, store, user), so at most one transaction at a time decides for a
 * cashier — concurrent takeovers resolve to exactly one winner and lazy
 * expiry cannot race a renewal. `lockRequestKey` does the same per
 * (tenant, device, key digest), so two concurrent requests with one key are
 * processed one after the other and the second sees the first's outcome. The
 * partial UNIQUE index `uq_cashier_admissions_live` is the database backstop
 * for the single-active rule.
 *
 * Generation (RT-219): `renewed_at` moves on every grant and renewal of a row
 * and on nothing else, so its exact microsecond value is the admission's
 * generation. It is exposed as an opaque string (`GENERATION_OF`) and
 * compared as text, so no new column is needed. A renewal is STRICTLY
 * monotonic (`renewed_at + 1 µs` at least), so even a clock that stepped back
 * yields a new generation. `endOwned` compares the echoed generation and ends
 * in ONE statement on the row, under the cashier lock: an `end` racing a
 * renewal is decided in arrival order and never ends a renewal it did not see.
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
  /** Opaque generation of this grant or renewal (RT-219). */
  readonly generation: string;
}

export interface NewAdmission {
  readonly id: string;
  /** The request's clock reading (after the locks). */
  readonly at: Date;
  readonly scope: DeviceScope;
  readonly userId: string;
  readonly mode: AdmissionMode;
  readonly offlineAdmittedAt: string | null;
  readonly takeoverOf: string | null;
  readonly ttlSeconds: number;
}

/**
 * A stored `admitted` body. An entry written before RT-219 has no
 * `admission_generation` (the replay window bounds how long one can exist).
 */
export type StoredAdmittedBody = Omit<AdmittedBody, "admission_generation"> &
  Partial<Pick<AdmittedBody, "admission_generation">>;

export interface StoredRequest {
  readonly requestHash: Buffer;
  readonly admissionId: string;
  readonly responseBody: StoredAdmittedBody;
}

export interface SavedRequest {
  readonly at: Date;
  readonly keyHash: Buffer;
  readonly requestHash: Buffer;
  readonly admissionId: string;
  readonly responseBody: AdmittedBody;
  /** The replay window; never longer than the admission TTL. */
  readonly ttlSeconds: number;
}

/** An admission ended by lazy expiry, and the device that held it. */
export interface ExpiredAdmission {
  readonly id: string;
  readonly deviceId: string;
}

export interface OwnedAdmission {
  readonly id: string;
  readonly userId: string;
}

/** Who and when: the cashier and the request's clock reading. */
export interface CashierAt {
  readonly userId: string;
  readonly at: Date;
}

/** Which key and when. */
export interface KeyAt {
  readonly keyHash: Buffer;
  readonly at: Date;
}

/** Which admission and when. */
export interface AdmissionAt {
  readonly admissionId: string;
  readonly at: Date;
}

/** An `end`: which admission, when, and the generation it echoed (RT-219). */
export interface EndAt extends AdmissionAt {
  /** null: no echo, the end is unconditional (the 1.0.0-draft behaviour). */
  readonly generation: string | null;
}

/**
 * What `endOwned` did: ended the admission; found it live on this device but
 * renewed since the echoed generation (no-op); or found nothing live here.
 */
export type EndResult = "ended" | "stale_generation" | "not_live";

export interface AdmissionStore {
  lockRequestKey(client: PoolClient, scope: DeviceScope, keyHash: Buffer): Promise<void>;
  lockCashier(client: PoolClient, scope: DeviceScope, userId: string): Promise<void>;
  /** The database wall clock; read once per request, after the locks. */
  clock(client: PoolClient): Promise<Date>;
  findRequest(client: PoolClient, scope: DeviceScope, key: KeyAt): Promise<StoredRequest | null>;
  /** End the cashier's expired live admission(s); returns them with their holder. */
  expireStale(client: PoolClient, scope: DeviceScope, cashier: CashierAt): Promise<ExpiredAdmission[]>;
  isLiveOnDevice(client: PoolClient, scope: DeviceScope, admissionId: string): Promise<boolean>;
  findLive(client: PoolClient, scope: DeviceScope, userId: string): Promise<LiveAdmission | null>;
  create(client: PoolClient, input: NewAdmission): Promise<AdmissionRecord>;
  renew(client: PoolClient, scope: DeviceScope, admission: AdmissionAt, ttlSeconds: number): Promise<AdmissionRecord>;
  end(client: PoolClient, scope: DeviceScope, admission: AdmissionAt, reason: EndReason): Promise<void>;
  saveRequest(client: PoolClient, scope: DeviceScope, input: SavedRequest): Promise<void>;
  /** This device's live admission `admissionId`, if any. */
  findOwned(client: PoolClient, scope: DeviceScope, admissionId: string): Promise<OwnedAdmission | null>;
  /** End this device's live admission unless the echoed generation is stale. */
  endOwned(client: PoolClient, scope: DeviceScope, end: EndAt): Promise<EndResult>;
}

async function advisoryLock(client: PoolClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

/**
 * The generation of a row as opaque text: `renewed_at` in whole microseconds
 * since the epoch. JS `Date` keeps only milliseconds, so it is computed and
 * compared in SQL, never round-tripped through a `Date`.
 */
const GENERATION_OF = "(extract(epoch FROM renewed_at) * 1000000)::bigint::text";

interface RecordRow {
  id: string;
  renewed_at: Date;
  generation: string;
}

function toRecord(row: RecordRow | undefined): AdmissionRecord {
  if (!row) throw new Error("cashier admission write returned no row");
  return { id: row.id, renewedAt: row.renewed_at, generation: row.generation };
}

export class CashierAdmissionsRepository implements AdmissionStore {
  async lockRequestKey(client: PoolClient, scope: DeviceScope, keyHash: Buffer): Promise<void> {
    await advisoryLock(client, `cashier_admission_key:${scope.tenantId}:${scope.deviceId}:${keyHash.toString("hex")}`);
  }

  async clock(client: PoolClient): Promise<Date> {
    const r = await client.query<{ at: Date }>("SELECT clock_timestamp() AS at");
    return r.rows[0]!.at;
  }

  async findRequest(client: PoolClient, scope: DeviceScope, key: KeyAt): Promise<StoredRequest | null> {
    const r = await client.query<{ request_hash: Buffer; admission_id: string; response_body: StoredAdmittedBody }>(
      `SELECT request_hash, admission_id, response_body
         FROM cashier_admission_requests
        WHERE tenant_id = $1 AND device_id = $2 AND key_hash = $3 AND expires_at > $4::timestamptz`,
      [scope.tenantId, scope.deviceId, key.keyHash, key.at],
    );
    const row = r.rows[0];
    return row
      ? { requestHash: row.request_hash, admissionId: row.admission_id, responseBody: row.response_body }
      : null;
  }

  async lockCashier(client: PoolClient, scope: DeviceScope, userId: string): Promise<void> {
    await advisoryLock(client, `cashier_admission:${scope.tenantId}:${scope.storeId}:${userId}`);
  }

  async expireStale(client: PoolClient, scope: DeviceScope, cashier: CashierAt): Promise<ExpiredAdmission[]> {
    const r = await client.query<{ id: string; device_id: string }>(
      `UPDATE cashier_admissions
          SET ended_at = $4::timestamptz, end_reason = 'expired'
        WHERE tenant_id = $1 AND store_id = $2 AND user_id = $3
          AND ended_at IS NULL AND expires_at <= $4::timestamptz
        RETURNING id, device_id`,
      [scope.tenantId, scope.storeId, cashier.userId, cashier.at],
    );
    return r.rows.map((row) => ({ id: row.id, deviceId: row.device_id }));
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
    const r = await client.query<RecordRow>(
      `INSERT INTO cashier_admissions
         (id, tenant_id, store_id, user_id, device_id, mode, offline_admitted_at,
          takeover_of, created_at, renewed_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $10::timestamptz, $10::timestamptz,
               $10::timestamptz + $9::int * interval '1 second')
       RETURNING id, renewed_at, ${GENERATION_OF} AS generation`,
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
        input.at,
      ],
    );
    return toRecord(r.rows[0]);
  }

  async renew(
    client: PoolClient,
    scope: DeviceScope,
    admission: AdmissionAt,
    ttlSeconds: number,
  ): Promise<AdmissionRecord> {
    const r = await client.query<RecordRow>(
      // STRICTLY monotonic: a renewal always moves renewed_at forward, by at
      // least 1 µs, so `renewed_at >= created_at` holds even for a stale
      // instant AND every renewal has a new generation (RT-219), even after
      // the clock stepped back. (SET expressions read the old renewed_at.)
      `UPDATE cashier_admissions
          SET renewed_at = GREATEST($5::timestamptz, renewed_at + interval '1 microsecond'),
              expires_at = GREATEST($5::timestamptz, renewed_at + interval '1 microsecond')
                           + $4::int * interval '1 second'
        WHERE id = $1 AND tenant_id = $2 AND device_id = $3 AND ended_at IS NULL
        RETURNING id, renewed_at, ${GENERATION_OF} AS generation`,
      [admission.admissionId, scope.tenantId, scope.deviceId, ttlSeconds, admission.at],
    );
    return toRecord(r.rows[0]);
  }

  async end(client: PoolClient, scope: DeviceScope, admission: AdmissionAt, reason: EndReason): Promise<void> {
    await client.query(
      `UPDATE cashier_admissions SET ended_at = $4::timestamptz, end_reason = $3
        WHERE id = $1 AND tenant_id = $2 AND ended_at IS NULL`,
      [admission.admissionId, scope.tenantId, reason, admission.at],
    );
  }

  async saveRequest(client: PoolClient, scope: DeviceScope, input: SavedRequest): Promise<void> {
    // The replay store is a cache: drop this device's expired entries first.
    await client.query(
      `DELETE FROM cashier_admission_requests
        WHERE tenant_id = $1 AND device_id = $2 AND expires_at <= $3::timestamptz`,
      [scope.tenantId, scope.deviceId, input.at],
    );
    await client.query(
      `INSERT INTO cashier_admission_requests
         (tenant_id, device_id, key_hash, request_hash, admission_id, response_body,
          created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $8::timestamptz,
               $8::timestamptz + $7::int * interval '1 second')
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
        input.at,
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

  async endOwned(client: PoolClient, scope: DeviceScope, end: EndAt): Promise<EndResult> {
    // One statement, one snapshot: `live` says whether the row is this
    // device's live admission; `ended` ends it only when no generation was
    // echoed or the echo is the row's current generation (RT-219).
    const r = await client.query<{ live: boolean; ended: boolean }>(
      `WITH live AS (
         SELECT id FROM cashier_admissions
          WHERE id = $1 AND tenant_id = $2 AND device_id = $3 AND ended_at IS NULL
       ), ended AS (
         UPDATE cashier_admissions
            SET ended_at = $4::timestamptz,
                end_reason = CASE WHEN expires_at <= $4::timestamptz THEN 'expired' ELSE 'device_end' END
          WHERE id = $1 AND tenant_id = $2 AND device_id = $3 AND ended_at IS NULL
            AND ($5::text IS NULL OR ${GENERATION_OF} = $5::text)
          RETURNING id
       )
       SELECT EXISTS (SELECT 1 FROM live) AS live, EXISTS (SELECT 1 FROM ended) AS ended`,
      [end.admissionId, scope.tenantId, scope.deviceId, end.at, end.generation],
    );
    const row = r.rows[0];
    if (row?.ended) return "ended";
    return row?.live ? "stale_generation" : "not_live";
  }
}
