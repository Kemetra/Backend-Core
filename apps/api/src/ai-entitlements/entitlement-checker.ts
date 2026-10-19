/**
 * AiEntitlementChecker — RT-664 (RT-644 ENT-BC3): the internal `check`
 * decision of `ai-entitlements.openapi.yaml` (`AiEntitlementCheckInput` →
 * `AiEntitlementDecision`, x-internal) and the reservation's commit / release.
 *
 * AND-chain (AD-AI-ENT-001 D-1), first deny wins, in this order:
 *   layer 2-4  the principal: a human session member, not a platform admin
 *              (it never consumes tenant AI features, D-6), and every target
 *              store inside its scope (D-4: refused, never narrowed). Role /
 *              capability (layer 3) is the calling route's `@Roles` guard.
 *   layer 1    the tenant is `active` and not deleted (read here, R-1).
 *   layer 6    the effective entitlement and the owner opt-out (D-5).
 *   layer 7    the quota reservation (Option A, D-3).
 * Layer 0 (the kill switch) and the internal spend cap / free credit are
 * gateway steps (`AiGateway`); layer 5 has no AD-POL-001 engine yet.
 *
 * Fail closed: any read or write that fails — an unreachable database, a
 * missing grant, an unexpected row — is deny `entitlement_unavailable`, with
 * nothing reserved (the transaction rolls back). `check` never throws.
 *
 * v1 constraint (0055): the ledger key is unique per (tenant, feature, key),
 * so one request reserves exactly ONE counter. A feature with zero or several
 * meters, or a per-store meter without exactly one target store, fails closed.
 *
 * Idempotency (D-3): a replay of the same key returns the same reservation
 * and is counted once. The same key with other units, another store or
 * another user is refused (`entitlement_unavailable`), never the old
 * reservation. `replay` marks a replay: only the call that took the
 * reservation may run the request it pays for (the gateway never runs a
 * replay, so concurrent same-key calls make one provider call).
 */
import { newId } from "@data-pulse-2/shared";
import { runWithTenantContext, settleAiReservation, type AiUsageTelemetry, type SettleAiReservationResult } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { resolveStoreScope } from "../context/store-scope";
import type { ResolvedContext } from "../context/types";
import { resolveFeature, type CatalogMeter, type FeatureResolution } from "./entitlement-resolution";
import { EntitlementRepository, NO_OPT_OUT } from "./entitlement.repository";
import type { AiCheckDenyReason } from "./entitlement.types";
import { UsageRepository, type CounterRef, type CounterState } from "./usage.repository";

export const AI_FEATURE_ID_PATTERN = /^ai\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/** `AiEntitlementCheckInput` (x-internal). No tenant or principal: they come from the context. */
export const AiEntitlementCheckInputSchema = z
  .object({
    featureId: z.string().min(4).max(64).regex(AI_FEATURE_ID_PATTERN),
    targetStores: z.array(z.string().uuid()).refine((ids) => new Set(ids).size === ids.length, "unique"),
    unitsEstimate: z.number().int().min(1).max(2_147_483_647),
    idempotencyKey: z.string().regex(/^[\x21-\x7E]{16,128}$/),
  })
  .strict();
export type AiEntitlementCheckInput = z.infer<typeof AiEntitlementCheckInputSchema>;

/** `AiEntitlementMeterSnapshot`. */
export interface MeterSnapshot {
  readonly meter: string;
  readonly window: "day" | "month";
  readonly limit: number;
  readonly used: number;
  readonly reserved: number;
  readonly remaining: number;
  readonly resetsAt: string;
}

export interface AllowBody {
  readonly decision: "allow";
  readonly entitlementVersion: number;
  readonly optOutVersion: number;
  readonly meter: MeterSnapshot;
  readonly reservationId: string;
  readonly evaluatedAt: string;
}

export interface DenyBody {
  readonly decision: "deny";
  readonly reasonCode: AiCheckDenyReason;
  readonly entitlementVersion: number | null;
  readonly optOutVersion: number | null;
  readonly meter?: MeterSnapshot;
  readonly evaluatedAt: string;
}

/** `AiEntitlementDecision`. */
export type AiEntitlementDecisionBody = AllowBody | DenyBody;

export interface CheckOutcome {
  readonly decision: AiEntitlementDecisionBody;
  /** Null for a first reservation; for a replay, whether it is still open. */
  readonly replay: { readonly open: boolean } | null;
}

/** Layers 1 and 6 only (no reservation): the gateway's pre-check and the read view. */
export type EvaluateOutcome =
  | { readonly allowed: true; readonly entitlementVersion: number; readonly optOutVersion: number }
  | { readonly allowed: false; readonly reason: AiCheckDenyReason };

export interface CheckMeta {
  readonly requestId?: string | null;
}

export interface SettleInput {
  readonly tenantId: string;
  readonly reservationId: string;
  readonly outcome: string;
  readonly telemetry?: AiUsageTelemetry;
}

export interface AiEntitlementCheckerOptions {
  /** The sweeper releases a reservation still open this long after it was taken (T17). */
  readonly reservationTtlSeconds: number;
  /**
   * Called with the cause of a fail-closed `entitlement_unavailable` (an
   * unreadable store, a missing grant), so an outage is told apart from a
   * legitimate deny. Implementations log the error class and code only.
   */
  readonly onUnavailable?: (err: unknown) => void;
}

interface Principal {
  readonly tenantId: string;
  readonly userId: string;
}

interface Layer6 {
  readonly entitlementVersion: number;
  readonly optOutVersion: number;
  readonly resolution: FeatureResolution;
}

function snapshot(meter: CatalogMeter, state: CounterState): MeterSnapshot {
  return {
    meter: meter.meter,
    window: meter.window,
    limit: meter.limit,
    used: state.used,
    reserved: state.reserved,
    remaining: Math.max(0, meter.limit - state.used - state.reserved),
    resetsAt: state.resetsAt.toISOString(),
  };
}

/** Layers 2-4 that a resolved context proves. */
function principalOf(ctx: ResolvedContext, targetStores: readonly string[]): Principal | null {
  if (ctx.source !== "session" || ctx.isPlatformAdmin || ctx.userId === null || ctx.tenantId === null) return null;
  const scope = resolveStoreScope(ctx);
  if (scope.kind === "tenant") return { tenantId: ctx.tenantId, userId: ctx.userId };
  if (targetStores.length === 0) return null;
  return targetStores.every((id) => scope.storeIds.includes(id)) ? { tenantId: ctx.tenantId, userId: ctx.userId } : null;
}

class Denied extends Error {
  constructor(readonly body: DenyBody) {
    super(body.reasonCode);
    this.name = "Denied";
  }
}

export class AiEntitlementChecker {
  private readonly entitlements = new EntitlementRepository();
  private readonly usage = new UsageRepository();

  constructor(
    private readonly pool: Pool,
    private readonly options: AiEntitlementCheckerOptions,
  ) {
    if (!Number.isInteger(options.reservationTtlSeconds) || options.reservationTtlSeconds < 1) {
      throw new Error("AiEntitlementChecker: reservationTtlSeconds must be a positive whole number");
    }
  }

  get reservationTtlSeconds(): number {
    return this.options.reservationTtlSeconds;
  }

  /** Layers 1-6 for one feature, read-only. Fails closed. */
  async evaluate(ctx: ResolvedContext, featureId: string, targetStores: readonly string[] = []): Promise<EvaluateOutcome> {
    const principal = principalOf(ctx, targetStores);
    if (principal === null || !AI_FEATURE_ID_PATTERN.test(featureId)) return { allowed: false, reason: "not_authorized" };
    try {
      return await this.inTenant(principal.tenantId, async (client) => {
        if (!(await this.entitlements.tenantActive(client, principal.tenantId))) return { allowed: false, reason: "tenant_inactive" };
        if (!(await this.entitlements.storesLive(client, principal.tenantId, targetStores))) return { allowed: false, reason: "not_authorized" };
        const layer6 = await this.layer6(client, principal.tenantId, featureId);
        const verdict = layer6.resolution.verdict;
        return verdict.allow
          ? { allowed: true, entitlementVersion: layer6.entitlementVersion, optOutVersion: layer6.optOutVersion }
          : { allowed: false, reason: verdict.reason };
      });
    } catch (err) {
      this.unavailable(err);
      return { allowed: false, reason: "entitlement_unavailable" };
    }
  }

  /** The full `check`: layers 1-7, reserving the units on allow. Never throws. */
  async check(ctx: ResolvedContext, rawInput: AiEntitlementCheckInput, meta: CheckMeta = {}): Promise<CheckOutcome> {
    const evaluatedAt = new Date().toISOString();
    const parsed = AiEntitlementCheckInputSchema.safeParse(rawInput);
    if (!parsed.success) return { decision: this.deny("entitlement_unavailable", null, null, evaluatedAt), replay: null };
    const input = parsed.data;
    const principal = principalOf(ctx, input.targetStores);
    if (principal === null) return { decision: this.deny("not_authorized", null, null, evaluatedAt), replay: null };
    try {
      return await this.inTenant(principal.tenantId, (client) => this.reserve(client, principal, input, meta));
    } catch (err) {
      if (err instanceof Denied) return { decision: err.body, replay: null };
      this.unavailable(err);
      return { decision: this.deny("entitlement_unavailable", null, null, evaluatedAt), replay: null };
    }
  }

  /** Commit (`ok`) or release (any other outcome) one reservation; null when the tenant has none. */
  settle(input: SettleInput): Promise<SettleAiReservationResult | null> {
    return this.inTenant(input.tenantId, (client) =>
      settleAiReservation(client, {
        tenantId: input.tenantId,
        reservationId: input.reservationId,
        outcome: input.outcome,
        entryId: newId(),
        ...(input.telemetry === undefined ? {} : { telemetry: input.telemetry }),
      }),
    );
  }

  private inTenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, work);
  }

  private unavailable(err: unknown): void {
    try {
      this.options.onUnavailable?.(err);
    } catch {
      // observability never changes a decision
    }
  }

  private deny(
    reasonCode: AiCheckDenyReason,
    entitlementVersion: number | null,
    optOutVersion: number | null,
    evaluatedAt: string,
    meter?: MeterSnapshot,
  ): DenyBody {
    return { decision: "deny", reasonCode, entitlementVersion, optOutVersion, ...(meter === undefined ? {} : { meter }), evaluatedAt };
  }

  private async layer6(client: PoolClient, tenantId: string, featureId: string): Promise<Layer6> {
    const revision = await this.entitlements.effectiveRevision(client, tenantId);
    const optOuts = await this.entitlements.optOuts(client, tenantId);
    const planFeatures = await this.entitlements.planFeaturesOf(client, revision);
    const resolution = resolveFeature({
      revision,
      planFeatures,
      featureId,
      optOut: optOuts.byFeature.get(featureId) ?? NO_OPT_OUT,
      now: await this.entitlements.now(client),
    });
    return { entitlementVersion: revision?.version ?? 0, optOutVersion: optOuts.version, resolution };
  }

  private async reserve(client: PoolClient, principal: Principal, input: AiEntitlementCheckInput, meta: CheckMeta): Promise<CheckOutcome> {
    const now = await this.entitlements.now(client);
    const at = now.toISOString();
    if (!(await this.entitlements.tenantActive(client, principal.tenantId))) throw new Denied(this.deny("tenant_inactive", null, null, at));
    if (!(await this.entitlements.storesLive(client, principal.tenantId, input.targetStores))) {
      throw new Denied(this.deny("not_authorized", null, null, at));
    }
    const layer6 = await this.layer6(client, principal.tenantId, input.featureId);
    const { entitlementVersion, optOutVersion, resolution } = layer6;
    if (!resolution.verdict.allow) throw new Denied(this.deny(resolution.verdict.reason, entitlementVersion, optOutVersion, at));

    const meter = this.singleMeter(resolution, input, layer6, at);
    const ref: CounterRef = {
      tenantId: principal.tenantId,
      storeId: meter.scope === "store" ? input.targetStores[0]! : null,
      meter: meter.meter,
      window: meter.window,
    };
    await this.usage.lockReservationKey(client, principal.tenantId, input.featureId, input.idempotencyKey);
    const existing = await this.usage.findReservation(client, principal.tenantId, input.featureId, input.idempotencyKey);
    if (existing !== null) {
      const sameBody = existing.units === input.unitsEstimate && existing.storeId === ref.storeId;
      if (!sameBody || existing.actorUserId !== principal.userId) {
        throw new Denied(this.deny("entitlement_unavailable", entitlementVersion, optOutVersion, at));
      }
      const state = await this.usage.counter(client, ref);
      const body: AllowBody = {
        decision: "allow",
        entitlementVersion: existing.entitlementVersion,
        optOutVersion: existing.optOutVersion ?? 0,
        meter: snapshot(meter, state),
        reservationId: existing.id,
        evaluatedAt: at,
      };
      return { decision: body, replay: { open: existing.open } };
    }

    await this.usage.ensureCounter(client, ref, newId());
    const counterId = await this.usage.tryReserve(client, ref, input.unitsEstimate, meter.limit);
    if (counterId === null) {
      const state = await this.usage.counter(client, ref);
      throw new Denied(this.deny("quota_exhausted", entitlementVersion, optOutVersion, at, snapshot(meter, state)));
    }
    const reservationId = newId();
    await this.usage.insertReservation(client, {
      id: reservationId,
      tenantId: principal.tenantId,
      featureId: input.featureId,
      counterId,
      units: input.unitsEstimate,
      entitlementVersion,
      optOutVersion: optOutVersion === 0 ? null : optOutVersion,
      idempotencyKey: input.idempotencyKey,
      ttlSeconds: this.options.reservationTtlSeconds,
      actorUserId: principal.userId,
      requestId: meta.requestId ?? null,
    });
    const state = await this.usage.counter(client, ref);
    const body: AllowBody = { decision: "allow", entitlementVersion, optOutVersion, meter: snapshot(meter, state), reservationId, evaluatedAt: at };
    return { decision: body, replay: null };
  }

  /** v1: exactly one meter, and a per-store meter needs exactly one target store. */
  private singleMeter(resolution: FeatureResolution, input: AiEntitlementCheckInput, layer6: Layer6, at: string): CatalogMeter {
    const meter = resolution.meters.length === 1 ? resolution.meters[0]! : null;
    if (meter === null || (meter.scope === "store" && input.targetStores.length !== 1)) {
      throw new Denied(this.deny("entitlement_unavailable", layer6.entitlementVersion, layer6.optOutVersion, at));
    }
    return meter;
  }
}
