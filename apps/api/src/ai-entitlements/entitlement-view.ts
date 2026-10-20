/**
 * The tenant AI entitlement views of `consoleGetTenantAiEntitlements` (D-6)
 * and the body every opt-out write answers with — RT-664.
 *
 * A feature is `available` when layers 0 (the kill switch) and 6 (the
 * effective entitlement and the owner opt-out) allow it at `evaluatedAt`.
 * The read reserves nothing. The tenant-facing reason is one of
 * `not_entitled`, `trial_expired`, `grace_read_only` and
 * `feature_disabled_tenant`; the kill switch shows as `null` ("temporarily
 * unavailable"). Meter exhaustion never makes a feature unavailable here.
 * No view carries a price, plan name, token cost, spend cap or credit.
 */
import type { PoolClient } from "pg";

import { resolveFeature, type CatalogMeter, type EntitlementRevision } from "./entitlement-resolution";
import { EntitlementRepository, NO_OPT_OUT, type OptOutSource } from "./entitlement.repository";
import type { AiEntitlementState, EntitlementDenyReason } from "./entitlement.types";
import { UsageRepository } from "./usage.repository";

export interface RequestMeterBody {
  readonly meter: string;
  readonly unit: "request";
  readonly window: "day" | "month";
  readonly storeRef: string | null;
  readonly limit: number;
  readonly used: number;
  readonly reserved: number;
  readonly remaining: number;
  readonly resetsAt: string;
}

export interface FeatureEntitlementBody {
  readonly featureId: string;
  readonly availability: "available" | "unavailable";
  readonly unavailableReason: EntitlementDenyReason | null;
  readonly entitled: boolean;
  readonly optOut: { readonly optedOut: boolean; readonly changedAt: string | null };
  readonly meters: readonly RequestMeterBody[];
}

export interface FullViewBody {
  readonly view: "full";
  readonly entitlementVersion: number;
  readonly optOutVersion: number;
  readonly state: AiEntitlementState;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly evaluatedAt: string;
  readonly features: readonly FeatureEntitlementBody[];
}

export interface MinimalViewBody {
  readonly view: "minimal";
  readonly evaluatedAt: string;
  readonly features: ReadonlyArray<{ readonly featureId: string; readonly availability: "available" | "unavailable" }>;
}

/** The facts one evaluation reads, all in one transaction. */
export interface TenantEntitlementSnapshot {
  readonly now: Date;
  readonly revision: EntitlementRevision | null;
  readonly optOuts: OptOutSource;
  readonly knownFeatures: readonly string[];
  readonly planFeatures: ReadonlyMap<string, readonly CatalogMeter[]>;
}

/** Where a feature's meters are read: the tenant, its live stores, the transaction. */
interface MeterScopeInput {
  readonly client: PoolClient;
  readonly tenantId: string;
  readonly stores: readonly string[];
}

/** The revision facts of the full view; state `none` has no effective dates. */
function revisionFacts(snap: TenantEntitlementSnapshot): Omit<FullViewBody, "view" | "evaluatedAt" | "features"> {
  const revision = snap.revision;
  const facts = { entitlementVersion: revision?.version ?? 0, optOutVersion: snap.optOuts.version };
  if (revision === null || revision.state === "none") {
    return { ...facts, state: "none", effectiveFrom: null, effectiveUntil: null };
  }
  return {
    ...facts,
    state: revision.state,
    effectiveFrom: revision.effectiveFrom.toISOString(),
    effectiveUntil: revision.effectiveUntil?.toISOString() ?? null,
  };
}

export class EntitlementViewBuilder {
  constructor(
    private readonly entitlements: EntitlementRepository = new EntitlementRepository(),
    private readonly usage: UsageRepository = new UsageRepository(),
  ) {}

  async snapshot(client: PoolClient, tenantId: string): Promise<TenantEntitlementSnapshot> {
    const revision = await this.entitlements.effectiveRevision(client, tenantId);
    const planFeatures = await this.entitlements.planFeaturesOf(client, revision);
    return {
      now: await this.entitlements.now(client),
      revision,
      optOuts: await this.entitlements.optOuts(client, tenantId),
      knownFeatures: await this.entitlements.knownFeatures(client),
      planFeatures,
    };
  }

  /** Entitled under the plan (before the opt-out): the D-5 opt-in ceiling. */
  entitled(snap: TenantEntitlementSnapshot, featureId: string): boolean {
    return this.resolve(snap, featureId).entitled;
  }

  async full(client: PoolClient, tenantId: string, snap: TenantEntitlementSnapshot, systemEnabled: boolean): Promise<FullViewBody> {
    const scope: MeterScopeInput = { client, tenantId, stores: await this.liveStores(client, tenantId) };
    const features: FeatureEntitlementBody[] = [];
    for (const featureId of snap.knownFeatures) {
      features.push(await this.featureBody(snap, featureId, { scope, systemEnabled }));
    }
    return { view: "full", ...revisionFacts(snap), evaluatedAt: snap.now.toISOString(), features };
  }

  private async featureBody(
    snap: TenantEntitlementSnapshot,
    featureId: string,
    run: { readonly scope: MeterScopeInput; readonly systemEnabled: boolean },
  ): Promise<FeatureEntitlementBody> {
    const res = this.resolve(snap, featureId);
    const optOut = snap.optOuts.byFeature.get(featureId) ?? NO_OPT_OUT;
    const available = run.systemEnabled && res.verdict.allow;
    return {
      featureId,
      availability: available ? "available" : "unavailable",
      unavailableReason: res.verdict.allow ? null : res.verdict.reason,
      entitled: res.entitled,
      optOut: { optedOut: optOut.optedOut, changedAt: optOut.changedAt?.toISOString() ?? null },
      meters: res.entitled ? await this.meters(run.scope, res.meters) : [],
    };
  }

  minimal(snap: TenantEntitlementSnapshot, systemEnabled: boolean): MinimalViewBody {
    return {
      view: "minimal",
      evaluatedAt: snap.now.toISOString(),
      features: snap.knownFeatures.map((featureId) => ({
        featureId,
        availability: systemEnabled && this.resolve(snap, featureId).verdict.allow ? "available" : "unavailable",
      })),
    };
  }

  private resolve(snap: TenantEntitlementSnapshot, featureId: string) {
    return resolveFeature({
      revision: snap.revision,
      planFeatures: snap.planFeatures,
      featureId,
      optOut: snap.optOuts.byFeature.get(featureId) ?? NO_OPT_OUT,
      now: snap.now,
    });
  }

  private async liveStores(client: PoolClient, tenantId: string): Promise<string[]> {
    const r = await client.query<{ id: string }>(
      `SELECT id FROM stores WHERE tenant_id = $1::uuid AND deleted_at IS NULL ORDER BY id`,
      [tenantId],
    );
    return r.rows.map((row) => row.id);
  }

  private async meters(scope: MeterScopeInput, meters: readonly CatalogMeter[]): Promise<RequestMeterBody[]> {
    const { client, tenantId, stores } = scope;
    const out: RequestMeterBody[] = [];
    for (const m of meters) {
      for (const storeRef of m.scope === "store" ? stores : [null]) {
        const c = await this.usage.counter(client, { tenantId, storeId: storeRef, meter: m.meter, window: m.window });
        out.push({
          meter: m.meter,
          unit: "request",
          window: m.window,
          storeRef,
          limit: m.limit,
          used: c.used,
          reserved: c.reserved,
          remaining: Math.max(0, m.limit - c.used - c.reserved),
          resetsAt: c.resetsAt.toISOString(),
        });
      }
    }
    return out;
  }
}
