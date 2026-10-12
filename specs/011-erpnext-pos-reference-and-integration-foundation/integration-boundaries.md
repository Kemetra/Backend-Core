# ERPNext Integration Boundaries

**Feature**: 011-erpnext-pos-reference-and-integration-foundation
**Status**: Draft — boundary documentation only
**Date**: 2026-06-03

> This document fixes the **trust and ownership boundaries** for the ERPNext backbone so they cannot drift across the downstream specs (012–017). It **extends** — and must not contradict — [docs/architecture/repo-boundaries.md](../../docs/architecture/repo-boundaries.md), [feature-placement-rules.md](../../docs/architecture/feature-placement-rules.md), [future-repo-split-criteria.md](../../docs/architecture/future-repo-split-criteria.md), and the Constitution §IV trust boundary.

---

## 1. The one-path invariant

```
   POS-Pulse ─────┐
                  │  POS OpenAPI contracts only (/api/pos/v1/…)
                  ▼
            Data-Pulse-2  ◀────────── Retail-Tower-Console
          (source of truth,            generated DP2 clients only
           orchestration               (no Frappe awareness)
           boundary)
                  │
                  │  the ONLY edge that touches ERPNext,
                  │  mediated by the future connector
                  ▼
   Retail-Tower-ERP-Next-Connector  ──▶  ERPNext / Frappe
        (future separate repo,            reference ERP /
         gated by ADR)                    accounting / inventory;
                                          POS surface = reference-only
```

**Invariant**: there is **exactly one** path to ERPNext — through **Data-Pulse-2** and the **connector**. No other repository has an edge to ERPNext.

---

## 2. Per-repository rules

### Data-Pulse-2 (backend — source of truth)

- **Remains the backend contract and orchestration boundary.** Every ERP interaction is orchestrated here.
- **Owns** the OpenAPI contracts that POS-Pulse and Retail-Tower-Console consume — including any future ERP-backed endpoints.
- **Is the only system permitted to talk to ERPNext**, and only via the future connector — never via ad-hoc direct calls scattered through the codebase.
- **Keeps source-of-truth ownership** of the sale fact (008), catalog (003), and stock ledger (009). ERPNext receives **postings**; it does not become the origin of these facts.
  - **Superseded (RT-288, Inventory Planning Gate 1, recorded 2026-10-12):** for inventory, "source-of-truth ownership of … stock ledger (009)" means
    operational inventory authority only (721, 722). ERPNext Stock Ledger/Bin remains the financial/book quantity
    authority (719), and 009 evolves into an Inventory Effects Journal (724). Source: the owner-approved Inventory Operations baseline of 2026-10-07, decisions 719–727 (Confluence RETAIL page 22544389).
- **Does not become a general ledger.** The chart-of-accounts / GL valuation that DP2 deliberately does not model is exactly what ERPNext provides.

### POS-Pulse (cashier terminal)

- **Never calls Frappe/ERPNext directly.** No ERPNext REST calls, no Frappe client, no ERPNext POS adoption.
- Continues to integrate **exclusively** via Data-Pulse-2's POS contracts (`/api/pos/v1/…`), device-principal authenticated (002).
- **Unaware of ERPNext.** ERP-backed data, if any, reaches POS-Pulse as ordinary DP2 API responses with no Frappe-specific shape leaking through.
- Retains ownership of offline-first cashiering, tender UX, and hardware (printer/drawer).

### Retail-Tower-Console (admin UI)

- **Frontend-only.** Consumes **Data-Pulse-generated clients only**.
- **Unaware of Frappe.** No ERPNext SDK, no Frappe URLs, no direct ERP queries. ERP-backed admin data arrives as DP2 API responses.
- Any ERP-derived screen is unblocked **only** once the matching `[GATED]` DP2 OpenAPI contract is merged (Constitution §IV contract-first coupling).

### Retail-Tower-ERP-Next-Connector (future repo — does not exist yet)

- The **only** component that holds ERPNext credentials and speaks the Frappe API.
- A **concrete instance** of the `Retail-Tower-Integrations` split candidate ([future-repo-split-criteria.md](../../docs/architecture/future-repo-split-criteria.md)).
- **Created only after an accepted ADR** under `.specify/memory/decisions/` per that document's "process for a split" — confirming a boundary test (security: external credentials/blast radius; team ownership: connector roadmap), then proposing contract surface and data ownership.
- Preserves the OpenAPI contract boundary with Data-Pulse-2: DP2 ↔ connector is itself a versioned contract, not a shared database or filesystem.

---

## 3. Hard prohibitions (inherited by all of 012–017)

| Prohibition | Source |
|---|---|
| POS-Pulse MUST NOT call ERPNext/Frappe directly | Constitution §IV; this doc §2 |
| Retail-Tower-Console MUST NOT call ERPNext/Frappe directly | Constitution §IV; this doc §2 |
| No direct DB access, shared filesystem, or undocumented endpoint between any pair of repos | Constitution §IV trust boundary |
| ERPNext POS MUST NOT be adopted as the production cashier terminal | spec §1; [erpnext-pos-reference-map.md](./erpnext-pos-reference-map.md) |
| ERPNext credentials MUST live only in the connector, never in POS-Pulse, Console, or scattered DP2 code | this doc §2; split-criteria security boundary |
| DP2 MUST NOT surrender source-of-truth ownership of sale/catalog/stock facts to ERPNext | Constitution §IX; spec §1 |

> **Clarified (RT-288, Inventory Planning Gate 1, recorded 2026-10-12):** for stock, the guardrail "DP2 MUST NOT surrender source-of-truth ownership of …
> stock facts to ERPNext" covers *operational* inventory facts and Available To Sell only (721, 722). ERPNext Stock
> Ledger/Bin is the financial/book quantity authority (719), and ERP snapshots are evidence, never a blind
> overwrite of operational state (729, 782, 783). Source: the owner-approved Inventory Operations baseline of 2026-10-07, decisions 719–727 (Confluence RETAIL page 22544389).

---

## 4. Direction of data (decided per downstream spec, not here)

011 fixes *who may talk to whom*. It does **not** fix *which way each piece of data flows* — that is decided per downstream spec and gated by the decision records:

- **Catalog / product master** direction → decided in **013** (gated by the posting decision).
- **Branch / warehouse inventory** direction → decided in **014** (gated by the stock-impact decision).
- **Sale posting** direction (DP2 → ERPNext) → decided in **015** (gated by posting + stock-impact).
- **Tax / fiscal** computation & e-invoice flow → decided in **016** (gated by tax/fiscal).

In all cases the **boundary** above holds regardless of direction: data crosses to/from ERPNext only through DP2 + the connector.

---

## 5. Relationship to existing architecture docs

This document is **additive**. It does not change:

- [repo-boundaries.md](../../docs/architecture/repo-boundaries.md) — Data-Pulse-2 / POS-Pulse / Console ownership table stands.
- [future-repo-split-criteria.md](../../docs/architecture/future-repo-split-criteria.md) — the `Retail-Tower-Integrations` candidate and its ADR process stand; the ERPNext connector is its concrete instance.
- [feature-placement-rules.md](../../docs/architecture/feature-placement-rules.md) — "Integrations/webhooks → DP2 module to start; extract when substantial" stands.

If any downstream spec finds a genuine conflict with these docs, that is a **STOP-and-raise-an-ADR** condition, not a silent override.
