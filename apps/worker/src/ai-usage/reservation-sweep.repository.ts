/**
 * RT-664 — Postgres side of the AI usage reservation sweep (T17).
 *
 * RLS posture (0055): `ai_usage_ledger` and `ai_usage_counters` are FORCE RLS
 * with tenant-only policies, so a cross-tenant read sees nothing. The sweep
 * therefore lists tenant ids as platform admin (the `tenants` policy has that
 * branch; the RT-209 replay purge's boundary) and releases each tenant's
 * reservations under that tenant's own GUC (`isPlatformAdmin: false`).
 *
 * Each batch lists, in one read, the tenant's open reservations whose TTL
 * passed (within the lookback), then releases each in its own transaction with
 * outcome `reservation_expired` through the shared `settleAiReservation`, the same
 * write the api's commit / release uses (an advisory lock per reservation, so
 * a racing commit and the sweep close it exactly once; a late commit after
 * the release is never charged).
 *
 * Privileges: the domain role's RT-664 grants (SELECT, INSERT on the ledger;
 * SELECT, INSERT, UPDATE on the counters) and SELECT on `tenants`. No DELETE
 * and no ledger UPDATE: the ledger is append-only. Those grants are an
 * owner-gated operator step (docs/operations/sql/ai-entitlements-domain-
 * grants.sql), so `isProvisioned` checks them first: until they exist the
 * sweep is a quiet no-op instead of a permission error per tenant.
 */
import { listExpiredAiReservations, runWithTenantContext, settleAiReservation } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

export interface ReservationSweepRepository {
  /** True when 0055 is migrated and the role holds the sweep's grants. */
  isProvisioned(): Promise<boolean>;
  /** Every tenant id (any status: a suspended tenant's reservations still expire). */
  listTenantIds(): Promise<string[]>;
  /**
   * Release up to `limit` expired reservations of one tenant. `listed` is how
   * many were found (a full batch means more may follow); `released` how many
   * this pass closed (a racing commit or release may have closed one first).
   */
  releaseExpiredBatch(tenantId: string, input: SweepBatchInput): Promise<SweepBatchResult>;
}

export interface SweepBatchInput {
  readonly lookbackSeconds: number;
  readonly limit: number;
}

export interface SweepBatchResult {
  readonly listed: number;
  readonly released: number;
}

export class PgReservationSweepRepository implements ReservationSweepRepository {
  constructor(private readonly pool: Pool) {}

  async isProvisioned(): Promise<boolean> {
    const r = await this.pool.query<{ ok: boolean | null }>(
      // The regclass (oid) forms are NULL-safe: a table 0055 has not created
      // yet is NULL, never an error (AND has no guaranteed evaluation order).
      `SELECT has_table_privilege(to_regclass('public.ai_usage_ledger'), 'SELECT, INSERT')
          AND has_table_privilege(to_regclass('public.ai_usage_counters'), 'SELECT, UPDATE') AS ok`,
    );
    return r.rows[0]?.ok === true;
  }

  listTenantIds(): Promise<string[]> {
    return runWithTenantContext(this.pool, { tenantId: null, isPlatformAdmin: true }, async (client) => {
      const r = await client.query<{ id: string }>(`SELECT id FROM tenants ORDER BY id`);
      return r.rows.map((row) => row.id);
    });
  }

  async releaseExpiredBatch(tenantId: string, input: SweepBatchInput): Promise<SweepBatchResult> {
    const expired = await this.inTenant(tenantId, (client) => listExpiredAiReservations(client, { tenantId, ...input }));
    let released = 0;
    // One transaction per release, never one for the batch: a release holds
    // its reservation's advisory lock and then the counter row lock, as the
    // api's commit / release does. Taking a second reservation's lock while
    // still holding a counter row lock could deadlock against an api settle.
    for (const reservationId of expired) {
      const r = await this.inTenant(tenantId, (client) =>
        settleAiReservation(client, { tenantId, reservationId, outcome: "reservation_expired", entryId: newId() }),
      );
      if (r?.applied === true) released += 1;
    }
    return { listed: expired.length, released };
  }

  private inTenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, work);
  }
}

/** No-DB path (dev / CI without DATABASE_URL): nothing to sweep. */
export class NoOpReservationSweepRepository implements ReservationSweepRepository {
  isProvisioned(): Promise<boolean> {
    return Promise.resolve(false);
  }

  listTenantIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  releaseExpiredBatch(): Promise<SweepBatchResult> {
    return Promise.resolve({ listed: 0, released: 0 });
  }
}
