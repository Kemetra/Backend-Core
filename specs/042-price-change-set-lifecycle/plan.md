# Spec 042 — Price Change Set and publishing lifecycle (plan)

| | |
|---|---|
| **Jira** | RT-484 (RT-282 PR-02). Builds on RT-483 / spec 041 |
| **Work Mode** | Planning. This file is the deliverable. No code, OpenAPI or migration |
| **Repository** | `Kemetra/Backend-Core` |
| **Baseline** | `origin/main` @ `ff9e6833` (2026-10-17) |
| **Decisions honoured** | Confluence RETAIL 23855106: 522–535 (Change Sets and publishing), 637–638 (lead time, emergency), 705–707 (authority, audit). Also 488, 519–520 from spec 041 |
| **Depends on** | Spec 041 (model, OD-3, OD-4 selected). RT-281 (shared primitive, To Do). RT-284 (approval policy, To Do) |
| **Status** | PLANNED. Open questions selected under the owner's standing delegation of 2026-10-17 (§11); the owner may revisit |

## 1. Objective

Every price change reaches a Store only through a **Price Change Set**: authored, validated against the
timeline, previewed, approved by policy, and published as one immutable **Pricing Revision** (spec 041 OD-3).
Rollback is a new revision. Nothing is edited in place.

## 2. What exists on `main` today

- No authoring surface and no change-set concept anywhere (spec 041 F3; grep for `change_set` in `packages/db/src`, `apps/api/src` finds nothing).
- `audit_events` is an insert-only governance log with actor, tenant, store, action and target
  (`packages/db/src/schema/audit_events.ts`). It is the audit sink reused here.
- Roles on `main` include `owner`, `tenant_admin` and `store_manager`; per-store reach is `store_access`.
- The cash-variance policy (spec 040) is the precedent for a narrow, single-key policy store shaped so the RT-284 engine can absorb it.
- Per-tenant serialization precedent: `lockPostingFeedSequence` (RT-456), a transaction-scoped advisory lock.

## 3. State machine

```
            edit (version+1)
          ┌───────────────┐
          ▼               │
 ┌──────► draft ──validate──► validated ──submit──► pending_approval ──approve──► approved ──publish──► published
 │          ▲  │                │  │                    │                          │                      │
 │          │  └─cancel─► cancelled  └─edit/stale─► draft  └─reject─► draft           └─stale─► draft        ├─► superseded
 │          └──────────────────────────────────────────────────────────────────────────────────────────────┤
 │                                                                                                         └─► rolled_back
 └── rollback of a published set creates a NEW change set (kind = rollback), which runs this same machine
```

| State | Meaning | Mutable? |
|---|---|---|
| `draft` | Being authored. Items and selectors can change. | yes (versioned) |
| `validated` | Selectors materialized, concrete prices computed, conflicts analyzed, Impact Preview stored with a `previewHash`. Valid only against the tenant's **head revision at validation** (`validatedAtRevision`). | no; any edit returns it to `draft` |
| `pending_approval` | Submitted; the policy said approval is required (§7). | no |
| `approved` | Approved for exactly the `previewHash` that was shown. | no |
| `published` | Its events and membership rows exist in revision `revisionNo`. Display status is **`scheduled`** while the revision's `earliest_effective_at` (events **and** memberships) is in the future, **`active`** after. | terminal for content |
| `superseded` | Every event **and every Zone-membership row** it published has been superseded by later revisions. Derived and set at the publish that completes it. | terminal |
| `rolled_back` | A rollback change set restoring the prior state was published. | terminal |
| `cancelled` | Abandoned before publish. Kept for audit. | terminal |

Rules:

- **Validation is bound to a head revision, but only conflicts make it stale.** When `head > validatedAtRevision`,
  `submit`, `approve` and `publish` run an intersection check against the revisions published since validation. A
  later revision **intersects** this set when it shares a `(Store, product, sell unit)` with the set's lines, judged on
  its store fan-out (spec 041 data-model §2.6). That covers Book and Zone events that change an inherited price the set's
  preview or helpers were based on. It also intersects in two membership cases:
  - it changes the Zone membership of a Store in the set;
  - it moves **any** Store into or out of a Zone (or the Book's default Zone, by fallback) that one of the set's
    Zone-scope lines targets, over an interval that overlaps that line. Such a Store was not in the materialized
    preview, so store and device counts, old prices and the sensitivity decision may all be wrong.
  - **Intersecting** → `409 stale_validation`, and the set returns to `draft` to be re-validated.
  - **Not intersecting** → the call proceeds, and `validatedAtRevision` advances to the head. The preview still holds,
    because no line's old price, class or helper base can have changed.

  Publish repeats the check under the publish lock. This is how a change set never publishes on top of a timeline it has
  not analyzed (525, 519), without one publish discarding every unrelated approval in flight.
- **Store lifecycle also makes a set stale (Q-B8).** Creating, activating, deactivating or retiring a Store, or changing its time zone, produces no
  pricing revision, yet it changes which Stores a Book-scope or Zone-scope line reaches (a new Store with no explicit
  membership falls back to the default Zone). Validation therefore stores a **`targetStoreSetHash`**: a hash of the
  sorted `(store_id, timezone)` pairs each line's scope reaches over its interval, and it is part of `previewHash`.
  Because the time zone is hashed, a Store time-zone change (spec 038) also changes the hash: it moves `store_local`
  activation instants that the approver saw in the preview. `submit`, `approve`
  and `publish` (the last under the publish lock) recompute the target Store set. If it differs → `409 stale_validation`,
  the set returns to `draft`, and it must be re-validated and **re-approved** against the new preview. Store-scope lines
  are affected only when their own Store is deactivated or retired. For the publish recheck to be atomic with Store
  lifecycle writes, those writes take the same per-tenant pricing publish lock (§8). A Store created after publish is
  covered by the bootstrap rule in spec 041 data-model §2.6.
- **Approval is bound to the preview.** `approve` carries `previewHash`. A different hash → `409 preview_changed`.
  People approve what they saw (526–527).
- **Publish is all-or-nothing.** One DB transaction under the per-tenant pricing publish lock: re-check head,
  allocate `revision_no`, insert events, mark superseded events, fan out `pricing_revision_stores`, write audit
  rows, emit a `pricing.revision.published` outbox event. Any failure leaves no partial revision (528, 530).
- **Scheduled vs immediate (529, 637).** Publishing always creates the revision **now**. Effective times live on the events.
  "Scheduled" means published ahead of effective time, which gives POS time to pre-deliver it (RT-487). There is no
  deferred publish job, so nothing can "fail to publish later".

## 4. Change set content

### 4.1 Header

`id`, `tenant_id`, `domain = 'pricing'`, `kind` (`standard | emergency | rollback`), `title`, `reason` (required for
`emergency`, `rollback` and past-dated), `state`, `version` (int, optimistic concurrency), `validated_at_revision`,
`preview_hash`, `revision_no` (once published), `created_by`, `submitted_by`, `approved_by`, `published_by`, timestamps.

### 4.2 Items (operations)

Each item is one operation on a **selector** (523):

| Operation | Effect after materialization |
|---|---|
| `set_price` | Fixed price at the target scope (514) |
| `adjust_amount` / `adjust_percent` | Helper. Resolves to a concrete price per target at validation, from the price *inherited at the target's effective instant* (515–517) |
| `end_price` | Ends the target-scope interval at an instant (for example the end of a limited-time regular price) |
| `reset_store_override` | Ends Store-scope events so the inherited price applies (491) |
| `move_store_zone` | New Zone membership interval; always produces an Impact Preview (488). The revision fans out to the moved Store (spec 041 data-model §2.6) |

Every item carries `effectiveFrom` (required), optional `effectiveTo` and `timeBasis` (`store_local` default; spec 041 §4.3).

### 4.3 Selectors (523)

| Selector | Targets |
|---|---|
| `items` | explicit product ids (+ sell unit, `each` in v1) |
| `category` | all products in a category subtree, **frozen at validation** (re-validation re-reads it) |
| `zone` | the scope is a Zone of the Book |
| `stores` | a Store set; the scope is each Store |
| `book` | the scope is the Book |

Scope (`book | zone | stores`) and product set (`items | category`) combine. Store Groups are authoring
selectors only, never a precedence layer (492); they expand into a `stores` set.

**Materialization** turns selectors into concrete `(scope target, product, sell unit)` rows with a concrete price.
Validation stores them as **change-set lines**; preview, approval and publish all work from the lines, not
the selectors. A set over the hard line limit (proposed 50 000, Q-B6) fails validation with a split hint.

## 5. Validation and conflict analysis (524–525, 519–520)

Validation runs every rule from spec 041 §5 on the lines and classifies each line against the timeline at
`validatedAtRevision`:

| Class | Meaning | Blocks approval? |
|---|---|---|
| `new` | No active event of the same key overlaps | no |
| `replaces` | Overlaps an active event of the same key and scope; publishing supersedes it (the old event is split/ended around the new interval) | no, but it is listed and must be acknowledged in the preview |
| `conflicts_pending` | Overlaps lines in another change set that is `validated`/`pending_approval`/`approved` | no. First publish wins; the other goes stale through the §3 intersection check. Shown as a warning |
| `shadowed` | Valid, but a more specific scope already prices the target, so some Stores see no change | no; listed per Store |
| `invalidates_dependent` | Changes the base of a **later, already-published** event that was authored with a helper. That later event keeps its approved concrete price (518). The finding asks the author whether it should be revised in this set | warning; approval requires explicit acknowledgement |
| `past_dated` | `effectiveFrom` earlier than now | **yes**, unless `kind = emergency` with the past-dating capability (§7) and a reason (520) |
| `invalid` | Not representable, `≤ 0` (spec 041 Q-4), wrong currency, ambiguous membership, retired product | **yes** |

Unchanged lines (new price = current price) are dropped with a note.

## 6. Impact Preview (526)

Stored at validation, keyed by `previewHash = sha256(canonical JSON of lines + classes + targetStoreSetHash + validatedAtRevision)`.

Draft payload (PR-04 commits it to OpenAPI):

```jsonc
{
  "changeSetId": "…", "version": 7, "validatedAtRevision": 418, "previewHash": "sha256:…",
  "summary": {
    "lines": 1240, "stores": 38, "devices": 112, "products": 410,
    "increases": 900, "decreases": 330, "unchanged": 10,
    "maxIncreasePct": "12.50", "maxDecreasePct": "-30.00",
    "earliestEffectiveAt": "2026-11-01T00:00:00+02:00",
    "findings": { "replaces": 40, "shadowed": 12, "invalidates_dependent": 1, "conflicts_pending": 0 }
  },
  "lines": [   // paginated
    { "storeId": "…", "productId": "…", "sellUnit": "each",
      "oldPrice": "130.0000", "oldSourceScope": "book",
      "newPrice": "125.5000", "newSourceScope": "zone",
      "deltaPct": "-3.46", "effectiveFrom": "…", "class": "new", "devices": 3 }
  ]
}
```

- `oldPrice` is the resolved price **at the line's effective instant** in each Store, at `validatedAtRevision` (spec 041 §4).
- `devices` counts active (not retired) devices of the Store, from `devices`.
- Sensitivity inputs for §7 (max delta, store count, emergency, past-dated) come from `summary`.

## 7. Approval and authority (527, 535, 638, 705–706)

RT-284 (the Policy engine) is not delivered. Until it is, a narrow tenant-level setting, shaped for RT-284 to absorb
(the spec 040 DR-1 pattern), drives approval:

`pricing.change_set_approval` = `{ mode: "always" | "sensitive_only", maxAutoDeltaPct, maxAutoStores }`
— v1 default `always` (Q-B1).

| Actor | May author | May approve | May publish | Emergency |
|---|---|---|---|---|
| `owner`, `tenant_admin` | any scope | yes; **not their own sensitive set** (four eyes) | yes, once approved | yes, with capability `pricing.emergency` |
| `store_manager` | **Store-scope only**, for Stores in `store_access`; operations `set_price`, `adjust_*`, `reset_store_override`; each line within **±bound %** of the inherited price (bound in the setting, default 10 %) (706) | no | no | no |
| others | no | no | no | no |

- **Sensitive** = mode `always`, or any of: `|deltaPct| > maxAutoDeltaPct`, stores `> maxAutoStores`, any
  `move_store_zone`, past-dated, `kind = rollback` or `emergency`. A non-sensitive set may be self-approved by an
  owner/tenant_admin; a sensitive one needs a **different** owner/tenant_admin.
- **Emergency path (535, 638).** `kind = emergency`, mandatory reason, capability `pricing.emergency`. It may skip
  lead time, may past-date with reason, and may be published by its author **without a second approver**. It
  never skips validation, preview or audit. An emergency publish opens a **post-hoc review** that a different
  owner/tenant_admin must acknowledge (it shows in Pricing Health until acknowledged; Q-B3). Critical-correction
  TTL and online-only behaviour are RT-487's (627).
- **Lead time (637).** Optional tenant setting `pricing.min_lead_time` (default none in v1). Standard sets with
  `earliestEffectiveAt < now + lead time` fail validation; emergency sets are exempt.
- All checks run **server-side**; the Console only reflects them.

## 8. Rollback, superseding and concurrency (530–534)

- **Rollback = new change set.** `POST …/{id}/rollback` generates a `kind = rollback` set whose lines restore,
  **from a chosen instant forward** (default now), the events **and Zone memberships** that the target revision
  superseded, and end the events and memberships it introduced. A rollback of a `move_store_zone` set therefore
  restores the Store's prior membership timeline, using the same supersede-and-replace rows as a move (spec 041
  data-model §2.3), and fans out to that Store. It is validated, previewed, approved (always sensitive) and published like any set. The
  original becomes `rolled_back`. History before the rollback instant is never rewritten (521, 531, 534).
- A rollback of a set whose events or memberships were already superseded by later revisions is refused with the list of blocking
  revisions; the author rolls back newest-first or authors a corrective set.
- **Optimistic concurrency (532).** Every mutating call carries `expectedVersion` (or `If-Match`). A mismatch →
  `409 version_conflict`. Publish additionally re-checks the head revision (§3).
- **Publish serialization.** Per-tenant transaction-scoped advisory lock around publish. Authoring and validation do
  not take it. **Store lifecycle writes take it too**: create, activate, deactivate and retire, plus a time-zone change
  (spec 038), because that moves `store_local` instants. They take it inside their own transaction, before mutating the
  `stores` row. Then the §3 target-Store recheck, the revision fan-out and any Store lifecycle change are serialized:
  either the Store change commits first and the publish recheck sees it (→ stale), or the publish commits first and the
  new Store gets the head through the bootstrap row (spec 041 data-model §2.6). This puts one lock acquisition into the
  Store write paths. That is an implementation change for PR-10, recorded here so it is not missed.
- **Canary rollouts (533)** are out of v1 (OD-1 later list); the revision model leaves room for per-store activation in RT-487.

## 9. Reuse of the RT-281 primitive (OD-4)

Spec 041 OD-4 selected **one shared primitive**. RT-281 is still To Do, so Pricing defines it, domain-neutrally:

| Shared (generic `change_sets` primitive) | Pricing-specific |
|---|---|
| Header table with a `domain` discriminator (`pricing`, later `catalog`) | Items / lines tables (`price_change_set_items`, `price_change_set_lines`) |
| State machine of §3, `version`, `expectedVersion` handling | Selectors and materialization (§4.3) |
| `validatedAtRevision` / `previewHash` binding | Validation and conflict classes (§5) |
| Approval hook: a domain callback returns `sensitive: bool` + reasons; the generic part enforces four eyes and the emergency post-hoc review | Sensitivity inputs and thresholds (§7) |
| Revision allocation per `(tenant, domain)` under the domain's publish lock | Event writes, superseding and store fan-out |
| Audit writer (§10) and outbox event `<domain>.revision.published` | Impact Preview payload (§6) |

If RT-281 needs something the primitive lacks, it extends the primitive; it does not fork it. If the owner later
prefers independent lifecycles (OD-4 B), only the "shared" column moves into Pricing.

## 10. Audit (707)

Every transition writes one `audit_events` row: `action = pricing.change_set.<transition>`, `target_type = price_change_set`,
`target_id`, actor, `store_id` (for single-store sets), and metadata: `reason`, `version`, `revisionNo`,
`previewHash`, `kind`, `earliestEffectiveAt`. Publish additionally writes a per-line before/after record
(`oldEventId/oldPrice → newEventId/newPrice`, effective time). Volume rule: the per-line record lives in the change-set
lines table (immutable after publish) and the audit row references it, so audit stays one row per transition (Q-B5).

## 11. Open questions (selected)

| ID | Question | Selected (recommended) | Alternative |
|---|---|---|---|
| **Q-B1** | Default approval mode before RT-284 | **`always`** (every set needs an approve step; self-approval only when non-sensitive) | `sensitive_only` |
| **Q-B2** | Store Manager bound | **±10 % of inherited price, Store scope only, no zone/book, no emergency** | No Store Manager authoring in v1 |
| **Q-B3** | Emergency second approver | **Not required to publish; post-hoc review by a different admin required and tracked** | Require a second approver even in emergencies |
| **Q-B4** | Deferred publish job vs publish-now with future effective time | **Publish now, future effective time** (no scheduler failure mode; enables pre-delivery) | A scheduler publishes at effective time |
| **Q-B5** | Per-line before/after in `audit_events` or in change-set lines | **Lines table, referenced from one audit row per transition** | One audit row per line |
| **Q-B6** | Line limit per change set | **50 000 lines**, revisit with RT-317-style measurement | Unlimited |
| **Q-B7** | Do pending sets that overlap block each other? | **No; first publish wins. Only sets that intersect it (§3) go stale and re-validate; unrelated sets keep their approval** | Lock targets while a set is pending; or stale every pending set on any publish |
| **Q-B8** | Store lifecycle changes (create, activate, deactivate, retire, time-zone change; no revision) alter a set's target Stores or their activation instants | **Bind the target Store set into the preview (`targetStoreSetHash`) and stale the set on mismatch at submit/approve/publish; re-approval required** | Re-materialize silently at publish (approver never sees the new Stores) |

Each row: Selected — recommended option, chosen by the coordinator under the owner's standing delegation of 2026-10-17; owner may revisit.

## 12. Draft API surface (for PR-04; not OpenAPI)

| Call | Transition |
|---|---|
| `POST /v1/pricing/change-sets` | create `draft` |
| `PATCH /v1/pricing/change-sets/{id}` (`expectedVersion`) | edit items → `draft` |
| `POST …/{id}/validate` | → `validated` (returns preview summary) |
| `GET …/{id}/preview?page=` | read preview |
| `POST …/{id}/submit` | → `pending_approval` or straight to `approved` when not sensitive and self-approval allowed |
| `POST …/{id}/approve` `{previewHash, expectedVersion}` / `…/reject` `{reason}` | → `approved` / `draft` |
| `POST …/{id}/publish` `{expectedVersion}` | → `published`, returns `revisionNo` |
| `POST …/{id}/rollback` `{from?, reason}` | creates a rollback set |
| `POST …/{id}/cancel` | → `cancelled` |
| `POST …/{id}/emergency-review` | acknowledges the post-hoc review |

## 13. Acceptance-criteria trace (RT-484)

| AC | Where |
|---|---|
| State machine | §3 |
| Payloads (selectors, preview, approval) | §4, §6, §12 |
| Authority rules (706) and audit (707) | §7, §10 |
| Reuse decision against RT-281 | §9 |
| Open questions listed | §11 |
| No code, OpenAPI or migration | this PR touches `specs/041-*` and `specs/042-*` only |

## 14. Next items this unblocks

PR-04 (contract) takes §3, §4, §6, §12. PR-05 adds the change-set tables next to spec 041's. PR-10 implements this plan
after PR-09 and an RT-284 interim (or the §7 setting).
