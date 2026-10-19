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
import { UsageRepository, type CounterRef, type CounterState, type ReservedEntry } from "./usage.repository";

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

/** The versions a decision reports (null when the refusal came before that source was read). */
interface Versions {
  readonly entitlementVersion: number | null;
  readonly optOutVersion: number | null;
}

const NO_VERSIONS: Versions = { entitlementVersion: null, optOutVersion: null };

interface Layer6 {
  readonly entitlementVersion: number;
  readonly optOutVersion: number;
  readonly resolution: FeatureResolution;
}

/** Everything one reservation attempt works on, inside its transaction. */
interface ReserveStep {
  readonly client: PoolClient;
  readonly principal: Principal;
  readonly input: AiEntitlementCheckInput;
  readonly meter: CatalogMeter;
  readonly ref: CounterRef;
  readonly layer6: Layer6;
  readonly at: string;
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

function denyBody(reasonCode: AiCheckDenyReason, versions: Versions, at: string, meter?: MeterSnapshot): DenyBody {
  return { decision: "deny", reasonCode, ...versions, ...(meter === undefined ? {} : { meter }), evaluatedAt: at };
}

function versionsOf(layer6: Layer6): Versions {
  return { entitlementVersion: layer6.entitlementVersion, optOutVersion: layer6.optOutVersion };
}

/** A human session member (a platform admin never consumes tenant AI features, D-6). */
function humanSession(ctx: ResolvedContext): boolean {
  return ctx.source === "session" && !ctx.isPlatformAdmin;
}

function sessionPrincipal(ctx: ResolvedContext): Principal | null {
  if (!humanSession(ctx)) return null;
  const { userId, tenantId } = ctx;
  return userId === null || tenantId === null ? null : { tenantId, userId };
}

/** D-4: every target store inside the scope; an empty request needs tenant-wide access. */
function coversStores(ctx: ResolvedContext, targetStores: readonly string[]): boolean {
  const scope = resolveStoreScope(ctx);
  if (scope.kind === "tenant") return true;
  return targetStores.length > 0 && targetStores.every((id) => scope.storeIds.includes(id));
}

/** Layers 2-4 that a resolved context proves. */
function principalOf(ctx: ResolvedContext, targetStores: readonly string[]): Principal | null {
  const principal = sessionPrincipal(ctx);
  return principal !== null && coversStores(ctx, targetStores) ? principal : null;
}

/** v1: a per-store meter needs exactly one target store. */
function meterFits(meter: CatalogMeter, input: AiEntitlementCheckInput): boolean {
  return meter.scope !== "store" || input.targetStores.length === 1;
}

function counterRefOf(tenantId: string, meter: CatalogMeter, input: AiEntitlementCheckInput): CounterRef {
  return { tenantId, storeId: meter.scope === "store" ? input.targetStores[0]! : null, meter: meter.meter, window: meter.window };
}

/** A replay is the same reservation only for the same user, units and counter. */
function sameReplay(existing: ReservedEntry, step: ReserveStep): boolean {
  const sameBody = existing.units === step.input.unitsEstimate && existing.storeId === step.ref.storeId;
  return sameBody && existing.actorUserId === step.principal.userId;
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
      return await this.inTenant(principal.tenantId, (client) => this.evaluateIn(client, { principal, featureId, targetStores }));
    } catch (err) {
      this.unavailable(err);
      return { allowed: false, reason: "entitlement_unavailable" };
    }
  }

  /** The full `check`: layers 1-7, reserving the units on allow. Never throws. */
  async check(ctx: ResolvedContext, rawInput: AiEntitlementCheckInput, meta: CheckMeta = {}): Promise<CheckOutcome> {
    const evaluatedAt = new Date().toISOString();
    const parsed = AiEntitlementCheckInputSchema.safeParse(rawInput);
    if (!parsed.success) return { decision: denyBody("entitlement_unavailable", NO_VERSIONS, evaluatedAt), replay: null };
    const principal = principalOf(ctx, parsed.data.targetStores);
    if (principal === null) return { decision: denyBody("not_authorized", NO_VERSIONS, evaluatedAt), replay: null };
    try {
      return await this.inTenant(principal.tenantId, (client) => this.reserve(client, principal, parsed.data, meta));
    } catch (err) {
      return { decision: this.refusal(err, evaluatedAt), replay: null };
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

  /** A documented refusal, or the fail-closed `entitlement_unavailable` for anything else. */
  private refusal(err: unknown, evaluatedAt: string): DenyBody {
    if (err instanceof Denied) return err.body;
    this.unavailable(err);
    return denyBody("entitlement_unavailable", NO_VERSIONS, evaluatedAt);
  }

  private unavailable(err: unknown): void {
    try {
      this.options.onUnavailable?.(err);
    } catch {
      // observability never changes a decision
    }
  }

  private async evaluateIn(
    client: PoolClient,
    q: { readonly principal: Principal; readonly featureId: string; readonly targetStores: readonly string[] },
  ): Promise<EvaluateOutcome> {
    const reachable = await this.reachability(client, q.principal, q.targetStores);
    if (reachable !== null) return { allowed: false, reason: reachable };
    const layer6 = await this.layer6(client, q.principal.tenantId, q.featureId);
    const verdict = layer6.resolution.verdict;
    if (!verdict.allow) return { allowed: false, reason: verdict.reason };
    return { allowed: true, entitlementVersion: layer6.entitlementVersion, optOutVersion: layer6.optOutVersion };
  }

  /** Layers 1 and 4 against the database: the tenant is active and every target store is its own, live. */
  private async reachability(client: PoolClient, principal: Principal, targetStores: readonly string[]): Promise<AiCheckDenyReason | null> {
    if (!(await this.entitlements.tenantActive(client, principal.tenantId))) return "tenant_inactive";
    const live = await this.entitlements.storesLive(client, principal.tenantId, targetStores);
    return live ? null : "not_authorized";
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
    const at = (await this.entitlements.now(client)).toISOString();
    const reachable = await this.reachability(client, principal, input.targetStores);
    if (reachable !== null) throw new Denied(denyBody(reachable, NO_VERSIONS, at));
    const layer6 = await this.layer6(client, principal.tenantId, input.featureId);
    const verdict = layer6.resolution.verdict;
    if (!verdict.allow) throw new Denied(denyBody(verdict.reason, versionsOf(layer6), at));
    const meter = this.singleMeter(layer6, input, at);
    const step: ReserveStep = { client, principal, input, meter, ref: counterRefOf(principal.tenantId, meter, input), layer6, at };
    const key = { tenantId: principal.tenantId, featureId: input.featureId, key: input.idempotencyKey };
    await this.usage.lockReservationKey(client, key);
    const existing = await this.usage.findReservation(client, key);
    return existing === null ? this.reserveNew(step, meta) : this.replay(step, existing);
  }

  /** v1: exactly one meter, and a per-store meter needs exactly one target store. */
  private singleMeter(layer6: Layer6, input: AiEntitlementCheckInput, at: string): CatalogMeter {
    const meters = layer6.resolution.meters;
    const meter = meters.length === 1 ? meters[0]! : null;
    if (meter === null || !meterFits(meter, input)) throw new Denied(denyBody("entitlement_unavailable", versionsOf(layer6), at));
    return meter;
  }

  /** A replay of the key: the same reservation, never a second one; another user or body is refused. */
  private async replay(step: ReserveStep, existing: ReservedEntry): Promise<CheckOutcome> {
    if (!sameReplay(existing, step)) throw new Denied(denyBody("entitlement_unavailable", versionsOf(step.layer6), step.at));
    const state = await this.usage.counter(step.client, step.ref);
    const body: AllowBody = {
      decision: "allow",
      entitlementVersion: existing.entitlementVersion,
      optOutVersion: existing.optOutVersion ?? 0,
      meter: snapshot(step.meter, state),
      reservationId: existing.id,
      evaluatedAt: step.at,
    };
    return { decision: body, replay: { open: existing.open } };
  }

  /** The conditional reserve (exactly the units that fit, T3) and the `reserved` ledger row. */
  private async reserveNew(step: ReserveStep, meta: CheckMeta): Promise<CheckOutcome> {
    const { client, ref, meter, input, principal, layer6 } = step;
    await this.usage.ensureCounter(client, ref, newId());
    const counterId = await this.usage.tryReserve(client, { ref, units: input.unitsEstimate, limit: meter.limit });
    if (counterId === null) {
      const state = await this.usage.counter(client, ref);
      throw new Denied(denyBody("quota_exhausted", versionsOf(layer6), step.at, snapshot(meter, state)));
    }
    const reservationId = newId();
    await this.usage.insertReservation(client, {
      id: reservationId,
      tenantId: principal.tenantId,
      featureId: input.featureId,
      counterId,
      units: input.unitsEstimate,
      entitlementVersion: layer6.entitlementVersion,
      optOutVersion: layer6.optOutVersion === 0 ? null : layer6.optOutVersion,
      idempotencyKey: input.idempotencyKey,
      ttlSeconds: this.options.reservationTtlSeconds,
      actorUserId: principal.userId,
      requestId: meta.requestId ?? null,
    });
    const state = await this.usage.counter(client, ref);
    const body: AllowBody = {
      decision: "allow",
      entitlementVersion: layer6.entitlementVersion,
      optOutVersion: layer6.optOutVersion,
      meter: snapshot(meter, state),
      reservationId,
      evaluatedAt: step.at,
    };
    return { decision: body, replay: null };
  }
}
