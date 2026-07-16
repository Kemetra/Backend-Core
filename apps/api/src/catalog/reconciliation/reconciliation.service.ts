/**
 * ReconciliationService — 005-WAVE2-LINK-HAPPY (T621) +
 *                          005-WAVE2-CREATE-HAPPY (T631).
 *
 * Implements the tenant-admin reconciliation surface:
 *   - linkUnknownItem (T621): link a pending unknown item to an existing
 *     active tenant product.
 *   - createProductFromUnknownItem (T631): create a brand-new
 *     tenant_products row directly from a pending unknown item.
 *
 * Both methods own a three-effect transaction described in FR-053 /
 * FR-063 and execute every effect inside a single `runWithTenantContext`
 * call so partial state can never be persisted.
 *
 * Returned discriminated unions:
 *   LinkResult (linkUnknownItem):
 *     {kind: "ok";                  row: UnknownItemRow}
 *     {kind: "not_found"}           — unknown item or product absent
 *     {kind: "already_reconciled"}  — item is already resolved/dismissed
 *     {kind: "alias_conflict"}      — unique index 23505 violated
 *     {kind: "target_unavailable"}  — target product retired (FR-051)
 *
 *   CreateResult (createProductFromUnknownItem):
 *     {kind: "ok";                  row: UnknownItemRow; productId: string}
 *     {kind: "not_found"}           — unknown item absent
 *     {kind: "already_reconciled"}  — item is already resolved/dismissed
 *     {kind: "alias_conflict"}      — unique index 23505 violated; the
 *                                     PG-level rollback aborts the whole
 *                                     transaction (no product, no UPDATE)
 *
 * The controller maps these to HTTP status codes per FR-040 / FR-063 /
 * FR-092.
 *
 * Race safety:
 *   SELECT ... FOR UPDATE on the unknown_items row prevents a concurrent
 *   dismiss/link/create from running between our existence check and the
 *   UPDATE, which would otherwise leave a ghost product_aliases row
 *   (the transaction rolls back, but the lock prevents the race entirely).
 *
 * RLS + GUC wiring (matches UnknownItemsService pattern):
 *   `runWithTenantContext` sets `app.current_tenant` via `set_config`.
 *   `app.current_store` is set explicitly inside the callback so the
 *   `unknown_items_store_read` RLS policy branch is satisfied.
 *
 * Dual-emission guard (tasks.md L477):
 *   createProductFromUnknownItem does NOT call TenantCatalogService.create
 *   because that service emits its own `catalog.product.create` audit row
 *   in-transaction (T351 lines 199–215). Instead, this service owns the
 *   raw `INSERT INTO tenant_products` SQL and the controller decorates the
 *   route with @Auditable("unknown_item.resolved.created"); only that
 *   subject is emitted.
 *
 * Constitution §III backend authority:
 *   tenant_id is taken from `input.tenantId` (which the controller sets
 *   from `ctx.tenantId`, never from the request body). Body-supplied
 *   tenantId is rejected at the Zod layer (`.strict()` schema).
 *
 * Spec anchors: FR-040, FR-053, FR-060, FR-061, FR-062, FR-063, FR-080,
 *               FR-081, Constitution §III.
 * OpenAPI: packages/contracts/openapi/catalog/unknown-items.yaml
 *   operationIds: tenantAdminLinkUnknownItem,
 *                 tenantAdminCreateProductFromUnknownItem
 */
import {
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Logger } from "@data-pulse-2/shared";

import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../audit/audit-job.enqueuer";
import { PG_POOL } from "../../auth/auth.module";
import { ROOT_LOGGER } from "../../common/logging.interceptor";
import {
  recordUnknownItemResolved,
  recordDuplicateAliasConflict,
} from "../../observability/metrics/api.metrics";

// Re-export the common row shape so the controller does not need a separate
// import from unknown-items.service.ts (avoids cross-module coupling).
export interface UnknownItemRow {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly identifierType: string;
  readonly identifierValue: string;
  readonly sourceSystem: string | null;
  readonly resolutionStatus: "pending" | "resolved" | "dismissed";
  readonly resolutionAction: "linked" | "created" | "dismissed" | null;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolvedProductId: string | null;
  readonly encounteredAt: Date;
  readonly saleContext: Record<string, unknown> | null;
}

export type LinkResult =
  | { kind: "ok"; row: UnknownItemRow }
  | { kind: "not_found" }
  | { kind: "already_reconciled" }
  | { kind: "alias_conflict" }
  | { kind: "target_unavailable" };

/**
 * Discriminated union returned by {@link ReconciliationService.createProductFromUnknownItem}.
 * Sibling to {@link LinkResult}; the `target_unavailable` branch does not
 * exist here because the create path does not consult a pre-existing
 * product (it INSERTs one).
 */
export type CreateResult =
  | { kind: "ok"; row: UnknownItemRow; productId: string }
  | { kind: "not_found" }
  | { kind: "already_reconciled" }
  | { kind: "alias_conflict" };

/**
 * Sentinel thrown inside the transaction callback to force
 * `runWithTenantContext` to ROLLBACK. Caught outside the transaction
 * and mapped to `{ kind: "alias_conflict" }`. Without this rollback the
 * preceding `INSERT INTO tenant_products` would commit even though the
 * operation reports a conflict, violating FR-062 atomicity.
 */
class AliasConflictSentinel extends Error {
  constructor() {
    super("alias_conflict");
    this.name = "AliasConflictSentinel";
  }
}

/** Rejection reasons that emit `unknown_item.reconciliation_conflict_rejected`. */
type RejectionReason = "alias_conflict" | "target_unavailable" | "already_reconciled";

/** Subject for conflict-rejection audit events (FR-082). */
const RECONCILIATION_CONFLICT_REJECTED = "unknown_item.reconciliation_conflict_rejected";

/**
 * 007 US7 (T053) — discriminated union returned by
 * {@link ReconciliationService.reopenUnknownItem}.
 *
 *   {kind: "ok";              row: UnknownItemRow}  — fresh pending row created
 *                                                    (005 FR-005), OR an existing
 *                                                    pending sibling returned
 *                                                    unchanged (already-pending,
 *                                                    no duplicate per FR-043).
 *   {kind: "forbidden"}       — in-scope row, store-scoped actor lacks tenant-wide
 *                                authority (FR-042, R7.4 service-layer split → 403).
 *   {kind: "already_reconciled"; priorState} — target is `resolved` (FR-043 →
 *                                409 + details.prior_state).
 *   {kind: "not_found"}       — RLS-filtered (cross-tenant / out-of-scope) or
 *                                absent → non-disclosing 404 (FR-062 / SI-004).
 */
export type ReopenResult =
  // `createdFresh` distinguishes the two `ok` paths (CodeRabbit #408 F2/F3):
  //   true  — a fresh `pending` row was INSERTed (005 FR-005) → 201 Created;
  //           emit BOTH `unknown_item.reopened` + `unknown_item.captured`.
  //   false — an existing pending row was reused (target already pending, or a
  //           pending sibling existed) → 200 OK, NO new row; emit NEITHER a
  //           fresh-capture NOR a reopened event (reuse changes no state — a
  //           phantom `captured` against a row that already existed would
  //           corrupt the provenance trail, §XIII).
  | { kind: "ok"; row: UnknownItemRow; createdFresh: boolean }
  | { kind: "forbidden" }
  | { kind: "already_reconciled"; priorState: "resolved" | "dismissed" }
  | { kind: "not_found" };

/** 007 US7 audit subjects (R7.5 — emitted programmatically, not via @Auditable). */
const UNKNOWN_ITEM_REOPENED = "unknown_item.reopened";
const UNKNOWN_ITEM_CAPTURED = "unknown_item.captured";
const UNKNOWN_ITEM_REOPEN_REJECTED = "unknown_item.reopen_rejected";

@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_JOB_ENQUEUER) private readonly auditEnqueuer: AuditJobEnqueuer,
    @Optional() @Inject(ROOT_LOGGER) private readonly logger?: Logger,
  ) {}

  /**
   * Emit a `reconciliation_conflict_rejected` audit event for a 4xx rejection.
   *
   * T645 / FR-082: the AuditEmitterInterceptor only fires on the success
   * (tap.next) path — a thrown 4xx never reaches it. So rejection events are
   * emitted explicitly here, AFTER the transaction has resolved/rolled back
   * (so the audit row is never itself rolled back). The discriminating
   * `reason` lands in `metadata` (PII-safe — only the enum reason, no row data).
   * Best-effort: a failed enqueue must not change the caller's HTTP outcome.
   */
  private async emitConflictRejection(
    reason: RejectionReason,
    ctx: {
      readonly tenantId: string;
      readonly storeId: string | null;
      readonly actorUserId: string;
    },
  ): Promise<void> {
    await this.auditEnqueuer
      .enqueue({
        actor_user_id: ctx.actorUserId,
        actor_label: null,
        tenant_id: ctx.tenantId,
        store_id: ctx.storeId,
        action: RECONCILIATION_CONFLICT_REJECTED,
        target_type: null,
        target_id: null,
        request_id: null,
        metadata: { reason },
      })
      .catch((err: unknown) => {
        // Best-effort: a failed audit enqueue must not change the caller's
        // HTTP outcome, but it must not be silent either — log so the
        // dropped rejection event is observable (no PII; only the reason).
        this.logger?.error(
          { err, action: RECONCILIATION_CONFLICT_REJECTED, reason },
          "ReconciliationService: conflict-rejection audit enqueue failed",
        );
      });
  }

  /**
   * Link a pending unknown item to an existing tenant product.
   *
   * Steps (inside a single transaction):
   *   1. SELECT unknown_items WHERE id=$unknownItemId FOR UPDATE
   *      — acquires a row-level lock for the transaction duration.
   *      RLS + store GUC filter means a cross-tenant or cross-store row
   *      returns 0 rows.
   *   2. Discriminate: 0 rows → not_found | non-pending → already_reconciled
   *   3. SELECT tenant_products WHERE id=$productId
   *      — fetch target and check retired_at: absent (0 rows) → not_found
   *        (RLS-filtered cross-tenant or non-existent UUID); retired
   *        (retired_at IS NOT NULL) → target_unavailable per FR-051.
   *   4. INSERT product_aliases — catch PG error 23505 → alias_conflict
   *   5. UPDATE unknown_items SET resolution_status='resolved' WHERE
   *      id=$unknownItemId AND resolution_status='pending'
   *      — rowCount=0 is impossible (FOR UPDATE locked pending row), but
   *        guard is kept for defensive correctness.
   */
  /**
   * Sets the app.current_store GUC (required by the unknown_items_store_read
   * RLS policy; tenant-wide actors pass storeId=null → "*", 003 0009
   * carve-out) and locks the target unknown_items row FOR UPDATE. The lock
   * prevents the FR-052 monotonicity race (T626, exercised by
   * link-already-reconciled.spec.ts). RLS filters a cross-tenant /
   * out-of-scope row to zero rows → undefined.
   */
  private async lockUnknownItem(
    client: PoolClient,
    storeId: string | null,
    unknownItemId: string,
  ): Promise<UnknownItemDbRow | undefined> {
    await client.query("SELECT set_config('app.current_store', $1, true)", [storeId ?? "*"]);
    const lockResult = await client.query<UnknownItemDbRow>(
      `SELECT ${UNKNOWN_ITEM_COLUMNS}
         FROM unknown_items
        WHERE id = $1
          FOR UPDATE`,
      [unknownItemId],
    );
    return lockResult.rows[0];
  }

  /**
   * Shared link/create step: INSERT the product_aliases row carrying the
   * unknown item's identifier. Returns false on a unique violation (23505)
   * without swallowing other errors. store_id carries the item's store to
   * preserve the store-scoped partial unique index semantics (FR-040);
   * source_system follows the source unknown_items row per the
   * product_aliases_source_system_required check in 0007_catalog.sql.
   */
  private async insertProductAlias(
    client: PoolClient,
    args: {
      tenantId: string;
      productId: string;
      item: UnknownItemDbRow;
      actorUserId: string;
    },
  ): Promise<boolean> {
    try {
      await client.query(
        `INSERT INTO product_aliases
           (tenant_id, product_id, identifier_type, value,
            source_system, store_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          args.tenantId,
          args.productId,
          args.item.identifier_type,
          args.item.value,
          args.item.source_system,
          args.item.store_id,
          args.actorUserId,
        ],
      );
      return true;
    } catch (err: unknown) {
      // PostgreSQL unique-violation: 23505
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: unknown }).code === "23505"
      ) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Shared link/create step: flip the locked pending row to resolved. The
   * monotonicity guard keeps resolution_status='pending' in the WHERE to be
   * defensive; the FOR UPDATE lock means 0 rows here indicates a logic error
   * (not a race) — callers throw to abort the transaction.
   */
  private async markUnknownItemResolved(
    client: PoolClient,
    args: {
      unknownItemId: string;
      actorUserId: string;
      productId: string;
      action: "linked" | "created";
    },
  ): Promise<UnknownItemDbRow | undefined> {
    const updateResult = await client.query<UnknownItemDbRow>(
      `UPDATE unknown_items
          SET resolution_status   = 'resolved',
              resolution_action   = $4,
              resolved_at         = now(),
              resolved_by         = $2,
              resolved_product_id = $3
        WHERE id                = $1
          AND resolution_status = 'pending'
       RETURNING ${UNKNOWN_ITEM_COLUMNS}`,
      [args.unknownItemId, args.actorUserId, args.productId, args.action],
    );
    return updateResult.rows[0];
  }

  async linkUnknownItem(input: {
    readonly tenantId: string;
    readonly storeId: string | null;
    readonly unknownItemId: string;
    readonly productId: string;
    readonly actorUserId: string;
  }): Promise<LinkResult> {
    const result = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<LinkResult> => {
        // Step 1+2: lock the unknown_items row and discriminate lifecycle.
        const existing = await this.lockUnknownItem(client, input.storeId, input.unknownItemId);
        if (!existing) {
          return { kind: "not_found" };
        }
        if (existing.resolution_status !== "pending") {
          return { kind: "already_reconciled" };
        }

        // Step 3: confirm target product exists; discriminate retired separately
        // so the controller can map retired -> 409 target_unavailable (FR-051)
        // while absent stays 404 non-disclosing (FR-092 / SI-001).
        const productCheck = await client.query<{
          id: string;
          retired_at: Date | null;
        }>(
          `SELECT id, retired_at
             FROM tenant_products
            WHERE id         = $1
              AND tenant_id  = $2
            LIMIT 1`,
          [input.productId, input.tenantId],
        );

        const productRow = productCheck.rows[0];
        if (!productRow) {
          return { kind: "not_found" };
        }
        if (productRow.retired_at !== null) {
          return { kind: "target_unavailable" };
        }

        // Step 4: INSERT product_aliases — unique constraint 23505 surfaces
        // as alias_conflict.
        const aliasInserted = await this.insertProductAlias(client, {
          tenantId: input.tenantId,
          productId: input.productId,
          item: existing,
          actorUserId: input.actorUserId,
        });
        if (!aliasInserted) {
          return { kind: "alias_conflict" };
        }

        // Step 5: flip the row to resolved (shared monotonicity-guarded UPDATE).
        const updated = await this.markUnknownItemResolved(client, {
          unknownItemId: input.unknownItemId,
          actorUserId: input.actorUserId,
          productId: input.productId,
          action: "linked",
        });
        if (!updated) {
          // FOR UPDATE lock + 'pending' status was confirmed at the top of
          // this transaction (see step 2 above). Reaching this branch means
          // the alias INSERT succeeded but the unknown_items UPDATE matched
          // zero rows — a logic error per markUnknownItemResolved's contract.
          // Throw to abort the transaction and roll back the alias INSERT
          // rather than committing inconsistent state.
          throw new Error(
            "reconciliation.linkUnknownItem invariant: unknown_items UPDATE returned 0 rows after FOR UPDATE lock + pending check",
          );
        }

        return { kind: "ok", row: toUnknownItemRow(updated) };
      },
    );

    if (result.kind === "ok") {
      // FR-081: increment the resolved counter on successful link.
      recordUnknownItemResolved({ action: "linked" });
    } else if (
      result.kind === "alias_conflict" ||
      result.kind === "target_unavailable" ||
      result.kind === "already_reconciled"
    ) {
      // T651 / FR-043: an alias unique-index violation increments the
      // duplicate-alias counter (alias_conflict only — not the other two
      // rejection kinds). The 003 §9 canonical signal.
      if (result.kind === "alias_conflict") {
        recordDuplicateAliasConflict();
      }
      // T645 / FR-082: emit the rejection audit event after the transaction
      // has resolved. not_found is intentionally excluded — a non-disclosing
      // 404 must not confirm the item's existence via an audit row.
      await this.emitConflictRejection(result.kind, {
        tenantId: input.tenantId,
        storeId: input.storeId,
        actorUserId: input.actorUserId,
      });
    }

    return result;
  }

  /**
   * Create a new tenant product from a pending unknown item.
   *
   * Steps (inside a single transaction):
   *   1. SELECT unknown_items WHERE id=$unknownItemId FOR UPDATE
   *      — acquires a row-level lock for the transaction duration.
   *      RLS + store GUC filter means a cross-tenant or cross-store row
   *      returns 0 rows.
   *   2. Discriminate: 0 rows → not_found | non-pending → already_reconciled
   *   3. INSERT tenant_products — raw SQL owned by this service so the
   *      audit subject stays `unknown_item.resolved.created` (NOT
   *      `catalog.product.create`; see tasks.md L477 dual-emission note).
   *      tenant_id is taken from `input.tenantId` (the resolved principal
   *      tenant), never from the request body — Constitution §III.
   *   4. INSERT product_aliases — catch PG error 23505 → alias_conflict.
   *      The PG-level rollback aborts the entire transaction including
   *      the tenant_products INSERT and the unknown_items UPDATE (T634
   *      atomicity guarantee).
   *   5. UPDATE unknown_items SET resolution_status='resolved',
   *      resolution_action='created', resolved_product_id=<new>
   *      WHERE id=$unknownItemId AND resolution_status='pending'
   *      — rowCount=0 is impossible (FOR UPDATE locked pending row), but
   *        we throw defensively to abort the transaction loudly if
   *        something has gone catastrophically wrong.
   */
  async createProductFromUnknownItem(input: {
    readonly tenantId: string;
    readonly storeId: string | null;
    readonly unknownItemId: string;
    readonly actorUserId: string;
    readonly name: string;
    readonly taxCategory: string;
    readonly categoryId: string | null;
  }): Promise<CreateResult> {
    let result: CreateResult;
    try {
      result = await runWithTenantContext(
        this.pool,
        { tenantId: input.tenantId, isPlatformAdmin: false },
        async (client): Promise<CreateResult> => {
        // Step 1+2: lock the unknown_items row and discriminate lifecycle.
        const existing = await this.lockUnknownItem(client, input.storeId, input.unknownItemId);
        if (!existing) {
          return { kind: "not_found" };
        }
        if (existing.resolution_status !== "pending") {
          return { kind: "already_reconciled" };
        }

        // Step 3: INSERT tenant_products with raw SQL.
        //   - `tenant_id` is taken from input.tenantId (Constitution §III).
        //   - `created_by` / `updated_by` are NOT NULL (no FK) and both
        //     default to the resolved actor.
        //   - `category_id` is nullable; the controller passes through the
        //     optional body field as null when absent.
        //   - We do NOT call TenantCatalogService.create because that
        //     service emits its own catalog.product.create audit row in
        //     the same transaction, which would dual-emit alongside the
        //     unknown_item.resolved.created subject decorating this route
        //     (tasks.md L477).
        const productId = newId();
        await client.query(
          `INSERT INTO tenant_products
             (id, tenant_id, name, tax_category, category_id,
              created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $6)`,
          [
            productId,
            input.tenantId,
            input.name,
            input.taxCategory,
            input.categoryId,
            input.actorUserId,
          ],
        );

        // Step 4: INSERT product_aliases — 23505 surfaces as alias_conflict.
        // Throw the sentinel to abort runWithTenantContext — the prior
        // INSERT INTO tenant_products MUST roll back to satisfy FR-062
        // atomicity. Caught outside the transaction and mapped to
        // { kind: "alias_conflict" }.
        const aliasInserted = await this.insertProductAlias(client, {
          tenantId: input.tenantId,
          productId,
          item: existing,
          actorUserId: input.actorUserId,
        });
        if (!aliasInserted) {
          throw new AliasConflictSentinel();
        }

        // Step 5: flip the row to resolved (shared monotonicity-guarded UPDATE).
        const updated = await this.markUnknownItemResolved(client, {
          unknownItemId: input.unknownItemId,
          actorUserId: input.actorUserId,
          productId,
          action: "created",
        });
        if (!updated) {
          // FOR UPDATE lock + 'pending' status was confirmed at the top
          // of this transaction. Reaching this branch means the
          // tenant_products + product_aliases INSERTs succeeded but the
          // unknown_items UPDATE matched zero rows — a logic error.
          // Throw to abort the transaction and roll back everything
          // rather than committing inconsistent state.
          throw new Error(
            "reconciliation.createProductFromUnknownItem invariant: unknown_items UPDATE returned 0 rows after FOR UPDATE lock + pending check",
          );
        }

        return { kind: "ok", productId, row: toUnknownItemRow(updated) };
      },
    );
    } catch (err: unknown) {
      // Sentinel thrown from the alias INSERT catch to force ROLLBACK
      // of the prior tenant_products INSERT (FR-062 atomicity). Map
      // back to the discriminated union AFTER the transaction has
      // already rolled back. Assign `result` (rather than returning here)
      // so control falls through to the post-transaction rejection-audit
      // block below — otherwise create-path alias_conflict would skip the
      // unknown_item.reconciliation_conflict_rejected emission (T645/FR-082).
      if (err instanceof AliasConflictSentinel) {
        result = { kind: "alias_conflict" };
      } else {
        throw err;
      }
    }

    if (result.kind === "ok") {
      // FR-081: increment the resolved counter on successful create.
      recordUnknownItemResolved({ action: "created" });
    } else if (
      result.kind === "alias_conflict" ||
      result.kind === "already_reconciled"
    ) {
      // T651 / FR-043: alias unique-index violation increments the
      // duplicate-alias counter (alias_conflict only).
      if (result.kind === "alias_conflict") {
        recordDuplicateAliasConflict();
      }
      // T645 / FR-082: emit the rejection audit event after the transaction
      // has resolved/rolled back. not_found excluded (non-disclosing 404).
      // The create path has no target_unavailable kind (no retired-product
      // check — it creates a brand-new product).
      await this.emitConflictRejection(result.kind, {
        tenantId: input.tenantId,
        storeId: input.storeId,
        actorUserId: input.actorUserId,
      });
    }

    return result;
  }

  /**
   * Reopen a dismissed unknown item (007 US7 / T053).
   *
   * Tenant-wide actors only. Reopening a `dismissed` item creates a FRESH
   * `pending` row for the same logical identifier (005 FR-005); the original
   * `dismissed` row is preserved unchanged as audit history.
   *
   * Authority split (R7.4 — SERVICE-layer, not the route guard): the route's
   * RolesGuard admits store_manager (denyAs:404) so a store-scoped actor
   * REACHES this method; the 403-vs-404 decision is made here from the
   * actor's `isTenantWide` flag:
   *   - 0 rows under RLS → `not_found` (non-disclosing 404; FR-062 / SI-004) —
   *     an out-of-scope store / cross-tenant id is invisible, never disclosed.
   *   - row in scope AND `!isTenantWide` → `forbidden` (403; FR-042) — the
   *     caller can see the item but lacks tenant-wide authority to reopen it.
   *   - row in scope AND `isTenantWide` → proceed.
   *
   * State machine (after authority passes):
   *   - `resolved`  → `already_reconciled` { priorState: "resolved" } (FR-043 →
   *     409 + details.prior_state).
   *   - `pending`   → already pending; return the row unchanged, no duplicate.
   *   - `dismissed` → if a `pending` sibling already exists for the tuple
   *     (re-captured between dismiss and reopen), return it unchanged
   *     (already-pending, NO duplicate — FR-043); else INSERT a fresh `pending`
   *     row (005 FR-005 capture path, mirrored inline — `UnknownItemsService`
   *     is a different module and out of this slice's allowed_files).
   *
   * Pending-sibling guard rationale: `idx_unknown_items_lookup_value` is a
   * NON-UNIQUE partial index (WHERE resolution_status='pending'), so a second
   * pending INSERT would NOT raise 23505 — it would SILENTLY create a duplicate.
   * The at-most-one-pending-per-tuple invariant is an application contract
   * (005 FR-032), enforced here by checking before INSERT.
   *
   * Audit (R7.5 — programmatic, AFTER the transaction resolves, mirroring
   * `emitConflictRejection` so an audit row is never tied to a rolled-back
   * commit): on a fresh capture, emit BOTH `unknown_item.reopened` (the action)
   * AND `unknown_item.captured` (the fresh row, FR-110). On a `forbidden` /
   * `already_reconciled` rejection, emit `unknown_item.reopen_rejected`
   * (FR-111). A `not_found` emits NOTHING — a non-disclosing 404 must not
   * confirm existence via an audit row.
   *
   * Idempotency: the route carries `@Idempotent("required")`; replay
   * short-circuit + body-mismatch 409 are handled by the shared
   * `IdempotencyInterceptor` (T003 ISOLATE — only the new ops carry the key).
   *
   * Spec anchors: FR-041, FR-042, FR-043, FR-062, FR-110, FR-111, 005 FR-005,
   *               005 FR-032, Constitution §III / §XIII / SI-004.
   */
  async reopenUnknownItem(input: {
    readonly tenantId: string;
    readonly storeId: string | null;
    readonly unknownItemId: string;
    readonly actorUserId: string;
    readonly isTenantWide: boolean;
    readonly correlationId: string;
  }): Promise<ReopenResult> {
    const freshRowId = newId();

    const result = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<ReopenResult> => {
        // Lock the target row and discriminate lifecycle. RLS filters a
        // cross-tenant / out-of-scope row to zero rows.
        const target = await this.lockUnknownItem(client, input.storeId, input.unknownItemId);

        // Non-disclosing 404 — RLS-filtered (cross-tenant / out-of-scope) or
        // absent. Decided BEFORE the authority check so an out-of-scope actor
        // cannot use a 403 as an existence oracle (FR-062 / SI-004).
        if (!target) {
          return { kind: "not_found" };
        }

        // R7.4: in-scope row, but a store-scoped actor lacks tenant-wide
        // authority → 403 forbidden (FR-042). Service-layer, not the guard.
        if (!input.isTenantWide) {
          return { kind: "forbidden" };
        }

        // resolved → already reconciled; the prior_state detail is surfaced
        // to the client (FR-043).
        if (target.resolution_status === "resolved") {
          return { kind: "already_reconciled", priorState: "resolved" };
        }

        // The target itself is already pending — reopen is a no-op; return it.
        // createdFresh=false: no row was created, so the caller maps this to
        // 200 OK and emits no fresh-capture audit.
        if (target.resolution_status === "pending") {
          return { kind: "ok", row: toUnknownItemRow(target), createdFresh: false };
        }

        // target is `dismissed` → reopen. First check for an existing pending
        // sibling for the SAME tuple (re-captured between dismiss and reopen):
        // returning it avoids creating a duplicate pending row (FR-043 /
        // 005 FR-032). source_system uses IS NOT DISTINCT FROM to match the
        // NULL (barcode/sku/plu/supplier_code) and NOT-NULL (external_pos_id)
        // branches uniformly — same predicate as captureItem's dedup.
        const siblingResult = await client.query<UnknownItemDbRow>(
          `SELECT ${UNKNOWN_ITEM_COLUMNS}
             FROM unknown_items
            WHERE tenant_id       = $1
              AND store_id        = $2
              AND identifier_type = $3
              AND value           = $4
              AND source_system IS NOT DISTINCT FROM $5
              AND resolution_status = 'pending'
            ORDER BY encountered_at ASC
            LIMIT 1`,
          [
            target.tenant_id,
            target.store_id,
            target.identifier_type,
            target.value,
            target.source_system,
          ],
        );

        const sibling = siblingResult.rows[0];
        if (sibling) {
          // Already pending — no duplicate (FR-043). Return the sibling row.
          // createdFresh=false: reused an existing row → 200 OK, no fresh-capture
          // audit (the row already existed; a `captured` event here would be a
          // phantom provenance record).
          return { kind: "ok", row: toUnknownItemRow(sibling), createdFresh: false };
        }

        // No sibling → INSERT a fresh pending row for the same logical
        // identifier (005 FR-005). The original dismissed row is untouched.
        // Mirrors UnknownItemsService.captureItem's INSERT. correlation_id is
        // NOT NULL per 0007_catalog.sql; the controller derives it from the
        // request id (no POS correlation exists on a reopen).
        const insertResult = await client.query<UnknownItemDbRow>(
          `INSERT INTO unknown_items
             (id, tenant_id, store_id, identifier_type, value,
              source_system, resolution_status, sale_context, correlation_id)
           VALUES
             ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
           RETURNING ${UNKNOWN_ITEM_COLUMNS}`,
          [
            freshRowId,
            target.tenant_id,
            target.store_id,
            target.identifier_type,
            target.value,
            target.source_system,
            // The dismissed row's sale_context is provenance; a fresh reopen
            // carries no new sale context (the original is preserved on the
            // dismissed row). NULL keeps the fresh row's review surface clean.
            null,
            input.correlationId,
          ],
        );

        const inserted = insertResult.rows[0];
        if (!inserted) {
          // RLS returning zero rows on a self-insert means the principal's
          // tenant/store context did not satisfy unknown_items_insert. A guard
          // error, not a domain error — throw to abort rather than corrupt the
          // response shape (mirrors captureItem).
          throw new Error("unknown_items: reopen insert produced no row");
        }

        // A fresh pending row was INSERTed → createdFresh=true (201 + both
        // audit events).
        return { kind: "ok", row: toUnknownItemRow(inserted), createdFresh: true };
      },
    );

    // ---- post-transaction audit (R7.5 / FR-110 / FR-111) -------------------
    // Emitted AFTER the txn resolves so an audit row is never tied to a
    // rolled-back commit (mirrors emitConflictRejection). Only a FRESH reopen
    // (createdFresh) emits state-change events: `unknown_item.reopened`
    // targeting the DISMISSED row acted on (input.unknownItemId, NOT the fresh
    // pending row), plus `unknown_item.captured` targeting the new row (FR-110).
    // A reuse path (target already pending / sibling reused) changed no state →
    // emit NOTHING (CodeRabbit #408 F2: a phantom `captured` against a
    // pre-existing row would corrupt provenance, §XIII). Rejections emit a
    // single reopen_rejected; not_found emits nothing (non-disclosure).
    if (result.kind === "ok" && result.createdFresh) {
      await this.emitReopenAudit(UNKNOWN_ITEM_REOPENED, {
        tenantId: input.tenantId,
        storeId: input.storeId,
        actorUserId: input.actorUserId,
        // The reopen ACTION targets the dismissed item the caller addressed,
        // not the freshly-created pending row.
        targetId: input.unknownItemId,
        requestId: input.correlationId,
        metadata: { action: "reopen", fresh_item_id: result.row.id },
      });
      await this.emitReopenAudit(UNKNOWN_ITEM_CAPTURED, {
        tenantId: input.tenantId,
        storeId: input.storeId,
        actorUserId: input.actorUserId,
        targetId: result.row.id,
        requestId: input.correlationId,
        metadata: { action: "reopen_fresh_capture" },
      });
    } else if (result.kind === "forbidden") {
      await this.emitReopenAudit(UNKNOWN_ITEM_REOPEN_REJECTED, {
        tenantId: input.tenantId,
        storeId: input.storeId,
        actorUserId: input.actorUserId,
        targetId: input.unknownItemId,
        requestId: input.correlationId,
        metadata: { reason: "forbidden" },
      });
    } else if (result.kind === "already_reconciled") {
      await this.emitReopenAudit(UNKNOWN_ITEM_REOPEN_REJECTED, {
        tenantId: input.tenantId,
        storeId: input.storeId,
        actorUserId: input.actorUserId,
        targetId: input.unknownItemId,
        requestId: input.correlationId,
        metadata: { reason: "already_reconciled", prior_state: result.priorState },
      });
    }
    // result.kind === "not_found" → no audit (non-disclosing 404).

    return result;
  }

  /**
   * Emit a 007-US7 reopen-related audit event (R7.5). Best-effort: a failed
   * enqueue must not change the caller's HTTP outcome, but it is logged so a
   * dropped event is observable (no PII — only the action/reason metadata).
   * Mirrors {@link emitConflictRejection}.
   */
  private async emitReopenAudit(
    action: string,
    ctx: {
      readonly tenantId: string;
      readonly storeId: string | null;
      readonly actorUserId: string;
      readonly targetId: string;
      readonly requestId: string | null;
      readonly metadata: Record<string, unknown> | null;
    },
  ): Promise<void> {
    await this.auditEnqueuer
      .enqueue({
        actor_user_id: ctx.actorUserId,
        actor_label: null,
        tenant_id: ctx.tenantId,
        store_id: ctx.storeId,
        action,
        target_type: "unknown_item",
        target_id: ctx.targetId,
        request_id: ctx.requestId,
        metadata: ctx.metadata,
      })
      .catch((err: unknown) => {
        this.logger?.error(
          { err, action },
          "ReconciliationService: reopen audit enqueue failed",
        );
      });
  }
}

/** Raw snake_case unknown_items row (FOR UPDATE / sibling / UPDATE / INSERT RETURNING). */
interface UnknownItemDbRow {
  id: string;
  tenant_id: string;
  store_id: string;
  identifier_type: string;
  value: string;
  source_system: string | null;
  resolution_status: "pending" | "resolved" | "dismissed";
  resolution_action: "linked" | "created" | "dismissed" | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolved_product_id: string | null;
  encountered_at: Date;
  sale_context: Record<string, unknown> | null;
}

/** Column list matching {@link UnknownItemDbRow} for SELECT / RETURNING clauses. */
const UNKNOWN_ITEM_COLUMNS = `id, tenant_id, store_id, identifier_type, value,
                  source_system, resolution_status, resolution_action,
                  resolved_at, resolved_by, resolved_product_id,
                  encountered_at, sale_context`;

/**
 * Adapter — raw snake_case row (FOR UPDATE / sibling / INSERT RETURNING) to the
 * camelCase {@link UnknownItemRow} the controller projects. Shared by all
 * reconciliation branches so the mapping lives in exactly one place.
 */
function toUnknownItemRow(row: UnknownItemDbRow): UnknownItemRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    storeId: row.store_id,
    identifierType: row.identifier_type,
    identifierValue: row.value,
    sourceSystem: row.source_system,
    resolutionStatus: row.resolution_status,
    resolutionAction: row.resolution_action,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolvedProductId: row.resolved_product_id,
    encounteredAt: row.encountered_at,
    saleContext: row.sale_context,
  };
}
