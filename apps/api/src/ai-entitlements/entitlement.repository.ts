/**
 * Reads and writes of the AI plan catalogue, the tenant entitlement revisions
 * and the owner opt-outs (migration 0055, RT-663) — RT-664.
 *
 * Every method takes the caller's `runWithTenantContext` client on the
 * NOBYPASSRLS domain pool. The catalogue is readable by every role; the
 * tenant tables are FORCE RLS to `app.current_tenant`, and each query also
 * names the tenant. A revision INSERT additionally needs
 * `app.is_platform_admin = 'true'` (0055: no tenant self-grant, T18).
 *
 * Both tenant chains are linear: version N names base N-1 (NULL for 1). Two
 * writers on one base collide on the version UNIQUE (23505), which surfaces
 * as `ChainConflictError` and is never merged.
 */
import type { PoolClient } from "pg";

import type { CatalogMeter, EntitlementOverride, EntitlementRevision, OptOutState } from "./entitlement-resolution";
import type { AiEntitlementState } from "./entitlement.types";

/** Another write of the same chain committed first (23505 on the version UNIQUE). */
export class ChainConflictError extends Error {
  constructor() {
    super("the chain changed concurrently");
    this.name = "ChainConflictError";
  }
}

const CHAIN_CONSTRAINTS: ReadonlySet<string> = new Set([
  "uq_tenant_ai_entitlements_version",
  "uq_tenant_ai_feature_opt_outs_version",
]);

function isChainConflict(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === "23505" && typeof e.constraint === "string" && CHAIN_CONSTRAINTS.has(e.constraint);
}

interface OverrideJson {
  feature_id: string;
  action: "enable" | "disable";
  meter?: string;
  meter_limit_delta?: number;
  expires_at?: string;
  reason: string;
}

interface RevisionRow {
  entitlement_version: number;
  state: AiEntitlementState;
  plan_code: string | null;
  catalog_version: number | null;
  effective_from: Date;
  effective_until: Date | null;
  overrides: OverrideJson[];
}

function toOverride(o: OverrideJson): EntitlementOverride {
  return {
    featureId: o.feature_id,
    action: o.action,
    reason: o.reason,
    ...(o.meter === undefined ? {} : { meter: o.meter }),
    ...(o.meter_limit_delta === undefined ? {} : { meterLimitDelta: o.meter_limit_delta }),
    ...(o.expires_at === undefined ? {} : { expiresAt: new Date(o.expires_at) }),
  };
}

function toRevision(row: RevisionRow): EntitlementRevision {
  return {
    version: row.entitlement_version,
    state: row.state,
    planCode: row.plan_code,
    catalogVersion: row.catalog_version,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    overrides: row.overrides.map(toOverride),
  };
}

/** The owner opt-out source: its tenant-wide head version and each feature's latest state. */
export interface OptOutSource {
  readonly version: number;
  readonly byFeature: ReadonlyMap<string, OptOutState>;
}

export const NO_OPT_OUT: OptOutState = { optedOut: false, changedAt: null };

export interface NewRevision {
  readonly id: string;
  readonly tenantId: string;
  readonly version: number;
  readonly state: AiEntitlementState;
  readonly planCode: string | null;
  readonly catalogVersion: number | null;
  /** RFC 3339, or null for the transaction's now(). */
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly overrides: readonly OverrideJson[];
  readonly reason: string;
  readonly createdByUserId: string;
  readonly contentHash: Buffer;
}

export interface NewOptOut {
  readonly id: string;
  readonly tenantId: string;
  readonly version: number;
  readonly featureId: string;
  readonly optedOut: boolean;
  readonly reason: string;
  readonly createdByUserId: string;
}

export type { OverrideJson };

export class EntitlementRepository {
  /** The transaction's clock (`now()` is fixed per transaction). */
  async now(client: PoolClient): Promise<Date> {
    const r = await client.query<{ now: Date }>(`SELECT now() AS now`);
    return r.rows[0]!.now;
  }

  /** Layer 1: `active` and not deleted. A tenant the context cannot see is inactive. */
  async tenantActive(client: PoolClient, tenantId: string): Promise<boolean> {
    const r = await client.query<{ ok: boolean }>(
      `SELECT (status = 'active' AND deleted_at IS NULL) AS ok FROM tenants WHERE id = $1::uuid`,
      [tenantId],
    );
    return r.rows[0]?.ok === true;
  }

  /** Layer 4: every target store is a live store of the tenant (another tenant's store is invisible under RLS). */
  async storesLive(client: PoolClient, tenantId: string, storeIds: readonly string[]): Promise<boolean> {
    if (storeIds.length === 0) return true;
    const r = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM stores WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [tenantId, [...storeIds]],
    );
    return r.rows[0]?.n === storeIds.length;
  }

  /** The newest revision already in effect (`effective_from <= now()`), or null. */
  async effectiveRevision(client: PoolClient, tenantId: string): Promise<EntitlementRevision | null> {
    const r = await client.query<RevisionRow>(
      `SELECT entitlement_version, state, plan_code, catalog_version, effective_from, effective_until, overrides
         FROM tenant_ai_entitlements
        WHERE tenant_id = $1::uuid AND effective_from <= now()
        ORDER BY entitlement_version DESC
        LIMIT 1`,
      [tenantId],
    );
    const row = r.rows[0];
    return row === undefined ? null : toRevision(row);
  }

  /** The chain head (0 when the tenant has no revision). */
  async headVersion(client: PoolClient, tenantId: string): Promise<number> {
    const r = await client.query<{ v: number | null }>(
      `SELECT max(entitlement_version) AS v FROM tenant_ai_entitlements WHERE tenant_id = $1::uuid`,
      [tenantId],
    );
    return r.rows[0]?.v ?? 0;
  }

  async optOuts(client: PoolClient, tenantId: string): Promise<OptOutSource> {
    const r = await client.query<{ feature_id: string; action: string; created_at: Date; head: number }>(
      `SELECT DISTINCT ON (feature_id) feature_id, action, created_at,
              max(opt_out_version) OVER () AS head
         FROM tenant_ai_feature_opt_outs
        WHERE tenant_id = $1::uuid
        ORDER BY feature_id, opt_out_version DESC`,
      [tenantId],
    );
    const byFeature = new Map<string, OptOutState>();
    for (const row of r.rows) byFeature.set(row.feature_id, { optedOut: row.action === "opt_out", changedAt: row.created_at });
    return { version: r.rows[0]?.head ?? 0, byFeature };
  }

  /** featureId → meters for one plan version (a feature with no meter maps to []). */
  async planFeatures(client: PoolClient, planCode: string, catalogVersion: number): Promise<Map<string, CatalogMeter[]>> {
    const r = await client.query<{
      feature_id: string;
      meter: string | null;
      window_kind: "day" | "month" | null;
      meter_scope: "tenant" | "store" | null;
      limit_value: string | null;
    }>(
      `SELECT f.feature_id, m.meter, m.window_kind, m.meter_scope, m.limit_value::text AS limit_value
         FROM ai_plan_catalog_features f
         LEFT JOIN ai_plan_catalog_meters m
           ON m.plan_code = f.plan_code AND m.catalog_version = f.catalog_version AND m.feature_id = f.feature_id
        WHERE f.plan_code = $1 AND f.catalog_version = $2
        ORDER BY f.feature_id, m.meter`,
      [planCode, catalogVersion],
    );
    const features = new Map<string, CatalogMeter[]>();
    for (const row of r.rows) {
      const meters = features.get(row.feature_id) ?? [];
      if (row.meter !== null && row.window_kind !== null && row.meter_scope !== null && row.limit_value !== null) {
        meters.push({ meter: row.meter, unit: "request", window: row.window_kind, scope: row.meter_scope, limit: Number(row.limit_value) });
      }
      features.set(row.feature_id, meters);
    }
    return features;
  }

  /** The plan features of a revision (none for no revision or state `none`). */
  async planFeaturesOf(client: PoolClient, revision: EntitlementRevision | null): Promise<Map<string, CatalogMeter[]>> {
    if (revision === null || revision.planCode === null || revision.catalogVersion === null) return new Map();
    return this.planFeatures(client, revision.planCode, revision.catalogVersion);
  }

  /** Every feature any catalogue version knows, ordered (the view's feature list; unknown ids are denied). */
  async knownFeatures(client: PoolClient): Promise<string[]> {
    const r = await client.query<{ feature_id: string }>(
      `SELECT DISTINCT feature_id FROM ai_plan_catalog_features ORDER BY feature_id`,
    );
    return r.rows.map((row) => row.feature_id);
  }

  async catalogVersionExists(client: PoolClient, planCode: string, catalogVersion: number): Promise<boolean> {
    const r = await client.query(`SELECT 1 FROM ai_plan_catalog WHERE plan_code = $1 AND catalog_version = $2`, [
      planCode,
      catalogVersion,
    ]);
    return r.rows.length > 0;
  }

  /** Serialises one tenant chain's writers until COMMIT. */
  async lockChain(client: PoolClient, chain: "entitlement" | "opt_out", tenantId: string): Promise<void> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`ai_${chain}_chain:${tenantId}`]);
  }

  async insertRevision(client: PoolClient, rev: NewRevision): Promise<{ effectiveFrom: Date }> {
    try {
      const r = await client.query<{ effective_from: Date }>(
        `INSERT INTO tenant_ai_entitlements
           (id, tenant_id, entitlement_version, base_version, plan_code, catalog_version, state,
            effective_from, effective_until, overrides, source, reason, created_by_user_id, content_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()), $9::timestamptz, $10::jsonb,
                 'manual_platform', $11, $12, $13)
         RETURNING effective_from`,
        [
          rev.id,
          rev.tenantId,
          rev.version,
          rev.version === 1 ? null : rev.version - 1,
          rev.planCode,
          rev.catalogVersion,
          rev.state,
          rev.effectiveFrom,
          rev.effectiveUntil,
          JSON.stringify(rev.overrides),
          rev.reason,
          rev.createdByUserId,
          rev.contentHash,
        ],
      );
      return { effectiveFrom: r.rows[0]!.effective_from };
    } catch (err) {
      if (isChainConflict(err)) throw new ChainConflictError();
      throw err;
    }
  }

  async insertOptOut(client: PoolClient, row: NewOptOut): Promise<void> {
    try {
      await client.query(
        `INSERT INTO tenant_ai_feature_opt_outs
           (id, tenant_id, opt_out_version, base_version, feature_id, action, reason, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          row.id,
          row.tenantId,
          row.version,
          row.version === 1 ? null : row.version - 1,
          row.featureId,
          row.optedOut ? "opt_out" : "opt_in",
          row.reason,
          row.createdByUserId,
        ],
      );
    } catch (err) {
      if (isChainConflict(err)) throw new ChainConflictError();
      throw err;
    }
  }
}
