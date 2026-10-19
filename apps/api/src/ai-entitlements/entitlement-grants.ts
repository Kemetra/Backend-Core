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
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { MembershipRepository } from "../context/membership.repository";
import { insertAiAudit, REVISION_PUBLISHED_ACTION, USAGE_ADJUSTED_ACTION } from "./ai-entitlements-audit";
import { ChainConflictError, EntitlementRepository } from "./entitlement.repository";
import { AI_ENTITLEMENT_STATES, type AiEntitlementState } from "./entitlement.types";
import { canonicalInstant, revisionContentHash, toOverrideJson, type OverrideInput } from "./revision-content";
import { UsageRepository } from "./usage.repository";

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

export interface RevisionInput {
  /** The current chain head (0 when the tenant has no revision). */
  readonly expectedVersion: number;
  readonly state: AiEntitlementState;
  readonly planCode: string | null;
  readonly catalogVersion: number | null;
  /** RFC 3339; defaults to the transaction's now(). */
  readonly effectiveFrom?: string;
  readonly effectiveUntil?: string | null;
  readonly overrides?: readonly OverrideInput[];
  readonly reason: string;
}

export interface AdjustmentInput {
  readonly committedEntryId: string;
  readonly units: number;
  readonly reason: string;
  readonly idempotencyKey: string;
}

/** The slice of `MembershipRepository` the service needs. */
export interface PlatformAdminLookup {
  isPlatformAdmin(userId: string): Promise<boolean>;
}

const KEY_PATTERN = /^[\x21-\x7E]{16,128}$/;
const MAX_OVERRIDES = 100;

function validReason(reason: string): boolean {
  return reason.length >= 1 && reason.length <= 500;
}

function invalid(detail: string): never {
  throw new InvalidEntitlementRevisionError(detail);
}

function validInstant(value: string | undefined | null): boolean {
  return value === undefined || value === null || !Number.isNaN(Date.parse(value));
}

/** The shape rules that need no database. */
function checkShape(input: RevisionInput): void {
  if (!validReason(input.reason)) invalid("reason must be 1-500 characters");
  if (!AI_ENTITLEMENT_STATES.includes(input.state)) invalid("unknown state");
  const hasPlan = input.planCode !== null && input.catalogVersion !== null;
  if ((input.state === "none") === hasPlan || (input.planCode === null) !== (input.catalogVersion === null)) {
    invalid("state none names no plan; every other state names a plan version");
  }
  if (input.state === "trial" && (input.effectiveUntil ?? null) === null) invalid("a trial needs effectiveUntil");
  if (!validInstant(input.effectiveFrom) || !validInstant(input.effectiveUntil)) invalid("malformed instant");
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) invalid("expectedVersion must be >= 0");
  const overrides = input.overrides ?? [];
  if (overrides.length > MAX_OVERRIDES) invalid("too many overrides");
  for (const o of overrides) {
    if (!validReason(o.reason) || !validInstant(o.expiresAt)) invalid("override reason or expiresAt is invalid");
    if (o.action === "disable" && (o.meter !== undefined || o.meterLimitDelta !== undefined)) invalid("a disable override has no meter");
    if (o.meterLimitDelta !== undefined && (!Number.isSafeInteger(o.meterLimitDelta) || o.meter === undefined)) {
      invalid("meterLimitDelta needs a meter and a whole number");
    }
  }
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
    checkShape(input);
    return this.asPlatform(tenantId, async (client) => {
      await this.entitlements.lockChain(client, "entitlement", tenantId);
      await this.requireTenant(client, tenantId);
      await this.checkCatalog(client, input);
      const head = await this.entitlements.headVersion(client, tenantId);
      if (head !== input.expectedVersion) throw new EntitlementRevisionConflictError();
      const version = head + 1;
      const effectiveFrom = canonicalInstant(input.effectiveFrom ?? (await this.entitlements.now(client)));
      const until = input.effectiveUntil ?? null;
      const effectiveUntil = until === null ? null : canonicalInstant(until);
      if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) invalid("effectiveUntil must be after effectiveFrom");
      const overrides = (input.overrides ?? []).map(toOverrideJson);
      const content = { state: input.state, planCode: input.planCode, catalogVersion: input.catalogVersion, effectiveFrom, effectiveUntil, overrides, reason: input.reason };
      const contentHash = revisionContentHash(content);
      const id = newId();
      try {
        await this.entitlements.insertRevision(client, { id, tenantId, version, ...content, createdByUserId: actor.actorUserId, contentHash });
      } catch (err) {
        throw err instanceof ChainConflictError ? new EntitlementRevisionConflictError() : err;
      }
      await insertAiAudit(client, {
        tenantId,
        actorUserId: actor.actorUserId,
        requestId: actor.requestId,
        action: REVISION_PUBLISHED_ACTION,
        targetType: "tenant_ai_entitlement",
        targetId: id,
        metadata: {
          entitlement_version: version,
          base_version: version === 1 ? null : version - 1,
          state: input.state,
          plan_code: input.planCode,
          catalog_version: input.catalogVersion,
          effective_from: effectiveFrom,
          effective_until: effectiveUntil,
          override_count: overrides.length,
          source: "manual_platform",
          reason: input.reason,
          content_hash: contentHash.toString("hex"),
        },
      });
      return { entitlementVersion: version };
    });
  }

  /** Credit a committed request with a compensating `adjusted` row (T20). */
  async adjustUsage(actor: PlatformActor, tenantId: string, input: AdjustmentInput): Promise<{ adjustmentId: string; replayed: boolean }> {
    await this.requirePlatformAdmin(actor);
    if (!Number.isSafeInteger(input.units) || input.units < 1) throw new AdjustmentRefusedError("units must be a positive whole number");
    if (!validReason(input.reason)) throw new AdjustmentRefusedError("reason must be 1-500 characters");
    if (!KEY_PATTERN.test(input.idempotencyKey)) throw new AdjustmentRefusedError("malformed idempotency key");
    return this.asPlatform(tenantId, async (client) => {
      await this.usage.lockCommittedEntry(client, input.committedEntryId);
      const committed = await this.usage.findCommitted(client, tenantId, input.committedEntryId);
      if (committed === null) throw new AdjustmentRefusedError("no such committed entry in the tenant");
      const prior = await this.usage.findAdjustmentByKey(client, tenantId, committed.featureId, input.idempotencyKey);
      if (prior !== null) {
        const same = prior.adjustsEntryId === committed.id && prior.units === input.units && prior.reason === input.reason;
        if (!same) throw new AdjustmentRefusedError("idempotency key reused with another adjustment");
        return { adjustmentId: prior.id, replayed: true };
      }
      const already = await this.usage.adjustedUnits(client, tenantId, committed.id);
      if (already + input.units > committed.units) throw new AdjustmentRefusedError("adjustments would exceed the committed units");
      const id = newId();
      try {
        await this.usage.insertAdjustment(client, { id, tenantId, committed, units: input.units, idempotencyKey: input.idempotencyKey, actorUserId: actor.actorUserId, reason: input.reason, requestId: actor.requestId });
      } catch (err) {
        if ((err as { code?: unknown }).code === "23505") throw new AdjustmentRefusedError("idempotency key reused with another adjustment");
        throw err;
      }
      await insertAiAudit(client, {
        tenantId,
        actorUserId: actor.actorUserId,
        requestId: actor.requestId,
        action: USAGE_ADJUSTED_ACTION,
        targetType: "ai_usage_ledger_entry",
        targetId: id,
        metadata: { adjusts_entry_id: committed.id, feature_id: committed.featureId, units: input.units, reason: input.reason },
      });
      return { adjustmentId: id, replayed: false };
    });
  }

  private async requirePlatformAdmin(actor: PlatformActor): Promise<void> {
    if (!(await this.admins.isPlatformAdmin(actor.actorUserId))) throw new NotPlatformAdminError();
  }

  private asPlatform<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: true }, work);
  }

  private async requireTenant(client: PoolClient, tenantId: string): Promise<void> {
    const r = await client.query(`SELECT 1 FROM tenants WHERE id = $1::uuid AND deleted_at IS NULL`, [tenantId]);
    if (r.rows.length === 0) invalid("unknown tenant");
  }

  /** The plan version exists; every override names a catalogue feature, and an enable / meter one a plan feature and meter. */
  private async checkCatalog(client: PoolClient, input: RevisionInput): Promise<void> {
    const overrides = input.overrides ?? [];
    if (input.planCode === null || input.catalogVersion === null) {
      if (overrides.length > 0) invalid("state none carries no override");
      return;
    }
    if (!(await this.entitlements.catalogVersionExists(client, input.planCode, input.catalogVersion))) invalid("unknown plan version");
    const known = new Set(await this.entitlements.knownFeatures(client));
    const plan = await this.entitlements.planFeatures(client, input.planCode, input.catalogVersion);
    for (const o of overrides) {
      if (!known.has(o.featureId)) invalid("override names an unknown feature");
      const meters = plan.get(o.featureId);
      if (o.action === "enable" && meters === undefined) invalid("an enable override needs a plan feature");
      if (o.meter !== undefined && !(meters ?? []).some((m) => m.meter === o.meter)) invalid("override names an unknown meter");
    }
  }
}
