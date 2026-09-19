# Retail Tower OS — Feature Placement Rules

**Status**: Proposed
**Date**: 2026-05-27
**Owner**: Ahmed Shaaban
**Constitution version**: v3.0.0
**Scope**: Documentation only. A practical decision procedure for *where* a new
capability lives.

> Read with [retail-tower-operating-model.md](retail-tower-operating-model.md),
> [repo-boundaries.md](repo-boundaries.md), and
> [future-repo-split-criteria.md](future-repo-split-criteria.md).

---

## The rule, in one sentence

Place a capability in the repository that owns its **domain**, as a **module** —
and only consider a new repository when its **deployment, data lifecycle,
security boundary, or team ownership** clearly diverges from that host.

---

## Decision tree

```
START: a new capability or feature
│
├─ Is it backend logic, data/schema, security/authorization, or an API contract?
│     └─ YES ──▶ Backend-Core  (as a module)
│
├─ Is it cashier / terminal / hardware / offline-sale behavior?
│     └─ YES ──▶ POS-Pulse  (as a module)
│
├─ Is it an admin / manager / support / reporting UI?
│     └─ YES ──▶ Retail-Tower-Console  (as a module)
│
├─ Does it need an INDEPENDENT lifecycle?
│     (deployment cadence ▸ data lifecycle ▸ security boundary ▸ team ownership)
│     └─ YES ──▶ consider a FUTURE repository
│                 (requires an ADR + a matching split criterion)
│
└─ Otherwise ──▶ a MODULE inside the existing owning repo  (default)
```

The four "independent lifecycle" tests are defined in
[future-repo-split-criteria.md](future-repo-split-criteria.md). If none clearly
applies, the capability is a module. "Big", "new", or "important" are not
boundaries.

---

## Placement quick reference

| If the work is mainly… | It belongs in… | As a… |
|---|---|---|
| API, DB, RLS, tenancy, contracts, workers, outbox | Backend-Core | module |
| Cashier UI, offline queue, receipts, hardware | POS-Pulse | module |
| Admin/manager/support/reporting screens | Retail-Tower-Console | module |
| Something with a genuinely independent lifecycle | future repo | repo (with ADR) |

---

## Worked examples

- **Billing** → Backend-Core module. Billing truth is tenant-coupled and PII-
  sensitive; it stays with the backend (see [ADR 0005](../../.specify/memory/decisions/0005-billing-and-usage-live-in-data-pulse.md)).
  Billing *screens* → Retail-Tower-Console.
- **Inventory** → Backend-Core module. Source-of-truth data; the backend owns it.
  Inventory *screens* → Retail-Tower-Console.
- **Analytics** → Backend-Core module *while lightweight* (API-query reporting).
  Becomes `Retail-Tower-Analytics` only under warehouse pressure (see
  [ADR 0006](../../.specify/memory/decisions/0006-analytics-module-before-analytics-repo.md)).
- **Integrations / webhooks** → Backend-Core module to start. Extract
  `Retail-Tower-Integrations` when connector lifecycle, DLQ/retry, and external
  credential management become substantial (split-criteria).
- **Device registry** → Backend-Core module (backend truth; `devices` table
  already exists from spec 002). Device pairing *screens* → Retail-Tower-Console;
  pairing *flow* on the terminal → POS-Pulse. No dedicated repo.
- **Demo tenant** → a tenant *configuration*, not a feature. Backend module +
  Retail-Tower-Console management UI. Never its own repo.
- **Feature flags** → Backend-Core module (backend-evaluated so the backend stays
  the authority). Flag-management *screens* → Retail-Tower-Console.
- **Design system** → start as a module/package inside Retail-Tower-Console.
  Promote to a shared package/repo only when POS-Pulse and Console genuinely
  co-consume the same components.
- **Event model / outbox** → Backend-Core module. Backend-internal plumbing
  (§V async work in workers); no UI, no repo split.
- **Support console** → support *APIs* in Backend-Core (cross-tenant actions
  must be audited, §II); support *UI* in Retail-Tower-Console.
- **Generated API clients** → generated *from* the OpenAPI contract of record in
  Backend-Core (see [ADR 0003](../../.specify/memory/decisions/0003-openapi-as-contract-source.md))
  and distributed as a package consumed by Console and POS-Pulse. The contract
  source never leaves the backend.

---

## Anti-patterns

- Creating a repo because a feature "feels large". Size is not a boundary.
- Putting authorization, pricing, or catalog *decisions* in a UI repo. UIs render
  and request; the backend decides (§III).
- Letting a sibling repo reach into the database or an undocumented endpoint. All
  cross-repo traffic goes through the OpenAPI contract (§IV).
- Splitting before validating the capability. Validate as a module first.
