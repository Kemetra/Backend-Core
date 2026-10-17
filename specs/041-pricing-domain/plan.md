# Spec 041 — Plan

| | |
|---|---|
| **Jira** | RT-483 (RT-282 PR-01) |
| **Work Mode** | Planning |
| **Baseline** | `origin/main` @ `ff9e6833` |
| **Spec** | [spec.md](spec.md) · [data-model.md](data-model.md) · [decision-record.md](decision-record.md) |

This plan says how spec 041 becomes executable work. It does not create Jira issues: RT-282 §"Created in Jira"
says the Phase 1+ items are created only after OD-1–6 are ratified and the relevant gate is open.

## 1. Constitution check

| Principle | How the spec meets it |
|---|---|
| §II multi-tenant RLS | Every proposed table carries `tenant_id` with RLS; composite `(id, tenant_id)` FKs prevent cross-tenant references |
| §III backend authority | Resolution, validation, inquiry and explain are Backend-computed; Admin-Console renders; ERPNext is never read |
| §IV contract-first | Shapes are drafts here. PR-04 / PR-06 / PR-07 commit them to OpenAPI before any runtime (PR-08+) |
| §VIII gated releases | OpenAPI and migrations are `[GATED]` items with their own owner authorization |
| §XII object safety | Events and revisions are immutable; corrections are new rows |
| §XIV PII | No PII in pricing tables |

## 2. Contract-first sequence (from the RT-282 backlog, refined by this spec)

| Step | Item | What spec 041 hands it |
|---|---|---|
| 1 | RT-484 (PR-02) Change Set plan | The event, revision and validity model (spec §3, §5). Done in spec 042 |
| 2 | RT-485 (PR-03) migration/cutover plan | Legacy mapping (data-model §3); Q-4 zero-price report; `price_history` check |
| 3 | RT-487 (PR-G4) offline activation design | OD-3 store applied revision; `earliest_effective_at`; `time_basis` rules (spec §4.3) |
| 4 | PR-04 `[GATED OpenAPI]` inquiry + authoring contract | §4.4 result, §8 inquiry/explain drafts, spec 042 lifecycle payloads |
| 5 | PR-05 `[GATED migration]` schema | data-model §2 (core tables). The device apply-state table waits for RT-487 |
| 6 | PR-07 `[GATED]` sale-line provenance | The `origin: "pricing"` provenance object (spec §4.4) |
| 7 | PR-06 `[GATED OpenAPI]` read-down v-next | Same provenance union; store applied revision |
| 8 | PR-08 resolver + inquiry runtime | §4 algorithm as a pure function; property tests below |

## 3. Test strategy for PR-08 (written now so the contract is testable)

- **Property tests** of the pure resolver:
  - determinism: same inputs → same output across shuffled event order and shuffled creation timestamps (496, 499);
  - precedence: adding a Store event never changes another Store's result; removing the Store event returns the Zone/Book result (490–491);
  - as-of-revision: results at revision R are unaffected by events published after R;
  - representability: no `priced` result has digits beyond the currency minor unit.
- **Example tests:** DST gap and overlap (Q-2), a Book event across two time zones (Q-1), ambiguous membership → `error` (494).
- **DB tests (PR-05):** exclusion constraints reject overlaps; immutability trigger rejects edits; RLS matrix.

## 4. Cross-repo inputs (no cross-repo work is done here)

- **POS (OD-6):** "Does POS validate Backend-Core read-down and sales responses strictly (`additionalProperties:false`
  enforced at runtime) or leniently?" To be asked on the POS side by PR-06's owner before its contract bump; until
  answered, assume strict.
- **RT-281:** adopt the shared Change Set primitive (spec 042 §9) and own Sell Units (OD-2) and Assortment (OD-5).
- **RT-294:** own tax derivation from `tax_price_basis` (spec §7) and the legacy `tax_category`.
- **RT-279:** consider versioning store time configuration (Q-3).

## 5. Risks

- **Store time-zone history (Q-3)** is not versioned. Historical inquiry for `store_local` events can shift after a zone change.
- **Gap-free `revision_no`** relies on per-tenant publish serialization. Very high publish rates per tenant would contend on that lock; not expected for v1.
- **Exclusion constraints need `btree_gist`.** If the extension is unavailable on the managed Postgres, PR-05 falls back to a validation-time check plus a serializable publish transaction.
- **OD-4 coupling.** Pricing defines the shared primitive before RT-281 has planned. If Catalog needs something different, the primitive changes under Pricing.
