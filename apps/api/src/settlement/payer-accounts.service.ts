/**
 * PayerAccountsService — RT-418: create and list payer accounts
 * (`settlement/settlement.yaml` 2.0.0, RT-417; 035 narrowed to Option B).
 *
 * A payer account is identity only: who may owe part of a sale. Balances,
 * terms, aging and collection belong to ERPNext. Kept apart from the 035
 * receivable runtime so RT-422 can delete that runtime without touching this.
 *
 * Scope: the tenant comes from the session principal, RLS enforces it. Store
 * scope is NOT in RLS (tenant-only policies), so it is applied here with the
 * one store-scope rule (`resolveStoreScope`):
 *   - create: a non-null `storeId` must be a live store of the tenant inside
 *     the caller's scope, else the non-disclosing `PayerStoreNotInScopeError`
 *     (404). A null `storeId` is a tenant-wide payer.
 *   - list: tenant-wide payers plus the payers of the stores in scope; a
 *     store-scoped payer outside it is excluded.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool, PoolClient } from "pg";

import { PG_POOL } from "../auth/auth.module";
import { resolveStoreScope, type StoreScope } from "../context/store-scope";
import type { ResolvedContext } from "../context/types";
import type {
  PayerAccountCreateDto,
  PayerAccountRow,
  PayerAccountUpdateDto,
  PayerCategory,
} from "./dto/payer-account.dto";
import { insertPayerUpdatedAudit } from "./payer-account-audit";

/** The create's `storeId` is absent, of another tenant, deleted or outside the caller's scope (404). */
export class PayerStoreNotInScopeError extends Error {
  constructor() {
    super("store not in scope");
    this.name = "PayerStoreNotInScopeError";
  }
}

/** The update's payer is absent, of another tenant, or store-scoped outside the caller's store access (404). */
export class PayerNotFoundError extends Error {
  constructor() {
    super("payer not found");
    this.name = "PayerNotFoundError";
  }
}

/** A `status` / `externalRef` change of a tenant-wide payer needs tenant-wide store scope (403 `payer_scope_insufficient`). */
export class PayerScopeInsufficientError extends Error {
  constructor() {
    super("a tenant-wide payer change needs tenant-wide store scope");
    this.name = "PayerScopeInsufficientError";
  }
}

/** `expectedVersion` is not the payer's current version (409 `payer_version_conflict`). */
export class PayerVersionConflictError extends Error {
  constructor() {
    super("payer version conflict");
    this.name = "PayerVersionConflictError";
  }
}

export interface UpdatePayerAccountInput extends PayerScopedInput {
  readonly payerRef: string;
  readonly actorUserId: string | null;
  readonly requestId: string | null;
  readonly body: PayerAccountUpdateDto;
}

export interface PayerScopedInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
}

export interface ListPayerAccountsInput extends PayerScopedInput {
  readonly category?: PayerCategory;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface PayerAccountPageResult {
  readonly items: readonly PayerAccountRow[];
  readonly nextCursor: string | null;
}

const PAYER_COLUMNS = `id::text AS id, category, display_name, external_ref, status,
                       store_id::text AS store_id, version`;

@Injectable()
export class PayerAccountsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  create(input: PayerScopedInput & { readonly body: PayerAccountCreateDto }): Promise<PayerAccountRow> {
    const { tenantId, body } = input;
    const storeId = body.storeId ?? null;
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      if (storeId !== null) await assertStoreInScope(client, resolveStoreScope(input.context), { tenantId, storeId });
      const r = await client.query<PayerAccountRow>(
        `INSERT INTO payer_account
           (id, tenant_id, store_id, category, display_name, external_ref, status, version)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', 0)
         RETURNING ${PAYER_COLUMNS}`,
        [newId(), tenantId, storeId, body.category, body.displayName, body.externalRef ?? null],
      );
      return r.rows[0]!;
    });
  }

  /**
   * RT-572 `consoleUpdatePayerAccount`. One transaction: the payer row is
   * locked, then the refusals run in the contract's order (404 not found / out
   * of store scope, 403 tenant-wide scope, 409 version), then a no-op returns
   * the unchanged row, else the row is updated (`version + 1`) and the audit
   * row is written on the same client. Nothing outside the three fields moves.
   */
  update(input: UpdatePayerAccountInput): Promise<PayerAccountRow> {
    const { tenantId, payerRef, body } = input;
    const scope = resolveStoreScope(input.context);
    return runWithTenantContext(this.pool, { tenantId, isPlatformAdmin: false }, async (client) => {
      const locked = await client.query<PayerAccountRow>(
        `SELECT ${PAYER_COLUMNS} FROM payer_account WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [payerRef, tenantId],
      );
      const current = locked.rows[0];
      if (!current || !payerInStoreScope(current, scope)) throw new PayerNotFoundError();
      // The gate is the field's presence in the body, not an effective change.
      const touchesTenantWideField = body.status !== undefined || body.externalRef !== undefined;
      if (current.store_id === null && scope.kind !== "tenant" && touchesTenantWideField) {
        throw new PayerScopeInsufficientError();
      }
      if (current.version !== body.expectedVersion) throw new PayerVersionConflictError();

      const next = {
        displayName: body.displayName ?? current.display_name,
        externalRef: body.externalRef ?? current.external_ref,
        status: body.status ?? current.status,
      };
      const changedFields = [
        ...(next.displayName !== current.display_name ? ["displayName"] : []),
        ...(next.externalRef !== current.external_ref ? ["externalRef"] : []),
        ...(next.status !== current.status ? ["status"] : []),
      ];
      if (changedFields.length === 0) return current;

      const updated = await client.query<PayerAccountRow>(
        `UPDATE payer_account
            SET display_name = $3, external_ref = $4, status = $5, version = version + 1
          WHERE id = $1 AND tenant_id = $2 AND version = $6
          RETURNING ${PAYER_COLUMNS}`,
        [payerRef, tenantId, next.displayName, next.externalRef, next.status, body.expectedVersion],
      );
      const row = updated.rows[0];
      if (!row) throw new PayerVersionConflictError();
      await insertPayerUpdatedAudit(client, {
        tenantId,
        storeId: current.store_id,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        payerId: current.id,
        metadata: {
          payerRef: current.id,
          changedFields,
          fromVersion: current.version,
          toVersion: row.version,
          ...(changedFields.includes("status") ? { statusFrom: current.status, statusTo: next.status } : {}),
          ...(changedFields.includes("externalRef")
            ? { externalRefFrom: current.external_ref, externalRefTo: next.externalRef }
            : {}),
        },
      });
      return row;
    });
  }

  list(input: ListPayerAccountsInput): Promise<PayerAccountPageResult> {
    const scope = resolveStoreScope(input.context);
    const allStores = scope.kind === "tenant";
    const storeIds = scope.kind === "stores" ? scope.storeIds : [];
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, async (client) => {
      // Newest-first keyset on id (UUIDv7 from the create route), backed by
      // idx_payer_account_tenant_list (tenant_id, id DESC). One row past the
      // page tells whether a next page exists.
      const r = await client.query<PayerAccountRow>(
        `SELECT ${PAYER_COLUMNS}
           FROM payer_account
          WHERE tenant_id = $1
            AND ($2::text IS NULL OR category = $2)
            AND ($3::uuid IS NULL OR id < $3::uuid)
            AND (store_id IS NULL OR $4::boolean OR store_id = ANY($5::uuid[]))
          ORDER BY id DESC
          LIMIT $6`,
        [input.tenantId, input.category ?? null, input.cursor, allStores, storeIds, input.limit + 1],
      );
      const items = r.rows.slice(0, input.limit);
      const nextCursor = r.rows.length > input.limit ? items[items.length - 1]!.id : null;
      return { items, nextCursor };
    });
  }
}

/** The payer is tenant-wide, or its store is inside the caller's store scope (the list's rule). */
function payerInStoreScope(payer: PayerAccountRow, scope: StoreScope): boolean {
  return payer.store_id === null || scope.kind === "tenant" || scope.storeIds.includes(payer.store_id);
}

/** A live store of the tenant (RLS, and matched explicitly) inside the caller's store scope, else 404. */
async function assertStoreInScope(
  client: PoolClient,
  scope: StoreScope,
  store: { readonly tenantId: string; readonly storeId: string },
): Promise<void> {
  const { tenantId, storeId } = store;
  if (scope.kind === "stores" && !scope.storeIds.includes(storeId)) throw new PayerStoreNotInScopeError();
  const r = await client.query(`SELECT 1 FROM stores WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [
    storeId,
    tenantId,
  ]);
  if (r.rows.length === 0) throw new PayerStoreNotInScopeError();
}
