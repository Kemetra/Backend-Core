# Spec 041 — Decision record: OD-1 to OD-6 and open questions (RT-483)

**Status:** decisions **selected**, not owner-ratified. The owner delegated these decisions on 2026-10-17 while away.
Each one below is marked:

> **Selected — recommended option, chosen by the coordinator under the owner's standing delegation of 2026-10-17; owner may revisit.**

Source of the OD questions: `docs/planning/rt-282-pricing-backlog-draft.md` §3 (merged in #765). The open
questions Q-1 to Q-7 were raised while writing spec 041 and are handled the same way.

**What "may revisit" costs.** Nothing here is in OpenAPI, a migration or code. A reversal before RT-282 PR-04/PR-05
merge costs only a doc change. After those merge, a reversal is a gated contract/migration change.

---

## OD-1 — Pilot v1 scope cut

| Option | Content |
|---|---|
| **A (recommended)** | v1 = one Price Book per tenant and currency (EGP, tax basis declared); an optional Zone layer with an implicit default Zone; Store override; effective-dated timeline; Change Set with publish/schedule/rollback; inquiry plus "why this price". **Later:** Clearance, Open Price, price-point profiles, cost guardrails, compare-at, recommendations, measured pricing. |
| B | A plus Clearance in v1. Blocked by G2 (RT-486) anyway. |
| C | Minimal: Book + Store override only, no Zones, no timeline. Fails 487–489 and 507–513 and would need a second migration. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation of 2026-10-17; owner may revisit.
Why: it is the smallest scope that honours the resolution (489–506) and timeline (507–521) decisions. Everything deferred is
additive (new `price_kind`, new capability flags).

## OD-2 — Sell Unit in the price key (475–476)

| Option | Content |
|---|---|
| **A (recommended)** | The key includes a `sell_unit` column now, defaulted to `each`. Only `each` is accepted in v1. Multi-UOM pricing arrives with RT-281 Sell Unit modelling. |
| B | Leave Sell Unit out of the key until RT-281. Changes the primary key and exclusion constraints later. |
| C | Model full Sell Units in Pricing now. Duplicates RT-281's ownership. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation of 2026-10-17; owner may revisit.
Why: the key is stable from day one, and Pricing does not invent a UOM model RT-281 owns.

## OD-3 — Revision granularity (628)

| Option | Content |
|---|---|
| **A (recommended)** | Each publish creates one immutable, tenant-wide **Pricing Revision** (`revision_no`, monotonic per tenant). Each Store exposes an **applied-revision number** = the latest tenant revision that touched it (sparse, monotonic). POS applies whole store revisions. |
| B | Per-store revision counters, independent per store. A tenant publish fans out into N counters; harder to reason about "which publish is this". |
| C | Per-item versions. Contradicts 628 (coherent revision, not item-by-item). |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation of 2026-10-17; owner may revisit.
Why: one number identifies a publish everywhere (audit, Impact Preview, POS, sale provenance), and the store view is
derived, not separately maintained. RT-487 (PR-G4) designs how a device applies it.

## OD-4 — Change Set primitive shared with Catalog (RT-281)

| Option | Content |
|---|---|
| **A (recommended)** | One shared Change Set / Revision primitive (lifecycle, versioning, approval hook, audit), with domain-specific item tables and validators (Pricing, Catalog). |
| B | Pricing builds its own lifecycle; Catalog builds another. Two state machines and two approval integrations. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation of 2026-10-17; owner may revisit.
**Consequence recorded here:** RT-281 is still To Do, so **Pricing is the first consumer**. Spec 042 §9 defines the
shared part domain-neutrally (a `domain` discriminator, per-domain revision counter) so RT-281 can adopt it without
a rewrite. If RT-281 later decides it needs a different primitive, the cost of reverting to B falls on Catalog, not Pricing.

## OD-5 — Split of legacy `store_product_overrides` (716)

| Option | Content |
|---|---|
| **A (recommended)** | `price` → Pricing (Store-scope price event). `is_active` → Assortment (RT-281). `tax_category` → Fiscal (RT-294). Legacy columns become read-only compatibility projections during the transition. |
| B | Keep the combined row and add time columns. Contradicts 716 and keeps three owners on one row. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation of 2026-10-17; owner may revisit.
Note: the Pricing part is executed by RT-485 / PR-16a/16b. The Assortment and Fiscal parts need RT-281 and RT-294;
until they deliver, `is_active` and `tax_category` keep their current read-down behaviour.

## OD-6 — POS strict vs lenient response validation

| Option | Content |
|---|---|
| **A (recommended)** | Ask POS to confirm (as was done for spec 033). **Until POS confirms, assume strict**: every additive read-down or sales contract bump ships with a POS contract-pin update in the same rollout. |
| B | Assume lenient and ship contract bumps alone. Risks rejecting responses in the field if POS is strict. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation of 2026-10-17; owner may revisit.
Action carried by RT-282 PR-06 / PR-07 (they are the first contract bumps). The question to POS is in
[plan.md](plan.md) §4. Asking it does not block RT-483 or RT-484.

---

## Open questions raised by spec 041

| ID | Question | Recommended (selected) | Alternative |
|---|---|---|---|
| **Q-1** | How do authors express effective time when one Book/Zone event spans Stores in different time zones? | **`time_basis = store_local` by default** (local wall-clock interpreted per Store), `absolute` allowed for emergency and explicit cross-zone changes (spec §4.3). | Absolute instants only; authors compute each zone themselves. |
| **Q-2** | DST rule for non-existent or repeated local times. | **Gap → first valid instant after; overlap → earlier occurrence.** | Reject such authoring outright. |
| **Q-3** | Historical inquiry after a Store time-zone change (zone history is not versioned on `main`). | **Accept for v1:** use the current zone; sale facts are frozen; record the limitation. Revisit if RT-279 versions store time configuration. | Version `stores.timezone` now (out of Pricing scope; RT-279). |
| **Q-4** | Is a zero price a valid regular price? | **No, in v1:** validation requires `price > 0`. A free item becomes an explicit capability later (like Open Price, 548–556). RT-485 must report any legacy zero prices. | Allow `0` as a normal price. |
| **Q-5** | Can a Book's tax-price basis change? | **Fixed at Book creation in v1.** A change (598) needs a new Book or a later effective-dated Fiscal-reviewed feature, after RT-294. | Make it an effective-dated Book attribute now. |
| **Q-6** | May one price key mix `store_local` and `absolute` events while both are active? | **No:** validation rejects mixing within one key; a change of basis supersedes the old events. Keeps DB overlap checks exact. | Allow mixing and validate per Store in the application only. |
| **Q-7** | Which reasons make the resolver return `error` rather than `unpriced`? | **Only data-integrity defects** (overlap, ambiguous membership). They are surfaced in Pricing Health (PR-12) and read-down omits the row with an issue metric, like unpriced rows today (F4). | Treat them as `unpriced`. Hides defects. |

Each Q row: Selected — recommended option, chosen by the coordinator under the owner's standing delegation of 2026-10-17; owner may revisit.
