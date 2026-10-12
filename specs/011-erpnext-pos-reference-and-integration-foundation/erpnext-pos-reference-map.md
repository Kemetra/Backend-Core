# ERPNext POS Reference Map

**Feature**: 011-erpnext-pos-reference-and-integration-foundation
**Status**: Draft — reference documentation only
**Date**: 2026-06-03

> **Reference-only.** This document maps **ERPNext POS** concepts to **Retail Tower OS** terms so the team can reason about the ERPNext backbone. **ERPNext POS is NOT the production cashier terminal** — that is and remains **POS-Pulse**. ERPNext POS behavior is studied here to inform posting, stock, and tax decisions; it is never adopted as the operator-facing terminal. Nothing in this document authorizes calling ERPNext from POS-Pulse or Retail-Tower-Console.

---

## 1. Why an ERPNext POS reference map (and not an adoption plan)

ERPNext ships a POS surface (the Frappe POS / "POS Awesome" experience) backed by **POS Profile**, **POS Invoice**, and the ERPNext accounting + stock engine. It is tempting to treat that as the cashier. We do not, because:

- **Offline-first cashiering is a POS-Pulse responsibility** (offline queue, local SQLite, hardware control — printer/drawer). ERPNext POS does not own the offline-first UX Retail Tower OS requires.
- **The trust boundary** (Constitution §IV) requires the cashier to talk to **Data-Pulse-2**, not to an ERP backend. Adopting ERPNext POS would put the terminal directly against Frappe.
- **Data-Pulse-2 is the source of truth** (§IX). The sale fact is owned by DP2 (spec 008), not by ERPNext. ERPNext receives a **posting** of that fact (future spec 015); it is not where the sale is born.

So ERPNext POS is a **reference model**: it tells us how a mature ERP turns a cart into an invoice, a stock movement, and a payment entry. We map those concepts to what DP2 already owns, and to what the connector (012) will post.

---

## 2. Concept map — ERPNext ↔ Retail Tower OS

| ERPNext / Frappe concept | Retail Tower OS equivalent | Owner of truth | Status for 011 |
|---|---|---|---|
| **POS Profile** (terminal config, warehouse, payment modes) | Store/terminal configuration (001 store + 002 device/operator identity) | Data-Pulse-2 | Reference — DP2 already owns terminal/store identity |
| **POS surface / cart UI** | The cashier terminal | **POS-Pulse** | **Reference-only** — ERPNext POS is *not* adopted |
| **POS Invoice / Sales Invoice** | The immutable **sale fact** (`sales` + `sale_lines`, spec 008) | Data-Pulse-2 | Reference — DP2 owns the sale; ERPNext receives a *posting* (future 015) |
| **Payment Entry / Mode of Payment** | Tender / payment capture (POS-side tender lines; voucher contract stub exists) | Data-Pulse-2 (authority) / POS-Pulse (tender UX) | Reference — posting target for 015 |
| **Item / Item Master** | Catalog product (`global_products` / `tenant_products`, spec 003) | Data-Pulse-2 | Reference — direction & ownership decided in 013 |
| **Warehouse** | Store / branch inventory location | Data-Pulse-2 (`stores`) | Reference — branch-inventory direction decided in 014 |
| **Stock Entry / Stock Ledger Entry** | Stock movement (`stock_movements`, append-only ledger, spec 009) | Data-Pulse-2 | Reference — DP2 owns the movement; ERPNext valuation is a *stock-impact* decision (014/015) |
| **Bin (on-hand per warehouse)** | Compute-on-read on-hand (009, signed SUM) | Data-Pulse-2 | Reference — DP2 computes on-hand; ERPNext valuation differs (decision) |
| **Tax Template / Item Tax / Tax Category** | Tax category (carried on catalog rows / read-down payload) | Data-Pulse-2 (category) / ERPNext (computation reference) | Reference — Egypt v1 fiscal model decided in 016 |
| **Chart of Accounts / GL Entry** | *(none in DP2 — DP2 is not a general ledger)* | ERPNext | Reference — the reason ERPNext is the accounting backbone |
| **Customer** | *(POS retail is largely walk-in; customer modeling TBD)* | TBD (likely ERPNext for account customers) | Out of scope for 011 |
| **Naming Series / posting date** | DP2 temporal catalog (§X: `occurredAt`/`businessDate`/…) | Data-Pulse-2 | Reference — posting timestamp mapping decided in 015 |

**Reading the table**: anything marked *Reference-only* or *Reference* is **studied, not wired**. The "Owner of truth" column is the load-bearing one — it shows that **DP2 keeps ownership of the sale, the catalog, and the stock movement**, while **ERPNext owns the general ledger / accounting valuation** that DP2 deliberately does not model.

> **Superseded (RT-288, 2026-10-07):** the Stock Entry / Bin rows above and the §3 "DP2 owns the stock ledger
> (009)" row now read as follows. Backend-Core owns operational inventory effects (721, 724). ERPNext Stock
> Ledger/Bin is the financial/book quantity authority (719). ERPNext stock is posted through the Sales Invoice with
> `update_stock=1` (Jira RT-47 D1), not mirrored from 009. Effect/confirmation semantics belong to Jira RT-289.
> Source: Inventory Operations baseline, decisions 719–727 (Confluence RETAIL page 22544389).

---

## 3. What ERPNext POS does that we explicitly do NOT adopt

| ERPNext POS behavior | Why we do not adopt it |
|---|---|
| Cashier UI runs against the Frappe backend | Violates §IV trust boundary; cashier must talk to DP2. POS-Pulse owns the terminal. |
| Offline POS sync via Frappe's own mechanism | POS-Pulse owns offline-first (queue, local store, conflict handling) against DP2 contracts. |
| POS prints/receipts via Frappe print formats | Hardware (printer/drawer) is POS-Pulse's domain. |
| Direct stock decrement on POS Invoice submit | DP2 owns the stock ledger (009). Whether/how an ERPNext stock entry mirrors it is the **stock-impact decision** (placeholder), not an automatic adoption. |
| POS user/role model | Identity is DP2's (001/002): operators, devices, RBAC, RLS. |

---

## 4. What ERPNext POS legitimately informs (the reference value)

- **Posting shape**: how a cart becomes a Sales Invoice + Payment Entry + (optional) Stock Entry — the input to the **posting decision record**.
- **Stock valuation**: FIFO/moving-average valuation and the Stock Ledger Entry model — the input to the **stock-impact decision record**.
- **Tax composition**: tax templates, inclusive/exclusive tax, item tax overrides — the input to the **tax/fiscal (Egypt v1) decision record**.
- **Versioning surface**: which ERPNext/Frappe version's POS + accounting APIs we target — the input to the **version-pin & upgrade-policy decision record**.

Each of these feeds exactly one decision placeholder in [decisions/](./decisions/). 011 does **not** decide them; it captures the reference and stands up the gate.

---

## 5. Boundary reminder

This map does not create any integration. POS-Pulse and Retail-Tower-Console gain **no** ERPNext awareness from this document. The only system that will ever reach ERPNext is **Data-Pulse-2 via the future `Retail-Tower-ERP-Next-Connector`** (see [integration-boundaries.md](./integration-boundaries.md) and spec §5/§7).
