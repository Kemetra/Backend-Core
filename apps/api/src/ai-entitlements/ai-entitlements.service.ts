/**
 * AiEntitlementsService — RT-664: the runtime of the two Console operations
 * of `ai-entitlements.openapi.yaml` (RT-662).
 *
 *   read    `consoleGetTenantAiEntitlements` — the full or minimal view.
 *   optOut  `consolePutTenantAiFeatureOptOut` — the owner's subtract-only
 *           opt-out (D-5), in the contract's order (steps 4-8; 1-3 are the
 *           guards, the idempotency interceptor and the body pipe):
 *             4. the feature is a catalogue feature, else 404;
 *             5. under the tenant's opt-out chain lock, the stores are
 *                readable, else 503 (nothing written);
 *             6. `expectedOptOutVersion` is the head, else 409;
 *             7. an opt-in of a feature the plan does not include is 422;
 *             8. the same state writes nothing; otherwise the next opt-out
 *                version and one `ai_entitlement.opt_out_changed` audit row,
 *                in one transaction.
 *           An opt-out never writes an entitlement revision.
 *
 * Every call runs in ONE transaction in the session's tenant
 * (`runWithTenantContext` on the NOBYPASSRLS domain pool). A failure of an
 * entitlement read is `EntitlementUnavailableError` (503): the read never
 * returns a guessed view.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId, type Logger } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { ROOT_LOGGER } from "../common/logging.interceptor";
import { MembershipRepository } from "../context/membership.repository";
import { AI_ENTITLEMENTS_RUNTIME, type AiEntitlementsRuntime } from "./ai-entitlements.tokens";
import { insertAiAudit, OPT_OUT_CHANGED_ACTION } from "./ai-entitlements-audit";
import { EntitlementViewBuilder, type FullViewBody, type MinimalViewBody, type TenantEntitlementSnapshot } from "./entitlement-view";
import { ChainConflictError, EntitlementRepository, NO_OPT_OUT } from "./entitlement.repository";
import { unavailableLogger } from "./unavailable-log";

export class EntitlementUnavailableError extends Error {
  constructor() {
    super("the AI entitlement store cannot be read");
    this.name = "EntitlementUnavailableError";
  }
}
export class UnknownAiFeatureError extends Error {
  constructor() {
    super("unknown AI feature");
    this.name = "UnknownAiFeatureError";
  }
}
export class OptOutConflictError extends Error {
  constructor() {
    super("the opt-outs changed since they were read");
    this.name = "OptOutConflictError";
  }
}
export class OptInExceedsPlanError extends Error {
  constructor() {
    super("an opt-in cannot exceed the plan");
    this.name = "OptInExceedsPlanError";
  }
}

export interface OptOutWrite {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly featureId: string;
  readonly expectedOptOutVersion: number;
  readonly optedOut: boolean;
  readonly reason: string;
}


@Injectable()
export class AiEntitlementsService {
  private readonly entitlements = new EntitlementRepository();
  private readonly views = new EntitlementViewBuilder(this.entitlements);
  private readonly logUnavailable: (err: unknown) => void;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AI_ENTITLEMENTS_RUNTIME) private readonly runtime: AiEntitlementsRuntime,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
    @Optional() @Inject(ROOT_LOGGER) logger?: Pick<Logger, "warn">,
  ) {
    this.logUnavailable = unavailableLogger(logger, "console");
  }

  /** The caller's active membership role in the tenant, or null. An unreadable store is the 503. */
  roleOf(userId: string, tenantId: string): Promise<string | null> {
    return this.readable(() =>
      this.inTenant(tenantId, (client) => this.memberships.findRoleCodeForUserInTenant(userId, tenantId, client)),
    );
  }

  read(tenantId: string, view: "full" | "minimal"): Promise<FullViewBody | MinimalViewBody> {
    return this.readable(() =>
      this.inTenant(tenantId, async (client) => {
        const snap = await this.views.snapshot(client, tenantId);
        const enabled = this.runtime.isEnabled();
        return view === "full" ? this.views.full(client, tenantId, snap, enabled) : this.views.minimal(snap, enabled);
      }),
    );
  }

  optOut(write: OptOutWrite): Promise<FullViewBody> {
    return this.inTenant(write.tenantId, async (client) => {
      const known = await this.readable(() => this.entitlements.knownFeatures(client));
      if (!known.includes(write.featureId)) throw new UnknownAiFeatureError();
      const snap = await this.readable(async () => {
        await this.entitlements.lockChain(client, "opt_out", write.tenantId);
        return this.views.snapshot(client, write.tenantId);
      });
      this.requireWritable(snap, write);
      const current = (snap.optOuts.byFeature.get(write.featureId) ?? NO_OPT_OUT).optedOut;
      if (current === write.optedOut) return this.fullView(client, write.tenantId, snap);
      await this.writeOptOut(client, write, current, snap.optOuts.version + 1);
      return this.fullView(client, write.tenantId, await this.readable(() => this.views.snapshot(client, write.tenantId)));
    });
  }

  /** Steps 6 and 7: the version is current, and an opt-in never exceeds the plan (D-5). */
  private requireWritable(snap: TenantEntitlementSnapshot, write: OptOutWrite): void {
    if (snap.optOuts.version !== write.expectedOptOutVersion) throw new OptOutConflictError();
    const optIn = !write.optedOut;
    if (optIn && !this.views.entitled(snap, write.featureId)) throw new OptInExceedsPlanError();
  }

  private async writeOptOut(client: PoolClient, write: OptOutWrite, oldOptedOut: boolean, version: number): Promise<void> {
    const id = newId();
    try {
      await this.entitlements.insertOptOut(client, {
        id,
        tenantId: write.tenantId,
        version,
        featureId: write.featureId,
        optedOut: write.optedOut,
        reason: write.reason,
        createdByUserId: write.actorUserId,
      });
    } catch (err) {
      throw err instanceof ChainConflictError ? new OptOutConflictError() : err;
    }
    await insertAiAudit(client, {
      tenantId: write.tenantId,
      actorUserId: write.actorUserId,
      requestId: write.requestId,
      action: OPT_OUT_CHANGED_ACTION,
      targetType: "tenant_ai_feature_opt_out",
      targetId: id,
      metadata: {
        feature_id: write.featureId,
        old_opted_out: oldOptedOut,
        new_opted_out: write.optedOut,
        reason: write.reason,
        opt_out_version: version,
      },
    });
  }

  private fullView(client: PoolClient, tenantId: string, snap: TenantEntitlementSnapshot): Promise<FullViewBody> {
    return this.readable(() => this.views.full(client, tenantId, snap, this.runtime.isEnabled()));
  }

  /** Runs `read` and maps any failure to the fail-closed 503, logging its class only. */
  private async readable<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (err) {
      this.logUnavailable(err);
      throw new EntitlementUnavailableError();
    }
  }

  private inTenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, work);
  }
}
