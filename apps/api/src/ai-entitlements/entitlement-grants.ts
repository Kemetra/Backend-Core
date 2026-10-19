/**
 * AiEntitlementGrants — RT-664 (AD-AI-ENT-001 D-2, RT-644 §4.1 / §4.7):
 * platform-admin manual entitlement revisions and dispute adjustments.
 *
 * Interim grant source: platform admins only, with a reason, audited. A
 * tenant can never grant itself (T18): the caller must be
 * `users.is_platform_admin`, and 0055's RLS refuses a revision or an
 * `adjusted` row without `app.is_platform_admin = 'true'` anyway.
 *
 * Every write runs in the TARGET tenant's context with the platform flag
 * (`runWithTenantContext({ tenantId: target, isPlatformAdmin: true })`): the
 * 0055 tenant policies match `app.current_tenant`, so a NIL-tenant platform
 * context could neither read nor write these rows.
 *
 * This is a service API. The merged contract (RT-662) has no HTTP operation
 * for it; a platform route is a separate `[GATED]` contract item.
 *
 * Revisions: `expectedVersion` optimistic concurrency under an advisory lock
 * on the tenant's chain; a stale expectation or a lost race (23505) is
 * `EntitlementRevisionConflictError`, never merged.
 *
 * Adjustments (T20): a compensating `adjusted` row naming a `committed` row;
 * rows are never edited. Under an advisory lock on the committed row, the
 * total adjusted units never exceed its units, so concurrent adjustments
 * with different keys cannot over-credit. The credit lowers the committed
 * row's counter `used`. A retried key with the same body is the same
 * adjustment (`replayed: true`); with another body it is refused.
 *
 * The validation rules live in `revision-rules.ts`.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { MembershipRepository } from "../context/membership.repository";
import { insertAiAudit, REVISION_PUBLISHED_ACTION, USAGE_ADJUSTED_ACTION } from "./ai-entitlements-audit";
import { ChainConflictError, EntitlementRepository } from "./entitlement.repository";
import { canonicalInstant, revisionContentHash, toOverrideJson, type RevisionContent } from "./revision-content";
import {
  adjustmentFailure,
  overridesCatalogFailure,
  revisionShapeFailure,
  type AdjustmentInput,
  type RevisionInput,
} from "./revision-rules";
import { UsageRepository, type CommittedEntry } from "./usage.repository";

export type { AdjustmentInput, RevisionInput } from "./revision-rules";

export class NotPlatformAdminError extends Error {
  constructor() {
    super("only a platform admin may change AI entitlements");
    this.name = "NotPlatformAdminError";
  }
}

export class EntitlementRevisionConflictError extends Error {
  constructor() {
    super("the entitlement changed since it was read");
    this.name = "EntitlementRevisionConflictError";
  }
}

export class InvalidEntitlementRevisionError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "InvalidEntitlementRevisionError";
  }
}

export class AdjustmentRefusedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "AdjustmentRefusedError";
  }
}

export interface PlatformActor {
  readonly actorUserId: string;
  readonly requestId: string | null;
}

/** The slice of `MembershipRepository` the service needs. */
export interface PlatformAdminLookup {
  isPlatformAdmin(userId: string): Promise<boolean>;
}

/** One platform write: who, in which tenant, on which transaction. */
interface PlatformWrite {
  readonly client: PoolClient;
  readonly tenantId: string;
  readonly actor: PlatformActor;
}

function refuseRevision(failure: string | null): void {
  if (failure !== null) throw new InvalidEntitlementRevisionError(failure);
}

function refuseAdjustment(failure: string | null): void {
  if (failure !== null) throw new AdjustmentRefusedError(failure);
}

const KEY_REUSED = "idempotency key reused with another adjustment";

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}

/** A prior adjustment under the same key is a replay only when its body is the same. */
function samePriorAdjustment(
  prior: { readonly adjustsEntryId: string; readonly units: number; readonly reason: string },
  committed: CommittedEntry,
  input: AdjustmentInput,
): boolean {
  const sameTarget = prior.adjustsEntryId === committed.id;
  return sameTarget && prior.units === input.units && prior.reason === input.reason;
}

function revisionMetadata(version: number, content: RevisionContent, contentHash: Buffer): Record<string, unknown> {
  return {
    entitlement_version: version,
    base_version: version === 1 ? null : version - 1,
    state: content.state,
    plan_code: content.planCode,
    catalog_version: content.catalogVersion,
    effective_from: content.effectiveFrom,
    effective_until: content.effectiveUntil,
    override_count: content.overrides.length,
    source: "manual_platform",
    reason: content.reason,
    content_hash: contentHash.toString("hex"),
  };
}

@Injectable()
export class AiEntitlementGrants {
  private readonly entitlements = new EntitlementRepository();
  private readonly usage = new UsageRepository();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly admins: PlatformAdminLookup,
  ) {}

  /** Publish the tenant's next immutable entitlement revision. */
  async publishRevision(actor: PlatformActor, tenantId: string, input: RevisionInput): Promise<{ entitlementVersion: number }> {
    await this.requirePlatformAdmin(actor);
    refuseRevision(revisionShapeFailure(input));
    return this.asPlatform(tenantId, async (client) => {
      const write: PlatformWrite = { client, tenantId, actor };
      await this.entitlements.lockChain(client, "entitlement", tenantId);
      await this.requireTenant(write);
      await this.checkCatalog(client, input);
      const version = await this.nextVersion(write, input.expectedVersion);
      const content = await this.revisionContent(client, input);
      const contentHash = revisionContentHash(content);
      const id = await this.insertRevision(write, { version, content, contentHash });
      await insertAiAudit(client, {
        tenantId,
        actorUserId: actor.actorUserId,
        requestId: actor.requestId,
        action: REVISION_PUBLISHED_ACTION,
        targetType: "tenant_ai_entitlement",
        targetId: id,
        metadata: revisionMetadata(version, content, contentHash),
      });
      return { entitlementVersion: version };
    });
  }

  /** Credit a committed request with a compensating `adjusted` row (T20). */
  async adjustUsage(actor: PlatformActor, tenantId: string, input: AdjustmentInput): Promise<{ adjustmentId: string; replayed: boolean }> {
    await this.requirePlatformAdmin(actor);
    refuseAdjustment(adjustmentFailure(input));
    return this.asPlatform(tenantId, async (client) => {
      const write: PlatformWrite = { client, tenantId, actor };
      const entry = { tenantId, entryId: input.committedEntryId };
      await this.usage.lockCommittedEntry(client, entry);
      const committed = await this.usage.findCommitted(client, entry);
      if (committed === null) throw new AdjustmentRefusedError("no such committed entry in the tenant");
      const replayed = await this.replayedAdjustment(write, committed, input);
      if (replayed !== null) return { adjustmentId: replayed, replayed: true };
      await this.requireWithinCap(write, committed, input.units);
      const id = await this.insertAdjustment(write, committed, input);
      return { adjustmentId: id, replayed: false };
    });
  }

  private async requirePlatformAdmin(actor: PlatformActor): Promise<void> {
    if (!(await this.admins.isPlatformAdmin(actor.actorUserId))) throw new NotPlatformAdminError();
  }

  private asPlatform<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: true }, work);
  }

  private async requireTenant(write: PlatformWrite): Promise<void> {
    const r = await write.client.query(`SELECT 1 FROM tenants WHERE id = $1::uuid AND deleted_at IS NULL`, [write.tenantId]);
    if (r.rows.length === 0) throw new InvalidEntitlementRevisionError("unknown tenant");
  }

  /** The plan version exists, and every override fits the catalogue (state `none` carries none). */
  private async checkCatalog(client: PoolClient, input: RevisionInput): Promise<void> {
    const overrides = input.overrides ?? [];
    const { planCode, catalogVersion } = input;
    if (planCode === null || catalogVersion === null) {
      refuseRevision(overrides.length > 0 ? "state none carries no override" : null);
      return;
    }
    const exists = await this.entitlements.catalogVersionExists(client, planCode, catalogVersion);
    refuseRevision(exists ? null : "unknown plan version");
    const known = new Set(await this.entitlements.knownFeatures(client));
    const plan = await this.entitlements.planFeatures(client, planCode, catalogVersion);
    refuseRevision(overridesCatalogFailure(overrides, { known, plan }));
  }

  private async nextVersion(write: PlatformWrite, expectedVersion: number): Promise<number> {
    const head = await this.entitlements.headVersion(write.client, write.tenantId);
    if (head !== expectedVersion) throw new EntitlementRevisionConflictError();
    return head + 1;
  }

  /** The canonical content (instants as stored and hashed). */
  private async revisionContent(client: PoolClient, input: RevisionInput): Promise<RevisionContent> {
    const effectiveFrom = canonicalInstant(input.effectiveFrom ?? (await this.entitlements.now(client)));
    const until = input.effectiveUntil ?? null;
    const effectiveUntil = until === null ? null : canonicalInstant(until);
    refuseRevision(effectiveUntil !== null && effectiveUntil <= effectiveFrom ? "effectiveUntil must be after effectiveFrom" : null);
    return {
      state: input.state,
      planCode: input.planCode,
      catalogVersion: input.catalogVersion,
      effectiveFrom,
      effectiveUntil,
      overrides: (input.overrides ?? []).map(toOverrideJson),
      reason: input.reason,
    };
  }

  private async insertRevision(
    write: PlatformWrite,
    revision: { readonly version: number; readonly content: RevisionContent; readonly contentHash: Buffer },
  ): Promise<string> {
    const id = newId();
    try {
      await this.entitlements.insertRevision(write.client, {
        id,
        tenantId: write.tenantId,
        version: revision.version,
        ...revision.content,
        state: revision.content.state as RevisionInput["state"],
        createdByUserId: write.actor.actorUserId,
        contentHash: revision.contentHash,
      });
    } catch (err) {
      throw err instanceof ChainConflictError ? new EntitlementRevisionConflictError() : err;
    }
    return id;
  }

  /** The id of a same-key adjustment with the same body (a replay), or null; another body is refused. */
  private async replayedAdjustment(write: PlatformWrite, committed: CommittedEntry, input: AdjustmentInput): Promise<string | null> {
    const prior = await this.usage.findAdjustmentByKey(write.client, {
      tenantId: write.tenantId,
      featureId: committed.featureId,
      key: input.idempotencyKey,
    });
    if (prior === null) return null;
    refuseAdjustment(samePriorAdjustment(prior, committed, input) ? null : KEY_REUSED);
    return prior.id;
  }

  private async requireWithinCap(write: PlatformWrite, committed: CommittedEntry, units: number): Promise<void> {
    const already = await this.usage.adjustedUnits(write.client, { tenantId: write.tenantId, entryId: committed.id });
    refuseAdjustment(already + units > committed.units ? "adjustments would exceed the committed units" : null);
  }

  private async insertAdjustment(write: PlatformWrite, committed: CommittedEntry, input: AdjustmentInput): Promise<string> {
    const id = newId();
    try {
      await this.usage.insertAdjustment(write.client, {
        id,
        tenantId: write.tenantId,
        committed,
        units: input.units,
        idempotencyKey: input.idempotencyKey,
        actorUserId: write.actor.actorUserId,
        reason: input.reason,
        requestId: write.actor.requestId,
      });
    } catch (err) {
      throw isUniqueViolation(err) ? new AdjustmentRefusedError(KEY_REUSED) : err;
    }
    await insertAiAudit(write.client, {
      tenantId: write.tenantId,
      actorUserId: write.actor.actorUserId,
      requestId: write.actor.requestId,
      action: USAGE_ADJUSTED_ACTION,
      targetType: "ai_usage_ledger_entry",
      targetId: id,
      metadata: { adjusts_entry_id: committed.id, feature_id: committed.featureId, units: input.units, reason: input.reason },
    });
    return id;
  }
}
