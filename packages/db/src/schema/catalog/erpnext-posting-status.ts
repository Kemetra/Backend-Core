/**
 * `erpnext_posting_status` — ERPNext posting lifecycle per sale / reversal
 * (015 data-model.md §5).
 *
 * Records, per DP2 sale (`kind='sale_post'`) or per void/refund terminal event
 * (`kind='reversal'`), the state of its ERPNext posting — `pending` -> `posted`
 * / `failed_transient` / `permanently_rejected` — plus the ERPNext document
 * reference (`document_ref`) for O-3 idempotency. The 008 sale fact is NEVER
 * mutated by a posting outcome (012 contract, §IX); only this status row is. The
 * posting WORK-ITEM the connector pulls (012 feed) is a READ-PROJECTION over this
 * table ⊕ the 008 sale fact ⊕ 013 `erpnext_item_map` ⊕ 014 `erpnext_warehouse_map`
 * — NOT a stored wire row (data-model §3).
 *
 * Key invariants (015 data-model.md §5):
 *   - WHY a new table (NOT derive-on-read; 015-SIGNOFF-STATE): an
 *     externally-assigned ERPNext `document_ref` + the posting status cannot be
 *     derived, so O-3 (exactly-one document per sale across retries) is
 *     unenforceable without persisted state. 010's read-down feed set the
 *     precedent (a [GATED] change-log table; the app/outbox-mirror was rejected)
 *     for a WEAKER need. (data-model §2)
 *   - `source_ref_id` is the ORIGINATING row id — `sales.id` (sale_post) OR
 *     `sale_voids.id` / `sale_refunds.id` (reversal). DELIBERATELY NO FK: it is
 *     POLYMORPHIC across three tables (a single-table FK would make every reversal
 *     row fail to insert). Mirrors the 014 `erpnext_warehouse_ref` / 013
 *     `erpnext_item_ref` / 003 `source_global_product_id` no-FK rationale.
 *   - O-3 idempotency UNIQUE `(tenant_id, source_ref_id)` — keyed on the
 *     originating row's COLLISION-PROOF UUIDv7 PK, NOT on `(source_system,
 *     external_id)`. 008 capture takes a terminal event's `external_id` from the
 *     request body with no cross-table guarantee it differs from the parent sale's
 *     — so a `(source_system, external_id)` key could collide a reversal with its
 *     sale_post and permanently block the 2nd posting (the REVERSAL-CARDINALITY
 *     trap; data-model §5). Keying on `source_ref_id` is kind-agnostic +
 *     collision-proof: multiple partial refunds of one sale each get their own row.
 *   - `sale_id` (the parent sale, present for BOTH kinds) DOES FK — the composite
 *     `(sale_id, tenant_id, store_id)` -> sales' `uq_sales_id_tenant_store` (the
 *     008 child-table FK pattern). It is declared in the SQL migration (Drizzle
 *     cannot express a composite FK to a non-PK unique here; the schema mirrors
 *     008's sale-lines, which likewise declares the composite FK in SQL).
 *   - `sequence` is a single global IDENTITY — the feed CURSOR / ordering source
 *     the 012 `connectorPullPostings` cursor advances over (mirrors the 010
 *     read-down change-log sequence). Read-only / DB-assigned.
 *   - NO money / amount column: amounts live on the 008 sale fact + are projected
 *     into the work-item at read time. This table tracks posting STATE only.
 *   - `document_ref` is set ONLY on a `posted` ack (a CHECK ties the two); it is
 *     connector-assigned via `connectorAckOutcome`, never invented by DP2.
 *
 * Mutable tenant-owned resource: SELECT + INSERT + UPDATE RLS policies
 * (`pending` -> terminal; the ack updates status / document_ref /
 * rejection_category / retry_count). NO DELETE policy — a dead-letter is a
 * status, not a row removal. Policy lives in the 0019 migration. RLS-enabled by
 * `tenant_id`. TENANT-only table — `store_id` is a tenant-local FK, not a second
 * RLS axis.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";

export const erpnextPostingStatus = pgTable(
  "erpnext_posting_status",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    // The parent sale (present for BOTH kinds). Composite FK
    // (sale_id, tenant_id, store_id) -> sales declared in the 0019 SQL migration.
    saleId: uuid("sale_id").notNull(),
    kind: text("kind").notNull(),
    // The ORIGINATING row id (sales | sale_voids | sale_refunds). POLYMORPHIC —
    // deliberately NO FK. The O-3 idempotency anchor.
    sourceRefId: uuid("source_ref_id").notNull(),
    // Provenance (mirrors 008) — carried for correlation, NOT the O-3 key.
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id").notNull(),
    payloadHash: char("payload_hash", { length: 64 }).notNull(),
    // Posting lifecycle. `pending` on projection; the ack moves it.
    status: text("status").notNull().default("pending"),
    // ERPNext document id — set on a `posted` ack (powers O-3 replay). NULL until then.
    documentRef: text("document_ref"),
    // Nearest 012 RejectionReason.category on a `permanently_rejected` ack.
    rejectionCategory: text("rejection_category"),
    retryCount: integer("retry_count").notNull().default(0),
    // Feed cursor / ordering source (single global monotonic; 010 precedent).
    sequence: bigint("sequence", { mode: "bigint" }).generatedAlwaysAsIdentity(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    correlationId: uuid("correlation_id"),
    // 0037 (RT-330): the frozen resolution version the feed reads
    // (erpnext_posting_resolution). NULL = no frozen resolution; the feed
    // then keeps the pre-0037 live item-map join for that row only.
    currentResolutionVersion: integer("current_resolution_version"),
    // 0039 (RT-332): the EXISTING ERP document a `reconciliation_required` ack
    // (or a stale-version `posted` ack) reported, as ErpnextDocumentRef JSON.
    // Set only on a `permanently_rejected` row; separate from `document_ref`.
    reconciliationDocumentRef: text("reconciliation_document_ref"),
  },
  (t) => [
    check(
      "erpnext_posting_status_kind_valid",
      sql`${t.kind} IN ('sale_post', 'reversal')`,
    ),
    check(
      "erpnext_posting_status_status_valid",
      sql`${t.status} IN ('pending', 'posted', 'failed_transient', 'permanently_rejected')`,
    ),
    check(
      "erpnext_posting_status_payload_hash_format",
      sql`${t.payloadHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "erpnext_posting_status_retry_count_non_negative",
      sql`${t.retryCount} >= 0`,
    ),
    // A posted row MUST carry document_ref (O-3); a non-posted row leaves it NULL.
    check(
      "erpnext_posting_status_document_ref_when_posted",
      sql`(${t.status} = 'posted') = (${t.documentRef} IS NOT NULL)`,
    ),
    check(
      "erpnext_posting_status_resolution_version_positive",
      sql`${t.currentResolutionVersion} IS NULL OR ${t.currentResolutionVersion} >= 1`,
    ),
    check(
      "erpnext_posting_status_reconciliation_ref_when_rejected",
      sql`${t.reconciliationDocumentRef} IS NULL OR ${t.status} = 'permanently_rejected'`,
    ),
    // 0037: composite target for erpnext_posting_resolution (same-tenant intent).
    uniqueIndex("UQ_idx_erpnext_posting_status_id_tenant").on(t.id, t.tenantId),
    // O-3 idempotency: exactly one posting target per ORIGINATING row.
    uniqueIndex("UQ_idx_erpnext_posting_status_source_ref").on(
      t.tenantId,
      t.sourceRefId,
    ),
    // Pending-feed scan: the connector pulls pending rows ordered by the cursor.
    index("idx_erpnext_posting_status_pending")
      .on(t.tenantId, t.sequence)
      .where(sql`${t.status} = 'pending'`),
    // Provenance / reconciliation lookup (017).
    index("idx_erpnext_posting_status_provenance").on(
      t.tenantId,
      t.sourceSystem,
      t.externalId,
    ),
  ],
);

export type ErpnextPostingStatusRow = typeof erpnextPostingStatus.$inferSelect;
export type NewErpnextPostingStatusRow = typeof erpnextPostingStatus.$inferInsert;
