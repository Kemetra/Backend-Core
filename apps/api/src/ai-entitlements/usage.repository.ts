/**
 * The Option A usage counters and the append-only usage ledger (0055,
 * AD-AI-ENT-001 D-3) — RT-664. Terminal writes (commit / release) are the
 * shared `settleAiReservation` helper in `@data-pulse-2/db`, which the worker
 * sweeper also uses.
 *
 * Reserve: the counter row of (tenant, store?, meter, UTC window) is created
 * on first use (`ON CONFLICT DO NOTHING`), then reserved with ONE conditional
 * UPDATE (`used + reserved + n <= limit`). The UPDATE takes the row lock and
 * re-checks the predicate against the latest committed row, so concurrent
 * reservations at the limit admit exactly the units that fit (T3). The limit
 * is the effective entitlement's, passed in: 0055 does not store it, so a
 * downgrade needs no counter rewrite.
 *
 * Serialisation is by transaction-scoped advisory locks (no table lock, no
 * extra grant): a reservation key, and a committed entry for adjustments. A
 * `SELECT … FOR UPDATE` on the ledger cannot work: the runtime role has no
 * UPDATE privilege on it and it has no UPDATE policy.
 *
 * Windows are UTC (D-9): `date_trunc(kind, now() AT TIME ZONE 'UTC')`.
 */
import type { PoolClient } from "pg";

import type { MeterWindow } from "./entitlement.types";

export interface CounterRef {
  readonly tenantId: string;
  /** Null for a tenant meter. */
  readonly storeId: string | null;
  readonly meter: string;
  readonly window: MeterWindow;
}

export interface CounterState {
  readonly id: string | null;
  readonly used: number;
  readonly reserved: number;
  readonly resetsAt: Date;
}

export interface ReservedEntry {
  readonly id: string;
  readonly counterId: string;
  readonly units: number;
  readonly storeId: string | null;
  readonly entitlementVersion: number;
  readonly optOutVersion: number | null;
  /** The user who took it. */
  readonly actorUserId: string | null;
  /** True while no commit or release closed it. */
  readonly open: boolean;
}

export interface NewReservation {
  readonly id: string;
  readonly tenantId: string;
  readonly featureId: string;
  readonly counterId: string;
  readonly units: number;
  readonly entitlementVersion: number;
  readonly optOutVersion: number | null;
  readonly idempotencyKey: string;
  readonly ttlSeconds: number;
  readonly actorUserId: string | null;
  readonly requestId: string | null;
}

export interface CommittedEntry {
  readonly id: string;
  readonly featureId: string;
  readonly counterId: string;
  readonly units: number;
  readonly entitlementVersion: number;
}

export interface NewAdjustment {
  readonly id: string;
  readonly tenantId: string;
  readonly committed: CommittedEntry;
  readonly units: number;
  readonly idempotencyKey: string;
  readonly actorUserId: string;
  readonly reason: string;
  readonly requestId: string | null;
}

const WINDOW_START = `(date_trunc($4::text, now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;
/**
 * The next UTC boundary. The day / month arithmetic runs on the UTC
 * `timestamp`, never on the `timestamptz`, whose interval arithmetic follows
 * the session TimeZone (a month added in America/New_York would end a day early).
 */
const WINDOW_RESET = `((date_trunc($4::text, now() AT TIME ZONE 'UTC') + ('1 ' || $4::text)::interval) AT TIME ZONE 'UTC')`;

/** $1 tenant, $2 store (null = tenant meter), $3 meter, $4 window. Plain equality / IS NULL keeps the UNIQUE index usable. */
function counterPredicate(ref: CounterRef): string {
  const store = ref.storeId === null ? `store_id IS NULL AND $2::uuid IS NULL` : `store_id = $2::uuid`;
  return `tenant_id = $1::uuid AND ${store} AND meter = $3 AND window_kind = $4 AND window_start = ${WINDOW_START}`;
}

function counterParams(ref: CounterRef): unknown[] {
  return [ref.tenantId, ref.storeId, ref.meter, ref.window];
}

async function lock(client: PoolClient, name: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [name]);
}

export class UsageRepository {
  /** Serialises every reservation attempt of one (tenant, feature, key). */
  lockReservationKey(client: PoolClient, tenantId: string, featureId: string, key: string): Promise<void> {
    return lock(client, `ai_usage_reserve:${tenantId}:${featureId}:${key}`);
  }

  /** Serialises every adjustment of one committed entry (the cap is checked under it). */
  lockCommittedEntry(client: PoolClient, entryId: string): Promise<void> {
    return lock(client, `ai_usage_adjust:${entryId}`);
  }

  /** The reservation a key already took, with its store and whether it is still open. */
  async findReservation(client: PoolClient, tenantId: string, featureId: string, key: string): Promise<ReservedEntry | null> {
    const r = await client.query<{
      id: string;
      counter_id: string;
      units: number;
      store_id: string | null;
      entitlement_version: number;
      opt_out_version: number | null;
      actor_user_id: string | null;
      open: boolean;
    }>(
      `SELECT l.id, l.counter_id, l.units, c.store_id, l.entitlement_version, l.opt_out_version, l.actor_user_id,
              NOT EXISTS (SELECT 1 FROM ai_usage_ledger t
                           WHERE t.reservation_id = l.id AND t.entry_kind IN ('committed', 'released')) AS open
         FROM ai_usage_ledger l
         JOIN ai_usage_counters c ON c.id = l.counter_id AND c.tenant_id = l.tenant_id
        WHERE l.tenant_id = $1::uuid AND l.feature_id = $2 AND l.entry_kind = 'reserved' AND l.idempotency_key = $3`,
      [tenantId, featureId, key],
    );
    const row = r.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      counterId: row.counter_id,
      units: row.units,
      storeId: row.store_id,
      entitlementVersion: row.entitlement_version,
      optOutVersion: row.opt_out_version,
      actorUserId: row.actor_user_id,
      open: row.open,
    };
  }

  /** The current window's counter (zeros when it has no row yet) and its UTC reset. */
  async counter(client: PoolClient, ref: CounterRef): Promise<CounterState> {
    const r = await client.query<{ id: string | null; used: string; reserved: string; resets_at: Date }>(
      `SELECT c.id, COALESCE(c.used, 0)::text AS used, COALESCE(c.reserved, 0)::text AS reserved,
              ${WINDOW_RESET} AS resets_at
         FROM (SELECT 1) one
         LEFT JOIN ai_usage_counters c ON ${counterPredicate(ref)}`,
      counterParams(ref),
    );
    const row = r.rows[0]!;
    return { id: row.id, used: Number(row.used), reserved: Number(row.reserved), resetsAt: row.resets_at };
  }

  /** Ensure the window's counter row exists (concurrent first uses converge on one row). */
  async ensureCounter(client: PoolClient, ref: CounterRef, newId: string): Promise<void> {
    await client.query(
      `INSERT INTO ai_usage_counters (id, tenant_id, store_id, meter, window_kind, window_start)
       VALUES ($5, $1, $2, $3, $4, ${WINDOW_START})
       ON CONFLICT ON CONSTRAINT uq_ai_usage_counters_window DO NOTHING`,
      [...counterParams(ref), newId],
    );
  }

  /** The conditional reserve; null when `used + reserved + units` would exceed `limit`. */
  async tryReserve(client: PoolClient, ref: CounterRef, units: number, limit: number): Promise<string | null> {
    const r = await client.query<{ id: string }>(
      `UPDATE ai_usage_counters
          SET reserved = reserved + $5
        WHERE ${counterPredicate(ref)}
          AND used + reserved + $5 <= $6
        RETURNING id`,
      [...counterParams(ref), units, limit],
    );
    return r.rows[0]?.id ?? null;
  }

  async insertReservation(client: PoolClient, row: NewReservation): Promise<void> {
    await client.query(
      `INSERT INTO ai_usage_ledger
         (id, tenant_id, reservation_id, entry_kind, feature_id, counter_id, units, entitlement_version,
          opt_out_version, idempotency_key, expires_at, actor_user_id, request_id)
       VALUES ($1, $2, $1, 'reserved', $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9), $10, $11)`,
      [
        row.id,
        row.tenantId,
        row.featureId,
        row.counterId,
        row.units,
        row.entitlementVersion,
        row.optOutVersion,
        row.idempotencyKey,
        row.ttlSeconds,
        row.actorUserId,
        row.requestId,
      ],
    );
  }

  async findCommitted(client: PoolClient, tenantId: string, entryId: string): Promise<CommittedEntry | null> {
    const r = await client.query<{ id: string; feature_id: string; counter_id: string; units: number; entitlement_version: number }>(
      `SELECT id, feature_id, counter_id, units, entitlement_version
         FROM ai_usage_ledger WHERE id = $1::uuid AND tenant_id = $2::uuid AND entry_kind = 'committed'`,
      [entryId, tenantId],
    );
    const row = r.rows[0];
    return row === undefined
      ? null
      : { id: row.id, featureId: row.feature_id, counterId: row.counter_id, units: row.units, entitlementVersion: row.entitlement_version };
  }

  async findAdjustmentByKey(
    client: PoolClient,
    tenantId: string,
    featureId: string,
    key: string,
  ): Promise<{ id: string; adjustsEntryId: string; units: number; reason: string } | null> {
    const r = await client.query<{ id: string; adjusts_entry_id: string; units: number; adjustment_reason: string }>(
      `SELECT id, adjusts_entry_id, units, adjustment_reason FROM ai_usage_ledger
        WHERE tenant_id = $1::uuid AND feature_id = $2 AND entry_kind = 'adjusted' AND idempotency_key = $3`,
      [tenantId, featureId, key],
    );
    const row = r.rows[0];
    return row === undefined ? null : { id: row.id, adjustsEntryId: row.adjusts_entry_id, units: row.units, reason: row.adjustment_reason };
  }

  async adjustedUnits(client: PoolClient, tenantId: string, entryId: string): Promise<number> {
    const r = await client.query<{ n: string }>(
      `SELECT COALESCE(sum(units), 0)::text AS n FROM ai_usage_ledger
        WHERE adjusts_entry_id = $1::uuid AND tenant_id = $2::uuid AND entry_kind = 'adjusted'`,
      [entryId, tenantId],
    );
    return Number(r.rows[0]!.n);
  }

  /** The compensating row, and the credit on the committed entry's counter (`used` only ever drops here). */
  async insertAdjustment(client: PoolClient, row: NewAdjustment): Promise<void> {
    await client.query(
      `INSERT INTO ai_usage_ledger
         (id, tenant_id, reservation_id, entry_kind, feature_id, counter_id, units, entitlement_version,
          idempotency_key, actor_user_id, request_id, adjusts_entry_id, adjustment_reason)
       VALUES ($1, $2, $1, 'adjusted', $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        row.id,
        row.tenantId,
        row.committed.featureId,
        row.committed.counterId,
        row.units,
        row.committed.entitlementVersion,
        row.idempotencyKey,
        row.actorUserId,
        row.requestId,
        row.committed.id,
        row.reason,
      ],
    );
    const r = await client.query(
      `UPDATE ai_usage_counters SET used = used - $3 WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [row.committed.counterId, row.tenantId, row.units],
    );
    if (r.rowCount !== 1) throw new Error("ai usage counter of the committed entry is not visible");
  }
}
