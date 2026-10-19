/**
 * AI plan catalog, tenant entitlements, tenant opt-outs, usage counters and
 * the single AI usage ledger (Jira RT-663 = RT-644 ENT-BC2 + RT-643 F-3;
 * `0055_ai_entitlements_usage.sql`, [GATED]). Decisions: AD-AI-ENT-001 D-2,
 * D-3, D-5, D-8, D-9 and its usage-store ownership section; AD-AI-PROV-001
 * D-6 / E-8.
 *
 * - `ai_plan_catalog` / `_features` / `_meters`: the code-owned, versioned,
 *   default-deny plan catalogue (platform-scoped, immutable; written only by
 *   migrations under `app.is_platform_admin`). Seeded with `core@1`, which
 *   grants no feature and no meter.
 * - `tenant_ai_entitlements`: immutable revisions on one tenant-wide linear
 *   `entitlement_version` chain (`base_version` = the writer's
 *   `expected_version`; a stale write collides → 23505). Platform-admin
 *   INSERT only: a tenant can never grant itself.
 * - `tenant_ai_feature_opt_outs`: the tenant owner's subtract-only opt-out
 *   source (D-5), its own linear chain, apart from the grant source.
 * - `ai_usage_counters`: one row per (tenant, store or none, meter, UTC
 *   window); only `used` / `reserved` move. The limit is not stored here.
 * - `ai_usage_ledger`: THE single append-only AI usage store — `reserved`,
 *   then at most one `committed` (outcome `ok`) or `released` (any other
 *   outcome, never charged) per reservation, with the AI-09 run metadata;
 *   a platform admin's compensating `adjusted` row against a committed row
 *   settles a dispute (T20).
 *   No prompt, completion or price column.
 *
 * Every table is RLS-forced. The ledger's text-length CHECK, the policies
 * and the triggers (append-only, counter identity guard, terminal →
 * reservation guard) live in the SQL migration.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "./stores";
import { tenants } from "./tenants";
import { users } from "./users";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

/** `ai.<segment>[.<segment>…]`, at most four segments. */
const FEATURE_ID_FORMAT = String.raw`^ai(\.[a-z][a-z0-9_]{0,39}){1,4}$`;
const METER_FORMAT = String.raw`^[a-z][a-z0-9_]{0,39}(\.[a-z][a-z0-9_]{0,39}){0,5}$`;
/** The two formats as quoted SQL literals, for the CHECK expressions. */
const FEATURE_ID_PATTERN = sql.raw("'" + FEATURE_ID_FORMAT + "'");
const METER_PATTERN = sql.raw("'" + METER_FORMAT + "'");

/** The closed outcome set of a terminal ledger row (`ok` exactly when committed, D-8). */
export const AI_USAGE_OUTCOMES = [
  "ok",
  "provider_refused",
  "output_truncated",
  "output_invalid",
  "provider_unavailable",
  "input_rejected",
  "not_attempted",
  "reservation_expired",
] as const;
export type AiUsageOutcome = (typeof AI_USAGE_OUTCOMES)[number];

export const AI_ENTITLEMENT_STATES = ["none", "trial", "active", "grace", "expired", "cancelled"] as const;
export type AiEntitlementState = (typeof AI_ENTITLEMENT_STATES)[number];

// =============================================================================
// Plan catalog (platform-scoped)
// =============================================================================

export const aiPlanCatalog = pgTable(
  "ai_plan_catalog",
  {
    planCode: text("plan_code").notNull(),
    catalogVersion: integer("catalog_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.planCode, t.catalogVersion] }),
    check("ai_plan_catalog_plan_code_format", sql`${t.planCode} ~ '^[a-z][a-z0-9_]{1,62}$'`),
    check("ai_plan_catalog_version_positive", sql`${t.catalogVersion} >= 1`),
  ],
);

export const aiPlanCatalogFeatures = pgTable(
  "ai_plan_catalog_features",
  {
    planCode: text("plan_code").notNull(),
    catalogVersion: integer("catalog_version").notNull(),
    featureId: text("feature_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.planCode, t.catalogVersion, t.featureId] }),
    foreignKey({
      name: "fk_ai_plan_catalog_features_catalog",
      columns: [t.planCode, t.catalogVersion],
      foreignColumns: [aiPlanCatalog.planCode, aiPlanCatalog.catalogVersion],
    }).onDelete("restrict"),
    check(
      "ai_plan_catalog_features_feature_id_format",
      sql`${t.featureId} ~ ${FEATURE_ID_PATTERN}`,
    ),
  ],
);

export const aiPlanCatalogMeters = pgTable(
  "ai_plan_catalog_meters",
  {
    planCode: text("plan_code").notNull(),
    catalogVersion: integer("catalog_version").notNull(),
    featureId: text("feature_id").notNull(),
    meter: text("meter").notNull(),
    /** `request` only in v1 (D-3). */
    unit: text("unit").notNull(),
    /** `day` | `month`, UTC (D-9). */
    windowKind: text("window_kind").notNull(),
    /** `tenant` | `store` (D-4). */
    meterScope: text("meter_scope").notNull(),
    limitValue: bigint("limit_value", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.planCode, t.catalogVersion, t.featureId, t.meter] }),
    foreignKey({
      name: "fk_ai_plan_catalog_meters_feature",
      columns: [t.planCode, t.catalogVersion, t.featureId],
      foreignColumns: [
        aiPlanCatalogFeatures.planCode,
        aiPlanCatalogFeatures.catalogVersion,
        aiPlanCatalogFeatures.featureId,
      ],
    }).onDelete("restrict"),
    check("ai_plan_catalog_meters_meter_format", sql`${t.meter} ~ ${METER_PATTERN}`),
    check("ai_plan_catalog_meters_unit_valid", sql`${t.unit} IN ('request')`),
    check("ai_plan_catalog_meters_window_valid", sql`${t.windowKind} IN ('day', 'month')`),
    check("ai_plan_catalog_meters_scope_valid", sql`${t.meterScope} IN ('tenant', 'store')`),
    check("ai_plan_catalog_meters_limit_non_negative", sql`${t.limitValue} >= 0`),
  ],
);

// =============================================================================
// tenant_ai_entitlements
// =============================================================================

export const tenantAiEntitlements = pgTable(
  "tenant_ai_entitlements",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    entitlementVersion: integer("entitlement_version").notNull(),
    /** The writer's `expected_version`; NULL only for version 1. */
    baseVersion: integer("base_version"),
    /** NULL exactly for state `none`. */
    planCode: text("plan_code"),
    catalogVersion: integer("catalog_version"),
    state: text("state").$type<AiEntitlementState>().notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),
    /** Bounded JSON array (≤ 100), validated by the runtime, covered by `content_hash`. */
    overrides: jsonb("overrides").notNull().default(sql`'[]'::jsonb`),
    /** `manual_platform` | `billing_event`. */
    source: text("source").notNull(),
    sourceRef: text("source_ref"),
    reason: text("reason"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    /** SHA-256 of the revision content. */
    contentHash: bytea("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_tenant_ai_entitlements_version").on(t.tenantId, t.entitlementVersion),
    unique("uq_tenant_ai_entitlements_source_ref").on(t.tenantId, t.sourceRef),
    foreignKey({
      name: "fk_tenant_ai_entitlements_base",
      columns: [t.tenantId, t.baseVersion],
      foreignColumns: [t.tenantId, t.entitlementVersion],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_tenant_ai_entitlements_catalog",
      columns: [t.planCode, t.catalogVersion],
      foreignColumns: [aiPlanCatalog.planCode, aiPlanCatalog.catalogVersion],
    }).onDelete("restrict"),
    check(
      "tenant_ai_entitlements_version_chain",
      sql`(${t.entitlementVersion} = 1 AND ${t.baseVersion} IS NULL)
        OR (${t.entitlementVersion} > 1 AND ${t.baseVersion} IS NOT NULL
          AND ${t.baseVersion} = ${t.entitlementVersion} - 1)`,
    ),
    check(
      "tenant_ai_entitlements_state_valid",
      sql`${t.state} IN ('none', 'trial', 'active', 'grace', 'expired', 'cancelled')`,
    ),
    check(
      "tenant_ai_entitlements_plan_shape",
      sql`(${t.state} = 'none' AND ${t.planCode} IS NULL AND ${t.catalogVersion} IS NULL)
        OR (${t.state} <> 'none' AND ${t.planCode} IS NOT NULL AND ${t.catalogVersion} IS NOT NULL)`,
    ),
    check(
      "tenant_ai_entitlements_trial_ends",
      sql`${t.state} <> 'trial' OR ${t.effectiveUntil} IS NOT NULL`,
    ),
    check(
      "tenant_ai_entitlements_until_after_from",
      sql`${t.effectiveUntil} IS NULL OR ${t.effectiveUntil} > ${t.effectiveFrom}`,
    ),
    check(
      "tenant_ai_entitlements_overrides_shape",
      sql`jsonb_typeof(${t.overrides}) = 'array' AND jsonb_array_length(${t.overrides}) <= 100`,
    ),
    check(
      "tenant_ai_entitlements_source_valid",
      sql`${t.source} IN ('manual_platform', 'billing_event')`,
    ),
    check(
      "tenant_ai_entitlements_source_shape",
      sql`(${t.source} = 'manual_platform' AND ${t.sourceRef} IS NULL
          AND ${t.reason} IS NOT NULL AND ${t.createdByUserId} IS NOT NULL)
        OR (${t.source} = 'billing_event' AND ${t.sourceRef} IS NOT NULL)`,
    ),
    check(
      "tenant_ai_entitlements_source_ref_length",
      sql`${t.sourceRef} IS NULL OR char_length(${t.sourceRef}) BETWEEN 1 AND 200`,
    ),
    check(
      "tenant_ai_entitlements_reason_length",
      sql`${t.reason} IS NULL OR char_length(${t.reason}) BETWEEN 1 AND 500`,
    ),
    check("tenant_ai_entitlements_content_hash_sha256", sql`octet_length(${t.contentHash}) = 32`),
  ],
);

// =============================================================================
// tenant_ai_feature_opt_outs (D-5)
// =============================================================================

export const tenantAiFeatureOptOuts = pgTable(
  "tenant_ai_feature_opt_outs",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    optOutVersion: integer("opt_out_version").notNull(),
    baseVersion: integer("base_version"),
    featureId: text("feature_id").notNull(),
    /** `opt_out` | `opt_in` (back on, never above the plan). */
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_tenant_ai_feature_opt_outs_version").on(t.tenantId, t.optOutVersion),
    foreignKey({
      name: "fk_tenant_ai_feature_opt_outs_base",
      columns: [t.tenantId, t.baseVersion],
      foreignColumns: [t.tenantId, t.optOutVersion],
    }).onDelete("restrict"),
    check(
      "tenant_ai_feature_opt_outs_version_chain",
      sql`(${t.optOutVersion} = 1 AND ${t.baseVersion} IS NULL)
        OR (${t.optOutVersion} > 1 AND ${t.baseVersion} IS NOT NULL
          AND ${t.baseVersion} = ${t.optOutVersion} - 1)`,
    ),
    check(
      "tenant_ai_feature_opt_outs_feature_id_format",
      sql`${t.featureId} ~ ${FEATURE_ID_PATTERN}`,
    ),
    check("tenant_ai_feature_opt_outs_action_valid", sql`${t.action} IN ('opt_out', 'opt_in')`),
    check(
      "tenant_ai_feature_opt_outs_reason_length",
      sql`char_length(${t.reason}) BETWEEN 1 AND 500`,
    ),
    index("idx_tenant_ai_feature_opt_outs_feature").on(
      t.tenantId,
      t.featureId,
      t.optOutVersion.desc(),
    ),
  ],
);

// =============================================================================
// ai_usage_counters (D-3 Option A)
// =============================================================================

export const aiUsageCounters = pgTable(
  "ai_usage_counters",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    /** The store of a per-store meter; NULL for a tenant meter. */
    storeId: uuid("store_id"),
    meter: text("meter").notNull(),
    windowKind: text("window_kind").notNull(),
    /** The UTC start of the day or month (D-9). */
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    used: bigint("used", { mode: "number" }).notNull().default(0),
    reserved: bigint("reserved", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_ai_usage_counters_window")
      .on(t.tenantId, t.storeId, t.meter, t.windowKind, t.windowStart)
      .nullsNotDistinct(),
    unique("uq_ai_usage_counters_id_tenant").on(t.id, t.tenantId),
    foreignKey({
      name: "fk_ai_usage_counters_store",
      columns: [t.tenantId, t.storeId],
      foreignColumns: [stores.tenantId, stores.id],
    }).onDelete("restrict"),
    check("ai_usage_counters_meter_format", sql`${t.meter} ~ ${METER_PATTERN}`),
    check("ai_usage_counters_window_valid", sql`${t.windowKind} IN ('day', 'month')`),
    check(
      "ai_usage_counters_window_utc_aligned",
      sql`CASE WHEN ${t.windowKind} IN ('day', 'month')
        THEN date_trunc(${t.windowKind}, ${t.windowStart} AT TIME ZONE 'UTC') = ${t.windowStart} AT TIME ZONE 'UTC'
        ELSE false END`,
    ),
    check("ai_usage_counters_used_non_negative", sql`${t.used} >= 0`),
    check("ai_usage_counters_reserved_non_negative", sql`${t.reserved} >= 0`),
  ],
);

// =============================================================================
// ai_usage_ledger — the single AI usage store
// =============================================================================

export const aiUsageLedger = pgTable(
  "ai_usage_ledger",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    /** A `reserved` / `adjusted` row's own id; a terminal row's reservation. */
    reservationId: uuid("reservation_id").notNull(),
    /** `reserved` | `committed` | `released` | `adjusted` (platform-admin compensation). */
    entryKind: text("entry_kind").notNull(),
    featureId: text("feature_id").notNull(),
    counterId: uuid("counter_id").notNull(),
    units: integer("units").notNull(),
    entitlementVersion: integer("entitlement_version").notNull(),
    optOutVersion: integer("opt_out_version"),
    idempotencyKey: text("idempotency_key"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    requestId: text("request_id"),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "restrict" }),
    routeKey: text("route_key"),
    promptTemplateId: text("prompt_template_id"),
    promptTemplateVersion: text("prompt_template_version"),
    outputSchemaId: text("output_schema_id"),
    outputSchemaVersion: text("output_schema_version"),
    providerKey: text("provider_key"),
    modelId: text("model_id"),
    evidenceRefIds: text("evidence_ref_ids").array(),
    inputTokens: bigint("input_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }),
    cachedInputTokens: bigint("cached_input_tokens", { mode: "number" }),
    /** `reported` | `estimated`. */
    tokenCountSource: text("token_count_source"),
    /** Computed list-price-equivalent cost in micro-units of `cost_currency`. */
    listEquivalentCostMicros: bigint("list_equivalent_cost_micros", { mode: "number" }),
    costCurrency: char("cost_currency", { length: 3 }),
    costRateCardVersion: text("cost_rate_card_version"),
    outcome: text("outcome").$type<AiUsageOutcome>(),
    providerRequestId: text("provider_request_id"),
    /** `adjusted` rows only: the committed row compensated (T20). */
    adjustsEntryId: uuid("adjusts_entry_id"),
    adjustmentReason: text("adjustment_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_ai_usage_ledger_reservation_target").on(
      t.id,
      t.tenantId,
      t.featureId,
      t.counterId,
      t.units,
      t.entitlementVersion,
    ),
    unique("uq_ai_usage_ledger_adjustment_target").on(
      t.id,
      t.tenantId,
      t.featureId,
      t.counterId,
      t.entitlementVersion,
    ),
    foreignKey({
      name: "fk_ai_usage_ledger_adjusts",
      columns: [t.adjustsEntryId, t.tenantId, t.featureId, t.counterId, t.entitlementVersion],
      foreignColumns: [t.id, t.tenantId, t.featureId, t.counterId, t.entitlementVersion],
    }).onDelete("restrict"),
    check(
      "ai_usage_ledger_adjustment_shape",
      sql`(${t.entryKind} = 'adjusted' AND ${t.adjustsEntryId} IS NOT NULL
          AND ${t.adjustmentReason} IS NOT NULL AND ${t.actorUserId} IS NOT NULL
          AND ${t.outcome} IS NULL AND ${t.inputTokens} IS NULL AND ${t.outputTokens} IS NULL
          AND ${t.cachedInputTokens} IS NULL AND ${t.tokenCountSource} IS NULL
          AND ${t.listEquivalentCostMicros} IS NULL AND ${t.costCurrency} IS NULL
          AND ${t.costRateCardVersion} IS NULL AND ${t.providerRequestId} IS NULL)
        OR (${t.entryKind} <> 'adjusted' AND ${t.adjustsEntryId} IS NULL
          AND ${t.adjustmentReason} IS NULL)`,
    ),
    check(
      "ai_usage_ledger_adjustment_reason_length",
      sql`${t.adjustmentReason} IS NULL OR char_length(${t.adjustmentReason}) BETWEEN 1 AND 500`,
    ),
    index("idx_ai_usage_ledger_adjusts")
      .on(t.adjustsEntryId)
      .where(sql`${t.adjustsEntryId} IS NOT NULL`),
    unique("uq_ai_usage_ledger_idempotency").on(t.tenantId, t.featureId, t.idempotencyKey),
    foreignKey({
      name: "fk_ai_usage_ledger_reservation",
      columns: [t.reservationId, t.tenantId, t.featureId, t.counterId, t.units, t.entitlementVersion],
      foreignColumns: [t.id, t.tenantId, t.featureId, t.counterId, t.units, t.entitlementVersion],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_ai_usage_ledger_counter",
      columns: [t.counterId, t.tenantId],
      foreignColumns: [aiUsageCounters.id, aiUsageCounters.tenantId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_ai_usage_ledger_entitlement",
      columns: [t.tenantId, t.entitlementVersion],
      foreignColumns: [tenantAiEntitlements.tenantId, tenantAiEntitlements.entitlementVersion],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_ai_usage_ledger_opt_out",
      columns: [t.tenantId, t.optOutVersion],
      foreignColumns: [tenantAiFeatureOptOuts.tenantId, tenantAiFeatureOptOuts.optOutVersion],
    }).onDelete("restrict"),
    check(
      "ai_usage_ledger_entry_kind_valid",
      sql`${t.entryKind} IN ('reserved', 'committed', 'released', 'adjusted')`,
    ),
    check(
      "ai_usage_ledger_reservation_self",
      sql`(${t.entryKind} IN ('reserved', 'adjusted')) = (${t.reservationId} = ${t.id})`,
    ),
    check(
      "ai_usage_ledger_outcome_by_kind",
      sql`${t.entryKind} IN ('reserved', 'adjusted')
        OR (${t.entryKind} = 'committed' AND ${t.outcome} IS NOT NULL AND ${t.outcome} = 'ok')
        OR (${t.entryKind} = 'released' AND ${t.outcome} IS NOT NULL AND ${t.outcome} <> 'ok')`,
    ),
    check(
      "ai_usage_ledger_feature_id_format",
      sql`${t.featureId} ~ ${FEATURE_ID_PATTERN}`,
    ),
    check("ai_usage_ledger_units_positive", sql`${t.units} > 0`),
    check(
      "ai_usage_ledger_reserved_shape",
      sql`(${t.entryKind} = 'reserved' AND ${t.idempotencyKey} IS NOT NULL
          AND ${t.expiresAt} IS NOT NULL AND ${t.expiresAt} > ${t.createdAt})
        OR (${t.entryKind} = 'adjusted' AND ${t.idempotencyKey} IS NOT NULL AND ${t.expiresAt} IS NULL)
        OR (${t.entryKind} IN ('committed', 'released') AND ${t.idempotencyKey} IS NULL
          AND ${t.expiresAt} IS NULL)`,
    ),
    check(
      "ai_usage_ledger_idempotency_key_length",
      sql`${t.idempotencyKey} IS NULL OR char_length(${t.idempotencyKey}) BETWEEN 16 AND 128`,
    ),
    check(
      "ai_usage_ledger_reserved_no_result",
      sql`${t.entryKind} <> 'reserved'
        OR (${t.outcome} IS NULL AND ${t.inputTokens} IS NULL AND ${t.outputTokens} IS NULL
          AND ${t.cachedInputTokens} IS NULL AND ${t.tokenCountSource} IS NULL
          AND ${t.listEquivalentCostMicros} IS NULL AND ${t.costCurrency} IS NULL
          AND ${t.costRateCardVersion} IS NULL AND ${t.providerRequestId} IS NULL)`,
    ),
    check(
      "ai_usage_ledger_outcome_valid",
      sql`${t.outcome} IS NULL OR ${t.outcome} IN ('ok', 'provider_refused', 'output_truncated',
        'output_invalid', 'provider_unavailable', 'input_rejected', 'not_attempted',
        'reservation_expired')`,
    ),
    check(
      "ai_usage_ledger_token_source_valid",
      sql`${t.tokenCountSource} IS NULL OR ${t.tokenCountSource} IN ('reported', 'estimated')`,
    ),
    check(
      "ai_usage_ledger_tokens_sourced",
      sql`(${t.tokenCountSource} IS NULL)
        = (${t.inputTokens} IS NULL AND ${t.outputTokens} IS NULL AND ${t.cachedInputTokens} IS NULL)`,
    ),
    check(
      "ai_usage_ledger_tokens_non_negative",
      sql`(${t.inputTokens} IS NULL OR ${t.inputTokens} >= 0)
        AND (${t.outputTokens} IS NULL OR ${t.outputTokens} >= 0)
        AND (${t.cachedInputTokens} IS NULL OR ${t.cachedInputTokens} >= 0)`,
    ),
    check(
      "ai_usage_ledger_cost_all_or_none",
      sql`(${t.listEquivalentCostMicros} IS NULL AND ${t.costCurrency} IS NULL
          AND ${t.costRateCardVersion} IS NULL)
        OR (${t.listEquivalentCostMicros} IS NOT NULL AND ${t.costCurrency} IS NOT NULL
          AND ${t.costRateCardVersion} IS NOT NULL)`,
    ),
    check(
      "ai_usage_ledger_cost_non_negative",
      sql`${t.listEquivalentCostMicros} IS NULL OR ${t.listEquivalentCostMicros} >= 0`,
    ),
    check(
      "ai_usage_ledger_cost_currency_format",
      sql`${t.costCurrency} IS NULL OR ${t.costCurrency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "ai_usage_ledger_evidence_refs_shape",
      sql`${t.evidenceRefIds} IS NULL
        OR (cardinality(${t.evidenceRefIds}) <= 256
          AND array_position(${t.evidenceRefIds}, NULL) IS NULL
          AND char_length(array_to_string(${t.evidenceRefIds}, ',')) <= 32768)`,
    ),
    uniqueIndex("uq_ai_usage_ledger_one_terminal")
      .on(t.reservationId)
      .where(sql`${t.entryKind} IN ('committed', 'released')`),
    index("idx_ai_usage_ledger_reserved_expiry")
      .on(t.tenantId, t.expiresAt)
      .where(sql`${t.entryKind} = 'reserved'`),
    index("idx_ai_usage_ledger_tenant_feature_created").on(t.tenantId, t.featureId, t.createdAt),
    index("idx_ai_usage_ledger_counter").on(t.counterId),
  ],
);

export type AiUsageLedgerDbRow = typeof aiUsageLedger.$inferSelect;
export type NewAiUsageLedgerDbRow = typeof aiUsageLedger.$inferInsert;
export type AiUsageCounterDbRow = typeof aiUsageCounters.$inferSelect;
export type TenantAiEntitlementDbRow = typeof tenantAiEntitlements.$inferSelect;
export type TenantAiFeatureOptOutDbRow = typeof tenantAiFeatureOptOuts.$inferSelect;
