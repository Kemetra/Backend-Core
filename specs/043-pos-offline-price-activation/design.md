# Spec 043 — Offline scheduled-price activation on POS (Pricing Gate 4 design)

| | |
|---|---|
| **Jira** | RT-487 (RT-282 PR-G4, Pricing Planning Gate 4). Builds on RT-483 / spec 041 and RT-484 / spec 042 |
| **Work Mode** | Planning. This folder is the deliverable. No code, OpenAPI or migration |
| **Repositories** | Primary `Kemetra/Backend-Core`. `Kemetra/POS` was **read only** (coordinator authorization under the owner's standing delegation, recorded on RT-487) |
| **Baselines** | Backend-Core `origin/main` @ `c6635b89` (2026-10-18). POS `origin/main` @ `70972209` (read-only clone) |
| **Decisions honoured** | Confluence RETAIL 23855106: 510, 528–529, 602–611 (cart lock, boundary only), 618–630, 631–640 (readiness, boundary only), 637–638. RT-284 ratified P-E / P-F (offline modes) |
| **Decision record** | [decision-record.md](decision-record.md) — G4-1 to G4-14 |
| **Status** | PLANNED. Decisions selected under the owner's standing delegation; the owner may revisit. Ratifying this item meets **G4a** (RT-282 §2). Runtime closure (**G4b**) is PR-V2 |

## 1. Objective

Define, on paper, how a POS terminal applies Retail Pricing **offline**, trustworthily and coherently:

1. **Trusted time** on a device whose clock cannot be trusted (622).
2. **Coherent revision apply**: whole store revisions, atomic, never mixed (628).
3. **Pre-delivery** of future prices, activated offline at the right instant per Store (621, 510, 637).
4. **Staleness**: configurable maximum, visible stale state, POS behaviour when stale (624–626).
5. **Critical corrections**: a short TTL or online-only behaviour, and an emergency fix overriding scheduled prices (627, 638).
6. **Failed apply** leaves the previous revision active and identifiable (629).
7. **Sale snapshot**: what the sale freezes, consistent with PR-07 (630).
8. The **additive contract changes** for the later `[GATED]` items, the **test plan** and the **implementation slices** per repo.

## 2. What exists today

### 2.1 Backend-Core (`c6635b89`)

| # | Fact | Evidence |
|---|---|---|
| B1 | Catalogue read-down is `GET /api/pos/v1/catalog/snapshot` (paged, one consistent cursor) and `…/deltas` (since-cursor, `snapshot_required` 409). Device-bearer auth; tenant and store come from the device row. No pricing revision, no future-dated rows, no server time. | `packages/contracts/openapi/catalog/read-down.yaml:1-140` |
| B2 | The snapshot cursor is the head of `catalog_change_log.sequence`. Sellable = active AND priced AND currency AND representable: a product without a current price is **absent** from the stream. | `apps/api/src/catalog/read-down/read-down.service.ts:21-22,139-161`; contract description |
| B3 | Precedent for a server time on a POS response: `server_time` on cashier admission; POS computes expiry from its own receipt time and clamps the server's `offline_grace_seconds` to a local 72 h ceiling. | `packages/contracts/openapi/pos-cashier-admissions.openapi.yaml:57-62,527-551` |
| B4 | Spec 041 gives the bitemporal resolver `resolve(item, sellUnit, store, instant, asOfRevision)`, `time_basis` (`store_local` / `absolute`) converted per Store, the Store applied revision (sparse, monotonic, `max(revision_no)` of `pricing_revision_stores`), the new-Store bootstrap row, and `earliest_effective_at` (UTC+14 lower bound, **only** the G4 pre-delivery horizon). | spec 041 §4.1–4.3; data-model §2.5–2.6 |
| B5 | Spec 042: publish happens **now** with a future effective time (Q-B4); publish is atomic under a per-tenant lock that Store lifecycle **and time-zone** writes also take; the emergency path skips lead time and the second approver but never validation, preview or audit, and defers critical-correction TTL to RT-487. | spec 042 §3, §7, §8, Q-B4 |
| B6 | RT-284 (ratified 2026-10-15, P-F): offline modes `allow_cached` / `deny_if_stale` / `online_only`; staleness = `trusted_now − bundle_received_at` using the POS trusted-clock floor; a clock rollback counts as stale; POS clamps server values to local ceilings; delivery is a device **policy bundle** (not the catalogue read-down). The bundle runtime (PE-BC4 / PE-POS1) is not built. | RT-284 comments (planning record + owner ratification) |

### 2.2 POS (`70972209`, read only)

| # | Fact | Evidence |
|---|---|---|
| P1 | POS calls **only** the catalogue snapshot (deltas deferred by spec 010). It walks all pages, requires the same cursor on every page, and fails the whole fetch on any bad page. | `src/main/catalogue/read-down/read-down-client.ts:56-64,206-280`; `specs/010-…/spec.md:38` |
| P2 | Cadence: one tick at start, then **hourly**, plus a manual refresh. No backoff and no online detection. | `src/main/index.ts:1625-1636`; `read-down-driver.ts:414-436` |
| P3 | Apply = stage, then **one better-sqlite3 transaction** that deletes live rows, copies staging, clears staging and records success. A throw rolls back and keeps the previous catalogue. | `src/main/catalogue/read-down/read-down-writer.ts:245-298` |
| P4 | `catalogue_sync_state` holds `last_success_at`, `source_snapshot_id`, `last_attempt_at`, `last_outcome`. There is **no staleness threshold or policy**; the UI shows the last success time only. | `migrations/0033_create_catalogue_sync_state.sql`; `src/main/catalogue/catalogue-bridge.ts:210-228` |
| P5 | `products.price_minor` (integer minor units), **no currency column**, no effective dates. The price is frozen on the cart line at scan; park/resume shows an explicit repricing diff that the cashier accepts. | `migrations/0029_create_products.sql`; `src/main/catalogue/resolve-item-ref.ts:62-80`; `src/main/cart/park/resume-diff.ts:85-121` |
| P6 | Response validation is a hand-written check of **required fields only**; extra fields are tolerated (no zod/ajv). The contract pin (`contracts/backend-core/PIN`) is checked by blob SHA, so any contract bump the POS adopts needs a re-pin. | `read-down-client.ts:97-113,176-201`; `contracts/backend-core/PIN` |
| P7 | Trusted-clock machinery exists for offline cashier grants: a sealed wall-clock **high-water mark** that only rises, written every 60 s; offline admission refused as `clock_suspect` when `now < hwm − 5 min`. `performance.now()` anchors other deadlines. | `src/main/operator/offline-grant-store.ts:30-68,643-686`; `offline-grant-wiring.ts:66`; `cashier-admission.ts:86-95` |
| P8 | The POS store zone is a **build constant** (`Africa/Cairo`), deliberately not read from settings or the OS. | `src/shared/time/business-day.ts:1-13` |
| P9 | Sale capture lines carry no pricing provenance, cursor or revision. | `src/main/sales-sync/create-sale-sync-client.ts:236-268` |

Everything in this design is therefore greenfield on both sides, except the apply pattern (P3) and the clock high-water mark (P7), which it reuses.

## 3. Design overview

```
 Backend-Core                                             POS (offline-capable)
 ───────────                                              ─────────────────────
 publish (042) ─► revision R fans out to Stores (041 §2.6)
                         │
 GET  /pricing/manifest  │  {storeRevision, timeBasisEpoch, serverTime,      ──►  trusted clock re-anchors
      (ETag, cheap)      │   contentHash, freshness policy, urgent, …}            (serverTime + monotonic)
 GET  /pricing/snapshot  │  all entries at exactly (R, epoch), paged          ──►  stage → verify count+hash
      ?revision=R        │  each entry = timeline segments with ABSOLUTE           → ONE transaction promote
                         │  per-Store instants + provenance                        (previous kept on failure)
 POST /pricing/acks      ◄──────────────────────────── received / applied / failed (R, epoch)
                                                          scan: segment where from ≤ t_lo < to
 PR-12 Pricing Health ◄── acks + earliest_effective_at       staleness: t_hi − lastCheck vs maxStaleness
 sale sync (PR-07)    ◄── line provenance + sale pricingContext (revision, stale, clockState)
```

Four ideas carry the design:

1. **The server does all time-zone work.** Every segment the POS receives has absolute UTC bounds for *that* Store (G4-1). POS compares instants; it never converts zones (P8 makes that the only safe choice).
2. **A store revision is applied whole or not at all.** The pricing projection is a separate stream from the catalogue, identified by `(storeRevision, timeBasisEpoch)`, verified by a content hash, and promoted in one SQLite transaction (G4-2, G4-3).
3. **Activation is evaluation, not a job.** Future segments are already on the device. At each scan the POS picks the segment that contains a *trusted lower bound* of now. Nothing has to "run" at midnight, so nothing can fail to run (G4-5).
4. **Time is bounded in both directions.** Activation uses a lower bound of trusted time (late-biased, never early). Staleness uses an upper bound (early-biased, never hidden). A clock that cannot be trusted makes pricing *stale*, never silently *fresh* (G4-6, G4-7).

## 4. Trusted time on the terminal (622)

### 4.1 Clock model

POS keeps one **pricing clock** service in the main process. It reuses and generalises the P7 high-water mark machinery, but splits it into **two sealed marks** so that untrusted time can never become trusted (G4-5).

| Input | Source | Trust |
|---|---|---|
| `anchor = (serverTime, mono_at_receipt, wall_at_receipt)` | `serverTime` on every pricing manifest response (and any other BC response that carries one, e.g. cashier admission `server_time`). Accepted only when the request's round trip is ≤ 5 s; the anchor error is then ≤ RTT. | trusted while the process lives |
| `mono` | `performance.now()` / `process.hrtime` | monotonic within one process; **reset by restart**; may or may not advance across OS suspend, so it is never assumed to |
| `wall` | `Date.now()` | untrusted |
| `hwm_trusted` | sealed mark raised **only from `t_anch`** (anchored time), every 60 s, at every apply and at every sale while `anchored` | trusted floor; only rises; never fed by the wall clock |
| `wall_seen` | sealed mark raised from `wall` every 60 s and at every sale, in any state | **rollback detector only**; never used as a time value for activation |

Derived values:

- **Anchored estimate** (same process, anchor present): `t_anch = serverTime + (mono_now − mono_at_receipt)`.
- **Drift** = `(wall_now − t_anch) − (wall_at_receipt − serverTime)`, the change of the wall-minus-server offset since the anchor.
- **Lower bound `t_lo`** (used for **activation**):
  - `anchored`: `max(hwm_trusted, t_anch)`;
  - `unverified` (no anchor since process start or OS resume): `max(hwm_trusted, min(wall_now, hwm_trusted + maxStaleness))`. Untrusted time can advance activation at most `maxStaleness` past the last trusted instant; beyond that the device is stale anyway (§7);
  - `suspect`: frozen at the `t_lo` it had when it became suspect (§4.2).
- **Upper bound `t_hi`** (used for **staleness**): `max(t_lo, wall_now)`. A forward-set wall clock can only make pricing look *older*, never fresher.

Within `anchored`, `t_lo` never decreases. A re-anchor after `unverified` can move `t_lo` **back** to true time if the wall clock had been ahead; that is a correction of untrusted time, not a rollback, and it is recorded (§4.3). Because `hwm_trusted` is only ever fed by anchored time, a forward-set clock cannot poison the floor that later trusted time is compared against.

### 4.2 Clock states

| State | Entered when | Activation | Staleness |
|---|---|---|---|
| `anchored` | an anchor was taken in this process and `|drift| ≤ 120 s` | by `t_lo` | by `t_hi` |
| `unverified` | after a restart or an OS resume (see "OS suspend" below), before the next anchor, with `wall ≥ hwm_trusted − 5 min` and `wall ≥ wall_seen − 5 min` | by `t_lo` (bounded, §4.1) | by `t_hi`; lines record `clockState = unverified` |
| `suspect` | `wall < hwm_trusted − 5 min` or `wall < wall_seen − 5 min` (rollback, the P7 rule), **or** `|drift| > 120 s` in this process with no resume event (the wall clock moved against the monotonic clock) | **frozen**: no further activation | **treated as stale** whatever the age (RT-284 P-F: "a clock rollback counts as stale") |

Leaving `suspect` or `unverified` needs a fresh anchor (a successful manifest check). At every re-anchor, POS compares the untrusted time it used with the server's:

- if `wall_seen > t_anch + 120 s`, the device's clock **ran ahead** while untrusted. POS records a **clock incident** `{ kind: ran_ahead, byMs: wall_seen − t_anch, from: first unverified instant, to: t_anch }`, resets `wall_seen` to `wall_now`, and reports it on the next ack (§9.2);
- a rollback seen while offline (`suspect` from `wall_seen`) is likewise recorded as `{ kind: rolled_back, … }`.

**OS suspend.** Whether the monotonic clock advances across sleep depends on the platform, so the design does not rely on it. On Electron's `powerMonitor` `resume` event, POS **drops the anchor** and moves to `unverified`, exactly as after a restart. A store PC that sleeps overnight offline therefore activates the morning's scheduled prices from its wall clock (within the §4.1 bound), rather than freezing in `suspect`. A drift seen *without* a resume event is still `suspect`.

The 120 s drift budget matches the existing future-dating tolerance on the void approval path (RT-530) and is a constant on POS, not server policy. The 5 min rollback tolerance is the existing P7 constant.

### 4.3 What the clock does not protect against (stated residual risk)

- **Forward tampering while unverified.** After a restart with no network, the POS cannot tell a correct wall clock from one set forward. A forward-set clock activates future segments early. Bounds and evidence:
  - activation can run ahead of the last trusted instant by at most `maxStaleness` (§4.1), and staleness uses `t_hi`, so under `deny_if_stale` the device stops selling at cached prices at the same point;
  - every line records `clockState = unverified` and its `pricedAt` (§9.1);
  - **detection is through clock incidents, not the sale's own times.** If the device re-anchors while its clock is still ahead, the `ran_ahead` incident (with its interval and size) reaches BC on the next ack, and BC re-checks that device's `unverified` lines in the interval (§9.3). If someone sets the clock back before reconnecting, `wall_seen` turns that into a `rolled_back` incident, which is reported the same way;
  - **undetectable case, stated plainly:** a device that stays offline, with its clock ahead, until real time overtakes the forged time leaves no discrepancy at re-anchor, and its sales look like ordinary `unverified` sales. Its exposure is bounded only by the `maxStaleness` limit above. A tenant that cannot accept this uses `deny_if_stale` with a short `maxStaleness`;
  - `hwm_trusted` and `wall_seen` prevent the reverse attack (rolling back to keep an old price).
- **Same-Windows-user edits of the sealed marks** are the accepted P7 residual risk (OD11); unchanged here.
- **No signed manifest in v1** (RT-284 Q7 precedent): integrity is TLS, sealed local state, a monotonic `(revision, epoch)` that rejects downgrades, the content hash, and server revalidation on sync.

## 5. Coherent revision apply (628, 629)

### 5.1 What a "store revision" is on the wire

The unit POS applies is the **store pricing projection at `(storeRevision, timeBasisEpoch)`**:

- `storeRevision` = the Store's applied revision of spec 041 data-model §2.6 (`max(revision_no)` over its fan-out rows, including the bootstrap row).
- `timeBasisEpoch` = a per-Store integer that Backend-Core increments when the Store's time zone changes (G4-3). A zone change creates no pricing revision (spec 042 Q-B8), but it moves every `store_local` instant the device already holds, so the device must re-apply.
- Order is lexicographic on `(storeRevision, timeBasisEpoch)`. Both only rise. A manifest or snapshot with a lower pair than the one applied is a **downgrade** and is refused (logged, not applied).

The projection is a pure function of `(store, storeRevision, timeBasisEpoch)`: for every `(product, sellUnit)` that has any segment ending after the generation instant, the **ordered, non-overlapping timeline segments** that the resolver (spec 041 §4) returns at `asOfRevision = storeRevision`, with absolute bounds for that Store. The only time-dependent part is trimming segments that have already ended, which does not change what a device would select.

### 5.2 Why a separate stream from the catalogue (G4-2)

The catalogue read-down's coherence unit is the global `catalog_change_log.sequence` (B2). A pricing revision is a different unit: one publish can touch every product of hundreds of Stores, and its coherence boundary is the revision, not a change-log position. Folding pricing into catalogue rows would force either a change-log row per product per Store per revision, or a composite cursor that both streams must respect page by page. A sibling stream keyed by store revision is simpler and leaves spec 010 untouched.

Consequences:

- **Sellability post-cutover** (G4-12). Today a product without a current price is absent from the catalogue stream (B2). That would drop a product that has only a *future* price, so it could never be pre-delivered. When a tenant's pricing authority is `pricing` (RT-485 / PR-16b cutover), the catalogue stream must include active products **regardless of current price**, and the POS decides sellability as *catalogue active AND a segment of the applied pricing projection contains `t_lo`*. Before cutover, nothing changes: POS keeps the catalogue row price (legacy), as today.
- **Single price source at the till.** The manifest says `authority: legacy | pricing` for the tenant. Under `pricing`, the POS ignores the catalogue row price for selling (it may show it in diagnostics). Under `legacy`, the POS does not consume the pricing snapshot. There is never a mix within one device at one time.

### 5.3 Fetch and apply on POS

1. **Check.** `GET /pricing/manifest` with `If-None-Match`. A `304` is still a successful **check** (it refreshes freshness, §7.1, and re-anchors the clock).
2. **Fetch.** If the manifest pair is higher than the applied pair, page `GET /pricing/snapshot?revision=R&epoch=E` to the end. Every page must echo the same `(R, E)` (the P1 rule, reused). Any bad page fails the fetch.
3. **Stage** into `pricing_segments_staging` (one transaction).
4. **Verify** before promote: `entryCount` and `contentHash` from the final page and the manifest match the staged rows (canonical hash: rows sorted by `productId, sellUnit, from`, fields in a fixed order, decimals as the wire strings). Every segment has `currencyCode` equal to the Book currency, a representable amount, `from < to` when `to` is set, and no overlap within a key.
5. **Promote** in **one** better-sqlite3 transaction: delete live segments for the tenant, copy staging, clear staging, write `pricing_sync_state` (applied pair, hash, `applied_at_t_lo`, clear the failure fields). This is the P3 pattern.
6. **Ack** `applied (R, E)` (§9.2). An ack that cannot be sent is queued; it never blocks selling.

A cart that is open during a promote is untouched: its lines are frozen (602–603, P5). The next scan reads the new projection. Promote runs between scans, never inside a scan's read.

**Deltas.** v1 POS uses the snapshot only, like P1. The contract reserves `GET /pricing/deltas?fromRevision&fromEpoch` (a whole-revision diff pinned to a target pair, with `snapshot_required` on a gap or an epoch change); a POS that adopts it later must still verify the full-projection hash after merging in staging, so the apply stays whole-revision.

### 5.4 Failed apply (629)

| Failure | POS outcome |
|---|---|
| transport / 5xx / timeout | nothing staged or promoted; previous pair stays applied; retry with backoff (30 s, 60 s, 2 min, 5 min cap) |
| page mismatch, malformed row, validation failure, hash or count mismatch | staging cleared; previous pair stays applied; `pricing_sync_state.last_failed_pair`, `last_failure_code` (closed set: `transport`, `page_inconsistent`, `malformed`, `invalid_segment`, `hash_mismatch`, `downgrade`, `storage`), `last_failed_at`; ack `failed` with the code |
| promote transaction throws | rolled back by SQLite; same as above with `storage` |
| three consecutive failures for the same pair | the next attempt re-fetches from page 1 with a fresh manifest (no partial reuse) |

"Identifiable" means: the applied pair is shown in catalogue/pricing diagnostics and on the stale banner; it is stamped on every sale (§9.1); and BC holds it per device from the acks (PR-05 table, §10.3). A device is never in an "unknown revision" state: before the first successful apply it is `never_applied`, which under `pricing` authority means nothing is sellable (480, 506: missing price means not sellable).

## 6. Pre-delivery and offline activation (510, 621, 637)

### 6.1 What is delivered

The snapshot carries the **whole future timeline** for each key, not a window (G4-4). Publishing is always "now" with a future effective time (spec 042 Q-B4), so a scheduled change reaches every Store's projection as soon as its revision is published, and POS receives it at its next successful check.

Size guard: the snapshot is paged like the catalogue, and the number of future segments per key is bounded by authoring (one active event per key and scope per instant, spec 041 §5). Should a tenant author an unusually long schedule, BC logs a size metric; a delivery window is a later optimisation, not v1.

### 6.2 Segment shape and instants

Each entry is `(productId, sellUnit)` with an ordered list of segments `{ from, to | null, amount, currencyCode, taxPriceBasis, provenance, offlinePolicy? }`:

- `from` / `to` are **absolute instants for this Store**. For a `store_local` event, BC converts the local bound with the Store's zone and the spec 041 DST rules (gap → first valid instant after; overlap → earlier occurrence). For `absolute` events, they are passed through.
- A gap with no price is **not** a segment; POS treats "no segment contains `t_lo`" as not sellable.
- `provenance` is the `origin: "pricing"` union variant of spec 041 §4.4, with `pricingRevision` = the **store revision the projection was resolved at** (`asOfRevision`), so `resolve(item, store, instant, pricingRevision)` reproduces the POS's belief (G4-11).

### 6.3 Activation rule

At scan (and at any price display):

```
segment = the one segment of (product, sellUnit) with from ≤ t_lo < (to ?? +∞)
```

- No job, timer or write is involved. Activation happens at the first scan whose `t_lo` crosses `from`.
- While `anchored`, `t_lo` never decreases (it is floored by `hwm_trusted`), so a segment in effect cannot revert through clock changes. The only backward move is the §4.1 correction of untrusted time at re-anchor, which is recorded as a clock incident.
- The boundary is inclusive at `from`, exclusive at `to`, the same as the resolver.
- A line scanned before the boundary keeps its frozen price (603). Lines scanned after it use the new price. A park/resume after the boundary uses the existing resume diff (P5), which now compares against the segment at `t_lo`.
- Held-cart Price Lock TTL and business-day revalidation (605–607) are cart decisions, not G4. They read the same `t_lo`.

### 6.4 The pre-delivery deadline (`earliest_effective_at`)

A revision's `earliest_effective_at` (data-model §2.5) is the conservative earliest instant it can change any price. It is used for exactly two things (G4-4):

1. **Health.** For each Store in the revision's fan-out, BC computes the exact first activation instant for that Store at read time (spec 042 §3 display rule). A device that has not acked `applied` for the revision (or a later pair) by that instant raises **`missed_pre_delivery`** (634). Pricing Health shows a **`pre_delivery_at_risk`** warning from `earliest_effective_at − pricing.preDeliveryWarnLead` (tenant setting, default 2 h).
2. **Urgency.** A revision whose `earliest_effective_at ≤ publish time + manifest poll interval` is flagged `urgent` on the manifest, so an online POS fetches it before its next scan rather than at its next idle moment.

It is never used to compute a POS activation instant.

### 6.5 Store time-zone change after pre-delivery

The zone change takes the pricing publish lock (spec 042 §8), increments `timeBasisEpoch` for that Store, and BC flags the manifest `urgent`. Devices re-apply the projection with re-converted instants. A device that misses it while offline keeps the old instants; this is the same exposure as missing a revision, it is visible in Health (`missed_pre_delivery` if an instant moved earlier), and spec 038 already blocks a zone change during an open shift.

## 7. Staleness (624–626)

### 7.1 Definition

```
age = t_hi − lastCheckAt_lo
stale ⇔ age > maxStaleness  OR  clockState = suspect  OR  never_applied
```

- `lastCheckAt_lo` is the `t_lo` at the last **successful check**: a manifest `200` that led to a successful apply, or a `304` / an unchanged pair, while the applied pair equals the manifest pair. A fetch that fails does **not** refresh it; the device is then running a known-older revision. A check that finds a newer pair it cannot apply does not refresh it either.
- Using `t_lo` for the check and `t_hi` for now makes `age` an upper bound.

### 7.2 Policy

Freshness is policy (624) and configurable (626). The values, per tenant with an optional Store override:

| Key | Meaning | v1 default |
|---|---|---|
| `offlineMode` | `allow_cached` \| `deny_if_stale` \| `online_only` (RT-284 P-F semantics) | `allow_cached` (G4-7) |
| `maxStalenessSeconds` | the stale threshold | 86 400 (24 h) |
| `warnAfterSeconds` | visible "pricing ageing" indicator before stale | 43 200 (12 h) |
| `onlineWindowSeconds` | how recent a successful check must be to count as "online" for `online_only` | 120 |
| `pollIntervalSeconds` | manifest check cadence while online | 300 (min 60) |

POS **clamps**: `maxStalenessSeconds ≤ 72 h` (the existing P7 ceiling), `onlineWindowSeconds ≤ 600`, `pollIntervalSeconds ∈ [60, 3600]`. A value outside the clamp is clamped, never rejected.

**Delivery (G4-8).** Until the RT-284 device policy bundle exists (PE-BC4 / PE-POS1), these values travel on the **pricing manifest** as `freshness { …, policySource, policyRevisionId }`, the spec 040 interim pattern. RT-284 P-F rejected carrying *policy* on the **catalogue** read-down; the pricing manifest is a pricing surface and carries only pricing freshness. When the bundle ships, the bundle becomes the source, `policySource` says so, and the manifest field is removed in a later contract version. Never-fetched POS (no manifest yet): defaults above, clamped.

### 7.3 POS behaviour

| Mode | Fresh | Ageing (`age > warnAfter`) | Stale |
|---|---|---|---|
| `allow_cached` | normal | non-blocking "prices last checked N h ago" indicator on the sale screen | persistent **stale banner** on the sale screen and the receipt preview; selling continues at the cached projection; every line and the sale record `stale = true` |
| `deny_if_stale` | normal | indicator | items cannot be added at a cached price: scan shows "pricing out of date — reconnect"; lines already in the cart stay (they were priced while fresh) and the sale can complete; a manager override is **not** offered in v1 |
| `online_only` | allowed only while `now − lastCheckAt ≤ onlineWindow` | — | items cannot be added; same message |

Stale is **never hidden** (625): the banner cannot be dismissed while the condition holds, the diagnostics screen shows the applied pair, `lastCheckAt`, `clockState`, the mode and the last failure, and BC's Pricing Health shows the device as stale from its acks (§10.3).

While online, a stale device is just one that cannot reach BC; the driver checks immediately on reconnect, on app start, on a manual refresh, and every `pollIntervalSeconds`.

## 8. Critical corrections (627, 638)

### 8.1 Model

- A Change Set of `kind = emergency` (spec 042 §7) may be marked **`critical = true`**. It needs the `pricing.emergency` capability. `critical` is recorded on the revision (`pricing_revisions.critical`, new column, G4-9).
- A critical revision **supersedes scheduled events like any revision** (spec 041 §3.1): a bad future price is ended or replaced, and the next projection simply no longer contains it. Pre-delivered segments are never patched on the device; the whole projection is replaced (§5).
- Each line of a critical set may carry an **`offlinePolicy`** override for the key: `{ mode: deny_if_stale | online_only, maxStalenessSeconds?, until }` with `until` required (default `activation + 72 h`, max 30 days). The override travels on the affected segments and applies only to them. It is how a tenant says "for this item, do not sell from an old cache for a while" (shorter TTL or online-only, 627).

### 8.2 Behaviour

| Device situation | What happens |
|---|---|
| online, idle | manifest shows `urgent: true` and the new pair; POS fetches and applies before the next scan |
| online, cart open | applied between scans. Lines already in the cart whose key is in the critical revision are **flagged**; before tender the cashier sees old / new / difference for each and must accept (608); declining removes the line. A completed sale is never repriced (611) |
| offline, already applied the critical revision | the per-line `offlinePolicy` applies to those keys until `until` |
| offline, has **not** received it | nothing can reach it. It sells at its cached projection, visibly stale once past `maxStaleness`. On reconnect: the critical revision applies first; BC raises a **`critical_not_applied`** Health finding from the publish onward for every device without an `applied` ack, and the sale revalidation (§9.3) lists the sales captured on older pairs after the correction's activation instant as **`sold_before_correction`** findings for follow-up. Sales are never rewritten (611) |

What bounds the last row is the tenant's choice of `offlineMode` / `maxStaleness`: a tenant that cannot accept hours of exposure after an emergency fix chooses `deny_if_stale` with a short `maxStaleness`. That trade-off is the owner's, and it is explicit in the setting.

## 9. Sale snapshot and server revalidation (630)

### 9.1 What a sale line freezes (consistent with PR-07)

On the line (PR-07's `pricingProvenance` union, unchanged in shape):

- `origin: "pricing"`: `sourceScope`, `priceEventId`, `priceKind`, `pricingRevision` (= the store revision the POS applied, §6.2);
- `origin: "legacy"`: `sourceScope` (`legacy_tenant | legacy_store`), `catalogCursor`.

POS stores the segment's provenance **verbatim** and sends it unchanged; it never recomputes it.

Next to the union, each line also freezes a **`pricingCapture`** object. It is a sibling optional field, not part of the union, so PR-06 and PR-07 still share one union shape:

```jsonc
"pricingCapture": {
  "pricedAt": "2026-11-01T07:02:11Z",  // the t_lo used to select the segment (§6.3)
  "timeBasisEpoch": 3,                 // the epoch of the projection the segment came from
  "stale": false,                      // §7.1, evaluated when this line was priced
  "clockState": "anchored"             // anchored | unverified | suspect, when this line was priced
}
```

Freezing these **per line** matters because they can change inside one open cart: a line can be added after the staleness threshold is crossed, after the clock turns `suspect`, or after a mid-cart apply of a new revision or epoch. `pricedAt` and `timeBasisEpoch` let revalidation (§9.3) evaluate exactly what the device evaluated.

On the **sale** (one object per sale, additive to PR-07, G4-11), an **aggregate** of its lines plus the device's freshness settings:

```jsonc
"pricingContext": {
  "appliedRevision": 418,          // highest pricingRevision among the lines; null under legacy authority
  "stale": true,                   // true if ANY line was priced stale
  "clockState": "unverified",      // the worst line state: suspect > unverified > anchored
  "offlineMode": "allow_cached",
  "lastPricingCheckAt": "2026-11-01T06:58:10Z"   // t_lo of the last successful check when the sale was finalized
}
```

A sale that started fresh and later added a stale line therefore reports `stale = true`, and the stale line is identifiable. A line added after a mid-cart apply carries the newer `pricingRevision` in its own provenance and the newer epoch in its `pricingCapture`, so the mix is explicit, not hidden.

### 9.2 Acks

`POST /api/pos/v1/pricing/acks` (device bearer, idempotent on `(device, pair, status)`): `{ status: received | applied | failed, storeRevision, timeBasisEpoch, failureCode?, deviceAppliedAt (t_lo), clockState, clockIncidents?: [{ kind: ran_ahead | rolled_back, byMs, from, to }] }`. BC persists the latest per status per device (PR-05 table) and every clock incident (`pricing_device_clock_incidents`). An ack is evidence for Health; BC never trusts it for authority. An incident is resent until an ack carrying it succeeds.

### 9.3 Revalidation on sale sync

When a sale arrives, BC (asynchronously, never on the capture path) recomputes, for each line, `resolve(item, sellUnit, store, pricedAt, pricingRevision)` **using the Store time zone that was in force at the line's `timeBasisEpoch`** (from the epoch history, §10.3), not the Store's current zone. It compares the result with the line's unit price and provenance:

- equal → nothing;
- different → `price_mismatch` finding (tampered projection or POS defect). Because the epoch's zone is used, a time-zone change between capture and sync does not cause a false mismatch;
- `pricedAt` is after a critical revision's first activation instant for that Store and the line's `pricingRevision` is older → `sold_before_correction`;
- **early activation**, judged from evidence tied to trusted time, not from the sale's own clock:
  - the line is `unverified` or `suspect` and falls inside a reported **clock incident** interval of that device: BC shifts `pricedAt` back by the incident's `byMs` and re-resolves. A different segment → `early_activation`. A `ran_ahead` incident that arrives *after* the sale is matched retroactively when it arrives;
  - the selected segment's `from` is later than BC's receive time of the sale → `early_activation` (the price was not in effect even when BC received it);
  - `pricedAt` later than the receive time + 120 s → `device_clock_ahead`.

A forward-clock sale that leaves none of this evidence is the undetectable case stated in §4.3. Revalidation does not claim to catch it.

Findings feed Pricing Health (PR-12). Capture never fails because of them, and sale facts are never changed (611, 612–617).

## 10. Proposed contract and schema additions (not made here)

All are **additive** and belong to later `[GATED]` items. OD-6 evidence: POS validates read-down responses leniently at runtime (P6) but pins contract blobs, so each bump the POS adopts needs a POS re-pin in the same rollout.

### 10.1 PR-06 `[GATED OpenAPI]` — new `pos-pricing` document (device bearer)

| Operation | Shape (draft) |
|---|---|
| `GET /api/pos/v1/pricing/manifest` | `ETag` over `(storeRevision, timeBasisEpoch, authority, freshness.policyRevisionId)`; `If-None-Match` → 304 with `serverTime` header echo. Body: `authority` (`legacy`\|`pricing`), `storeRevision` (int64 \| null), `timeBasisEpoch` (int), `serverTime` (date-time), `contentHash` (string), `entryCount` (int), `urgent` (bool), `criticalRevisions` (int64[] published since the device's last applied pair; empty when none), `freshness` {`offlineMode`, `maxStalenessSeconds`, `warnAfterSeconds`, `onlineWindowSeconds`, `pollIntervalSeconds`, `policySource`, `policyRevisionId`} |
| `GET /api/pos/v1/pricing/snapshot?revision&epoch&page_token&limit` | pages of `PricingEntry { productId, sellUnit, segments: PricingSegment[] }`; every page echoes `storeRevision`, `timeBasisEpoch`, `serverTime`; the final page carries `contentHash`, `entryCount`. A pair that is no longer current → 409 `pricing_revision_superseded` (the device re-reads the manifest) |
| `PricingSegment` | `{ from, to \| null, amount (decimal string), currencyCode, taxPriceBasis, provenance (PR-07 union), offlinePolicy? {mode, maxStalenessSeconds?, until} }` |
| `GET /api/pos/v1/pricing/deltas?fromRevision&fromEpoch` | reserved (§5.3); `snapshot_required` 409 on gap or epoch change |
| `POST /api/pos/v1/pricing/acks` | §9.2 (including `clockIncidents`); 202; idempotent |
| `serverTime` | also on every pricing response header (`X-Server-Time`) |

Error vocabulary: the read-down `Error` envelope plus `pricing_revision_superseded`. Scope comes from the device row only; a foreign revision or epoch is refused non-disclosingly (§II, §XII).

Also in PR-06 (Console-facing, moved there by RT-282): the **distribution-status** and **Pricing Health** read models with these per-device states: `never_applied`, `pending` (a newer pair exists), `received`, `applied`, `failed` (+code), `stale` (from last check age on BC's side), `clock_suspect`, `missed_pre_delivery`, `critical_not_applied`; plus sale findings `price_mismatch`, `sold_before_correction`, `early_activation`, `device_clock_ahead`.

### 10.2 Other contract additions

| Item | Addition |
|---|---|
| PR-07 `[GATED]` sales | line-level `pricingCapture` and sale-level aggregate `pricingContext` (§9.1), optional and additive, frozen on capture. The line union is unchanged |
| PR-11 / PR-16b catalogue read-down | under `pricing` authority the snapshot includes active products **without** a current price (§5.2). Rows keep `price` as a compatibility field. Legacy rows gain the `origin: "legacy"` provenance (already planned in PR-11) |
| PR-04 change-set contract (spec 042) | `critical` on emergency sets; per-line `offlinePolicy` |
| Tenant settings (interim, retired into RT-284) | `pricing.offline` (the §7.2 values) and `pricing.preDeliveryWarnLead` |

### 10.3 PR-05 `[GATED migration]` — revision-state shape (the G4a-gated second migration)

- `pricing_device_revision_state` (RLS by tenant): `tenant_id`, `store_id`, `device_id` (FK `devices`), `last_received_revision`, `last_received_epoch`, `last_received_at`, `last_applied_revision`, `last_applied_epoch`, `device_applied_at`, `last_applied_ack_at`, `last_failed_revision`, `last_failed_epoch`, `last_failure_code`, `last_failed_at`, `last_clock_state`, `last_check_at` (server time of the latest manifest read by this device). PK `(tenant_id, device_id)`.
- Store-level state is **derived** from it (worst device), not stored.
- `store_pricing_time_basis_epochs` (`tenant_id`, `store_id`, `epoch`, `timezone`, `started_at`; PK `(tenant_id, store_id, epoch)`; insert-only): the current epoch is the highest row. A row is inserted under the pricing publish lock on a zone change, and at Store creation (epoch 0). It is the zone history that revalidation needs (§9.3), so it also answers spec 041 Q-3 for pricing revalidation, though not for general historical inquiry.
- `pricing_device_clock_incidents` (RLS by tenant): `tenant_id`, `device_id`, `kind`, `by_ms`, `from_at`, `to_at`, `reported_at`; unique on `(device_id, kind, from_at)` so a resent incident is idempotent.
- `pricing_revisions.critical boolean NOT NULL DEFAULT false`; per-line `offline_policy` jsonb on change-set lines and on the published events it produces.

### 10.4 POS `[GATED local migration]`

`pricing_segments`, `pricing_segments_staging` (both keyed `(tenant_id, product_id, sell_unit, from)`, amount as **decimal string** plus `currency_code`, unlike `products.price_minor`), `pricing_sync_state` (authority, applied pair, hash, `last_check_at_lo`, failure fields), the two sealed clock marks `hwm_trusted` and `wall_seen` (generalising `cashier_offline_clock_hwm`), and a local queue for acks and clock incidents.

## 11. Interactions

- **RT-485 (migration and cutover, planned in parallel).** The `authority` flag on the manifest is the POS side of RT-485's per-tenant switch (PR-16b). Three dependencies for RT-485 to note: (1) the cutover flips the catalogue sellable filter (§5.2) and the manifest `authority` **in the same transaction**; (2) the first `pricing` revision after `legacy_import` must be fanned out to every Store (bootstrap at head), so every device has a projection to apply before it can sell; (3) a rollback to `legacy` authority flips the manifest back, and POS returns to the catalogue row price at its next check. This design does not block on RT-485.
- **RT-284.** Offline modes, clamping and "rollback = stale" are RT-284 P-F. The freshness policy moves to the RT-284 bundle when it exists (G4-8). Per-line `offlinePolicy` would become a policy entry only if RT-284 later models per-object policy; until then it is pricing data.
- **RT-279 / spec 038.** The POS zone constant (P8) is irrelevant to pricing because BC sends absolute instants. Zone changes reach POS through `timeBasisEpoch`.
- **Cart decisions 602–611.** Frozen lines and explicit repricing are respected; held-cart TTL is out of scope.
- **PR-V2 (G4b).** Runs the §12.3 scenarios end-to-end on rt9.

## 12. Test plan

### 12.1 Backend-Core

| Layer | Tests |
|---|---|
| Contract (PR-06/07) | oasdiff additive-only; strict schemas; every 4xx in the envelope; example payloads validate |
| Projection (PR-11) | property: projection at `(R, E)` equals `resolve()` sampled at every segment boundary ± 1 ms; deterministic hash across row order; a revision outside a Store's fan-out leaves its projection and hash unchanged; Book event across two zones → two different absolute `from`s; DST gap and overlap (spec 041 Q-2); zone change → epoch + 1, instants move, hash changes; future-only product appears; paging consistent while a new revision is published mid-walk (`pricing_revision_superseded`) |
| Auth / isolation | device of store A cannot read store B's pair (non-disclosing 404); cross-tenant; revoked device 401 |
| Acks / state (PR-05/12) | idempotent replay; out-of-order acks keep the highest pair; `failed` keeps `applied`; health states incl. `missed_pre_delivery` at the exact per-Store instant and `critical_not_applied` |
| Revalidation | equal → none; tampered price → `price_mismatch`; older revision after critical activation → `sold_before_correction`; segment `from` after receive time → `early_activation`; `ran_ahead` incident covering an `unverified` line, before or after the sale arrives → `early_activation`; `pricedAt` ahead of receive time → `device_clock_ahead`; a time-zone change between capture and sync → no false `price_mismatch` (epoch history used); capture never fails |
| Publish lock | zone change vs publish race → either order yields a consistent `(R, E)` |

### 12.2 POS

| Area | Tests |
|---|---|
| Clock | matrix `{anchored, unverified, suspect} × {wall correct, forward 1 h, forward > maxStaleness, back 10 min, back 2 min, suspend 8 h}`: `t_lo` never decreases while anchored, activation never early in `anchored`, `unverified` activation capped at `hwm_trusted + maxStaleness`, `suspect` freezes activation and forces stale; `hwm_trusted` never raised from wall time (offline restart with clock +1 day, then re-anchor → correct activation and a `ran_ahead` incident); set-forward-then-back offline → `rolled_back` incident; anchor rejected when RTT > 5 s; both marks sealed and restored after restart |
| Apply | promote atomicity (throw inside the transaction keeps previous pair and rows); hash mismatch, count mismatch, page pair mismatch, downgrade → previous kept, ack `failed` with the code; never a mix of two pairs (rows of one pair only, checked after every failure injection) |
| Activation | boundary inclusive/exclusive at `from` ± 1 ms; a line scanned before the boundary keeps its price; resume diff after the boundary; gap → not sellable |
| Staleness | per mode × {fresh, ageing, stale, never applied, clock suspect}; 304 refreshes the check, a failed fetch does not; clamps |
| Critical | urgent fetch before next scan; open-cart flagged lines require explicit accept; per-line `offlinePolicy` until `until` |
| Sale | provenance verbatim; per-line `pricingCapture` frozen; a cart that turns stale or `suspect` mid-way has the later lines `stale` / `suspect` and the sale aggregate `stale = true`; mid-cart apply gives lines with two revisions or epochs, each explicit |
| Authority | `legacy` → catalogue price used, pricing snapshot not fetched; `pricing` → catalogue price ignored |

### 12.3 PR-V2 end-to-end (rt9, produces G4b)

1. Publish a scheduled change (store-local 00:00) a day ahead; device applies; disconnect; cross midnight offline; first scan after 00:00 shows the new price; sale carries the revision; Connector posts the exact rate; Health shows `applied`.
2. Same, but the device reboots offline before midnight (`unverified`): activation still at midnight; sale says `unverified`.
3. Wall clock rolled back 1 h offline → `suspect`: banner, stale, no activation change.
4. Stale scenarios for `allow_cached` and `deny_if_stale`.
5. Critical correction of a pre-delivered bad price: online device drops it; offline device sells it, then on reconnect applies the correction and BC lists `sold_before_correction`.
6. Failed apply (injected hash mismatch): previous revision kept and shown; Health `failed`.
7. Store zone change with a pending scheduled price: epoch bump; new instant used.

## 13. Implementation slices

Ratifying this design (G4a) unlocks these. `[GATED]` items need their own owner authorization.

### Backend-Core

| Slice | Content | Gate / depends on |
|---|---|---|
| **BC-G4-1** (part of PR-06) `[GATED OpenAPI]` | `pos-pricing` document (§10.1), distribution/health read models | G4a; PR-07 union; OD-6 re-pin note to POS |
| **BC-G4-2** (part of PR-07) `[GATED]` | line `pricingCapture`, sale `pricingContext` | with PR-07 |
| **BC-G4-3** (PR-05 second migration) `[GATED migration]` | §10.3 tables and columns | G4a; PR-05 core tables |
| **BC-G4-4** (part of PR-04/PR-10) | `critical` flag and per-line `offlinePolicy` in the change-set contract and publish | PR-04, PR-10 |
| **BC-G4-5** (PR-11) | projection builder, manifest, snapshot, hash, `serverTime`, acks endpoint; serves `authority: legacy` until cutover | BC-G4-1, BC-G4-3, PR-08 |
| **BC-G4-6** (PR-12) | Health: states and findings of §10.1, `missed_pre_delivery`, `critical_not_applied`, async sale revalidation | BC-G4-5, PR-07 runtime |
| **BC-G4-7** (PR-16b, with RT-485) | atomic flip of catalogue sellability and manifest authority per tenant | RT-485 cutover plan |
| **BC-G4-8** (with spec 038 path) | `timeBasisEpoch` increment under the publish lock on a zone change | BC-G4-3 |

### POS (`Kemetra/POS`, needs its own Jira authorization)

| Slice | Content | Depends on |
|---|---|---|
| **POS-G4-1** | pricing clock service: anchor, `t_lo` / `t_hi`, states, the two sealed marks (generalise P7), clock incidents | none (can start after G4a) |
| **POS-G4-2** `[GATED local migration]` | §10.4 tables | BC-G4-1 contract |
| **POS-G4-3** | manifest / snapshot client and driver (poll cadence, backoff, urgent), stage → verify → promote, acks queue, contract re-pin | POS-G4-1, POS-G4-2, BC-G4-5 |
| **POS-G4-4** | scan-time evaluation, sellability under `pricing` authority, mode enforcement, ageing/stale banner, diagnostics | POS-G4-3 |
| **POS-G4-5** (PR-P2) | line provenance verbatim + `pricingCapture` + sale `pricingContext`; critical flagged-line accept before tender | POS-G4-4, BC-G4-2 |

PR-V2 (§12.3) closes G4b once BC-G4-5…7 and POS-G4-1…5 are on rt9.

## 14. Acceptance-criteria trace (RT-487)

| RT-487 scope / AC | Where |
|---|---|
| 1 Trusted time | §4; G4-5, G4-6 |
| 2 Future revisions, pre-delivery, atomic whole-revision apply (628) | §5, §6; G4-2, G4-3, G4-4 |
| 3 Failed apply leaves previous identifiable (629) | §5.4; G4-10 |
| 4 Configurable staleness, visible stale state (624–626) | §7; G4-7, G4-8 |
| 5 Critical corrections, RT-284 modes (627) | §8; G4-9 |
| 6 Sale snapshot consistent with PR-07 (630) | §9; G4-11 |
| 7 Revision granularity per OD-3 | §5.1 (store applied revision + epoch) |
| Additive contract changes listed for a later `[GATED]` item | §10 |
| Design doc + decision record | this file, [decision-record.md](decision-record.md) |
| No code, OpenAPI or migration | this PR touches `specs/043-*` only |
