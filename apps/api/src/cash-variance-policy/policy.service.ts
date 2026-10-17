/**
 * CashVariancePolicyService — RT-387 (AD-CASH-001 F3): the shift variance
 * policy runtime on the RT-385 schema (`cash-variance-policy.openapi.yaml`
 * 1.0.0-draft).
 *
 * Every call runs in ONE transaction under the caller's tenant
 * (`runWithTenantContext` on the NOBYPASSRLS domain pool): RLS bounds every
 * statement to the tenant, which comes from the session or the device row,
 * never the request (§II, §XII).
 *
 * Store scope (not in RLS): a Console store operation first resolves the store
 * in the caller's operator-surface scope (`callerStoreScope`, the shift-closes
 * rule) and in the tenant, live (not deleted). Anything else — another
 * tenant's store, one outside the scope, a deleted or absent one — is the
 * same `PolicyStoreNotFoundError` (→ the non-disclosing 404).
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import type { Logger } from "@data-pulse-2/shared";

import { PG_POOL } from "../auth/auth.module";
import { ROOT_LOGGER } from "../common/logging.interceptor";
import { MembershipRepository } from "../context/membership.repository";
import { callerStoreScope, inStoreScope } from "../context/operator-store-scope";
import type { ResolvedContext } from "../context/types";
import { PolicyPublisher, type StorePublish, type TenantPublish } from "./policy-publish";
import { PolicyReader, tenantLevelOf } from "./policy-reader";
import {
  decodePolicyCursor,
  encodePolicyCursor,
  HORIZON_DAYS,
  toActiveOverride,
  toRevisionBody,
  type DevicePolicyBody,
  type RevisionPage,
  type StorePolicyBody,
  type TenantPolicyBody,
} from "./policy.projections";
import { PolicyRepository } from "./policy.repository";

/** A store outside the caller's scope, of another tenant, deleted or absent → 404. */
export class PolicyStoreNotFoundError extends Error {
  constructor() {
    super("store not found");
    this.name = "PolicyStoreNotFoundError";
  }
}

/** The session context of a Console call. */
export interface ConsoleInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
}

export interface ListInput extends ConsoleInput {
  readonly cursor: string | null;
  readonly limit: number;
}

export interface PublishInput extends ConsoleInput {
  readonly actorUserId: string;
  readonly requestId: string | null;
}

@Injectable()
export class CashVariancePolicyService {
  private readonly repo = new PolicyRepository();
  private readonly reader: PolicyReader;
  private readonly publisher: PolicyPublisher;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
    @Optional() @Inject(ROOT_LOGGER) logger?: Logger,
  ) {
    this.reader = new PolicyReader(this.repo, logger);
    this.publisher = new PolicyPublisher(this.repo, this.reader);
  }

  /** `posGetCashVariancePolicy`: the device's own store, resolved now. */
  deviceRead(scope: { readonly tenantId: string; readonly storeId: string }): Promise<DevicePolicyBody> {
    return this.inTenant(scope.tenantId, async (client) => {
      const resolution = await this.reader.store(client, scope);
      return { ...resolution.effective, serverTime: resolution.now.toISOString() };
    });
  }

  tenantRead(input: ConsoleInput): Promise<TenantPolicyBody> {
    return this.inTenant(input.tenantId, (client) => this.tenantBody(client, input.tenantId));
  }

  tenantRevisions(input: ListInput): Promise<RevisionPage> {
    const scope = { tenantId: input.tenantId, storeId: null };
    const keyset = input.cursor === null ? null : decodePolicyCursor(scope, input.cursor);
    return this.inTenant(input.tenantId, (client) => this.revisionPage(client, { ...input, scope, keyset }));
  }

  tenantPublish(input: PublishInput, body: TenantPublish): Promise<TenantPolicyBody> {
    return this.inTenant(input.tenantId, async (client) => {
      await this.publisher.publishTenant(client, await this.actor(client, input), body);
      return this.tenantBody(client, input.tenantId);
    });
  }

  storeRead(input: ConsoleInput, storeId: string): Promise<StorePolicyBody> {
    return this.inTenant(input.tenantId, async (client) => {
      await this.requireStore(client, input, storeId);
      return this.storeBody(client, { tenantId: input.tenantId, storeId });
    });
  }

  storeRevisions(input: ListInput, storeId: string): Promise<RevisionPage> {
    const scope = { tenantId: input.tenantId, storeId };
    const keyset = input.cursor === null ? null : decodePolicyCursor(scope, input.cursor);
    return this.inTenant(input.tenantId, async (client) => {
      await this.requireStore(client, input, storeId);
      return this.revisionPage(client, { ...input, scope, keyset });
    });
  }

  storePublish(input: PublishInput, body: StorePublish): Promise<StorePolicyBody> {
    return this.inTenant(input.tenantId, async (client) => {
      await this.requireStore(client, input, body.storeId);
      await this.publisher.publishStore(client, await this.actor(client, input), body);
      return this.storeBody(client, { tenantId: input.tenantId, storeId: body.storeId });
    });
  }

  private inTenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, work);
  }

  private async actor(client: PoolClient, input: PublishInput) {
    const roleCode = await this.memberships.findRoleCodeForUserInTenant(input.actorUserId, input.tenantId, client);
    return { tenantId: input.tenantId, actorUserId: input.actorUserId, roleCode, requestId: input.requestId };
  }

  /** The store in the caller's operator-surface scope, live, in the session tenant; else 404. */
  private async requireStore(client: PoolClient, input: ConsoleInput, storeId: string): Promise<void> {
    const scope = await callerStoreScope(client, this.memberships, input);
    if (!inStoreScope(scope, storeId)) throw new PolicyStoreNotFoundError();
    const r = await client.query(
      `SELECT 1 FROM stores WHERE id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL`,
      [storeId, input.tenantId],
    );
    if (r.rows.length === 0) throw new PolicyStoreNotFoundError();
  }

  private async tenantBody(client: PoolClient, tenantId: string): Promise<TenantPolicyBody> {
    const { now, latest } = await this.reader.tenant(client, tenantId);
    return {
      tenantDefault: tenantLevelOf(latest, now),
      latestRevision: latest === null ? null : toRevisionBody(latest, { latestId: latest.id, now }),
      latestRevisionId: latest?.id ?? null,
    };
  }

  private async storeBody(
    client: PoolClient,
    scope: { readonly tenantId: string; readonly storeId: string },
  ): Promise<StorePolicyBody> {
    const r = await this.reader.store(client, scope);
    return {
      storeId: scope.storeId,
      effective: r.effective,
      tenantDefault: r.tenantLevel,
      activeOverride: r.activeOverride === null ? null : toActiveOverride(r.activeOverride),
      latestRevisionId: r.latestStore?.id ?? null,
      permanentOverrideHorizonDays: HORIZON_DAYS,
    };
  }

  private async revisionPage(
    client: PoolClient,
    input: {
      readonly scope: { readonly tenantId: string; readonly storeId: string | null };
      readonly keyset: ReturnType<typeof decodePolicyCursor> | null;
      readonly limit: number;
    },
  ): Promise<RevisionPage> {
    const now = await this.repo.now(client);
    const latest = await this.repo.latest(client, input.scope);
    const rows = await this.repo.page(client, { ...input.scope, keyset: input.keyset, limit: input.limit });
    const items = rows.slice(0, input.limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > input.limit && last !== undefined
        ? encodePolicyCursor(input.scope, { createdAtKey: last.createdAtKey, id: last.id })
        : null;
    return { items: items.map((r) => toRevisionBody(r, { latestId: latest?.id ?? null, now })), nextCursor };
  }
}
