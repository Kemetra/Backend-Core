/**
 * The two publishes of the shift variance policy (contract
 * `consolePublishTenantCashVariancePolicy`,
 * `consolePublishStoreCashVariancePolicyOverride`): the in-transaction checks
 * in the contract's order, each stopping the call, then the revision and its
 * `cash_variance_policy.changed` audit row in the same transaction.
 *
 * Every time rule runs on the database clock (`PolicyRepository.publishClock`),
 * the one the 0050 CHECKs use, so the expiry, the 90-day horizon, `permanent`
 * and the owner rule always agree with what the database stores.
 */
import type { PoolClient } from "pg";

import { insertPolicyChangedAudit } from "./policy-audit";
import { PolicyReader } from "./policy-reader";
import { compareStrictness, SUPPORTED_POLICY_CURRENCIES, type PolicyValue } from "./policy-value";
import { PolicyRepository, type StoredRevision } from "./policy.repository";

export type PolicyRefusalCode =
  | "policy_currency_unsupported"
  | "override_expiry_invalid"
  | "override_not_active"
  | "override_looser_than_tenant"
  | "owner_approval_required"
  | "cash_variance_policy_changed_concurrently";

const STATUS: Readonly<Record<PolicyRefusalCode, number>> = {
  policy_currency_unsupported: 422,
  override_expiry_invalid: 422,
  override_not_active: 422,
  override_looser_than_tenant: 422,
  owner_approval_required: 403,
  cash_variance_policy_changed_concurrently: 409,
};

/** A documented publish refusal; nothing was written. */
export class PolicyPublishRefusedError extends Error {
  readonly status: number;
  constructor(readonly code: PolicyRefusalCode) {
    super(code);
    this.name = "PolicyPublishRefusedError";
    this.status = STATUS[code];
  }
}

/** Who publishes, and where the audit row points. */
export interface PublishActor {
  readonly tenantId: string;
  readonly actorUserId: string;
  /** The caller's membership role in the tenant (null for none). */
  readonly roleCode: string | null;
  readonly requestId: string | null;
}

export interface TenantPublish {
  readonly expectedRevisionId: string | null;
  readonly policyValue: PolicyValue;
  readonly reason: string;
}

export interface StorePublish {
  readonly storeId: string;
  readonly expectedRevisionId: string | null;
  readonly kind: "set" | "clear";
  readonly policyValue?: PolicyValue;
  readonly reason: string;
  readonly effectiveUntil?: string;
}

function requireSupportedCurrency(value: PolicyValue | undefined): void {
  if (value?.mode === "limit" && !SUPPORTED_POLICY_CURRENCIES.has(value.currencyCode)) {
    throw new PolicyPublishRefusedError("policy_currency_unsupported");
  }
}

function requireExpected(latest: StoredRevision | null, expected: string | null): void {
  if ((latest?.id ?? null) !== expected) throw new PolicyPublishRefusedError("cash_variance_policy_changed_concurrently");
}

export class PolicyPublisher {
  constructor(
    private readonly repo: PolicyRepository = new PolicyRepository(),
    private readonly reader: PolicyReader = new PolicyReader(repo),
  ) {}

  /** Checks (4) currency, (5) `expectedRevisionId`, then (6) writes. */
  async publishTenant(client: PoolClient, actor: PublishActor, body: TenantPublish): Promise<StoredRevision> {
    const scope = { tenantId: actor.tenantId, storeId: null };
    await this.repo.lockScope(client, scope);
    requireSupportedCurrency(body.policyValue);
    const { latest, level } = await this.reader.tenant(client, actor.tenantId);
    requireExpected(latest, body.expectedRevisionId);
    const revision = await this.repo.insert(client, {
      ...scope,
      kind: "set",
      value: body.policyValue,
      reason: body.reason,
      effectiveUntil: null,
      permanent: false,
      supersedesRevisionId: latest?.id ?? null,
      createdByUserId: actor.actorUserId,
    });
    await insertPolicyChangedAudit(client, { ...actor, revision, oldValue: level.policyValue });
    return revision;
  }

  /**
   * Checks (4) currency, expiry, a clear with no active override, stricter
   * only, the owner rule; (5) `expectedRevisionId`; then (6) writes.
   */
  async publishStore(client: PoolClient, actor: PublishActor, body: StorePublish): Promise<StoredRevision> {
    const scope = { tenantId: actor.tenantId, storeId: body.storeId };
    await this.repo.lockScope(client, scope);
    requireSupportedCurrency(body.policyValue);
    const until = body.effectiveUntil ?? null;
    const clock = await this.repo.publishClock(client, until);
    if (!clock.untilAfterNow) throw new PolicyPublishRefusedError("override_expiry_invalid");
    const current = await this.reader.store(client, scope);
    const permanent = body.kind === "set" && clock.beyondHorizon;
    this.checkOverride(body, { current, permanent, roleCode: actor.roleCode });
    requireExpected(current.latestStore, body.expectedRevisionId);
    const revision = await this.repo.insert(client, {
      ...scope,
      kind: body.kind,
      value: body.kind === "set" ? (body.policyValue ?? null) : null,
      reason: body.reason,
      effectiveUntil: body.kind === "set" ? until : null,
      permanent,
      supersedesRevisionId: current.latestStore?.id ?? null,
      createdByUserId: actor.actorUserId,
    });
    await insertPolicyChangedAudit(client, { ...actor, revision, oldValue: current.activeOverride?.value ?? null });
    return revision;
  }

  /** The store rules after the currency and expiry, in the contract's order. */
  private checkOverride(
    body: StorePublish,
    state: {
      readonly current: Awaited<ReturnType<PolicyReader["store"]>>;
      readonly permanent: boolean;
      readonly roleCode: string | null;
    },
  ): void {
    if (body.kind === "clear") {
      if (state.current.activeOverride === null) throw new PolicyPublishRefusedError("override_not_active");
      return;
    }
    const value = body.policyValue;
    if (value !== undefined && compareStrictness(value, state.current.tenantLevel.policyValue) < 0) {
      throw new PolicyPublishRefusedError("override_looser_than_tenant");
    }
    if (state.permanent && state.roleCode !== "owner") throw new PolicyPublishRefusedError("owner_approval_required");
  }
}
