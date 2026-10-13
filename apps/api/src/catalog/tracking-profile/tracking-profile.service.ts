/**
 * TrackingProfileService — RT-448 (RT-50 Inventory Gate 7, rule G7-1).
 *
 * Reads and sets a Tenant Catalog product's Tracking Profile: `tracking_mode`
 * none | batch | serial and `expiry_required` (decisions 852, 384, 386). The
 * ERPNext Item never defines it.
 *
 * The guard (387): once the product has an inventory effect or a captured sale
 * line, changing either field is refused. The service locks the product row
 * (`FOR UPDATE`), probes the history and answers `locked` before writing; the
 * 0045 `tenant_products_guard_tracking_profile` trigger enforces the same rule
 * at the database for every writer, and its error (SQLSTATE 23514, constraint
 * `tenant_products_tracking_profile_locked`) maps to the same result if a
 * history row commits between the probe and the UPDATE. Writing the same values
 * again is not a change and succeeds.
 *
 * Every call runs inside one `runWithTenantContext` transaction, so RLS hides
 * other tenants' products: a cross-tenant id is a non-disclosing `not_found`.
 * The happy-path audit subject (`catalog.tracking_profile.set`) is emitted by
 * the controller's `@Auditable` decorator.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { PoolClient, Pool } from "pg";

import { runWithTenantContext, type TrackingMode } from "@data-pulse-2/db";
import type { Logger } from "@data-pulse-2/shared";

import { PG_POOL } from "../../auth/auth.module";
import { ROOT_LOGGER } from "../../common/logging.interceptor";
import type { TrackingProfileRow } from "./tracking-profile.dto";

export type GetTrackingProfileResult =
  | { kind: "ok"; row: TrackingProfileRow }
  | { kind: "not_found" };

export type SetTrackingProfileResult =
  | { kind: "ok"; row: TrackingProfileRow }
  | { kind: "not_found" }
  | { kind: "locked" };

export interface SetTrackingProfileInput {
  readonly tenantId: string;
  readonly productId: string;
  readonly trackingMode: TrackingMode;
  readonly expiryRequired: boolean;
  readonly actorUserId: string;
}

const LOCK_CONSTRAINT = "tenant_products_tracking_profile_locked";

function isProfileLockedError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "23514" &&
    (err as { constraint?: unknown }).constraint === LOCK_CONSTRAINT
  );
}

interface ProfileDbRow {
  id: string;
  tracking_mode: TrackingMode;
  expiry_required: boolean;
}

@Injectable()
export class TrackingProfileService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Logger,
  ) {}

  async get(input: {
    readonly tenantId: string;
    readonly productId: string;
  }): Promise<GetTrackingProfileResult> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<GetTrackingProfileResult> => {
        const r = await client.query<ProfileDbRow>(
          `SELECT id, tracking_mode, expiry_required FROM tenant_products WHERE id = $1`,
          [input.productId],
        );
        const row = r.rows[0];
        if (!row) return { kind: "not_found" };
        return { kind: "ok", row: await this.toRow(client, row) };
      },
    );
  }

  async set(input: SetTrackingProfileInput): Promise<SetTrackingProfileResult> {
    try {
      return await runWithTenantContext(
        this.pool,
        { tenantId: input.tenantId, isPlatformAdmin: false },
        (client) => this.setInTransaction(client, input),
      );
    } catch (err: unknown) {
      // A history row committed between the probe and the UPDATE: the 0045
      // trigger refused the change. Same answer as the probe.
      if (isProfileLockedError(err)) return { kind: "locked" };
      throw err;
    }
  }

  private async setInTransaction(
    client: PoolClient,
    input: SetTrackingProfileInput,
  ): Promise<SetTrackingProfileResult> {
    const current = await client.query<ProfileDbRow>(
      `SELECT id, tracking_mode, expiry_required FROM tenant_products
        WHERE id = $1 FOR UPDATE`,
      [input.productId],
    );
    const row = current.rows[0];
    if (!row) return { kind: "not_found" };

    const unchanged =
      row.tracking_mode === input.trackingMode && row.expiry_required === input.expiryRequired;
    if (unchanged) return { kind: "ok", row: await this.toRow(client, row) };
    if (await this.hasHistory(client, input.productId)) return { kind: "locked" };

    const updated = await client.query<ProfileDbRow>(
      `UPDATE tenant_products
          SET tracking_mode = $2, expiry_required = $3, updated_by = $4
        WHERE id = $1
        RETURNING id, tracking_mode, expiry_required`,
      [input.productId, input.trackingMode, input.expiryRequired, input.actorUserId],
    );
    this.logger?.info(
      {
        tenant_id: input.tenantId,
        product_id: input.productId,
        tracking_mode: input.trackingMode,
        expiry_required: input.expiryRequired,
        action: "catalog.tracking_profile.set",
      },
      "tracking-profile: set",
    );
    return { kind: "ok", row: { ...this.base(updated.rows[0]!), profileLocked: false } };
  }

  /** 387: an inventory effect or a captured sale line locks the profile. */
  private async hasHistory(client: PoolClient, productId: string): Promise<boolean> {
    const r = await client.query<{ locked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM stock_movements WHERE tenant_product_ref = $1)
           OR EXISTS (SELECT 1 FROM sale_lines WHERE tenant_product_ref = $1) AS locked`,
      [productId],
    );
    return r.rows[0]?.locked === true;
  }

  private async toRow(client: PoolClient, row: ProfileDbRow): Promise<TrackingProfileRow> {
    return { ...this.base(row), profileLocked: await this.hasHistory(client, row.id) };
  }

  private base(row: ProfileDbRow): Omit<TrackingProfileRow, "profileLocked"> {
    return {
      productId: row.id,
      trackingMode: row.tracking_mode,
      expiryRequired: row.expiry_required,
    };
  }
}
