/**
 * `sale_reprints` — one row per receipt reprint authorized or recorded through
 * recordSaleReprint (Jira RT-538; contract RT-537 D-7, pos-sales/sale-history.yaml).
 * Policies and CHECKs in `0047_sale_history_capture.sql`.
 *
 * Append-only: SELECT + INSERT tenant policies only (FORCE RLS), like
 * `sale_voids`. Recording a reprint changes no sale, void, return or payment
 * fact.
 *
 *   - `mode` / `kind` are the SaleReprint enums;
 *   - `marked_voided` / `marked_returned` are SaleReprint.marks as two flags;
 *   - `copy_number` is the copy printed (`record`) or to print (`authorize`);
 *   - `printed_at` is the terminal's clock (provenance), `recorded_at` the server's;
 *   - `created_by` is the actor (envelope user, or the admitted cashier);
 *     `device_id` the calling terminal, NULL when the request carried none;
 *   - one Idempotency-Key per client per sale (`uq_sale_reprints_sale_actor_key`),
 *     never wider than the replay layer's route + saleRef + client + key scope;
 *   - composite FK to `sales (id, tenant_id, store_id)`.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { devices } from "../devices";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { sales } from "./sales";

export const saleReprints = pgTable(
  "sale_reprints",
  {
    id: uuid("id").primaryKey().notNull(),
    saleId: uuid("sale_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    mode: text("mode").notNull(),
    kind: text("kind").notNull(),
    markedVoided: boolean("marked_voided").notNull(),
    markedReturned: boolean("marked_returned").notNull(),
    copyNumber: integer("copy_number").notNull(),
    printedAt: timestamp("printed_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    deviceId: uuid("device_id").references(() => devices.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
  },
  (t) => [
    check("sale_reprints_mode_valid", sql`${t.mode} IN ('authorize', 'record')`),
    check("sale_reprints_kind_valid", sql`${t.kind} IN ('duplicate', 'sale_record')`),
    check("sale_reprints_copy_number_positive", sql`${t.copyNumber} >= 1`),
    foreignKey({
      name: "fk_sale_reprints_sale_tenant_store",
      columns: [t.saleId, t.tenantId, t.storeId],
      foreignColumns: [sales.id, sales.tenantId, sales.storeId],
    }).onDelete("restrict"),
    unique("uq_sale_reprints_sale_actor_key").on(
      t.tenantId,
      t.storeId,
      t.saleId,
      t.createdBy,
      t.idempotencyKey,
    ),
    index("idx_sale_reprints_sale").on(t.saleId),
  ],
);

export type SaleReprintRow = typeof saleReprints.$inferSelect;
export type NewSaleReprintRow = typeof saleReprints.$inferInsert;
