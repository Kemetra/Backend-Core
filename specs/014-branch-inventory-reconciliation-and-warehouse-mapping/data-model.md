# Data Model Design: Branch Inventory Reconciliation & Warehouse Mapping

**Feature ID**: 014
**Spec**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Constitution**: v3.0.1
**Status**: **Design only — `[GATED]`.** No SQL, no Drizzle schema, no migration, no OpenAPI YAML authored here.
**Created**: 2026-06-04
**Owner**: Ahmed Shaaban

> This document is **design-only** and carries the **`[GATED]`** marker because
> it designs a forbidden surface — a **new DB table + migration** under
> `packages/db/**` (standing rules §3, Constitution §VIII). **No schema file or
> migration is authored here.** The actual Drizzle schema + SQL migration land
> in their own `[GATED]` approval slice **after this design is accepted**.
>
> It mirrors the shipped [013 `erpnext_item_map` data-model](../013-product-master-from-erpnext/data-model.md)
> shape (the proven sibling, CLOSED on `main`). It realises the [014 plan](./plan.md)'s
> committed design (OQ-1 no-mirror, OQ-2 1:1 forward-compatible to
> warehouse-by-purpose, OQ-3 manual admin-set), all locked by the owner
> 2026-06-04, and pins **OQ-4** (the mismatch-class vocabulary).

---

## Contents

1. [Overview and conventions](#1-overview-and-conventions)
2. [Entity: `erpnext_warehouse_map`](#2-entity-erpnext_warehouse_map)
3. [The OQ-2 forward-compatible `purpose` grain](#3-the-oq-2-forward-compatible-purpose-grain)
4. [Concurrency posture (§III)](#4-concurrency-posture-iii)
5. [RLS policy summary](#5-rls-policy-summary)
6. [Reconciliation definition + mismatch-class vocabulary (OQ-4)](#6-reconciliation-definition--mismatch-class-vocabulary-oq-4)
7. [Relationships & cross-entity notes](#7-relationships--cross-entity-notes)
8. [What is deliberately NOT modelled](#8-what-is-deliberately-not-modelled)
9. [Constitution Check (data-model level)](#9-constitution-check-data-model-level)

---

## 1. Overview and conventions

### What this table is — and is NOT

`erpnext_warehouse_map` is a **pure mapping table**: it links a DP2 `stores` row
to an **ERPNext Warehouse reference** so ERPNext can *value* the same physical
stock the store holds, and so the reconciliation (017) + future posting (015)
target the right warehouse. Per the **signed stock-impact decision** (§4) and
**OQ-1**, it does **NOT** carry stock authority: DP2's 009 ledger stays the
**operational on-hand authority**; ERPNext owns **valuation**. The mapping
reconciles two ledgers' locations; it never makes ERPNext the on-hand master.

**It is a mapping table only:**

- **No ERPNext-quantity / Bin-mirror column** (OQ-1) — a standing DP2 copy of
  ERPNext stock quantities is exactly the **read-down look-alike** the signed
  decision rejects. ERPNext Bin quantities are fetched on-demand by **017** at
  reconcile time, never stored here.
- **No valuation / cost column** — valuation is ERPNext's authority (stock-impact
  §2); a cost column on a DP2 mapping table is where §IX would blur, so it is
  deliberately absent.
- **No on-hand column** — operational on-hand is computed-on-read from 009; it is
  never duplicated here.

### Source-of-truth authority

| Entity | Layer | Authority |
|---|---|---|
| `stores` (001) | Tenant store/branch | **Authoritative** for the DP2 store (unchanged by 014) |
| `stock_movements` (009) | Operational ledger | **Authoritative** for operational on-hand (compute-on-read; unchanged by 014) |
| `erpnext_warehouse_map` (014, new) | Mapping | Authoritative for **the link** only — which ERPNext Warehouse a store maps to, per purpose |
| ERPNext Warehouse / Bin (external) | Accounting | ERPNext owns valued stock quantity; reached only via the connector (017 reconcile) |

### Notation

Same as 013's data-model: **PK / FK / UQ / CHK / IDX / RLS**. `[OQ-#]` binds to
[spec.md §11](./spec.md#11-open-questions-must-be-locked-before-implementation).

### Universal type conventions (inherited from 003/013)

| Concern | Type | Binding |
|---|---|---|
| Primary key | `uuid NOT NULL DEFAULT gen_random_uuid()` | UUIDv7 preferred; UUIDv4 fallback |
| Timestamps | `timestamptz NOT NULL DEFAULT now()` | UTC storage; §X |
| Soft-delete | `retired_at timestamptz NULL` | `NULL` = active (mirrors 003/013) |
| Tenant scope | `tenant_id uuid NOT NULL` FK → `tenants(id)` | §II — all tenant-owned rows |
| Actor | `*_by uuid` | §XII/§XIII — never body-supplied; resolved from principal |
| Correlation ID | `correlation_id uuid NULL` | §XIII — linked to audit event |

### RLS context variables (from Feature 001)

- `app.current_tenant` (`uuid`) — set by the API tenant-context middleware.

The runtime DB role must not have `BYPASSRLS` (§II). This table is **tenant-axis
only** — it is keyed by `store_id` *within* a tenant, but RLS scopes on
`app.current_tenant` (a store is reachable to any actor in its tenant; there is
no separate store-axis RLS bypass to probe, unlike 003's store-override table).

---

## 2. Entity: `erpnext_warehouse_map`

### Purpose and source-of-truth role

One **active** row per `(tenant_id, store_id, purpose)` recording the ERPNext
Warehouse a store maps to **for that purpose**. v1 writes exactly one row per
store with `purpose = 'stock'` (the sellable/stock warehouse), giving 1:1
behavior; the `purpose` grain leaves room for the owner's future
returns/expired warehouse **without a breaking migration** (§3). A Tenant Admin
sets the mapping directly (OQ-3 manual admin-set); there is **no
suggest-engine** and **no import worker**. Reconciliation (017) reads the active
`stock` mapping to know which ERPNext Warehouse to compare a store's 009 on-hand
against.

### Columns

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | NOT NULL | `gen_random_uuid()` | **PK**. UUIDv7 preferred. |
| `tenant_id` | `uuid` | NOT NULL | — | **FK → tenants.id** (`ON DELETE restrict`). Never body-supplied. [§II/§XII] |
| `store_id` | `uuid` | NOT NULL | — | **FK → stores.id** (`ON DELETE restrict`). The DP2 store/branch being mapped. |
| `purpose` | `text` | NOT NULL | `'stock'` | The warehouse role: v1 only `'stock'` (sellable/stock). The enum reserves `'returns'` for the owner's future expired/returns warehouse. CHK-constrained. **The OQ-2 forward-compat discriminator (§3).** |
| `erpnext_warehouse_ref` | `text` | NOT NULL | — | The ERPNext Warehouse reference **in DP2 terms** (e.g. the ERPNext Warehouse `name` as a string). **NO FK** — ERPNext is external, reached only via the connector; version-independent (012 O-6). Length 1–180 by CHK. |
| `set_by` | `uuid` | NULL | `NULL` | Tenant Admin user that set/last-updated the mapping. Never body-supplied. [§XII/§XIII] |
| `set_at` | `timestamptz` | NOT NULL | `now()` | When the mapping was set/last-updated (UTC). |
| `version` | `integer` | NOT NULL | `1` | **Optimistic-concurrency token** (§4). Incremented on every update; version-on-update at the API. |
| `retired_at` | `timestamptz` | NULL | `NULL` | Soft-delete. `NULL` = active. Re-pointing retires the old row + inserts a new one (no in-place identity rewrite — mirrors 013). |
| `created_at` | `timestamptz` | NOT NULL | `now()` | UTC. |
| `updated_at` | `timestamptz` | NOT NULL | `now()` | Updated on every write. |
| `correlation_id` | `uuid` | NULL | `NULL` | Links the row change to its audit event. [§XIII] |

> **No** ERPNext-quantity/Bin column (OQ-1), **no** valuation/cost column, **no**
> on-hand column, **no** ERPNext-doctype field columns — by the OQ-1 decision +
> the signed stock-impact split.

### Constraints

**PK**
- `(id)`

**Foreign keys**
- `FK erpnext_warehouse_map_tenant_id → tenants(id)` — `ON DELETE restrict`.
- `FK erpnext_warehouse_map_store_id → stores(id)` — `ON DELETE restrict` (a mapped store is not hard-deleted out from under its mapping).
- **No FK on `erpnext_warehouse_ref`** — ERPNext is external (mirrors the 013 `erpnext_item_ref` / 003 `source_global_product_id` no-FK rationale: never couple DP2 row lifecycle to an out-of-DP2 catalogue).

**Unique**
- `UQ_idx_erpnext_warehouse_map_active` — `UNIQUE (tenant_id, store_id, purpose) WHERE retired_at IS NULL` — at most one *active* mapping per `(store, purpose)`. v1 (only `purpose='stock'`) is therefore **1:1 per store** in behavior; the `purpose` column is what lets a future `'returns'` row coexist without a breaking migration (§3). Retired rows accumulate as history (the partial index is the correct form — mirrors 013).

**Check constraints**
- `CHK erpnext_warehouse_map_purpose_valid`: `purpose IN ('stock','returns')` — `'returns'` reserved for the future expired/returns warehouse; **v1 service writes only `'stock'`**.
- `CHK erpnext_warehouse_map_ref_length`: `length(erpnext_warehouse_ref) BETWEEN 1 AND 180`
- `CHK erpnext_warehouse_map_version_positive`: `version >= 1`

### Indexes

| Name | Columns | Condition | Purpose |
|---|---|---|---|
| `UQ_idx_erpnext_warehouse_map_active` | `(tenant_id, store_id, purpose)` | `WHERE retired_at IS NULL` | The active-mapping unique (above). Also the **reconciliation lookup** (017 reads the active `stock` mapping for a store). |
| `idx_erpnext_warehouse_map_ref` | `(tenant_id, erpnext_warehouse_ref)` | `WHERE retired_at IS NULL` | Reverse lookup — which store(s) point at an ERPNext Warehouse (reconciliation/audit). |

### Audit / provenance notes

Auditable events (§XIII): **set** (create), **update** (re-point in place is an
update with version++), **retire**. Each carries the actor (`set_by`), a
`correlation_id` from the request context. Audit is insert-only; corrections are
new events, never edits to audit rows.

---

## 3. The OQ-2 forward-compatible `purpose` grain

**The owner locked 1:1 for v1 but flagged a concrete future:** a store may later
map to **two** ERPNext warehouses — one for sellable **stock**, one for
**expired product returned to the producer**. The v1 schema is designed so that
future needs **no breaking migration**:

- The active-uniqueness is `(tenant_id, store_id, purpose)`, **not** bare
  `(tenant_id, store_id)`. v1 only ever writes `purpose = 'stock'`, so there is
  exactly one active mapping per store → strict 1:1 **behavior**.
- The `purpose` enum already reserves `'returns'`. A future slice flips the
  service + contract to allow setting a `'returns'` mapping; the table needs **no
  ALTER** (the constraint + index already admit it).
- **Reconciliation + future posting (015) target the `'stock'` purpose.** The
  returns/expired warehouse is a non-sellable destination; it **never** drives
  POS/Console sellability (operational authority stays DP2, §IX) and is excluded
  from the sale-posting path. When the `'returns'` purpose ships, its own
  reconciliation semantics are a separate decision.

> This is the data-model expression of the plan's OQ-2 forward-compat rule: v1 is
> strictly 1:1 in behavior, with zero design debt for the owner's stated future.

---

## 4. Concurrency posture (§III)

`erpnext_warehouse_map` is a **mutable tenant-owned resource** (set → updated →
possibly retired/re-pointed). Constitution §III requires new mutable tenant-owned
resources to use **optimistic concurrency** (a `version` column +
version-on-update) **or** explicitly justify last-write-wins.

**Decision: optimistic concurrency via the `version` column** — consistent with
the shipped 013 `erpnext_item_map`. Two admins could edit the same store's
mapping concurrently; re-pointing a stale view must not silently clobber a
concurrent change. The update API takes the expected `version` and the update is
`... WHERE id = $1 AND version = $2`, incrementing `version`; a mismatch is a
`409 conflict` (canonical envelope). This deliberately diverges from the 003
catalog tables' last-write-wins: a warehouse re-point is an explicit, low-volume
admin trust action where a silent overwrite is unacceptable, so LWW is **not**
justified here.

---

## 5. RLS policy summary

`erpnext_warehouse_map` is tenant-scoped; RLS uses `app.current_tenant` (Feature
001 GUC), fail-closed with the empty-GUC CASE guard (the repo-wide pattern from
migrations 0009/0010, also used by 013's 0017).

| Policy | Command | Using | Check |
|---|---|---|---|
| `erpnext_warehouse_map_tenant_read` | `SELECT` | `tenant_id = <empty-GUC-guarded app.current_tenant>` | — |
| `erpnext_warehouse_map_tenant_insert` | `INSERT` | — | `tenant_id = <empty-GUC-guarded app.current_tenant>` |
| `erpnext_warehouse_map_tenant_update` | `UPDATE` | `tenant_id = <empty-GUC-guarded app.current_tenant>` | `tenant_id = <empty-GUC-guarded app.current_tenant>` |

No `DELETE` policy — rows are soft-deleted via `retired_at` (mirrors 013).
Cross-tenant access returns a safe non-disclosing **404** (§II/§XII). The future
model/schema slice MUST add: an **RLS-bypass probe** (raw SQL with the wrong
tenant → zero rows) and a **cross-tenant sweep** per §VI. (No store-axis sweep —
the table is tenant-scoped; `store_id` is a tenant-local FK, not a second RLS
axis.)

---

## 6. Reconciliation definition + mismatch-class vocabulary (OQ-4)

> This is the part of 014 that **017 consumes**. 014 defines *what is compared*
> and *what a mismatch is*; **017 runs the comparison, persists the reports, and
> repairs** (the [spec §8](./spec.md#8-the-014--017-reconciliation-boundary-the-carve)
> carve). Nothing in this section is a scheduled job or a stored mismatch row —
> those are 017.

### 6.1 The comparison (the two sides)

For a given `(tenant, store)` with an active `purpose='stock'` mapping,
reconciliation compares **per item**:

- **DP2 side** — operational on-hand from **009** (`stock_movements` signed-SUM
  compute-on-read) for that `(tenant, store, product)`.
- **ERPNext side** — the **Bin quantity** for the mapped ERPNext Warehouse + the
  ERPNext Item that the product's **013 `erpnext_item_map`** (confirmed) resolves
  to. **Fetched on-demand by 017** via the connector (never stored in DP2 — OQ-1).

The two are **compared, never summed** (stock-impact "invariants preserved").

### 6.2 Mismatch-class vocabulary (the OQ-4 lock)

A reconciliation result for a `(tenant, store, item)` is exactly one class. 014
defines the **stable vocabulary**; 017 emits/persists/repairs against it:

| Class | Meaning | Typical repair owner |
|---|---|---|
| `match` | DP2 on-hand and ERPNext Bin agree within tolerance (§6.3). | none |
| `quantity_divergence` | Both ledgers have the item, but the quantity delta exceeds tolerance. | 017 repair (investigate; re-post / stock-reconcile in ERPNext) |
| `unmapped_store` | The store has **no active `stock` warehouse mapping** (014). Reconciliation cannot run for it. | 014 admin-set the mapping |
| `unmapped_item` | The product has **no confirmed 013 `erpnext_item_map`**, so it has no ERPNext Item to compare against. | 013 confirm the item mapping |
| `dp2_only` | The item has DP2 on-hand but no corresponding ERPNext Bin quantity (absent in ERPNext). | 017 repair (create/sync the ERPNext stock) |
| `erpnext_only` | The item has an ERPNext Bin quantity but no DP2 009 on-hand. | 017 repair (investigate; DP2 ledger gap) |
| `negative_balance_flagged` | DP2 on-hand is **negative** (009 allow-and-flag, FR-024). ERPNext may reject negative stock; this is an **expected** divergence, surfaced **not erased** (stock-impact §6). | 017 repair queue (per posting decision failure posture) |

> `unmapped_store` and `unmapped_item` are **precondition** classes — they say
> "reconciliation could not even compare," distinct from `quantity_divergence`
> which is a genuine ledger disagreement. Keeping them separate lets 017 route
> them to the right fix (014 mapping vs 013 mapping vs ERPNext repair).

> **Superseded (RT-288, Inventory Planning Gate 1, recorded 2026-10-12):** the premise that ERPNext rejects negative stock (→ `permanently_rejected` / DLQ / repair queue) was superseded by Jira RT-47 D3. Negative stock is allowed on the V1 ERPNext stock path, and a negative Bin is an observable operational discrepancy, not by itself a posting failure (730, 743). How negative balances are classified in reconciliation belongs to the Inventory reconciliation decisions (923–942) and Jira RT-289, not to this artifact. Source: the owner-approved Inventory Operations baseline of 2026-10-07, decisions 719–727 (Confluence RETAIL page 22544389). Shipped code, data and history are unchanged (727).

### 6.3 Tolerance semantics

- **Default: exact match** (delta = 0) → `match`. Stock quantities are exact
  integers/decimals; §III forbids silent rounding. A non-zero delta is
  `quantity_divergence`, **never** rounded away to `match`.
- A configurable **per-tenant tolerance** (e.g. allow ±N for known
  in-flight timing) is **possible but deferred** — v1 uses exact match. If a
  tolerance is later introduced it is an explicit, audited tenant setting, not a
  silent default. (This keeps the OQ-4 lock minimal + §III-safe; 017 may revisit.)
- `negative_balance_flagged` is evaluated **before** quantity comparison: a
  flagged negative DP2 on-hand is classed as `negative_balance_flagged`
  regardless of the ERPNext side, so the operational reality is surfaced, never
  overwritten to satisfy ERPNext (stock-impact §6).

> **No mismatch rows are stored by 014.** This vocabulary is a *contract* (likely
> realised later as a shared TypeScript enum / OpenAPI schema in 017's slice). The
> exact storage of reconciliation results is **017's** data-model concern.

---

## 7. Relationships & cross-entity notes

- **`stores` (001)** — the FK parent. The mapping reads it; never writes it.
- **`stock_movements` (009)** — the DP2 side of reconciliation (compute-on-read
  on-hand). Read-only; 014 does **not** modify the 009 ledger, its RLS, or its
  append-only invariant (assumption A-4).
- **`erpnext_item_map` (013)** — supplies the **item correspondence** for the
  per-item comparison (§6.1). A product with no confirmed 013 mapping →
  `unmapped_item` (§6.2). Read-only; no schema change to 013.
- **ERPNext Warehouse / Bin** — referenced as an opaque DP2-terms string
  (`erpnext_warehouse_ref`), no FK, resolved to the live doctype by the connector
  (012 O-6). ERPNext **major is UNCONFIRMED** (assumption A-1); the text reference
  is deliberately version-independent. Bin quantities are fetched on-demand by
  017, never stored in DP2 (OQ-1).

---

## 8. What is deliberately NOT modelled

| Not modelled | Why | Owner |
|---|---|---|
| ERPNext Bin/Warehouse **quantity** (a mirror table/column) | OQ-1 — a standing DP2 copy of ERPNext stock = the rejected read-down look-alike; fetched on-demand. | 017 (transient) |
| Stock **valuation / cost** | ERPNext's authority (stock-impact §2); §IX would blur. | ERPNext |
| **On-hand** quantity | Computed-on-read from 009; never duplicated. | 009 |
| Reconciliation **result rows** (persisted mismatch reports) | 014 defines the vocabulary; persisting/running is machinery. | 017 |
| Reconciliation **schedule / jobs / repair API** | Machinery, not mapping (§8 carve). | 017 |
| Sale **posting** / Stock Entry / "Update Stock" | The posting path. | 015 |
| A second warehouse **purpose row** (`returns`) | OQ-2 — reserved in the grain, not written by v1. | future 014 widening |

---

## 9. Constitution Check (data-model level)

| Principle | Verdict |
|---|---|
| **§II Multi-tenant RLS** | ✅ `tenant_id` NOT NULL + FK; fail-closed RLS on `app.current_tenant` (empty-GUC guard); safe-404 cross-tenant; RLS-bypass probe + cross-tenant sweep required in the model/schema slice (§5). |
| **§III Backend authority & concurrency** | ✅ **Optimistic concurrency** via `version` (§4, mirrors 013). Quantity exactness preserved in the reconciliation definition — exact-match default, **no silent rounding** (§6.3). No valuation/on-hand column (authorities stay ERPNext/009). |
| **§IV Contract-first** | ✅ The manual set/list/retire surface ships as a `[GATED]` 014-CONTRACT (its own slice); no raw entity in responses (a `toBody()` projection). The mismatch vocabulary is a contract 017 consumes. |
| **§VIII Reproducible releases** | ✅ This doc authors **no** schema/migration — the table + next migration (with paired `*.down.sql`, lock-duration review) is a separate `[GATED]` slice. ERPNext version pin stays an explicit unconfirmed assumption (A-1). |
| **§IX Source-of-truth** | ✅ Mapping only; DP2 009 stays operational on-hand authority, ERPNext owns valuation; reconciled never merged; **read-down rejected** (no Bin mirror, OQ-1). Faithful to the SIGNED stock-impact decision. |
| **§XI Idempotency** | ✅ The set/update write is idempotent via `version` (replay with the same version is a no-op/409); reconciliation matches on correlation IDs (the run is 017). |
| **§XII Object safety** | ✅ `tenant_id`/`set_by` never body-supplied (resolved from principal); strict DTOs; the set/update command DTO omits security fields. |
| **§XIII Auditability & provenance** | ✅ set/update/retire audited; `set_by` + `correlation_id` recorded; insert-only audit; mismatch classes are traceable for 017 repair. |

**Result: PASS.** No principle violated. The deliberate divergence (optimistic
concurrency vs 003's LWW) is justified per §III, consistent with 013. The OQ-1
no-mirror decision actively **strengthens** §IX (no read-down look-alike).

**Complexity Tracking:** one new table, standard `[GATED]` treatment. No
complexity exception to justify; OQ-1 removed the would-be Bin-mirror table.

---

## Next step

This design → `tasks.md` + `execution-map.yaml` (sequence the slices), then its
own **`[GATED]` schema slice** (author the Drizzle schema
`packages/db/src/schema/catalog/erpnext-warehouse-map.ts` + the migration, next
available number at authoring — **`0018`** indicatively, since 013 took 0017 —
with paired `*.down.sql` + RLS), and the **`[GATED]` 014-CONTRACT** for the
manual set/list/retire review surface. The mismatch-class vocabulary (§6) is the
contract **017** consumes; 017 owns the reconciliation run + repair.
