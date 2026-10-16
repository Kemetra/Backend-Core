/**
 * `payer_account` — 035 §5 (FR-001/2/4). Who is responsible for settling a sale
 * balance (distinct from the buyer at the till).
 *
 * Category = credit_customer | corporate | insurer (FR-002). RT-418 (0049):
 * `credit_terms` is dropped (ERPNext owns terms and credit limits);
 * `external_ref` is the payer's ERPNext Customer link (settlement.yaml 2.0.0).
 * `(id, tenant_id)` is unique: the composite FK target of
 * `sale_responsibilities`.
 * Optimistic concurrency via `version` (Principle III). RLS-enabled + FORCE,
 * fail-closed by tenant_id; policies live in `0027_settlement_receivables.sql`.
 *
 * §XIV BUSINESS-class: display_name is light PII; no national-id / card / secret.
 */
import { sql } from "drizzle-orm";
import {
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

export const payerAccount = pgTable(
  "payer_account",
  {
    id: uuid("id").primaryKey().notNull().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // NULL = tenant-wide payer; non-NULL = store-scoped.
    storeId: uuid("store_id").references(() => stores.id, {
      onDelete: "restrict",
    }),
    category: text("category").notNull(),
    displayName: text("display_name").notNull(),
    externalRef: text("external_ref"),
    status: text("status").notNull().default("active"),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "payer_account_category_valid",
      sql`${t.category} IN ('credit_customer', 'corporate', 'insurer')`,
    ),
    check("payer_account_status_valid", sql`${t.status} IN ('active', 'suspended')`),
    check(
      "payer_account_display_name_non_empty",
      sql`length(btrim(${t.displayName})) > 0`,
    ),
    check("payer_account_version_non_negative", sql`${t.version} >= 0`),
    index("idx_payer_account_tenant_list").on(t.tenantId, t.id.desc()),
    uniqueIndex("UQ_idx_payer_account_id_tenant").on(t.id, t.tenantId),
  ],
);

export type PayerAccountRow = typeof payerAccount.$inferSelect;
export type NewPayerAccountRow = typeof payerAccount.$inferInsert;
