/**
 * CashierAdmissionsService — the server's cashier admission authority
 * (RT-113 BC2; decisions D2 / D8 / D9 / D11 in comment 10763, accepted basis
 * in 10826; contract `pos-cashier-admissions.openapi.yaml`).
 *
 * `admit` runs in ONE tenant-scoped transaction and decides in the
 * contract's outcome order (401 is the guard's, 400 the DTO pipe's):
 *
 *   1. lock the idempotency key, then the cashier (tenant, store, user), then
 *      read the clock ONCE (`clock_timestamp()`, after any wait on the locks;
 *      every comparison and write below uses that instant)
 *   2. same key + different body → 409; end an expired live admission
 *   3. replay candidate? (same body, its admission still live on this device)
 *   4. a fresh takeover over the per-device limit → 429
 *   5. eligibility → 403 `refused` (audited by category, logged by request_id)
 *   6. replay candidate → the stored 200, nothing applied again
 *   7. live elsewhere without takeover → `active_elsewhere` (nothing recorded)
 *   8. otherwise admit: create, renew (same id, heartbeat) or take over
 *
 * Only an `admitted` outcome writes the replay entry (contract: only 200
 * outcomes are recorded; `active_elsewhere` records nothing).
 *
 * `end` (RT-219, `[GATED]` approval: RT-219 comment 10877): an `end` that
 * echoes an `admission_generation` ends the admission only while that is its
 * current generation. A stale echo (the admission was renewed after the
 * `admitted` it came from, e.g. the same cashier signed in again on this
 * till) changes nothing and still answers `ended`. Without an echo the end is
 * unconditional, as in 1.0.0-draft.
 */
import type { Logger } from "@data-pulse-2/shared";
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import { admissionAction, keyDigest, requestFingerprint, type LiveAdmission } from "./admission-request";
import { ADMISSION_AUDIT_ACTIONS, type AdmissionAuditEvent, type AdmissionAuditWriter } from "./cashier-admissions.audit";
import type { CashierAdmissionPolicy } from "./cashier-admissions.config";
import type {
  AdmissionStore,
  AdmissionRecord,
  EndResult,
  StoredAdmittedBody,
  StoredRequest,
} from "./cashier-admissions.repository";
import type { CashierEligibilityReader, Eligibility, RefusalReason } from "./cashier-eligibility";
import type { DeviceScope } from "./device-scope";
import type { AdmissionRequestInput, AdmittedBody, EndedBody, RosterBody } from "./dto";
import type { TakeoverLimit } from "./takeover-rate-limit";

export type { AdmissionStore, StoredRequest } from "./cashier-admissions.repository";

/**
 * The generation completed into a replay entry stored before RT-219. Real
 * generations are microseconds since the epoch of a recent instant, so "0"
 * never matches: an `end` echoing it is a no-op (the safe direction), and the
 * terminal gets a real generation on its next heartbeat.
 */
export const PRE_GENERATION_REPLAY = "0";

/** Which admission an `end` targets, and the generation it echoed (RT-219). */
export interface EndTarget {
  readonly admissionId: string;
  /** null: no echo — the end is unconditional. */
  readonly generation: string | null;
}

export type AdmitOutcome =
  | { readonly kind: "admitted"; readonly body: AdmittedBody }
  | { readonly kind: "active_elsewhere" }
  | { readonly kind: "refused" }
  | { readonly kind: "idempotency_conflict" }
  | { readonly kind: "rate_limited" };

/** Runs `work` in one transaction with the tenant GUC set (RLS). */
export type TenantTransaction = <T>(tenantId: string, work: (client: PoolClient) => Promise<T>) => Promise<T>;

export interface AdmissionPorts {
  readonly tx: TenantTransaction;
  readonly admissions: AdmissionStore;
  readonly eligibility: CashierEligibilityReader;
  readonly takeoverLimit: TakeoverLimit;
  readonly audit: AdmissionAuditWriter;
  readonly logger: Pick<Logger, "warn">;
  readonly policy: () => CashierAdmissionPolicy;
}

type EligibleCashier = Extract<Eligibility, { eligible: true }>;

/** Everything one admission request needs, normalised once. */
type AdmitRequest = Omit<AdmitContext, "client" | "at">;

interface AdmitContext {
  readonly client: PoolClient;
  /** The clock reading taken after the locks. */
  readonly at: Date;
  readonly scope: DeviceScope;
  readonly body: AdmissionRequestInput;
  readonly userId: string;
  readonly takeover: boolean;
  readonly keyHash: Buffer;
  readonly requestHash: Buffer;
  readonly policy: CashierAdmissionPolicy;
  readonly requestId: string | null;
}

export class CashierAdmissionsService {
  constructor(private readonly ports: AdmissionPorts) {}

  async admit(scope: DeviceScope, body: AdmissionRequestInput, requestId: string | null): Promise<AdmitOutcome> {
    const request: AdmitRequest = {
      scope,
      body,
      userId: body.user_id,
      takeover: body.mode === "online" && body.takeover === true,
      keyHash: keyDigest(body.idempotency_key),
      requestHash: requestFingerprint(body),
      policy: this.ports.policy(),
      requestId,
    };
    return this.ports.tx(scope.tenantId, async (client) =>
      this.admitInTx({ ...request, client, at: await this.lockAndReadClock(client, request) }),
    );
  }

  async end(scope: DeviceScope, target: EndTarget, requestId: string | null): Promise<EndedBody> {
    await this.ports.tx(scope.tenantId, async (client) => {
      const outcome = await this.endIfOwned(client, scope, target);
      await this.ports.audit.record(client, {
        scope,
        action: ADMISSION_AUDIT_ACTIONS.ended,
        actorUserId: outcome.userId,
        targetId: target.admissionId,
        requestId,
        metadata: endMetadata(scope, target.admissionId, outcome),
      });
    });
    // The same answer whatever happened: `end` is idempotent and
    // non-disclosing, and a stale generation must not change the POS flow.
    return { kind: "ended" };
  }

  async roster(scope: DeviceScope): Promise<RosterBody> {
    const cashiers = await this.ports.tx(scope.tenantId, (client) => this.ports.eligibility.roster(client, scope));
    return { cashiers };
  }

  // -------------------------------------------------------------------------
  // admit
  // -------------------------------------------------------------------------

  /** Take both locks (key, then cashier), then read the clock once. */
  private async lockAndReadClock(client: PoolClient, request: AdmitRequest): Promise<Date> {
    const { admissions } = this.ports;
    await admissions.lockRequestKey(client, request.scope, request.keyHash);
    await admissions.lockCashier(client, request.scope, request.userId);
    return admissions.clock(client);
  }

  private async admitInTx(ctx: AdmitContext): Promise<AdmitOutcome> {
    const prior = await this.ports.admissions.findRequest(ctx.client, ctx.scope, { keyHash: ctx.keyHash, at: ctx.at });
    if (prior && !prior.requestHash.equals(ctx.requestHash)) return { kind: "idempotency_conflict" };

    await this.expireStale(ctx);
    const replay = await this.replayable(ctx, prior);
    if (!replay && !(await this.takeoverAllowed(ctx))) return { kind: "rate_limited" };

    const eligibility = await this.ports.eligibility.check(ctx.client, ctx.scope, ctx.userId);
    if (!eligibility.eligible) return this.refuse(ctx, eligibility.reason);
    if (replay) return { kind: "admitted", body: replayBody(replay.responseBody) };
    return this.decide(ctx, eligibility);
  }

  private async expireStale(ctx: AdmitContext): Promise<void> {
    const expired = await this.ports.admissions.expireStale(ctx.client, ctx.scope, { userId: ctx.userId, at: ctx.at });
    for (const admission of expired) {
      // Attributed to the device that held the admission, not the requester.
      await this.record(ctx, ADMISSION_AUDIT_ACTIONS.expired, admission.id, {
        device_id: admission.deviceId,
        user_id: ctx.userId,
        prior_admission_id: admission.id,
      });
    }
  }

  /** A stored response is replayable only while its admission is live here. */
  private async replayable(ctx: AdmitContext, prior: StoredRequest | null): Promise<StoredRequest | null> {
    if (!prior) return null;
    const live = await this.ports.admissions.isLiveOnDevice(ctx.client, ctx.scope, prior.admissionId);
    return live ? prior : null;
  }

  /** Only a fresh takeover consumes the per-device budget. */
  private async takeoverAllowed(ctx: AdmitContext): Promise<boolean> {
    if (!ctx.takeover) return true;
    return this.ports.takeoverLimit.allow(ctx.scope.deviceId, ctx.policy.takeoverLimit);
  }

  private async refuse(ctx: AdmitContext, reason: RefusalReason): Promise<AdmitOutcome> {
    // The cause is server-side only, keyed by request_id (SR-6/7).
    this.ports.logger.warn({ request_id: ctx.requestId, refusal: reason }, "cashier admission refused");
    await this.ports.audit.record(ctx.client, {
      scope: ctx.scope,
      action: ADMISSION_AUDIT_ACTIONS.refused,
      actorUserId: null,
      targetId: null,
      requestId: ctx.requestId,
      metadata: { device_id: ctx.scope.deviceId, user_id: ctx.userId, category: reason },
    });
    return { kind: "refused" };
  }

  private async decide(ctx: AdmitContext, cashier: EligibleCashier): Promise<AdmitOutcome> {
    const live = await this.ports.admissions.findLive(ctx.client, ctx.scope, ctx.userId);
    const action = admissionAction(live, ctx.scope.deviceId, ctx.takeover);
    if (action === "active_elsewhere") return { kind: "active_elsewhere" };

    const record = await this.apply(ctx, action, live);
    const body = admittedBody(record, cashier, ctx.policy);
    await this.ports.admissions.saveRequest(ctx.client, ctx.scope, {
      at: ctx.at,
      keyHash: ctx.keyHash,
      requestHash: ctx.requestHash,
      admissionId: record.id,
      responseBody: body,
      ttlSeconds: ctx.policy.admissionTtlSeconds,
    });
    return { kind: "admitted", body };
  }

  private async apply(
    ctx: AdmitContext,
    action: "create" | "renew" | "takeover",
    live: LiveAdmission | null,
  ): Promise<AdmissionRecord> {
    if (action === "renew") return this.renew(ctx, live!.id);
    if (action === "takeover") return this.takeOver(ctx, live!.id);
    return this.create(ctx, null);
  }

  private async renew(ctx: AdmitContext, admissionId: string): Promise<AdmissionRecord> {
    const ttl = ctx.policy.admissionTtlSeconds;
    const record = await this.ports.admissions.renew(ctx.client, ctx.scope, { admissionId, at: ctx.at }, ttl);
    await this.record(ctx, ADMISSION_AUDIT_ACTIONS.renewed, record.id, admissionMetadata(ctx));
    return record;
  }

  private async takeOver(ctx: AdmitContext, priorId: string): Promise<AdmissionRecord> {
    await this.ports.admissions.end(ctx.client, ctx.scope, { admissionId: priorId, at: ctx.at }, "takeover");
    return this.create(ctx, priorId);
  }

  private async create(ctx: AdmitContext, takeoverOf: string | null): Promise<AdmissionRecord> {
    const record = await this.ports.admissions.create(ctx.client, {
      id: newId(),
      at: ctx.at,
      scope: ctx.scope,
      userId: ctx.userId,
      mode: ctx.body.mode,
      offlineAdmittedAt: ctx.body.mode === "reconcile_offline" ? ctx.body.offline_admitted_at : null,
      takeoverOf,
      ttlSeconds: ctx.policy.admissionTtlSeconds,
    });
    const action = takeoverOf === null ? ADMISSION_AUDIT_ACTIONS.admitted : ADMISSION_AUDIT_ACTIONS.takeover;
    const metadata = takeoverOf === null ? admissionMetadata(ctx) : { ...admissionMetadata(ctx), prior_admission_id: takeoverOf };
    await this.record(ctx, action, record.id, metadata);
    return record;
  }

  private async record(
    ctx: AdmitContext,
    action: AdmissionAuditEvent["action"],
    admissionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.ports.audit.record(ctx.client, {
      scope: ctx.scope,
      action,
      actorUserId: ctx.userId,
      targetId: admissionId,
      requestId: ctx.requestId,
      metadata,
    });
  }

  // -------------------------------------------------------------------------
  // end
  // -------------------------------------------------------------------------

  /**
   * Ends this device's live admission unless the echoed generation is stale.
   * The generation is compared under the cashier lock, after any renewal
   * queued before this end has committed.
   */
  private async endIfOwned(client: PoolClient, scope: DeviceScope, target: EndTarget): Promise<EndOutcome> {
    const { admissions } = this.ports;
    const owned = await admissions.findOwned(client, scope, target.admissionId);
    if (!owned) return NOT_LIVE;
    await admissions.lockCashier(client, scope, owned.userId);
    const at = await admissions.clock(client);
    const result = await admissions.endOwned(client, scope, { ...target, at });
    return result === "not_live" ? NOT_LIVE : { result, userId: owned.userId };
  }
}

/** What an `end` did, and the cashier when the admission was live here. */
type EndOutcome = { readonly result: "not_live"; readonly userId: null } | {
  readonly result: Exclude<EndResult, "not_live">;
  readonly userId: string;
};

const NOT_LIVE: EndOutcome = { result: "not_live", userId: null };

/** A stored body, completed with a never-matching generation if it predates RT-219. */
function replayBody(body: StoredAdmittedBody): AdmittedBody {
  return { ...body, admission_generation: body.admission_generation ?? PRE_GENERATION_REPLAY };
}

function admittedBody(record: AdmissionRecord, cashier: EligibleCashier, policy: CashierAdmissionPolicy): AdmittedBody {
  return {
    kind: "admitted",
    admission_id: record.id,
    offline_grace_seconds: policy.offlineGraceSeconds,
    admission_ttl_seconds: policy.admissionTtlSeconds,
    server_time: record.renewedAt.toISOString(),
    display_name: cashier.displayName,
    admission_generation: record.generation,
  };
}

/** Audit metadata for an admission: ids, mode and the offline provenance. */
function admissionMetadata(ctx: AdmitContext): Record<string, unknown> {
  const base = { device_id: ctx.scope.deviceId, user_id: ctx.userId, mode: ctx.body.mode };
  return ctx.body.mode === "reconcile_offline"
    ? { ...base, offline_admitted_at: ctx.body.offline_admitted_at }
    : base;
}

/**
 * An `end` on an admission not live on this device records only what the
 * device itself sent (the contract: only what is visible in the device's own
 * tenant scope). A stale-generation no-op is on the device's OWN live
 * admission, so it names the cashier and the cause (RT-219).
 */
function endMetadata(scope: DeviceScope, admissionId: string, outcome: EndOutcome): Record<string, unknown> {
  if (outcome.userId === null) return { device_id: scope.deviceId, prior_admission_id: admissionId, changed: false };
  const base = { device_id: scope.deviceId, user_id: outcome.userId, prior_admission_id: admissionId };
  return outcome.result === "ended" ? { ...base, changed: true } : { ...base, changed: false, stale_generation: true };
}
