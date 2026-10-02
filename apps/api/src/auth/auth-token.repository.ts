/**
 * AuthTokenRepository — Postgres source of truth for opaque bearer tokens.
 *
 * `auth_tokens` is tenant-scoped (RLS-enabled, `tenant_id` nullable for
 * platform tokens). Callers who need RLS-aware lookups (i.e., from request
 * context) should pass a `PoolClient` obtained via `runWithTenantContext`;
 * callers who legitimately need platform scope (issuing or admin paths)
 * use the admin pool directly.
 *
 * The repository hashes the raw token internally so callers never pass a
 * raw secret as a SQL parameter.
 */
import { Injectable } from "@nestjs/common";
import {
  type AuthTokenRow,
  authTokens,
  type NewAuthTokenRow,
} from "@data-pulse-2/db/schema";
import { hashToken } from "@data-pulse-2/auth";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";

type DrizzleClient = NodePgDatabase;

function db(client: Pool | PoolClient): DrizzleClient {
  return drizzle(client as Pool);
}

@Injectable()
export class AuthTokenRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Issue a new auth token. The caller supplies the raw token (use
   * `generateRawToken()` from `@data-pulse-2/auth`) and the row metadata;
   * we hash it here and write the hash to `token_hash`.
   *
   * Issuance bypasses RLS — it runs on the admin pool by default. Pass
   * `client` when you want issuance to happen inside an existing tenant
   * context (uncommon but possible).
   */
  async issue(
    rawToken: string,
    input: Omit<NewAuthTokenRow, "tokenHash">,
    client?: PoolClient,
  ): Promise<AuthTokenRow> {
    const target = client ?? this.pool;
    const tokenHash = hashToken(rawToken);
    const [row] = await db(target)
      .insert(authTokens)
      .values({ ...input, tokenHash })
      .returning();
    if (!row) {
      throw new Error("AuthTokenRepository.issue: insert returned no row");
    }
    return row;
  }

  /**
   * Look up an active token by its raw form. Returns null when the hash
   * isn't found, the row is revoked, or the row is past `expires_at`.
   *
   * Pass a `client` from `runWithTenantContext` to apply tenant RLS;
   * otherwise queries against the admin pool see all rows (only
   * appropriate for platform-admin paths).
   */
  async findActiveByRawToken(
    rawToken: string,
    client?: PoolClient,
  ): Promise<AuthTokenRow | null> {
    const target = client ?? this.pool;
    const tokenHash = hashToken(rawToken);
    const rows = await db(target)
      .select()
      .from(authTokens)
      .where(
        and(
          eq(authTokens.tokenHash, tokenHash),
          isNull(authTokens.revokedAt),
          gt(authTokens.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * 018-US4 — resolve an active CONNECTOR credential to its registration
   * context by token id. Returns the linked registration only when the FULL
   * usability rule holds (FR-015): the token is connector-scoped, unrevoked,
   * unexpired, LINKED to a registration, the registration's tenant matches the
   * token's tenant, and the registration is NOT disabled. Returns null on any
   * failure — the caller (ConnectorAuthGuard) maps null to a single
   * non-disclosing 401 (FR-016). Runs on the admin pool (the guard has no tenant
   * GUC yet — that is exactly what this resolves). Connector-only: does NOT
   * touch the generic dashboard/POS lookup paths (FR-019).
   */
  async findActiveConnectorCredentialByTokenId(
    tokenId: string,
    client?: PoolClient,
  ): Promise<{ registrationId: string; tenantId: string; environment: string } | null> {
    const target = client ?? this.pool;
    const result = await db(target).execute(sql`
      SELECT cr.id AS registration_id, cr.tenant_id, cr.environment
        FROM auth_tokens t
        JOIN connector_registration cr
          ON cr.id = t.connector_registration_id
         AND cr.tenant_id = t.tenant_id
         AND cr.disabled_at IS NULL
       WHERE t.id = ${tokenId}
         AND t.scope = 'connector'
         AND t.revoked_at IS NULL
         AND t.expires_at > now()
       LIMIT 1
    `);
    const rows = result.rows as Array<{
      registration_id: string;
      tenant_id: string;
      environment: string;
    }>;
    const r = rows[0];
    if (!r) return null;
    return { registrationId: r.registration_id, tenantId: r.tenant_id, environment: r.environment };
  }

  /**
   * Atomically consume a one-time token (RT-146): revoke it and return its
   * row in a single `UPDATE … RETURNING`, but only while it is unrevoked,
   * unexpired and of `scope`. Concurrent consumers of the same token
   * serialize on the row lock and only the first sees a row; the rest (and
   * any later replay) get null. A token of another scope is left untouched.
   */
  async consumeActiveByRawToken(
    rawToken: string,
    scope: string,
    client?: PoolClient,
  ): Promise<AuthTokenRow | null> {
    const target = client ?? this.pool;
    const tokenHash = hashToken(rawToken);
    const rows = await db(target)
      .update(authTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(authTokens.tokenHash, tokenHash),
          eq(authTokens.scope, scope),
          isNull(authTokens.revokedAt),
          gt(authTokens.expiresAt, sql`now()`),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  /**
   * Revoke a token by id. Idempotent: returns true on first revoke and
   * false on subsequent calls (the row's `revoked_at` is already set).
   */
  async revoke(id: string, client?: PoolClient): Promise<boolean> {
    const target = client ?? this.pool;
    const result = await db(target)
      .update(authTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(authTokens.id, id), isNull(authTokens.revokedAt)));
    return (result.rowCount ?? 0) > 0;
  }
}
