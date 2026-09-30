/**
 * `sales` — the immutable sale fact (008 sale header). (data-model.md §1)
 *
 * The FIRST sale fact the SaaS owns. Tenant- and store-scoped. One row per
 * logical `(tenant_id, source_system, external_id)` (dedup, FR-050). Built
 * ALONGSIDE the shipped 005 ingestion seam — reuses the Idempotency-Key
 * interceptor + `sourceSystem + externalId` dedup; this table is the new
 * durable fact.
 *
 * Key invariants:
 *   - Money: `pos_total` is `numeric(19,4)` + `currency_code` `char(3)`
 *     (gate A.1/A.6); never floating point; paired-currency + non-negative
 *     CHECK (mirror 003 `tenant_products`).
 *   - Gate B nullability: `occurred_at` / `received_at` / `business_date`
 *     are NOT NULL; `processed_at` / `source_clock_at` / `mismatch_flag` are
 *     nullable (SaaS-owned, set off-request).
 *   - `business_date` is a DATE (store-tz derived, FR-023), not a timestamptz.
 *   - Immutable fact: NO `version` column (gate D.1 / FR-070 — no
 *     optimistic-concurrency column). Tenders live in the child
 *     `sale_tenders` (RT-77); `tender_count` records how many capture wrote.
 *   - `device_id` (RT-77, RT-10 D7(i)): the envelope guard's bound device,
 *     never a body field; NULL for pre-RT-77 sales.
 *   - Provenance: `source_system` / `external_id` / `payload_hash`
 *     (SHA-256 canonical, gate C). Dedup-unique on
 *     `(tenant_id, source_system, external_id)`.
 *   - RLS-enabled + FORCE, fail-closed by `tenant_id`. Policy lives in
 *     `0012_sales.sql`.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  smallint,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { devices } from "../devices";
import { stores } from "../stores";
import { tenants } from "../tenants";

export const sales = pgTable(
  "sales",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    currencyCode: char("currency_code", { length: 3 }).notNull(),
    posTotal: numeric("pos_total", { precision: 19, scale: 4 }).notNull(),
    // Gate B: business-event + receipt + derived business date are NOT NULL.
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    businessDate: date("business_date").notNull(),
    // SaaS-owned processing state — nullable until set off-request (§V, FR-071).
    processedAt: timestamp("processed_at", { withTimezone: true }),
    // 032 §7 — server-authoritative sync-status. DP-2 owns it; POS never
    // overrides. NOT NULL with a 'captured' default (set in the capture INSERT
    // and advanced to 'synced' by the SAME drain UPDATE that sets processed_at —
    // spec clarify Q1: the DP-2 sale-processing drain, NOT the ERPNext posting
    // path). Allowed values are enforced by the `sales_sync_status_valid` CHECK
    // in 0026_sale_sync_status.sql. Rides the existing `sales` tenant UPDATE
    // policy (no new RLS) — the same SaaS-owned-mutable posture as processed_at.
    syncStatus: text("sync_status").notNull().default("captured"),
    // POS-reported clock, preserved as provenance; NEVER a security clock (FR-022).
    sourceClockAt: timestamp("source_clock_at", { withTimezone: true }),
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    // Advisory; SaaS-owned (FR-031/032). Nullable until processing computes it.
    mismatchFlag: boolean("mismatch_flag"),
    createdBy: uuid("created_by").notNull(),
    // RT-77 (0033): the terminal that captured the sale, server-resolved.
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "restrict" }),
    // RT-77 (0033): number of sale_tenders rows; the feed's visibility guard.
    tenderCount: smallint("tender_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "sales_currency_code_format",
      sql`${t.currencyCode} ~ '^[A-Z]{3}$'`,
    ),
    check("sales_pos_total_non_negative", sql`${t.posTotal} >= 0`),
    check("sales_tender_count_range", sql`${t.tenderCount} BETWEEN 0 AND 2`),
    // Backs the composite FK from each child table (sale_lines / sale_voids /
    // sale_refunds reference (id, tenant_id, store_id) so a child can never
    // attach to a sale in a different tenant/store).
    unique("uq_sales_id_tenant_store").on(t.id, t.tenantId, t.storeId),
    // Dedup contract (FR-050/041): one sale per (tenant, sourceSystem, externalId).
    uniqueIndex("uq_sales_tenant_source_external").on(
      t.tenantId,
      t.sourceSystem,
      t.externalId,
    ),
    index("idx_sales_tenant_store").on(t.tenantId, t.storeId),
    index("idx_sales_business_date").on(t.tenantId, t.businessDate),
    index("idx_sales_unprocessed")
      .on(t.tenantId)
      .where(sql`${t.processedAt} IS NULL`),
    // 032 §9 — NEEDS_REPAIR queue read acceleration. Tenant+store scoped,
    // newest-first (UUIDv7 id keyset), filtered to the failed-needs-repair
    // state. Mirrors the idx_sales_unprocessed partial-index pattern.
    index("idx_sales_needs_repair")
      .on(t.tenantId, t.storeId, t.id.desc())
      .where(sql`${t.syncStatus} = 'failed-needs-repair'`),
  ],
);

export type SaleRow = typeof sales.$inferSelect;
export type NewSaleRow = typeof sales.$inferInsert;
