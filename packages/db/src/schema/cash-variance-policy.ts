/**
 * `cash_variance_policy_revisions` — the shift variance policy history (Jira
 * RT-385, AD-CASH-001 D-3; `0050_shift_variance_policy.sql`, [GATED]).
 * Contract: `cash-variance-policy.openapi.yaml` 1.0.0-draft (RT-384).
 *
 * One immutable row per published revision: the tenant default (`scope =
 * 'tenant'`, always a `set`, no expiry) or a store override (`scope =
 * 'store'`, `set` or `clear`). The value is `mode` `none` | `limit` with an
 * exact-decimal `limit_amount` and its `currency_code` (D-1). Apply Now only
 * (`effective_from = created_at`, DR-12). `permanent` is derived by CHECK: a
 * store `set` with no expiry, or one more than 90 × 24 h of elapsed time after
 * publish (DR-4); a permanent revision names its publishing owner as
 * `approved_by_user_id`. Each scope's history is one linear chain
 * (`supersedes_revision_id`, unique per predecessor, one first revision per
 * scope): the backstop of the `expectedRevisionId` concurrency check.
 * Effective state (current / superseded / expired) is derived at read.
 *
 * Append-only for every role and tenant-RLS-forced with SELECT and INSERT
 * policies only. The same-scope predecessor rule, the partial unique indexes,
 * the policies and the triggers live in the SQL migration.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "./stores";
import { tenants } from "./tenants";
import { users } from "./users";

export const cashVariancePolicyRevisions = pgTable(
  "cash_variance_policy_revisions",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    scope: text("scope").notNull(),
    storeId: uuid("store_id"),
    kind: text("kind").notNull(),
    mode: text("mode"),
    limitAmount: numeric("limit_amount", { precision: 19, scale: 4 }),
    currencyCode: char("currency_code", { length: 3 }),
    reason: text("reason").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),
    permanent: boolean("permanent").notNull(),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    supersedesRevisionId: uuid("supersedes_revision_id"),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_cash_variance_policy_revisions_id_tenant").on(t.id, t.tenantId),
    foreignKey({
      name: "fk_cash_variance_policy_revisions_store",
      columns: [t.tenantId, t.storeId],
      foreignColumns: [stores.tenantId, stores.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_cash_variance_policy_revisions_supersedes",
      columns: [t.supersedesRevisionId, t.tenantId],
      foreignColumns: [t.id, t.tenantId],
    }).onDelete("restrict"),
    check("cash_variance_policy_revisions_scope_valid", sql`${t.scope} IN ('tenant', 'store')`),
    check("cash_variance_policy_revisions_kind_valid", sql`${t.kind} IN ('set', 'clear')`),
    check(
      "cash_variance_policy_revisions_mode_valid",
      sql`${t.mode} IS NULL OR ${t.mode} IN ('none', 'limit')`,
    ),
    check(
      "cash_variance_policy_revisions_store_iff_store_scope",
      sql`(${t.scope} = 'store') = (${t.storeId} IS NOT NULL)`,
    ),
    check(
      "cash_variance_policy_revisions_tenant_set_only",
      sql`${t.scope} = 'store' OR (${t.kind} = 'set' AND ${t.effectiveUntil} IS NULL)`,
    ),
    check(
      "cash_variance_policy_revisions_value_shape",
      sql`(${t.kind} = 'clear' AND ${t.mode} IS NULL AND ${t.limitAmount} IS NULL
          AND ${t.currencyCode} IS NULL AND ${t.effectiveUntil} IS NULL)
        OR (${t.kind} = 'set' AND ${t.mode} IS NOT NULL AND ${t.mode} = 'none'
          AND ${t.limitAmount} IS NULL AND ${t.currencyCode} IS NULL)
        OR (${t.kind} = 'set' AND ${t.mode} IS NOT NULL AND ${t.mode} = 'limit'
          AND ${t.limitAmount} IS NOT NULL AND ${t.currencyCode} IS NOT NULL)`,
    ),
    check(
      "cash_variance_policy_revisions_limit_non_negative",
      sql`${t.limitAmount} IS NULL OR ${t.limitAmount} >= 0`,
    ),
    check(
      "cash_variance_policy_revisions_limit_not_nan",
      sql`${t.limitAmount} IS NULL OR ${t.limitAmount} <> 'NaN'::numeric`,
    ),
    check(
      "cash_variance_policy_revisions_currency_code_format",
      sql`${t.currencyCode} IS NULL OR ${t.currencyCode} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "cash_variance_policy_revisions_reason_length",
      sql`char_length(${t.reason}) BETWEEN 1 AND 200`,
    ),
    check(
      "cash_variance_policy_revisions_apply_now",
      sql`${t.effectiveFrom} = ${t.createdAt}`,
    ),
    check(
      "cash_variance_policy_revisions_until_after_from",
      sql`${t.effectiveUntil} IS NULL OR ${t.effectiveUntil} > ${t.effectiveFrom}`,
    ),
    check(
      "cash_variance_policy_revisions_permanent_derived",
      sql`${t.permanent} = (${t.scope} = 'store' AND ${t.kind} = 'set'
        AND (${t.effectiveUntil} IS NULL
          OR ${t.effectiveUntil} > ${t.effectiveFrom} + interval '2160 hours'))`,
    ),
    check(
      "cash_variance_policy_revisions_approver_iff_permanent",
      sql`${t.permanent} = (${t.approvedByUserId} IS NOT NULL)`,
    ),
    check(
      "cash_variance_policy_revisions_approver_is_publisher",
      sql`${t.approvedByUserId} IS NULL OR ${t.approvedByUserId} = ${t.createdByUserId}`,
    ),
    check(
      "cash_variance_policy_revisions_not_self",
      sql`${t.supersedesRevisionId} IS NULL OR ${t.supersedesRevisionId} <> ${t.id}`,
    ),
    index("idx_cash_variance_policy_revisions_scope_history").on(
      t.tenantId,
      t.scope,
      t.storeId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
);

export type CashVariancePolicyRevisionDbRow = typeof cashVariancePolicyRevisions.$inferSelect;
export type NewCashVariancePolicyRevisionDbRow = typeof cashVariancePolicyRevisions.$inferInsert;
