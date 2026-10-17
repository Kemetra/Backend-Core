/**
 * Persistence of the shift variance policy revisions (RT-387 on the RT-385
 * `0050_shift_variance_policy` schema).
 *
 * Every method takes the caller's tenant-scoped client (`runWithTenantContext`
 * on the NOBYPASSRLS domain pool): `cash_variance_policy_revisions` is FORCE
 * RLS with SELECT and INSERT tenant policies, so every statement is also
 * bounded by the tenant GUC. Each query also names the tenant explicitly.
 * Store scoping is not in RLS: the service resolves the store in the caller's
 * scope before any call here.
 *
 * Revisions are append-only: there is no UPDATE or DELETE here. Each scope's
 * history is one linear chain (`supersedes_revision_id`); the 0050 unique
 * indexes and chain guard are the backstop of the service's
 * `expectedRevisionId` check (`ConcurrentPolicyChangeError`).
 */
import type { PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";

import type { PolicyKind, PolicyRevision, PolicyScope } from "./policy-resolution";
import { renderPolicyValue, type PolicyValue } from "./policy-value";

/** Another publish of the same scope committed first (or the chain guard refused). → 409. */
export class ConcurrentPolicyChangeError extends Error {
  constructor() {
    super("the policy scope changed concurrently");
    this.name = "ConcurrentPolicyChangeError";
  }
}

/** A revision with its keyset key (`created_at` at microsecond precision, UTC). */
export interface StoredRevision extends PolicyRevision {
  readonly createdAtKey: string;
}

/** Which scope a statement addresses: the tenant default, or one store's override. */
export interface PolicyScopeRef {
  readonly tenantId: string;
  /** Null for the tenant scope. */
  readonly storeId: string | null;
}

/** The keyset position after which the next page starts. */
export interface RevisionKeyset {
  readonly createdAtKey: string;
  readonly id: string;
}

interface RevisionDbRow {
  id: string;
  scope: PolicyScope;
  store_id: string | null;
  kind: PolicyKind;
  mode: string | null;
  limit_amount: string | null;
  currency_code: string | null;
  reason: string;
  effective_until: Date | null;
  permanent: boolean;
  approved_by_user_id: string | null;
  supersedes_revision_id: string | null;
  created_by_user_id: string;
  created_at: Date;
  created_at_key: string;
}

const REVISION_COLUMNS = `
  id, scope, store_id, kind, mode, limit_amount::text AS limit_amount, currency_code, reason,
  effective_until, permanent, approved_by_user_id, supersedes_revision_id, created_by_user_id,
  created_at, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_key`;

/**
 * $1 tenant, $2 store (null = the tenant scope). Written per scope with plain
 * equality / IS NULL (never IS NOT DISTINCT FROM, which no B-tree can use), so
 * every read is an index range scan of `idx_cash_variance_policy_revisions_
 * scope_history (tenant_id, scope, store_id, created_at DESC, id DESC)`; the
 * tenant form still names $2 so both forms take the same parameters.
 */
function scopePredicate(scope: PolicyScopeRef): string {
  return scope.storeId === null
    ? `tenant_id = $1::uuid AND scope = 'tenant' AND store_id IS NULL AND $2::uuid IS NULL`
    : `tenant_id = $1::uuid AND scope = 'store' AND store_id = $2::uuid`;
}

function toRevision(row: RevisionDbRow): StoredRevision {
  return {
    id: row.id,
    scope: row.scope,
    storeId: row.store_id,
    kind: row.kind,
    value:
      row.kind === "clear" || row.mode === null
        ? null
        : renderPolicyValue({ mode: row.mode, limitAmount: row.limit_amount, currencyCode: row.currency_code }),
    reason: row.reason,
    createdAt: row.created_at,
    effectiveUntil: row.effective_until,
    permanent: row.permanent,
    approvedByUserId: row.approved_by_user_id,
    supersedesRevisionId: row.supersedes_revision_id,
    createdByUserId: row.created_by_user_id,
    createdAtKey: row.created_at_key,
  };
}

/** The values a publish appends; the server fills times, `permanent` and the approver. */
export interface NewRevision extends PolicyScopeRef {
  readonly kind: PolicyKind;
  readonly value: PolicyValue | null;
  readonly reason: string;
  /** RFC 3339 as sent, cast by Postgres (no JS Date rounding). */
  readonly effectiveUntil: string | null;
  readonly permanent: boolean;
  readonly supersedesRevisionId: string | null;
  readonly createdByUserId: string;
}

/** The publish-time facts computed on the database clock (the 0050 CHECKs use `now()`). */
export interface PublishClock {
  readonly now: Date;
  /** `effectiveUntil` is after the server time (or absent). */
  readonly untilAfterNow: boolean;
  /** A store `set` with no expiry, or one more than 2160 h after now (DR-4). */
  readonly beyondHorizon: boolean;
}

const CHAIN_INDEXES: ReadonlySet<string> = new Set([
  "uq_cash_variance_policy_revisions_tenant_first",
  "uq_cash_variance_policy_revisions_store_first",
  "uq_cash_variance_policy_revisions_supersedes",
]);

/**
 * True for a refusal that means "another publish of this scope won": a chain
 * unique index (23505), or the 0050 chain guard's "dated before the revision
 * it supersedes" (23514). Any other CHECK failure is a bug and stays a 500.
 */
function isChainRefusal(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown; message?: unknown };
  if (e.code === "23505") return typeof e.constraint === "string" && CHAIN_INDEXES.has(e.constraint);
  return e.code === "23514" && typeof e.message === "string" && e.message.includes("is dated before the revision it supersedes");
}

/** The value columns of a revision: mode, limit and currency (all null for a `clear`, the last two for `none`). */
function valueParams(value: PolicyValue | null): [string | null, string | null, string | null] {
  if (value === null) return [null, null, null];
  return value.mode === "limit" ? ["limit", value.limitAmount, value.currencyCode] : ["none", null, null];
}

/** $1-$14 of the revision INSERT. */
function insertParams(revision: NewRevision): unknown[] {
  return [
    newId(),
    revision.tenantId,
    revision.storeId === null ? "tenant" : "store",
    revision.storeId,
    revision.kind,
    ...valueParams(revision.value),
    revision.reason,
    revision.effectiveUntil,
    revision.permanent,
    revision.permanent ? revision.createdByUserId : null,
    revision.supersedesRevisionId,
    revision.createdByUserId,
  ];
}

export class PolicyRepository {
  /** The transaction's clock: `now()` is fixed for the whole transaction, as the 0050 CHECKs see it. */
  async now(client: PoolClient): Promise<Date> {
    const r = await client.query<{ now: Date }>(`SELECT now() AS now`);
    return r.rows[0]!.now;
  }

  /** The publish facts for `effectiveUntil` on the database clock. */
  async publishClock(client: PoolClient, effectiveUntil: string | null): Promise<PublishClock> {
    const r = await client.query<{ now: Date; until_after_now: boolean; beyond_horizon: boolean }>(
      `SELECT now() AS now,
              ($1::timestamptz IS NULL OR $1::timestamptz > now()) AS until_after_now,
              ($1::timestamptz IS NULL OR $1::timestamptz > now() + interval '2160 hours') AS beyond_horizon`,
      [effectiveUntil],
    );
    const row = r.rows[0]!;
    return { now: row.now, untilAfterNow: row.until_after_now, beyondHorizon: row.beyond_horizon };
  }

  /**
   * Serialises publishes of one scope until COMMIT (a transaction-level
   * advisory lock: no table lock, no grant beyond the session's own).
   */
  async lockScope(client: PoolClient, scope: PolicyScopeRef): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `cash_variance_policy:${scope.tenantId}:${scope.storeId ?? "tenant"}`,
    ]);
  }

  /** The scope's latest revision (newest by created_at, id), or null. */
  async latest(client: PoolClient, scope: PolicyScopeRef): Promise<StoredRevision | null> {
    const r = await client.query<RevisionDbRow>(
      `SELECT ${REVISION_COLUMNS}
         FROM cash_variance_policy_revisions
        WHERE ${scopePredicate(scope)}
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [scope.tenantId, scope.storeId],
    );
    const row = r.rows[0];
    return row === undefined ? null : toRevision(row);
  }

  /** The scope's revisions created at or before `until`, oldest first (historical resolution). */
  async history(client: PoolClient, scope: PolicyScopeRef, until: Date): Promise<StoredRevision[]> {
    const r = await client.query<RevisionDbRow>(
      `SELECT ${REVISION_COLUMNS}
         FROM cash_variance_policy_revisions
        WHERE ${scopePredicate(scope)}
          AND created_at <= $3::timestamptz
        ORDER BY created_at ASC, id ASC`,
      [scope.tenantId, scope.storeId, until],
    );
    return r.rows.map(toRevision);
  }

  /** One revision of the tenant by id, of any scope, or null. */
  async find(client: PoolClient, tenantId: string, revisionId: string): Promise<StoredRevision | null> {
    const r = await client.query<RevisionDbRow>(
      `SELECT ${REVISION_COLUMNS} FROM cash_variance_policy_revisions WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, revisionId],
    );
    const row = r.rows[0];
    return row === undefined ? null : toRevision(row);
  }

  /** One keyset page of the scope's revisions, newest first; `limit + 1` rows tell whether more follow. */
  async page(
    client: PoolClient,
    input: PolicyScopeRef & { readonly keyset: RevisionKeyset | null; readonly limit: number },
  ): Promise<StoredRevision[]> {
    const r = await client.query<RevisionDbRow>(
      `SELECT ${REVISION_COLUMNS}
         FROM cash_variance_policy_revisions
        WHERE ${scopePredicate(input)}
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $5`,
      [input.tenantId, input.storeId, input.keyset?.createdAtKey ?? null, input.keyset?.id ?? null, input.limit + 1],
    );
    return r.rows.map(toRevision);
  }

  /**
   * Appends a revision (Apply Now: `effective_from` = `created_at` = the
   * transaction's `now()`). A permanent revision names its publisher as the
   * approver. A chain refusal (another publish of the scope won) is
   * `ConcurrentPolicyChangeError`.
   */
  async insert(client: PoolClient, revision: NewRevision): Promise<StoredRevision> {
    const params = insertParams(revision);
    try {
      const r = await client.query<RevisionDbRow>(
        `INSERT INTO cash_variance_policy_revisions
           (id, tenant_id, scope, store_id, kind, mode, limit_amount, currency_code, reason,
            effective_until, permanent, approved_by_user_id, supersedes_revision_id, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10::timestamptz, $11, $12, $13, $14)
         RETURNING ${REVISION_COLUMNS}`,
        params,
      );
      return toRevision(r.rows[0]!);
    } catch (err) {
      if (isChainRefusal(err)) throw new ConcurrentPolicyChangeError();
      throw err;
    }
  }
}
