# Spec 043 — Decision record: G4-1 to G4-14 (RT-487, Pricing Gate 4)

**Status:** decisions **selected**, not owner-ratified. Each one below is marked:

> **Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.**

Ratifying this record meets **G4a** (RT-282 §2) and unlocks the G4-gated items PR-06, PR-11, PR-12 and PR-P1 (and the
G4a-gated second PR-05 migration). It does not close G4: runtime closure (**G4b**) is PR-V2.

**What "may revisit" costs.** Nothing here is in OpenAPI, a migration or code. A reversal before PR-05/PR-06/PR-07 merge
costs a doc change. After they merge, it is a gated contract or migration change, and on the POS a local migration.

Design: [design.md](design.md). Section references (§) are to it.

---

## G4-1 — Who converts store-local time to instants

| Option | Content |
|---|---|
| **A (recommended)** | Backend-Core converts every segment bound to an **absolute instant for that Store** (spec 041 §4.3 rules). POS compares instants only. |
| B | Send local bounds plus the Store's IANA zone; POS converts. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Why: the POS zone is a build constant that is deliberately not read from settings (POS `src/shared/time/business-day.ts`),
and DST rules then live in one place, the resolver. Cost: a Store zone change must re-deliver (G4-3).

## G4-2 — Where pricing travels to POS

| Option | Content |
|---|---|
| **A (recommended)** | A **separate pricing projection stream** (`/api/pos/v1/pricing/manifest | snapshot | acks`), keyed by store revision, next to the unchanged catalogue read-down. Under `pricing` authority the catalogue includes active products without a current price, and POS decides sellability from the applied projection. |
| B | Extend catalogue read-down rows with revision-tagged price fields and future entries. Coherence would have to follow both `catalog_change_log.sequence` and the pricing revision page by page. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Why: the coherence unit of pricing is the revision (628), not the catalogue's global change-log position; spec 010 stays
untouched; legacy and pricing authority never mix on one device. Consequence carried to RT-485/PR-16b: the catalogue
sellable filter and the manifest `authority` flip together per tenant (§5.2, §11).

## G4-3 — Identity of what a device applies

| Option | Content |
|---|---|
| **A (recommended)** | The pair **`(storeRevision, timeBasisEpoch)`**, ordered lexicographically. `timeBasisEpoch` rises when the Store's zone changes (under the pricing publish lock), and BC keeps an insert-only epoch → zone history so sales priced under an old epoch revalidate with the zone that was in force. A lower pair is a downgrade and is refused. |
| B | `storeRevision` only; a zone change publishes a synthetic pricing revision fanned out to the Store. Needs a revision kind without a Change Set. |
| C | `storeRevision` only; ignore zone changes until the next revision. Leaves wrong instants on devices. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Why: OD-3's revision stays one number per publish; a zone change (spec 038) creates no pricing revision (spec 042 Q-B8) yet
moves instants, so it needs its own counter.

## G4-4 — Pre-delivery horizon and the use of `earliest_effective_at`

| Option | Content |
|---|---|
| **A (recommended)** | Deliver the **whole future timeline** per key in every projection (no window). `earliest_effective_at` drives only Health (`pre_delivery_at_risk` from `earliest_effective_at − preDeliveryWarnLead`, default 2 h; `missed_pre_delivery` at each Store's exact first activation) and manifest `urgent`. |
| B | Deliver a sliding window (e.g. 14 days). The projection then depends on time as well as revision, and a device offline past the window loses future prices. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Why: future events are few per key (one active per scope per instant), and the projection stays a function of the pair.
A window is a later optimisation if size metrics require it.

## G4-5 — Trusted time model

| Option | Content |
|---|---|
| **A (recommended)** | **Server-anchored monotonic clock + two sealed marks** (generalising the offline-grant mark): `hwm_trusted`, raised **only from anchored time**, and `wall_seen`, raised from the wall clock and used **only to detect rollback**. Anchor = `serverTime` from any manifest with RTT ≤ 5 s; `t_lo = max(hwm_trusted, serverTime + Δmono)`; after restart or OS resume (`unverified`) `t_lo = max(hwm_trusted, min(wall, hwm_trusted + maxStaleness))`. **Activation uses the lower bound `t_lo`; staleness uses the upper bound `t_hi = max(t_lo, wall)`.** At re-anchor, a wall clock that ran ahead or was rolled back produces a reported **clock incident**. Drift budget 120 s; rollback tolerance 5 min. |
| B | Wall clock with skew detection only. Easy to roll back to keep an old price. |
| C | Server-signed activation tokens per revision. Needs signing keys and still needs local time to know *when* to use them. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Why: it reuses machinery the POS already has, closes rollback, biases activation late and staleness early, and keeps
untrusted wall time out of the trusted floor, so a re-anchor always restores correct activation. The remaining risk
(forward tampering after an offline restart) is bounded by `maxStaleness` and detected through clock incidents (G4-13),
except when the device stays offline until real time overtakes the forged time. That case is stated as undetectable. A signed manifest stays optional
hardening (RT-284 Q7 precedent).

## G4-6 — Behaviour when time cannot be trusted

| Option | Content |
|---|---|
| **A (recommended)** | Three states. `anchored`: normal. `unverified`: activation by `max(hwm, wall)`; sales record it. `suspect` (wall below `hwm − 5 min`, or drift > 120 s with no resume event): **activation frozen at `hwm`** (no un-activation, no new activation) and pricing **treated as stale** in every mode, until a fresh anchor. |
| B | Block all selling while `suspect`. |
| C | Ignore suspicion and keep using the wall clock. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Why: matches RT-284 P-F ("a clock rollback counts as stale") and lets the tenant's mode decide whether stale blocks
(`deny_if_stale`) or only shows (`allow_cached`), instead of a second, clock-specific blocking rule.

## G4-7 — Staleness definition and v1 defaults

| Option | Content |
|---|---|
| **A (recommended)** | `age = t_hi − lastCheckAt` where a **check** is a successful manifest read with the applied pair current (`If-None-Match` carries the applied pair's ETag, so a 304 counts; a failed apply does not). Defaults: `offlineMode = allow_cached`, `maxStaleness = 24 h`, `warnAfter = 12 h`, `poll = 300 s`, `onlineWindow = 360 s`. POS clamps `maxStaleness ≤ 72 h` and `onlineWindow ≥ poll + 60`; under `online_only` a lapsed window triggers one on-demand check at scan before refusing. `allow_cached` sells with a non-dismissable stale banner; `deny_if_stale` refuses new lines at a cached price; `online_only` requires a check within `onlineWindow`. |
| B | Same, default `deny_if_stale` with 24 h. Blocks a store's sales after one day of outage. |
| C | Age from the last *apply* rather than the last check. A store with no price changes would go stale while fully connected. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Why: RT-284 ratified `allow_cached` as the default for standard-tier offline behaviour; pilot connectivity is intermittent;
stale stays visible (625) and on every sale. A tenant that wants blocking sets `deny_if_stale`.

## G4-8 — Where the freshness policy comes from before RT-284 ships

| Option | Content |
|---|---|
| **A (recommended)** | Interim tenant setting `pricing.offline` (Store override allowed), carried on the **pricing manifest** with `policySource` / `policyRevisionId` (spec 040 pattern). It moves to the RT-284 device policy bundle (PE-BC4 / PE-POS1) when that exists; the manifest field is then removed in a later contract version. |
| B | Wait for the RT-284 bundle. Blocks G4 implementation on RT-284. |
| C | POS constants only. Not configurable (contradicts 626). |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Note: RT-284 P-F rejected carrying policy on the **catalogue** read-down. The pricing manifest is a pricing surface carrying
only pricing freshness, and the interim is retired by design.

## G4-9 — Critical corrections

| Option | Content |
|---|---|
| **A (recommended)** | `critical = true` on an **emergency** Change Set (capability `pricing.emergency`), recorded on the revision. Effects: manifest `urgent` → online POS applies before the next scan; open-cart lines for affected keys are flagged and need explicit old/new accept before tender (608); optional per-line `offlinePolicy {deny_if_stale | online_only, maxStaleness?, until}` (until required, default activation + 72 h, max 30 days) applies to those keys only; Health `critical_not_applied` per device; sync findings `sold_before_correction`. Pre-delivered bad prices are removed by superseding, never patched on the device. |
| B | A critical revision switches the whole Store to `online_only` until every device acks. Stops all sales at an offline till for one item. |
| C | No special handling beyond emergency publish. Fails 627. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Why: it gives both levers decision 627 names (shorter TTL, online-only) scoped to the corrected items, keeps 603/608/611,
and states plainly that an unreached offline device cannot be corrected, only detected; the tenant's `maxStaleness`
bounds that exposure.

## G4-10 — Failed apply

| Option | Content |
|---|---|
| **A (recommended)** | Stage → verify `entryCount` + canonical `contentHash` → promote in **one** SQLite transaction. Any failure keeps the previous pair live and records `last_failed_pair`, a closed `failure_code` and time; ack `failed`; backoff 30 s → 5 min; after three failures on one pair, re-fetch from page 1. Before the first apply under `pricing` authority, nothing is sellable (`never_applied`). |
| B | Item-by-item apply with per-row retry. Contradicts 628. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.

## G4-11 — What the sale freezes (with PR-07)

| Option | Content |
|---|---|
| **A (recommended)** | Line: PR-07 provenance union verbatim, with `pricingRevision` = the **store revision the device applied** (the `asOfRevision` that reproduces its belief), plus a sibling **`pricingCapture {pricedAt, timeBasisEpoch, stale, clockState}`** frozen per line (these can change inside one open cart). Sale: an **aggregate** `pricingContext {appliedRevision (max), stale (any line), clockState (worst line), offlineMode, lastPricingCheckAt}`. |
| B | `pricingRevision` = the revision that published the event. Does not reproduce what the device saw when a later revision changed nothing for that key but did for others. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Consequence: PR-07 gains `pricingCapture` and `pricingContext` (additive). The union shape shared by PR-06 and PR-07 is unchanged.

## G4-12 — Sellability after cutover

| Option | Content |
|---|---|
| **A (recommended)** | Under `pricing` authority, POS sells an item iff the catalogue has it active **and** the applied projection has a segment containing `t_lo`. The catalogue snapshot includes active products without a current price, so future-only prices can be pre-delivered. |
| B | Keep the current-price sellable filter on the catalogue. A product launching at a future price can never be pre-delivered. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.
Interaction recorded for RT-485 (PR-16b): flip the filter and the manifest `authority` together.

## G4-13 — Server revalidation of offline-priced sales

| Option | Content |
|---|---|
| **A (recommended)** | Asynchronous, never on the capture path. Recompute `resolve(item, store, pricedAt, pricingRevision)` with the zone of the line's `timeBasisEpoch`; findings `price_mismatch`, `sold_before_correction`, `early_activation` (from device clock incidents, matched retroactively, or a segment start later than BC's receive time), `device_clock_ahead`. A forward-clock sale with no such evidence is stated as undetectable. Findings go to Pricing Health; capture never fails; sale facts are never changed. |
| B | Reject sales whose prices do not revalidate. Contradicts 611 and loses real sales. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.

## G4-14 — Delivery cadence

| Option | Content |
|---|---|
| **A (recommended)** | A cheap manifest check (ETag/304) every `pollIntervalSeconds` (default 300) while online, plus at start, on reconnect and on manual refresh; snapshot only when the pair changes or `urgent`. The catalogue keeps its hourly cadence. |
| B | Reuse the hourly catalogue tick. Critical corrections could take an hour to reach an online till. |
| C | Server push (WebSocket / SSE). New infrastructure; not needed for v1. |

**Selected: A.** Selected — recommended option, chosen by the coordinator under the owner's standing delegation; owner may revisit.

---

## Evidence for OD-6 (not a new decision)

POS validates read-down responses with a hand-written check of required fields; extra fields are tolerated (POS
`read-down-client.ts:97-113,176-201`, no zod/ajv). The POS contract pin is checked by blob SHA
(`contracts/backend-core/PIN`), so every Backend-Core contract bump the POS adopts needs a POS re-pin in the same rollout.
This is input to OD-6 (RT-483), which keeps "assume strict until POS confirms".

## Open items for the owner

None blocking. The owner may revisit any selection above; G4-7 (default mode) and G4-9 (per-line offline policy) are the
two with the most operational impact.
