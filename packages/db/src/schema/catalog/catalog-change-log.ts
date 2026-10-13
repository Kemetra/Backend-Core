/**
 * `catalog_change_log` — 010 POS Catalogue Read-Down Sync. (data-model.md §3)
 *
 * Append-only change-log that backs the read-down **cursor + delta** mechanism
 * (research R1). It mirrors the `outbox_events` append-only pattern but is a
 * read-side projection-versioning aid — NOT a new source of truth (R1
 * "alternatives considered": full event-sourcing rejected).
 *
 * Key invariants (research R9 — resolves external-review R-3):
 *   - `sequence` is a **single GLOBAL monotonic identity** (`GENERATED ALWAYS AS
 *     IDENTITY` in the 0015 migration), filtered by `tenant_id` at read. It is
 *     therefore monotonic-*within*-tenant by construction (any subset of a
 *     strictly-increasing series is strictly increasing) and **sparse** for any
 *     single store — that is correct. A per-tenant `max(sequence)+1` counter is
 *     intentionally NOT used: it races under concurrent catalog writes
 *     (duplicate / non-monotonic values, deadlocks). Completeness is
 *     server-guaranteed by the delta filter, NOT consumer-verified by cursor
 *     contiguity (FR-022).
 *   - `tenant_id` is NOT NULL — the cursor + RLS are scoped by it.
 *   - `store_id` is **NULLABLE**: `NULL` = a tenant-wide event (a
 *     `tenant_products` / tenant-wide-alias change affecting all non-overriding
 *     stores — the R9 *sentinel*); non-NULL = a store-override / store-scoped
 *     alias change for that store. The delta read unions
 *     `(store_id = S OR store_id IS NULL)`.
 *   - `op` is `upsert | remove_from_sellable` (the tombstone for retire OR
 *     became-unpriced/non-representable — Decision #3 / FR-042).
 *   - The change-log carries only `product_id` + `op` — **never payload**. The
 *     resolved `row` is computed at read time per `(tenant, store)` (data-model
 *     §1/§4), which is why write-time fan-out pre-resolves nothing and the dumb
 *     one-row-per-raw-change trigger wins (R9).
 *
 * Population (T001 [SIGN-OFF], read-only): rows are written by **DB triggers
 * inside the 0015 migration** on `tenant_products` / `store_product_overrides` /
 * `product_aliases` — NOT by any 003/005 application write path. The triggers
 * read NEW/OLD and INSERT here only (additive); the app-level outbox-mirror is
 * the REJECTED alternative.
 *
 * RLS-enabled + FORCED by `tenant_id`, SELECT + INSERT only (append-only — no
 * UPDATE/DELETE policy, mirroring `stock_movements` / 0014). Policy lives in
 * `0015_pos_catalog_read_down.sql`. The trigger INSERT runs in the catalog
 * write transaction's tenant-GUC context (`runWithTenantContext` sets
 * `app.current_tenant`), so a plain INSERT satisfies the INSERT policy — no
 * SECURITY DEFINER (which would bypass §II tenant isolation) is used.
 */
import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "../tenants";
import { stores } from "../stores";
import { tenantProducts } from "./tenant-products";

export const catalogChangeLog = pgTable(
  "catalog_change_log",
  {
    // Single GLOBAL monotonic cursor (GENERATED ALWAYS AS IDENTITY in 0015).
    // Drizzle models the column as bigint; the IDENTITY clause + PK live in the
    // migration (no Drizzle generatedAlwaysAsIdentity round-trip dependency).
    sequence: bigint("sequence", { mode: "bigint" }).primaryKey().notNull(),
    // ON DELETE CASCADE on ALL three FKs — DELIBERATE deviation from the
    // schema-wide RESTRICT convention. catalog_change_log is a trigger-populated
    // DERIVED PROJECTION; it must never veto deletion of the entities it mirrors.
    // RESTRICT would deadlock every real catalog deletion (the trigger writes a
    // change-log row on a tenant_products/override insert/update, and that row
    // would then block deleting the product/store/tenant). CASCADE is also the
    // correct semantic for the advisory-op delta read: a row pointing at a
    // hard-deleted product is unresolvable, so the projection dies with its
    // subject. See 0015_pos_catalog_read_down.sql for the full rationale.
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // NULLABLE: NULL = tenant-wide (sentinel) event; non-NULL = store-scoped (R9).
    storeId: uuid("store_id").references(() => stores.id, {
      onDelete: "cascade",
    }),
    // Provenance only — the resolved payload is computed at read time (§1/§4).
    productId: uuid("product_id")
      .notNull()
      .references(() => tenantProducts.id, { onDelete: "cascade" }),
    op: text("op").notNull(),
    // Diagnostics only — ordering uses `sequence`, never this (data-model §3).
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The delta-read access path: `WHERE tenant_id = T AND (store_id = S OR
    // store_id IS NULL) AND sequence > C ORDER BY sequence` (R9). Lead with
    // (tenant_id, sequence) — store_id is an INCLUDE/filter column.
    index("idx_catalog_change_log_tenant_sequence").on(t.tenantId, t.sequence),
  ],
);

export type CatalogChangeLogRow = typeof catalogChangeLog.$inferSelect;
export type NewCatalogChangeLogRow = typeof catalogChangeLog.$inferInsert;
