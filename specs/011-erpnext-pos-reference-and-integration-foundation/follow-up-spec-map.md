# Follow-up Spec Map — ERPNext Integration Arc (012–017)

**Feature**: 011-erpnext-pos-reference-and-integration-foundation
**Status**: Draft — sequencing/roadmap only. **Advisory; nothing here is green-lit.**
**Date**: 2026-06-03

> Like all Spec-Kit identifiers, **012–017 are proposed, not reserved/created.**
> Each must run its own planning chain (`spec.md` → `plan.md` → Constitution Check →
> `[GATED]` OpenAPI contract → `tasks.md` → `execution-map.yaml`) and the Agent OS
> gates before any code is written. **Every spec below is additionally blocked until
> the gating decision record(s) in [decisions/](./decisions/) are `SIGNED`** (spec §9).

---

## Dependency graph

```
        011 (this spec, foundation + signed-decision gate)
         │
         ▼
        012  erpnext-connector-contracts        ── gated by: posting + version-pin
         │
         ▼
        013  product-master-from-erpnext         ── gated by: posting
         │
         ▼
        014  branch-inventory-reconciliation-     ── gated by: stock-impact
             and-warehouse-mapping
         │
         ▼
        015  pos-sale-posting-to-erpnext          ── gated by: posting + stock-impact
         │
         ▼
        016  tax-and-fiscal-egypt-v1              ── gated by: tax/fiscal
         │
         ▼
        017  sync-ops-and-repair-api              ── gated by: posting + stock-impact + version-pin
```

---

## The specs

### 012 — `erpnext-connector-contracts`
- **Domain**: The OpenAPI contract surface + connector lifecycle between Data-Pulse-2 and ERPNext (the DP2 ↔ connector boundary; not ERPNext-internal APIs).
- **Depends on**: 011 signed.
- **Gated by**: `posting-decision-record` (shape of what crosses) + `version-pin-upgrade-policy` (which ERPNext surface).
- **Why first**: nothing can be posted, imported, or synced until the connector contract and lifecycle exist. This is also where the **`Retail-Tower-ERP-Next-Connector` split ADR** (per [future-repo-split-criteria.md](../../docs/architecture/future-repo-split-criteria.md)) is proposed/accepted.

### 013 — `product-master-from-erpnext`
- **Domain**: Product/item master sourced from ERPNext (catalog import direction over the 003 catalog).
- **Depends on**: 012.
- **Gated by**: `posting-decision-record` (item identity & mapping inform posting).
- **Why here**: you cannot post a sale line (015) referencing an item that has no agreed master/mapping.

### 014 — `branch-inventory-reconciliation-and-warehouse-mapping`
- **Domain**: ERPNext **Warehouse ↔ DP2 store/branch mapping** and the **reconciliation/mismatch-detection** between DP2 operational on-hand (009) and ERPNext Bin/valuation. **NOT** an ERPNext stock read-down: per the [stock-impact decision](./decisions/stock-impact-decision-record.md), **DP2 remains the operational availability authority** and POS/Console sellability is driven by DP2 operational stock; ERPNext Bin/Warehouse quantities may be mirrored **for reconciliation only**.
- **Depends on**: 012, 013 (items must exist before stock against them).
- **Gated by**: `stock-impact-decision-record`.
- **Why here**: stock posting (015) needs the operational-vs-accounting authority split and the warehouse mapping settled first.

### 015 — `pos-sale-posting-to-erpnext`
- **Domain**: Posting DP2 sale facts (008) into ERPNext (Sales Invoice / Payment Entry / optional Stock Entry).
- **Depends on**: 012, 013, 014.
- **Gated by**: `posting-decision-record` + `stock-impact-decision-record`.
- **Why here**: the keystone of the ERPNext arc — turns the DP2 sale fact into ERPNext accounting + stock truth. Needs items (013) and stock model (014) settled.
- **Terminology (RT-288, 2026-10-07)**: "accounting + stock truth" means ERPNext accounting and *book* stock
  quantity (719, 720). Operational inventory authority stays in Backend-Core (721). Source: Inventory Operations
  baseline (Confluence RETAIL page 22544389).

### 016 — `tax-and-fiscal-egypt-v1`
- **Domain**: Egypt tax/fiscal compliance (e-invoice / ETA) layered over the posting path.
- **Depends on**: 015.
- **Gated by**: `tax-fiscal-egypt-decision-record`.
- **Why here**: fiscal submission rides on a working posting; tax math + rounding must be pinned (the §III open gate) before any tax-bearing fiscal document ships.

### 017 — `sync-ops-and-repair-api`
- **Domain**: Sync operations, reconciliation, retry/DLQ, and a repair API for the connector (operability of the whole arc).
- **Depends on**: 012–016.
- **Gated by**: `posting-decision-record` + `stock-impact-decision-record` + `version-pin-upgrade-policy`.
- **Why last**: you can only build reconciliation/repair once there are real postings and stock/tax flows to reconcile and repair.

---

## Relationship to the old `ROADMAP-ERP.md`

`docs/ROADMAP-ERP.md` (pre-ERPNext) proposed a greenfield retail-loop sequence (Payments, Purchasing, Reporting as DP2-native specs at numbers it called "not reserved"). That reasoning is preserved as history, but the **capabilities are re-homed onto the ERPNext backbone**:

- **Accounting / GL** → owned by ERPNext (the reason ERPNext was chosen); not a DP2 spec.
- **Inventory valuation** → ERPNext (stock-impact decision); DP2 keeps the movement ledger (009).
- **Purchasing / restock** → an ERPNext-backed flow (a future spec after 017, or folded into 014's direction), not a greenfield DP2 purchasing schema.
- **Reporting / "see the numbers"** → may draw on ERPNext + DP2 read-models; its own future spec after the arc lands.

A one-line erratum in `ROADMAP-ERP.md` points readers to this spec for the current numbering.
