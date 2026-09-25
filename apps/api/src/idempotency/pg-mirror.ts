/**
 * Postgres mirror for idempotency keys (#614 / constitution §III).
 *
 * Redis stays the fast path. This writer is the durable copy, and the
 * claim insert is what turns a retry race into a unique-violation instead
 * of a second handler run. The UNIQUE (tenant_id, store_id, client_id, key)
 * index already exists (0000, NULLS NOT DISTINCT); no new migration.
 *
 * A claim row uses response_status 0 and a sentinel body. find() returns
 * it so the caller can answer 425 instead of replaying a placeholder.
 */
import { newId } from "@data-pulse-2/shared";
import type {
  IdempotencyEntry,
  PgMirrorReader,
  PgMirrorWriter,
  StoredResult,
} from "@data-pulse-2/shared";
import { IdempotencyMirrorConflict } from "@data-pulse-2/shared";
import { runWithTenantContext } from "@data-pulse-2/db/middleware/tenant-context";
import type { Pool, PoolClient } from "pg";

const CLAIM_BODY = JSON.stringify({ __dp2IdempotencyClaim: true });
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTenantUuid(value: string): boolean {
  return UUID_RE.test(value);
}

interface MirrorRow {
  tenantId: string;
  storeId: string | null;
  clientId: string;
  key: string;
  fingerprint: Buffer;
  expiresAt: Date;
}

export class PgIdempotencyMirror implements PgMirrorWriter, PgMirrorReader {
  constructor(private readonly pool: Pool) {}

  async claim(row: MirrorRow): Promise<void> {
    if (!isTenantUuid(row.tenantId)) return;
    await runWithTenantContext(
      this.pool,
      { tenantId: row.tenantId, isPlatformAdmin: false },
      async (client) => {
        const claimed = await client.query(
          `INSERT INTO idempotency_keys
             (id, tenant_id, store_id, client_id, key, request_hash,
              response_status, response_body, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, 0, $7::jsonb, $8)
           ON CONFLICT (tenant_id, store_id, client_id, key)
           DO UPDATE SET
             request_hash = EXCLUDED.request_hash,
             response_status = 0,
             response_body = EXCLUDED.response_body,
             expires_at = EXCLUDED.expires_at
           WHERE idempotency_keys.expires_at <= now()
           RETURNING id`,
          [
            newId(),
            row.tenantId,
            row.storeId,
            row.clientId,
            row.key,
            row.fingerprint,
            CLAIM_BODY,
            row.expiresAt,
          ],
        );
        if ((claimed.rowCount ?? 0) === 0) throw new IdempotencyMirrorConflict();
      },
    );
  }

  async release(row: {
    tenantId: string;
    storeId: string | null;
    clientId: string;
    key: string;
  }): Promise<void> {
    if (!isTenantUuid(row.tenantId)) return;
    await runWithTenantContext(
      this.pool,
      { tenantId: row.tenantId, isPlatformAdmin: false },
      async (client) => {
        await client.query(
          `DELETE FROM idempotency_keys
            WHERE tenant_id = $1 AND client_id = $2 AND key = $3
              AND store_id IS NOT DISTINCT FROM $4
              AND response_status = 0`,
          [row.tenantId, row.clientId, row.key, row.storeId],
        );
      },
    );
  }

  async insert(row: MirrorRow & { result: StoredResult }): Promise<void> {
    if (!isTenantUuid(row.tenantId)) return;
    await runWithTenantContext(
      this.pool,
      { tenantId: row.tenantId, isPlatformAdmin: false },
      async (client) => {
        const updated = await client.query(
          `UPDATE idempotency_keys
              SET response_status = $1,
                  response_body = $2::jsonb,
                  request_hash = $3,
                  expires_at = $4
            WHERE tenant_id = $5
              AND client_id = $6
              AND key = $7
              AND store_id IS NOT DISTINCT FROM $8
              AND response_status = 0`,
          [
            row.result.status,
            JSON.stringify(row.result.body ?? null),
            row.fingerprint,
            row.expiresAt,
            row.tenantId,
            row.clientId,
            row.key,
            row.storeId,
          ],
        );
        if ((updated.rowCount ?? 0) > 0) return;
        const inserted = await insertCompleted(client, row);
        if (inserted) return;
        const existing = await client.query<{ request_hash: Buffer }>(
          `SELECT request_hash FROM idempotency_keys
            WHERE tenant_id = $1 AND client_id = $2 AND key = $3
              AND store_id IS NOT DISTINCT FROM $4`,
          [row.tenantId, row.clientId, row.key, row.storeId],
        );
        const stored = existing.rows[0]?.request_hash;
        if (stored && stored.equals(row.fingerprint)) return;
        throw new Error("idempotency completion conflict");
      },
    );
  }

  async find(params: {
    tenantId: string;
    storeId: string | null;
    clientId: string;
    key: string;
  }): Promise<IdempotencyEntry | null> {
    if (!isTenantUuid(params.tenantId)) return null;
    return runWithTenantContext(
      this.pool,
      { tenantId: params.tenantId, isPlatformAdmin: false },
      async (client) => {
        const result = await client.query<{
          request_hash: Buffer;
          response_status: number;
          response_body: unknown;
          expires_at: Date;
        }>(
          `SELECT request_hash, response_status, response_body, expires_at
             FROM idempotency_keys
            WHERE tenant_id = $1
              AND client_id = $2
              AND key = $3
              AND store_id IS NOT DISTINCT FROM $4
            LIMIT 1`,
          [params.tenantId, params.clientId, params.key, params.storeId],
        );
        const found = result.rows[0];
        if (!found) return null;
        return {
          fingerprint: found.request_hash,
          result: { status: found.response_status, body: found.response_body },
          expiresAt: found.expires_at,
        };
      },
    );
  }
}

async function insertCompleted(
  client: PoolClient,
  row: MirrorRow & { result: StoredResult },
): Promise<boolean> {
  const inserted = await client.query(
    `INSERT INTO idempotency_keys
       (id, tenant_id, store_id, client_id, key, request_hash,
        response_status, response_body, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (tenant_id, store_id, client_id, key) DO NOTHING`,
    [
      newId(),
      row.tenantId,
      row.storeId,
      row.clientId,
      row.key,
      row.fingerprint,
      row.result.status,
      JSON.stringify(row.result.body ?? null),
      row.expiresAt,
    ],
  );
  return (inserted.rowCount ?? 0) > 0;
}
