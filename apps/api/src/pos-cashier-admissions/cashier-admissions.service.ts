/**
 * CashierAdmissionsService — the server's cashier admission authority
 * (RT-113 BC2; decisions D2 / D8 / D9 / D11 in comment 10763, accepted basis
 * in 10826; contract `pos-cashier-admissions.openapi.yaml`).
 *
 * `admit` runs in ONE tenant-scoped transaction and decides in the
 * contract's outcome order (401 is the guard's, 400 the DTO pipe's):
 *
 *   1. lock the idempotency key; same key + different body → 409
 *   2. lock the cashier (tenant, store, user); end an expired live admission
 *   3. replay candidate? (same body, its admission still live on this device)
 *   4. a fresh takeover over the per-device limit → 429
 *   5. eligibility → 403 `refused` (audited by category, logged by request_id)
 *   6. replay candidate → the stored 200, nothing applied again
 *   7. live elsewhere without takeover → `active_elsewhere` (nothing recorded)
 *   8. otherwise admit: create, renew (same id, heartbeat) or take over
 *
 * Only an `admitted` outcome writes the replay entry (contract: only 200
 * outcomes are recorded; `active_elsewhere` records nothing).
 */
import type { Logger } from "@data-pulse-2/shared";
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import { admissionAction, keyDigest, requestFingerprint, type LiveAdmission } from "./admission-request";
import { ADMISSION_AUDIT_ACTIONS, type AdmissionAuditEvent, type AdmissionAuditWriter } from "./cashier-admissions.audit";
import type { CashierAdmissionPolicy } from "./cashier-admissions.config";
import type { AdmissionStore, AdmissionRecord, StoredRequest } from "./cashier-admissions.repository";
import type { CashierEligibilityReader, Eligibility, RefusalReason } from "./cashier-eligibility";
import type { DeviceScope } from "./device-scope";
import type { AdmissionRequestInput, AdmittedBody, EndedBody, RosterBody } from "./dto";
import type { TakeoverLimit } from "./takeover-rate-limit";

export type { AdmissionStore, StoredRequest } from "./cashier-admissions.repository";

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
interface AdmitContext {
  readonly client: PoolClient;
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
    const policy = this.ports.policy();
    return this.ports.tx(scope.tenantId, (client) =>
      this.admitInTx({
        client,
        scope,
        body,
        userId: body.user_id,
        takeover: body.mode === "online" && body.takeover === true,
        keyHash: keyDigest(body.idempotency_key),
        requestHash: requestFingerprint(body),
        policy,
        requestId,
      }),
    );
  }

  async end(scope: DeviceScope, admissionId: string, requestId: string | null): Promise<EndedBody> {
    await this.ports.tx(scope.tenantId, async (client) => {
      const userId = await this.endIfOwned(client, scope, admissionId);
      await this.ports.audit.record(client, {
        scope,
        action: ADMISSION_AUDIT_ACTIONS.ended,
        actorUserId: userId,
        targetId: admissionId,
        requestId,
        metadata: endMetadata(scope, admissionId, userId),
      });
    });
    return { kind: "ended" };
  }

  async roster(scope: DeviceScope): Promise<RosterBody> {
    const cashiers = await this.ports.tx(scope.tenantId, (client) => this.ports.eligibility.roster(client, scope));
    return { cashiers };
  }

  // -------------------------------------------------------------------------
  // admit
  // -------------------------------------------------------------------------

  private async admitInTx(ctx: AdmitContext): Promise<AdmitOutcome> {
    const { admissions } = this.ports;
    await admissions.lockRequestKey(ctx.client, ctx.scope, ctx.keyHash);
    const prior = await admissions.findRequest(ctx.client, ctx.scope, ctx.keyHash);
    if (prior && !prior.requestHash.equals(ctx.requestHash)) return { kind: "idempotency_conflict" };

    await admissions.lockCashier(ctx.client, ctx.scope, ctx.userId);
    await this.expireStale(ctx);
    const replay = await this.replayable(ctx, prior);
    if (!replay && !(await this.takeoverAllowed(ctx))) return { kind: "rate_limited" };

    const eligibility = await this.ports.eligibility.check(ctx.client, ctx.scope, ctx.userId);
    if (!eligibility.eligible) return this.refuse(ctx, eligibility.reason);
    if (replay) return { kind: "admitted", body: replay.responseBody };
    return this.decide(ctx, eligibility);
  }

  private async expireStale(ctx: AdmitContext): Promise<void> {
    const expired = await this.ports.admissions.expireStale(ctx.client, ctx.scope, ctx.userId);
    for (const admissionId of expired) {
      await this.record(ctx, ADMISSION_AUDIT_ACTIONS.expired, admissionId, {
        device_id: ctx.scope.deviceId,
        user_id: ctx.userId,
        prior_admission_id: admissionId,
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
    const record = await this.ports.admissions.renew(ctx.client, ctx.scope, admissionId, ttl);
    await this.record(ctx, ADMISSION_AUDIT_ACTIONS.renewed, record.id, admissionMetadata(ctx));
    return record;
  }

  private async takeOver(ctx: AdmitContext, priorId: string): Promise<AdmissionRecord> {
    await this.ports.admissions.end(ctx.client, ctx.scope, priorId, "takeover");
    return this.create(ctx, priorId);
  }

  private async create(ctx: AdmitContext, takeoverOf: string | null): Promise<AdmissionRecord> {
    const record = await this.ports.admissions.create(ctx.client, {
      id: newId(),
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

  /** Ends this device's live admission; returns its user when it changed. */
  private async endIfOwned(client: PoolClient, scope: DeviceScope, admissionId: string): Promise<string | null> {
    const { admissions } = this.ports;
    const owned = await admissions.findOwned(client, scope, admissionId);
    if (!owned) return null;
    await admissions.lockCashier(client, scope, owned.userId);
    return (await admissions.endOwned(client, scope, admissionId)) ? owned.userId : null;
  }
}

function admittedBody(record: AdmissionRecord, cashier: EligibleCashier, policy: CashierAdmissionPolicy): AdmittedBody {
  return {
    kind: "admitted",
    admission_id: record.id,
    offline_grace_seconds: policy.offlineGraceSeconds,
    admission_ttl_seconds: policy.admissionTtlSeconds,
    server_time: record.renewedAt.toISOString(),
    display_name: cashier.displayName,
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
 * An `end` that changed nothing records only what the device itself sent
 * (the contract: only what is visible in the device's own tenant scope).
 */
function endMetadata(scope: DeviceScope, admissionId: string, userId: string | null): Record<string, unknown> {
  return userId === null
    ? { device_id: scope.deviceId, prior_admission_id: admissionId, changed: false }
    : { device_id: scope.deviceId, user_id: userId, prior_admission_id: admissionId, changed: true };
}
