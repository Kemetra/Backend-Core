/**
 * RT-209 — Postgres side of the cashier-admission replay purge.
 *
 * RLS posture (the RT-123 lesson: a sweep without a GUC sees nothing under
 * FORCE RLS):
 *   - `cashier_admission_requests` (0035) has tenant-only policies and NO
 *     platform-admin branch, so a platform-admin DELETE would see no row.
 *   - `listTenantIds` is therefore the ONLY platform-admin read. It reads
 *     tenant ids, nothing else, through the `tenants` policy's
 *     is_platform_admin branch (the RT-179 stock sweep's boundary). Every
 *     tenant is listed, whatever its status: a suspended or deleted tenant's
 *     stored display names are still personal data and still expire.
 *   - `purgeExpiredBatch` runs in its own transaction under ONE tenant's GUC
 *     (`isPlatformAdmin: false`), so RLS confines it to that tenant; the
 *     explicit `tenant_id = $1` predicate is belt-and-braces.
 *
 * Privileges: the worker's DATABASE_URL is the domain role the api also uses.
 * 0035 documents its production grants on `cashier_admission_requests` as
 * SELECT, INSERT, UPDATE and DELETE (the api already deletes a device's
 * expired rows); `FOR UPDATE` needs the UPDATE one. The tenant listing needs
 * SELECT on `tenants`, as the stock sweep does. No new grant.
 *
 * Expiry uses the database clock (`clock_timestamp()`), the same clock the api
 * compares against: a row is replayable only while `expires_at > clock`, and
 * the api's own per-device purge deletes `expires_at <= clock`. The predicate
 * here is that same one, so the sweep never deletes a replayable row.
 *
 * `FOR UPDATE SKIP LOCKED` keeps the sweep from waiting on a row the api is
 * upserting at that moment (a reused key); that row is picked up next time.
 */
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

export interface ReplayPurgeRepository {
  /** Every tenant id (any status). */
  listTenantIds(): Promise<string[]>;
  /** Delete up to `batchSize` expired replay rows of one tenant; returns how many. */
  purgeExpiredBatch(tenantId: string, batchSize: number): Promise<number>;
}

const PURGE_EXPIRED_BATCH_SQL = `
DELETE FROM cashier_admission_requests
 WHERE id IN (
   SELECT id
     FROM cashier_admission_requests
    WHERE tenant_id = $1
      AND expires_at <= clock_timestamp()
    ORDER BY expires_at
    LIMIT $2
      FOR UPDATE SKIP LOCKED
 )
`;

export class PgReplayPurgeRepository implements ReplayPurgeRepository {
  constructor(private readonly pool: Pool) {}

  async listTenantIds(): Promise<string[]> {
    return runWithTenantContext(
      this.pool,
      { tenantId: null, isPlatformAdmin: true },
      async (client) => {
        const r = await client.query<{ id: string }>(`SELECT id FROM tenants ORDER BY id`);
        return r.rows.map((row) => row.id);
      },
    );
  }

  async purgeExpiredBatch(tenantId: string, batchSize: number): Promise<number> {
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query(PURGE_EXPIRED_BATCH_SQL, [tenantId, batchSize]);
        return r.rowCount ?? 0;
      },
    );
  }
}

/** No-DB path (dev / CI without DATABASE_URL): nothing to purge. */
export class NoOpReplayPurgeRepository implements ReplayPurgeRepository {
  async listTenantIds(): Promise<string[]> {
    return [];
  }

  async purgeExpiredBatch(_tenantId: string, _batchSize: number): Promise<number> {
    return 0;
  }
}
