/**
 * UnknownItemsService — 005 Wave 1 / T511 (CAPTURE-HAPPY) + T514
 * (CAPTURE-RESOLVE) + T516 (CAPTURE-STORE-SCOPE) + T518 (CAPTURE-DEDUP).
 *
 * Owns the data-layer writes for the POS unknown-item capture path.
 *
 * CAPTURE-HAPPY scope (T511): on a miss against the tenant's active alias
 * set, INSERT a fresh `pending` `unknown_items` row.
 *
 * CAPTURE-RESOLVE scope (T514): before that INSERT, query
 * `product_aliases` filtered to `retired_at IS NULL` (uses the partial
 * index `idx_product_aliases_lookup`). On a hit, return a `resolved`
 * outcome carrying the resolved `tenant_products.id` (and the alias id
 * for auditing). NO `unknown_items` row is created on the resolved path
 * per FR-022 / FR-030 / FR-031.
 *
 * CAPTURE-STORE-SCOPE scope (T516): the alias lookup applies the
 * `store_id IS NULL OR store_id = $current_store` residual filter so a
 * store-scoped alias bound to a DIFFERENT store of the same tenant does
 * not resolve a submission from the submitting store (FR-030a).
 *
 * CAPTURE-DEDUP scope (T518, THIS extension): after alias lookup misses,
 * SELECT `unknown_items` filtered to `resolution_status = 'pending'` for
 * the same `(tenant_id, store_id, identifier_type, value, source_system)`
 * tuple — uses the partial index `idx_unknown_items_lookup_value`
 * (003 §8, predicate `WHERE resolution_status = 'pending'`). On a hit,
 * return the existing row's reference; do NOT INSERT (FR-032). A
 * `dismissed` or `resolved` row is excluded by the partial-index
 * predicate and MUST NOT short-circuit a fresh capture (FR-005).
 *
 * Out of scope for THIS slice (each lands in a downstream Wave 1 slice
 * that EXTENDS this service):
 *   - Non-disclosing get-by-id (SI-004 / FR-013 / FR-092) →
 *       005-WAVE1-NON-DISCLOSING (T521/T522)
 *   - List + dismiss → 005-WAVE1-LIST / 005-WAVE1-DISMISS
 *   - Idempotency-mismatch audit + counter (FR-021c, FR-082) →
 *       005-WAVE1-IDEMP-MISMATCH (T533) — the existing
 *       `IdempotencyInterceptor` already provides the 409 outcome;
 *       this slice does not author the catalog-domain mismatch hook.
 *
 * Hard constraints (constitutional + plan-binding):
 *   - Every DB call runs inside `runWithTenantContext(...)` per 003 §8 +
 *     001 helpers. No raw pool access.
 *   - The store GUC `app.current_store` is set explicitly inside the
 *     transactional callback (003's RLS INSERT policy checks it).
 *   - No PII in logs: `value` is catalog reference data (per Constitution
 *     §XIV + 003 §10 redaction matrix) and is not redacted, but
 *     `sale_context` is opaque advisory JSON and MUST NOT be logged
 *     verbatim — pino redaction at the boundary takes care of this when
 *     a downstream slice wires a structured log statement. The current
 *     slice does not log `sale_context`.
 *
 * See:
 *   specs/005-pos-catalog-sync-reconciliation/spec.md §5 US1, §6.1–§6.4
 *   specs/005-pos-catalog-sync-reconciliation/data-model.md §2.1 + §2.2
 *   packages/contracts/openapi/catalog/unknown-items.yaml — posCaptureItem
 */
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

import { runWithTenantContext } from "@data-pulse-2/db";

import {
  AUDIT_JOB_ENQUEUER,
  type AuditJobEnqueuer,
} from "../../audit/audit-job.enqueuer";
import { PG_POOL } from "../../auth/auth.module";
import type { StoreScope } from "../../context/store-scope";
import {
  recordUnknownItemCaptured,
  recordUnknownItemResolved,
} from "../../observability/metrics/api.metrics";
import {
  applyItemStoreScope,
  applyListStoreScope,
} from "./unknown-item-store-scope";

/**
 * Inputs accepted at the service boundary. Mirrors the contract's
 * `PosCaptureItemRequest` (Zod-validated upstream in the controller).
 * `tenantId`, `storeId`, and `actorUserId` come from the resolved POS
 * principal context — body-supplied tenant/store fields are NOT trusted
 * (Constitution §III).
 */
export interface CaptureItemInput {
  readonly tenantId: string;
  readonly storeId: string;
  /** POS principal's `userId` per `ResolvedContext` (= device identity). */
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly identifierType: "barcode" | "sku" | "plu" | "supplier_code" | "external_pos_id";
  readonly identifierValue: string;
  readonly sourceSystem: string | null;
  readonly saleContext: Record<string, unknown> | null;
}

/**
 * Raw row shape returned by the INSERT ... RETURNING clause. Aligned to
 * the 003 `unknown_items` Drizzle schema; the controller adapts to the
 * contract `UnknownItem` shape. `captureItem` narrows to `pending` because
 * a fresh INSERT is always `pending` per FR-001 + 003's CHK
 * `unknown_items_resolved_fields_consistent` (all `resolved_*` fields
 * NULL when status='pending').
 */
export interface CapturedUnknownItemRow {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly identifierType: string;
  readonly identifierValue: string;
  readonly sourceSystem: string | null;
  readonly resolutionStatus: "pending";
  readonly resolutionAction: null;
  readonly resolvedAt: null;
  readonly resolvedBy: null;
  readonly resolvedProductId: null;
  readonly encounteredAt: Date;
  readonly saleContext: Record<string, unknown> | null;
}

/**
 * Lifecycle-tolerant row shape for read paths (`findByIdForTenant`).
 * A GET-by-id may surface any of the three lifecycle states; the
 * resolution-fields nullability mirrors 003's
 * `unknown_items_resolved_fields_consistent` CHK (NULL for `pending`,
 * NOT NULL for `resolved` / `dismissed`). Callers that need narrowing
 * can discriminate on `resolutionStatus` at the use site.
 */
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

/**
 * 007 US8 (T057) — per-item outcome of a bulk-dismiss. Mirrors the contract's
 * `BulkDismissOutcome` (data-model §2.3): `{ id, outcome, details? }` where
 * `outcome ∈ {dismissed, already_reconciled, not_found}`. `details` carries
 * `prior_state` on the `already_reconciled` branch; null otherwise.
 */
export interface BulkDismissOutcome {
  readonly id: string;
  readonly outcome: "dismissed" | "already_reconciled" | "not_found";
  // Optional per the wire contract (`{ id, outcome, details? }`) — present only
  // on `already_reconciled` (carries `prior_state`); omitted for `dismissed` /
  // `not_found` (CodeRabbit #409 F2 — don't serialize `details: null`).
  readonly details?: Record<string, unknown>;
}

/**
 * Resolved-outcome variant — alias lookup hit. Mirrors the contract's
 * `PosCaptureResolvedResponse` (kind, product_id, alias_id?). The
 * controller adapts these fields to snake_case wire shape.
 */
export interface ResolvedAliasMatch {
  readonly kind: "resolved";
  readonly productId: string;
  readonly aliasId: string;
}

/**
 * Discriminated-union return shape mirroring the contract's
 * `PosCaptureResolvedResponse | PosCaptureUnknownResponse`.
 * CAPTURE-HAPPY (T511) emits the `unknown` variant; CAPTURE-RESOLVE
 * (T514, this extension) adds the `resolved` variant via an alias-lookup
 * prelude that runs before the INSERT.
 */
export type CaptureItemResult =
  | { readonly kind: "unknown"; readonly unknownItem: CapturedUnknownItemRow }
  | ResolvedAliasMatch;

@Injectable()
export class UnknownItemsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    // 007 US8 (T057): OPTIONAL audit enqueuer. The shipped single-dismiss
    // audit is emitted route-level by @Auditable + AuditEmitterInterceptor, so
    // the ~15 existing specs construct this service with PG_POOL ONLY. Making
    // the enqueuer @Optional() keeps those specs compiling (enqueuer ===
    // undefined → bulk audit is a no-op) while the bulk-dismiss path — which
    // calls dismissUnknownItem in a loop, BYPASSING the route decorator — emits
    // one unknown_item.dismissed PROGRAMMATICALLY per transitioned item. Mirrors
    // ReconciliationService's @Optional() ROOT_LOGGER pattern.
    @Optional()
    @Inject(AUDIT_JOB_ENQUEUER)
    private readonly auditEnqueuer?: AuditJobEnqueuer,
  ) {}

  /**
   * Capture a POS-submitted item reference.
   *
   * Behavior (FR-022 / FR-030 / FR-031 / FR-032 / FR-001):
   *   1. ALIAS-RESOLUTION PRELUDE (T514) — SELECT the most recent active
   *      `product_aliases` row matching `(tenant_id, identifier_type,
   *      value)` filtered to `retired_at IS NULL`. On a hit, return a
   *      `resolved` outcome carrying the resolved `tenant_products.id`
   *      — no `unknown_items` row is created (FR-022).
   *   2. NATURAL-DEDUP CHECK (T518) — on alias miss, SELECT
   *      `unknown_items` for the same `(tenant_id, store_id,
   *      identifier_type, value, source_system)` tuple where
   *      `resolution_status = 'pending'`. On a hit, return that row's
   *      reference; do NOT INSERT (FR-032). Dismissed/resolved rows are
   *      excluded by the partial-index predicate so FR-005 (resubmit
   *      after dismissal creates a fresh `pending` row) is preserved.
   *   3. CAPTURE FALLBACK (T511) — on both misses, INSERT a fresh
   *      `pending` `unknown_items` row scoped to (tenant, store) and
   *      return the persisted row.
   *
   * Alias scope (T516 — store-scope respected, FR-030a):
   *   The lookup filter is `(tenant_id, identifier_type, value) AND
   *   (store_id IS NULL OR store_id = $current_store)`. Tenant-wide
   *   aliases (`store_id IS NULL`) resolve at every store of the tenant;
   *   store-scoped aliases resolve ONLY when the submitting store
   *   matches `store_id`. A store-scoped alias bound to a DIFFERENT
   *   store of the same tenant MUST NOT resolve here — per FR-030a it
   *   must fall through to capture as `unknown` at the submitting
   *   store.
   *
   *   Precedence: when both a store-scoped match AND a tenant-wide
   *   match exist for the same `(tenant_id, identifier_type, value)`,
   *   the store-scoped row wins. This is implemented via
   *   `ORDER BY (store_id IS NULL) ASC, created_at DESC LIMIT 1` —
   *   `FALSE` (store-scoped) sorts before `TRUE` (tenant-wide). The
   *   003 partial unique indexes guarantee at most ONE active row per
   *   scope, so the secondary `created_at DESC` tiebreaker only
   *   matters for defensive shape tolerance.
   *
   *   The 003 partial index `idx_product_aliases_lookup` (tenant_id,
   *   identifier_type, value) WHERE retired_at IS NULL still serves
   *   this access pattern — the `store_id` predicate is applied as a
   *   filter after the index scan. Adding `store_id` to the index key
   *   would be a 003-domain migration, out of scope for this slice.
   *
   * Transactional contract:
   *   - Both the alias SELECT and (when needed) the `unknown_items`
   *     INSERT run inside `runWithTenantContext` so 003's RLS policies
   *     see the correct tenant GUC. The store GUC is set inside the
   *     same callback for the INSERT path.
   *   - On the resolved branch the callback short-circuits before any
   *     INSERT; `recordUnknownItemCaptured()` is NOT called (the row
   *     never existed). The Wave 1 capture metric counts inserts, not
   *     POS-submission count.
   *
   * Metric handling (T514 — alias-hit branch):
   *   `unknown_item_resolved_total{action}` exists with a closed enum
   *   `{linked, created, dismissed}` (api.metrics.ts:78-83). NONE of
   *   those values describe a capture-time alias hit — `linked` denotes
   *   the Wave 2 reconciliation action that links a pending row to a
   *   product. Per the slice brief ("do NOT extend the enum"), this
   *   slice emits NO metric on the resolved branch. If signals.md later
   *   adds an `alias_hit` action, the call site lives here.
   */
  async captureItem(input: CaptureItemInput): Promise<CaptureItemResult> {
    const id = randomUUID();

    const result = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<
        | { kind: "resolved"; productId: string; aliasId: string }
        | { kind: "unknown"; inserted: boolean; row: {
            id: string;
            tenant_id: string;
            store_id: string;
            identifier_type: string;
            value: string;
            source_system: string | null;
            resolution_status: "pending";
            resolution_action: null;
            resolved_at: null;
            resolved_by: null;
            resolved_product_id: null;
            encountered_at: Date;
            sale_context: Record<string, unknown> | null;
          } }
      > => {
        // Alias-resolution prelude (T514, refined by T516 for FR-030a).
        //
        // Uses the partial index `idx_product_aliases_lookup`
        // (tenant_id, identifier_type, value) WHERE retired_at IS NULL.
        // The `store_id` predicate is applied as a residual filter:
        // `store_id IS NULL` (tenant-wide alias, resolves anywhere) OR
        // `store_id = $current_store` (store-scoped alias, resolves
        // ONLY at the submitting store). A store-scoped alias bound to
        // a DIFFERENT store of the same tenant MUST NOT match — that's
        // the FR-030a invariant.
        //
        // Precedence (FR-030a): store-scoped wins over tenant-wide for
        // the same identifier. `ORDER BY (store_id IS NULL) ASC` puts
        // FALSE (store-scoped) before TRUE (tenant-wide); `created_at
        // DESC` is a defensive tiebreaker (003's partial unique indexes
        // already guarantee at most one active row per scope).
        const aliasHit = await client.query<{
          id: string;
          product_id: string;
        }>(
          `SELECT id, product_id
             FROM product_aliases
            WHERE tenant_id       = $1
              AND identifier_type = $2
              AND value           = $3
              AND retired_at IS NULL
              AND (store_id IS NULL OR store_id = $4)
            ORDER BY (store_id IS NULL) ASC, created_at DESC
            LIMIT 1`,
          [
            input.tenantId,
            input.identifierType,
            input.identifierValue,
            input.storeId,
          ],
        );

        const hit = aliasHit.rows[0];
        if (hit) {
          // FR-022 / FR-030 / FR-031: no INSERT; surface the resolved
          // product directly. Store GUC remains unset on this branch —
          // the resolved path does not read or write `unknown_items`
          // and therefore needs neither the store_read RLS predicate
          // nor the insert WITH CHECK predicate.
          return {
            kind: "resolved",
            productId: hit.product_id,
            aliasId: hit.id,
          };
        }

        // Set the store GUC BEFORE the dedup SELECT.
        //
        // 003 ships TWO permissive SELECT policies on `unknown_items`:
        //   - `unknown_items_tenant_isolation` (tenant_id = $tenant)
        //   - `unknown_items_store_read`       (store_id = $store OR
        //                                       store='')
        // Permissive policies OR — visibility requires at least one to
        // be TRUE. But `current_setting('app.current_store', true)`
        // returns NULL when unset (the `true` second arg suppresses the
        // missing-setting error), so `NULL::uuid` makes both halves of
        // the store policy NULL → NULL, which Postgres treats as FALSE
        // in filter context. Tenant-isolation alone would be enough to
        // see the row in theory, but the OR'd-NULL drives the policy
        // evaluation to FALSE for the store_read branch and the row is
        // filtered when the tenant policy is also unreachable for the
        // current login role. Setting `app.current_store` here makes
        // the store_read policy succeed and the dedup query find any
        // pending rows the prior capture committed.
        //
        // The GUC is harmless to the resolved-alias branch above: that
        // branch returned BEFORE this point, so the store GUC remains
        // unset for the resolved-path commit (no row written, no SELECT
        // attempted on `unknown_items` on that branch).
        await client.query(
          "SELECT set_config('app.current_store', $1, true)",
          [input.storeId],
        );

        // Natural-dedup check (T518, FR-032).
        //
        // Uses the partial index `idx_unknown_items_lookup_value`
        // (tenant_id, identifier_type, value) WHERE resolution_status =
        // 'pending'. The predicate is written literally (not
        // parameterized) so the planner can match the partial index;
        // `store_id` and `source_system` are applied as residual filters.
        //
        // Store-scope enforcement: `store_id = $4` ensures dedup is
        // bounded to the submitting store. A pending row at a DIFFERENT
        // store of the same tenant MUST NOT short-circuit this capture
        // — that's the FR-030a invariant carried forward from T516.
        //
        // source_system matching: 003's `unknown_items_source_system_required`
        // CHK ties source_system NOT NULL <=> identifier_type =
        // 'external_pos_id'. For `barcode` / `sku` / `plu` /
        // `supplier_code` the column is always NULL; for
        // `external_pos_id` it's always NOT NULL. `IS NOT DISTINCT
        // FROM` matches both branches (NULL=NULL → TRUE,
        // 'pos-a'='pos-a' → TRUE, NULL='pos-a' → FALSE).
        //
        // FR-005 invariant: dismissed/resolved rows are excluded by the
        // partial-index predicate `WHERE resolution_status = 'pending'`,
        // so resubmitting an identifier whose only prior row is
        // `dismissed` correctly falls through to INSERT a new pending
        // row (the dismissed row is NOT returned). T545 elsewhere
        // codifies this as a service-layer assertion.
        const dedupHit = await client.query<{
          id: string;
          tenant_id: string;
          store_id: string;
          identifier_type: string;
          value: string;
          source_system: string | null;
          resolution_status: "pending";
          resolution_action: null;
          resolved_at: null;
          resolved_by: null;
          resolved_product_id: null;
          encountered_at: Date;
          sale_context: Record<string, unknown> | null;
        }>(
          `SELECT id, tenant_id, store_id, identifier_type, value,
                  source_system, resolution_status, resolution_action,
                  resolved_at, resolved_by, resolved_product_id,
                  encountered_at, sale_context
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
            input.tenantId,
            input.storeId,
            input.identifierType,
            input.identifierValue,
            input.sourceSystem,
          ],
        );

        const existing = dedupHit.rows[0];
        if (existing) {
          // FR-032: a pending row already exists for this logical
          // identifier in the same (tenant, store). Return its
          // reference unchanged — no INSERT, no metric increment
          // (`unknown_item_captured_total` counts NEW pending rows
          // per docs/observability/signals.md). The row's
          // `encountered_at` reflects the ORIGINAL capture time, not
          // this resubmission — that's intentional per FR-032
          // ("return that existing record's reference").
          return { kind: "unknown", inserted: false, row: existing };
        }

        // Both misses → capture path (T511). The store GUC required by
        // 003's `unknown_items_insert` RLS policy was already set above
        // (before the dedup SELECT) and remains in scope for this
        // transaction.
        const insertResult = await client.query<{
          id: string;
          tenant_id: string;
          store_id: string;
          identifier_type: string;
          value: string;
          source_system: string | null;
          resolution_status: "pending";
          resolution_action: null;
          resolved_at: null;
          resolved_by: null;
          resolved_product_id: null;
          encountered_at: Date;
          sale_context: Record<string, unknown> | null;
        }>(
          `INSERT INTO unknown_items
             (id, tenant_id, store_id, identifier_type, value,
              source_system, resolution_status, sale_context,
              correlation_id)
           VALUES
             ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
           RETURNING id, tenant_id, store_id, identifier_type, value,
                     source_system, resolution_status, resolution_action,
                     resolved_at, resolved_by, resolved_product_id,
                     encountered_at, sale_context`,
          [
            id,
            input.tenantId,
            input.storeId,
            input.identifierType,
            input.identifierValue,
            input.sourceSystem,
            input.saleContext,
            input.correlationId,
          ],
        );

        const r = insertResult.rows[0];
        if (!r) {
          // RLS returning zero rows on a self-insert means the principal's
          // tenant/store context did not satisfy `unknown_items_insert`.
          // This is a guard error, not a domain error; surface a thrown
          // exception rather than corrupt the response shape.
          throw new Error("unknown_items: insert produced no row");
        }
        return { kind: "unknown", inserted: true, row: r };
      },
    );

    if (result.kind === "resolved") {
      // FR-022: identifier resolved to an existing tenant product. No
      // capture-metric increment (the counter tracks `unknown_items`
      // inserts, not POS submissions).
      return {
        kind: "resolved",
        productId: result.productId,
        aliasId: result.aliasId,
      };
    }

    if (result.inserted) {
      // T518 / FR-032: only increment the capture counter on a FRESH
      // INSERT. A dedup-hit returns an existing pending row (no new
      // `unknown_items` write) and so must NOT increment the counter
      // — per docs/observability/signals.md `unknown_item_captured_total`
      // tracks "successful POS capture INTO unknown_items table".
      recordUnknownItemCaptured();
    }

    const row = result.row;
    const captured: CapturedUnknownItemRow = {
      id: row.id,
      tenantId: row.tenant_id,
      storeId: row.store_id,
      identifierType: row.identifier_type,
      identifierValue: row.value,
      sourceSystem: row.source_system,
      resolutionStatus: "pending",
      resolutionAction: null,
      resolvedAt: null,
      resolvedBy: null,
      resolvedProductId: null,
      encounteredAt: row.encountered_at,
      saleContext: row.sale_context,
    };

    return { kind: "unknown", unknownItem: captured };
  }

  /**
   * Non-disclosing GET-by-id for `unknown_items` (T522 /
   * 005-WAVE1-NON-DISCLOSING).
   *
   * Behavior (SI-001 / SI-004 / FR-013 / FR-092):
   *   - The caller's tenant + (optional) store scope are set as GUCs via
   *     `runWithTenantContext` + `set_config('app.current_store', ...)`.
   *   - Selects the row by `id` ONLY — the WHERE clause does NOT explicitly
   *     check `tenant_id`. RLS does the tenant filtering: 003's
   *     `unknown_items_tenant_isolation` policy returns zero rows when the
   *     id belongs to a different tenant, and the OR'd `unknown_items_store_read`
   *     branch enforces store-scope when the principal is store-scoped.
   *   - Zero rows ⇒ `NotFoundException` (404-class). Indistinguishable from
   *     "id does not exist anywhere" — the response MUST NOT leak existence
   *     in another tenant or another store.
   *   - One row ⇒ adapted to `CapturedUnknownItemRow` shape (mirrors
   *     `captureItem`'s `unknown` branch).
   *
   * `storeId`:
   *   - Tenant-wide principal (tenant admin / tenant owner) passes `null`;
   *     `app.current_store` is set to `''` so 0009's empty-string carve-out
   *     in `unknown_items_store_read` evaluates TRUE for all stores in the
   *     tenant.
   *   - Store-scoped principal (store manager / operator) passes their
   *     store's UUID; the store_read predicate matches rows from that store
   *     only.
   *
   * Why NOT add `WHERE tenant_id = $X` explicitly:
   *   The whole point of RLS is that the service does not need to layer
   *   tenant filtering on top — that introduces a second source of truth
   *   and risks silent disagreement with the policy. SI-001's invariant is
   *   that the DB layer alone makes cross-tenant reads impossible; this
   *   helper composes that into a 404-class HTTP signal, no more.
   *
   * Wave 1 usage:
   *   Internal only — no public route exposes this in Wave 1. tasks.md
   *   T522 calls out that LIST is the public surface; this helper exists
   *   so that when a future slice authors a controller GET-by-id (or
   *   reconciliation-needs-by-id), the non-disclosing posture is already
   *   the service contract.
   */
  async findByIdForTenant(input: {
    readonly id: string;
    readonly tenantId: string;
    /** RT-131: the caller's store scope (`resolveStoreScope`). */
    readonly storeScope: StoreScope;
  }): Promise<UnknownItemRow> {
    const row = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        // Set `app.current_store` BEFORE the SELECT so the store RLS branch
        // admits the item only when it is in the caller's store scope
        // (RT-131; `'*'` only for genuinely tenant-wide actors).
        await applyItemStoreScope(client, input.storeScope, input.id);

        const result = await client.query<{
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
        }>(
          // No `tenant_id = $X` predicate — RLS does the cross-tenant
          // filter. SI-001 invariant: the row is unreachable from any
          // tenant other than its owning tenant under 003's policies.
          `SELECT id, tenant_id, store_id, identifier_type, value,
                  source_system, resolution_status, resolution_action,
                  resolved_at, resolved_by, resolved_product_id,
                  encountered_at, sale_context
             FROM unknown_items
            WHERE id = $1
            LIMIT 1`,
          [input.id],
        );

        return result.rows[0] ?? null;
      },
    );

    if (!row) {
      // FR-013 / FR-092 / SI-004: non-disclosing 404. The exception body
      // names no tenant, no store, no identifier — the actor cannot use
      // this response to learn whether the id exists in another tenant.
      // NestJS's `NotFoundException` formats as `{ statusCode: 404,
      // message: "Not Found" }` by default; the `GlobalExceptionFilter`
      // rewrites that into the canonical envelope with
      // `error.code = "not_found"`.
      throw new NotFoundException("Not Found");
    }

    // Shape-tolerant adapter — the return type `UnknownItemRow` admits
    // any lifecycle state, so no `as` narrowing is needed. 003's
    // `unknown_items_resolved_fields_consistent` CHK guarantees the
    // resolved_*/resolution_action fields are mutually consistent with
    // `resolution_status` at the DB layer; callers that need narrowing
    // discriminate on `resolutionStatus` at the use site.
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

  /**
   * Tenant-admin / store-operator queue read (T524 /
   * 005-WAVE1-LIST).
   *
   * Behavior (FR-014 + SI-001 / SI-004 / FR-013):
   *   - The caller's tenant + (optional) store scope are set as GUCs
   *     via `runWithTenantContext` + `set_config('app.current_store', ...)`.
   *   - SELECT WHERE resolution_status = $1 only — no application-level
   *     `tenant_id` predicate. RLS enforces tenant isolation (003
   *     `unknown_items_tenant_isolation`); the explicit
   *     `app.current_store` GUC drives the `unknown_items_store_read`
   *     policy branch (empty-string for tenant-wide actors via 0009
   *     carve-out; store UUID for store-scoped actors). A tenant
   *     admin sees all stores; a store-scoped operator sees only
   *     their store.
   *   - `storeIdFilter` is an OPTIONAL additional residual filter for
   *     a tenant-wide actor who wants to narrow the page to one
   *     store. RLS still controls security; this param just lets the
   *     caller filter further at the API. Supplying a store the
   *     principal cannot see returns an empty page (RLS filters
   *     before the residual predicate).
   *
   * Pagination:
   *   Wave 1 single-pages within `limit` (default 50, max 200 per
   *   contract). A cursor parameter is accepted at the controller
   *   boundary for forward-compat with the contract's
   *   `ListUnknownItemsResponse` shape, but Wave 1 ignores it
   *   internally — `next_cursor` is always `null`. Real cursor
   *   logic is a follow-up only if review queues exceed 50 rows.
   *   Order: `encountered_at DESC, id DESC` per the contract.
   *
   * No new audit subject emitted by list reads (FR-080's audit
   * scope is state transitions; a queue read is not a transition).
   */
  async listForTenant(input: {
    readonly tenantId: string;
    /** RT-131: the caller's store scope (`resolveStoreScope`). */
    readonly storeScope: StoreScope;
    readonly status: "pending" | "resolved" | "dismissed";
    readonly limit: number;
    readonly storeIdFilter?: string | null;
    // 007 US2 (T037): optional source_system filter + sort + grouping.
    readonly sourceSystem?: string | null;
    readonly sort?: "age_asc" | "age_desc" | "store";
    readonly groupBy?: "store" | "source_system" | null;
  }): Promise<{ items: ReadonlyArray<UnknownItemRow>; nextCursor: null }> {
    // Build the WHERE clause from parameterized fragments. `resolution_status`
    // is always present; `store_id` (residual narrow) and `source_system`
    // (007 US2 filter) are appended only when supplied. Every dynamic value is
    // a bound `$N` parameter — SQL injection cannot reach the planner.
    const where: string[] = ["resolution_status = $1"];
    const params: unknown[] = [input.status];
    if (input.storeIdFilter) {
      params.push(input.storeIdFilter);
      where.push(`store_id = $${params.length}`);
    }
    if (input.sourceSystem) {
      params.push(input.sourceSystem);
      where.push(`source_system = $${params.length}`);
    }

    // ORDER BY is built from a WHITELIST: `sort`/`group_by` are Zod enums, so
    // their values only SELECT a pre-written fragment — they are never
    // interpolated as SQL text. `group_by` adds a leading grouping key so
    // same-group rows are contiguous (FR-004 ordering, not a grouped envelope);
    // `sort` orders within. A stable `id DESC` tie-break is always last.
    const sort = input.sort ?? "age_desc";
    const sortFragment =
      sort === "age_asc"
        ? "encountered_at ASC"
        : sort === "store"
          ? "store_id ASC"
          : "encountered_at DESC";
    const groupFragment =
      input.groupBy === "store"
        ? "store_id ASC, "
        : input.groupBy === "source_system"
          ? "source_system ASC NULLS LAST, "
          : "";
    const orderBy = `${groupFragment}${sortFragment}, id DESC`;

    const rows = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        // Set `app.current_store` GUC — drives the store RLS branch from the
        // caller's store scope (RT-131). A multi-store scope also needs the
        // explicit `store_id = ANY(...)` predicate returned here.
        const scopedStoreIds = await applyListStoreScope(client, input.storeScope);
        const queryWhere = [...where];
        const queryParams = [...params];
        if (scopedStoreIds !== null) {
          queryParams.push(scopedStoreIds);
          queryWhere.push(`store_id = ANY($${queryParams.length}::uuid[])`);
        }
        queryParams.push(input.limit);
        const limitPlaceholder = `$${queryParams.length}`;

        const result = await client.query<{
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
        }>(
          `SELECT id, tenant_id, store_id, identifier_type, value,
                  source_system, resolution_status, resolution_action,
                  resolved_at, resolved_by, resolved_product_id,
                  encountered_at, sale_context
             FROM unknown_items
            WHERE ${queryWhere.join(" AND ")}
            ORDER BY ${orderBy}
            LIMIT ${limitPlaceholder}`,
          queryParams,
        );

        return result.rows;
      },
    );

    const items: UnknownItemRow[] = rows.map((row) => ({
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
    }));

    // Wave 1: single-page within limit; nextCursor always null.
    // Future cursor logic encodes the boundary in
    // `(encountered_at, id)` for the next page.
    return { items, nextCursor: null };
  }

  /**
   * Dismiss a pending unknown-item (T541 / 005-WAVE1-DISMISS).
   *
   * Behavior (FR-002, FR-003, FR-004 monotonic lifecycle):
   *   - Atomic UPDATE with monotonicity guard
   *     (`WHERE id = $1 AND resolution_status = 'pending'`) — the
   *     status filter encodes FR-004 ("pending → resolved/dismissed,
   *     no other transitions"). Re-dismissing a non-pending row
   *     can't succeed at the DB layer.
   *   - On success (rowCount = 1): RETURNING fetches the post-
   *     transition row; caller adapts to wire shape.
   *   - On failure (rowCount = 0): a conditional SELECT distinguishes
   *     the two non-disclosure cases per the contract:
   *       - SELECT returns 1 row → 409 `already_reconciled` (the
   *         caller's tenant CAN see the row, but it's already
   *         `resolved` or `dismissed`)
   *       - SELECT returns 0 rows → 404 non-disclosing (RLS filtered
   *         the row out — either cross-tenant or doesn't exist
   *         anywhere; SI-001/SI-004/FR-013/FR-092)
   *
   * Race safety:
   *   UPDATE-first avoids the SELECT-then-UPDATE race where two
   *   concurrent dismiss requests both see `pending`, both compute
   *   "200 OK", but only one transition actually lands. UPDATE-first
   *   guarantees exactly one atomic winner; the loser's rowCount=0
   *   path drives them to 409 via the SELECT check.
   *
   * RLS posture:
   *   Runs inside `runWithTenantContext` (sets `app.current_tenant`)
   *   + explicit `app.current_store` GUC (empty string for tenant-wide
   *   actors via 0009 carve-out; store UUID for store-scoped operators).
   *   No application-level `tenant_id` predicate — RLS does the
   *   cross-tenant filter. Same posture as `findByIdForTenant` and
   *   `listForTenant`.
   *
   * Audit / metrics:
   *   The route handler carries `@Auditable("unknown_item.dismissed")` —
   *   the global `AuditEmitterInterceptor` fires the audit subject
   *   on a successful response. Wave 1 does NOT emit a rejected-
   *   dismiss audit subject on the 404/409 paths (the
   *   `AuditEmitterInterceptor` only fires on handler success).
   *   Tasks.md T543 mentions a `rejected=true` discriminator;
   *   that's deferred to a future enhancement (would require a
   *   pattern similar to PR #339's IDEMP-MISMATCH filter).
   *
   *   `unknown_item_resolved_total{action='dismissed'}` is incremented on
   *   the `ok` branch (T553 / 005-WAVE1-METRICS). The counter was
   *   allowlisted with `action ∈ {linked, created, dismissed}` in PR #299;
   *   Wave 1 emits only `dismissed`. Wave 2 "linked"/"created" sites land
   *   in separate slices.
   */
  async dismissUnknownItem(input: {
    readonly id: string;
    readonly tenantId: string;
    /** RT-131: the caller's store scope (`resolveStoreScope`). */
    readonly storeScope: StoreScope;
    readonly actorUserId: string;
  }): Promise<UnknownItemRow> {
    const result = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<
        | { kind: "ok"; row: UnknownItemRow }
        | { kind: "already_reconciled" }
        | { kind: "not_found" }
      > => {
        // Set `app.current_store` GUC from the caller's store scope — an
        // out-of-scope row is invisible to the UPDATE and to the existence
        // check below, so it lands on the non-disclosing 404 (RT-131).
        await applyItemStoreScope(client, input.storeScope, input.id);

        // UPDATE-first with monotonicity guard. The `WHERE` clause
        // includes `resolution_status = 'pending'` per FR-004 +
        // the slice's explicit stop rule. Omitting that predicate
        // would allow re-dismissing a `resolved` row (silently
        // overwriting timestamps).
        const updateResult = await client.query<{
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
        }>(
          `UPDATE unknown_items
              SET resolution_status = 'dismissed',
                  resolution_action = 'dismissed',
                  resolved_at       = now(),
                  resolved_by       = $2,
                  resolved_product_id = NULL
            WHERE id = $1
              AND resolution_status = 'pending'
          RETURNING id, tenant_id, store_id, identifier_type, value,
                    source_system, resolution_status, resolution_action,
                    resolved_at, resolved_by, resolved_product_id,
                    encountered_at, sale_context`,
          [input.id, input.actorUserId],
        );

        const updated = updateResult.rows[0];
        if (updated) {
          return {
            kind: "ok",
            row: {
              id: updated.id,
              tenantId: updated.tenant_id,
              storeId: updated.store_id,
              identifierType: updated.identifier_type,
              identifierValue: updated.value,
              sourceSystem: updated.source_system,
              resolutionStatus: updated.resolution_status,
              resolutionAction: updated.resolution_action,
              resolvedAt: updated.resolved_at,
              resolvedBy: updated.resolved_by,
              resolvedProductId: updated.resolved_product_id,
              encounteredAt: updated.encountered_at,
              saleContext: updated.sale_context,
            },
          };
        }

        // rowCount = 0 — distinguish 404 (RLS filtered / doesn't exist)
        // from 409 (exists, just not pending). The SELECT runs with
        // the same RLS context (tenant + store GUC still set), so a
        // cross-tenant row will be invisible here just as it was to
        // the UPDATE.
        const existenceCheck = await client.query<{ resolution_status: string }>(
          `SELECT resolution_status
             FROM unknown_items
            WHERE id = $1
            LIMIT 1`,
          [input.id],
        );

        if (existenceCheck.rows[0]) {
          return { kind: "already_reconciled" };
        }
        return { kind: "not_found" };
      },
    );

    if (result.kind === "ok") {
      // T553 / FR-081: increment the dismiss counter on successful
      // transition. The action is always "dismissed" here — this is the
      // only Wave 1 emission site for `unknown_item_resolved_total`.
      // Wave 2 "linked" / "created" actions land in separate slices.
      recordUnknownItemResolved({ action: "dismissed" });
      return result.row;
    }
    if (result.kind === "already_reconciled") {
      // 409 with `error.code = "conflict"` (envelope) + `details.code =
      // "already_reconciled"` (research §R2 taxonomy). The nested code
      // mirrors PR #339's pattern where the interceptor's domain code
      // travels through `error.details`.
      throw new ConflictException({
        code: "already_reconciled",
        message:
          "The unknown item is already resolved or dismissed; lifecycle transitions are monotonic per FR-004.",
      });
    }
    // SI-001 / SI-004 / FR-013 / FR-092: non-disclosing 404. Same
    // posture as `findByIdForTenant` — the response carries no
    // identifier, no tenant id, nothing that could be used as an
    // existence oracle.
    throw new NotFoundException("Not Found");
  }

  /**
   * Bulk-dismiss a bounded selection of unknown items (007 US8 / T057).
   *
   * FR-070a: this is a UX batching of the SHIPPED per-item dismiss — NOT a new
   * lifecycle write. Each id is dismissed by calling {@link dismissUnknownItem}
   * (the exact shipped path the regression guard T062 protects); the per-item
   * outcome is derived from that call's success/throw. One item's failure
   * (already-reconciled / not-found) does NOT abort the batch or affect
   * siblings — each id is independent.
   *
   * The ≤200 ceiling (FR-044) is enforced UPSTREAM at the controller's Zod
   * `.strict()` `{ ids: maxItems 200 }` boundary, so this method never sees an
   * over-ceiling batch — a 201-id batch is rejected whole as 400 validation
   * before reaching here (reject, NOT clamp/truncate — SC-008).
   *
   * Per-item outcome mapping (data-model §2.3 — BulkDismissOutcome):
   *   - shipped dismiss succeeds            → { outcome: "dismissed" }
   *   - shipped dismiss throws Conflict     → { outcome: "already_reconciled",
   *       (already resolved/dismissed)          details: { prior_state } }
   *   - shipped dismiss throws NotFound     → { outcome: "not_found" }
   *       (RLS-filtered / absent — non-disclosing, SI-004)
   *
   * `prior_state` on the already_reconciled branch comes from an RLS-scoped
   * `findByIdForTenant` read — the row IS visible to the caller (the conflict
   * proves it is in-scope, just terminal), so disclosing its lifecycle state to
   * the actor who can already see it is not a leak.
   *
   * Idempotency: the route carries `@Idempotent("required")`; replay
   * short-circuit + body-mismatch 409 are handled by the shared
   * `IdempotencyInterceptor` so the WHOLE batch response is replayed verbatim
   * (SC-005).
   *
   * Spec anchors: FR-044, FR-070, FR-070a, SC-005, SC-008, Constitution §III.
   */
  async bulkDismissUnknownItems(input: {
    readonly tenantId: string;
    /** Active store, for audit attribution only. */
    readonly storeId: string | null;
    /** RT-131: the caller's store scope (`resolveStoreScope`). */
    readonly storeScope: StoreScope;
    readonly actorUserId: string;
    readonly ids: readonly string[];
    // Request correlation id, threaded from the controller (request_id ??
    // randomUUID), so each per-item dismiss audit carries the SAME
    // correlation-id as the originating request — symmetric with reopen
    // (T070 / SC-004 / FR-064 / FR-083 traceability; the batch's events are
    // linkable to the one request that produced them). OPTIONAL so existing
    // direct callers (service-level specs) don't break; the controller always
    // supplies it. Falls back to a minted UUID when absent — a present id is
    // strictly better for traceability than null.
    readonly correlationId?: string;
  }): Promise<{ outcomes: BulkDismissOutcome[] }> {
    const outcomes: BulkDismissOutcome[] = [];
    const correlationId = input.correlationId ?? randomUUID();

    // Decompose into the shipped per-item dismiss. Sequential (not parallel) so
    // each item's transaction is independent and the per-item outcome ordering
    // matches the input — no cross-item coupling (FR-070a). A handful of
    // dismisses per request is well within latency budget; a parallel fan-out
    // would add connection-pool pressure for no UX gain.
    for (const id of input.ids) {
      try {
        await this.dismissUnknownItem({
          id,
          tenantId: input.tenantId,
          storeScope: input.storeScope,
          actorUserId: input.actorUserId,
        });
        outcomes.push({ id, outcome: "dismissed" });
        // FR-070a / FR-064 / SC-004: the shipped single-dismiss audit
        // (`unknown_item.dismissed`) is emitted ROUTE-level by @Auditable +
        // AuditEmitterInterceptor — but the bulk path calls the service method
        // directly, bypassing that decorator. So emit the per-item dismiss audit
        // PROGRAMMATICALLY (one event per transitioned item). Guard the optional
        // enqueuer explicitly, then fire-and-forget (`void`) so a best-effort
        // audit never blocks the per-item loop and a dropped enqueue never fails
        // the item (CodeRabbit #409: don't await best-effort work; the prior
        // `?.enqueue().catch()` was correct by optional-chaining short-circuit
        // but this is clearer and non-blocking). Skipped when the optional
        // enqueuer is absent (existing single-route specs construct PG_POOL-only).
        if (this.auditEnqueuer) {
          void this.auditEnqueuer
            .enqueue({
              actor_user_id: input.actorUserId,
              actor_label: null,
              tenant_id: input.tenantId,
              store_id: input.storeId,
              action: "unknown_item.dismissed",
              target_type: "unknown_item",
              target_id: id,
              request_id: correlationId,
              metadata: { via: "bulk_dismiss" },
            })
            .catch(() => {
              // Best-effort — a dropped bulk-dismiss audit must not fail the item.
            });
        }
      } catch (err: unknown) {
        if (err instanceof ConflictException) {
          // already_reconciled — the row is in-scope but terminal. Read its
          // current lifecycle state (RLS-scoped) to surface prior_state; the
          // row is visible to this caller, so this is not a disclosure.
          let priorState: string | null = null;
          try {
            const row = await this.findByIdForTenant({
              id,
              tenantId: input.tenantId,
              storeScope: input.storeScope,
            });
            priorState = row.resolutionStatus;
          } catch {
            // If the follow-up read 404s (race: row dismissed+filtered between
            // the conflict and the read), omit prior_state rather than fail the
            // whole item — the outcome is still already_reconciled.
            priorState = null;
          }
          // CodeRabbit #409 F2: `details` is OPTIONAL in the wire contract
          // (`{ id, outcome, details? }`) — include it only when there's a
          // prior_state to report; never serialize `details: null`.
          outcomes.push(
            priorState !== null
              ? { id, outcome: "already_reconciled", details: { prior_state: priorState } }
              : { id, outcome: "already_reconciled" },
          );
        } else if (err instanceof NotFoundException) {
          // Non-disclosing not_found — RLS-filtered (cross-tenant/out-of-scope)
          // or absent. Does NOT abort the batch (FR-070a).
          outcomes.push({ id, outcome: "not_found" });
        } else {
          // Genuine system failure (e.g. DB error) — propagate so the whole
          // request surfaces a system_failure rather than masking it as a
          // per-item outcome (FR-054 / §XI: never a hidden partial state).
          throw err;
        }
      }
    }

    return { outcomes };
  }
}
