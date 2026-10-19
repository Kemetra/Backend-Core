/**
 * 021 product-master reconciliation — wire projections (`toBody()`).
 *
 * Explicit wire shapes for the US1 backlog, the US3 run + result, and the
 * recorded repair — never a raw DB entity (§IV). NO money / valuation field.
 */

// ---------------------------------------------------------------------------
// US1 backlog (live read-projection — NOT a persisted 021 row)
// ---------------------------------------------------------------------------

export type BacklogMismatchClass =
  | "unmapped_dp2_product"
  | "suggestion_unconfirmed";

export interface BacklogItem {
  readonly tenantProductId: string;
  readonly mismatchClass: BacklogMismatchClass;
  readonly suggestionMappingId: string | null;
  /** RT-733: the suggestion row's current 013 `version` (the repair guard). */
  readonly suggestionMappingVersion: number | null;
  readonly suggestionSource: string | null;
  readonly suggestedBy: string | null;
  readonly suggestedAt: string | null;
  readonly erpnextItemRef: string | null;
  readonly observedAt: string;
}

/** Raw DB row of the 003 ⟕ 013 backlog query. */
export interface BacklogDbRow {
  readonly tenant_product_id: string;
  readonly suggestion_mapping_id: string | null;
  readonly suggestion_mapping_version: number | null;
  readonly suggestion_source: string | null;
  readonly suggested_by: string | null;
  readonly suggested_at: Date | null;
  readonly erpnext_item_ref: string | null;
}

/**
 * Classify + project a backlog row. `suggestion_mapping_id` is non-null iff an
 * inert (suggested-only OR retired-confirmed) 013 row exists → `suggestion_
 * unconfirmed`; otherwise `unmapped_dp2_product` (no mapping at all). The
 * `observedAt` is the read timestamp (the gap is observed live, not stored).
 */
export function toBacklogItem(r: BacklogDbRow, observedAt: Date): BacklogItem {
  const mismatchClass: BacklogMismatchClass = r.suggestion_mapping_id
    ? "suggestion_unconfirmed"
    : "unmapped_dp2_product";
  return {
    tenantProductId: r.tenant_product_id,
    mismatchClass,
    suggestionMappingId: r.suggestion_mapping_id,
    suggestionMappingVersion: r.suggestion_mapping_version,
    suggestionSource: r.suggestion_source,
    suggestedBy: r.suggested_by,
    suggestedAt: r.suggested_at ? r.suggested_at.toISOString() : null,
    erpnextItemRef: r.erpnext_item_ref,
    observedAt: observedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// US3 run + result
// ---------------------------------------------------------------------------

export interface ProductReconciliationRunBody {
  readonly id: string;
  readonly trigger: "on_demand" | "scheduled";
  readonly status: "running" | "completed" | "failed";
  readonly erpnextViewStatus: "available" | "unavailable" | "partial";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly summary: Record<string, unknown> | null;
}

export interface RunDbRow {
  id: string;
  trigger: "on_demand" | "scheduled";
  status: "running" | "completed" | "failed";
  erpnext_view_status: "available" | "unavailable" | "partial";
  started_at: Date;
  finished_at: Date | null;
  summary: Record<string, unknown> | null;
}

export const RUN_COLS = `id, trigger, status, erpnext_view_status, started_at, finished_at, summary`;

export function toRunBody(r: RunDbRow): ProductReconciliationRunBody {
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    erpnextViewStatus: r.erpnext_view_status,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
    summary: r.summary,
  };
}

export type ProductMismatchClass =
  | "match"
  | "unmapped_dp2_product"
  | "suggestion_unconfirmed"
  | "unmapped_erpnext_item"
  | "attribute_drift"
  | "sellable_state_divergence";

export interface ProductReconciliationResultBody {
  readonly id: string;
  readonly runId: string;
  readonly mismatchClass: ProductMismatchClass;
  readonly tenantProductId: string | null;
  readonly erpnextItemRef: string | null;
  readonly resultState: "open" | "repaired" | "accepted";
  readonly detail: Record<string, unknown> | null;
  /** RT-733: the product's current ACTIVE 013 mapping id + `version` (null when none). */
  readonly mappingId: string | null;
  readonly mappingVersion: number | null;
}

export interface ResultDbRow {
  id: string;
  run_id: string;
  mismatch_class: ProductMismatchClass;
  tenant_product_id: string | null;
  erpnext_item_ref: string | null;
  result_state: "open" | "repaired" | "accepted";
  detail: Record<string, unknown> | null;
  mapping_id: string | null;
  mapping_version: number | null;
}

/**
 * Result columns, qualified on the `res` alias, plus the product's current
 * ACTIVE 013 mapping (`m`, at most one per product by the 013 1:1 partial
 * unique index) — read live in the same query (RT-733, no N+1).
 */
export const RESULT_COLS = `res.id, res.run_id, res.mismatch_class, res.tenant_product_id, res.erpnext_item_ref, res.result_state, res.detail, m.id AS mapping_id, m.version AS mapping_version`;

export function toResultBody(r: ResultDbRow): ProductReconciliationResultBody {
  return {
    id: r.id,
    runId: r.run_id,
    mismatchClass: r.mismatch_class,
    tenantProductId: r.tenant_product_id,
    erpnextItemRef: r.erpnext_item_ref,
    resultState: r.result_state,
    detail: r.detail,
    mappingId: r.mapping_id,
    mappingVersion: r.mapping_version,
  };
}

// ---------------------------------------------------------------------------
// Recorded repair
// ---------------------------------------------------------------------------

export type RepairKind = "confirm" | "suggest_confirm" | "re_point";
export type RepairOutcome = "mapped" | "still_unmapped" | "no_op_echo" | "conflict";

export interface RecordedProductRepair {
  readonly targetKind: "backlog_item" | "result";
  readonly targetRef: string;
  readonly repairKind: RepairKind;
  readonly outcome: RepairOutcome;
  readonly resolvedItemMapId: string | null;
  readonly recordedAt: string;
}
