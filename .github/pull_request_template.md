<!--
Backend-Core PR template
Constitution: .specify/memory/constitution.md v3.0.0

Every PR must be tied to a spec-backed task or explicitly explain why it is not.
Use "Closes #ISSUE_NUMBER" so GitHub closes the linked issue automatically on merge.
-->

## Spec / Task ID

- Spec:
- Task ID:
- Issue: Closes #ISSUE_NUMBER

## Summary

<!-- One short paragraph: what changed and why. -->

## Scope

<!-- What is intentionally included in this PR. Keep it small and reviewable. -->

-

## Out of scope

<!-- What this PR intentionally does not change. -->

-

## Changed files

<!-- List the meaningful files or folders changed. -->

-

## Tests

<!-- Include exact commands and results. For backend behavior changes, include cross-tenant/cross-store coverage where applicable. -->

```bash
# command
```

Result:

```text
# result
```

## Constitution / boundary check (v3.0.0)

Tick every principle this PR touches. For ticked items, briefly state how the change complies.

- [ ] **I. Reference, Not Source of Truth**: no legacy `Data-Pulse` content copied without re-spec'ing here.
- [ ] **II. Multi-Tenant SaaS by Default**: tenant scoping is enforced at DB, API, and test layers where relevant.
- [ ] **III. Backend Authority & Data Integrity**: server-side authz, DB constraints, uniform errors, exact money handling where relevant.
- [ ] **IV. Contract-First POS Integration**: OpenAPI contracts remain source of truth; no raw DB entities in API responses.
- [ ] **V. Async Work Belongs in Workers**: webhook, sync, retry, scheduled, and fanout work is worker-bound where relevant.
- [ ] **VI. Test-First Quality**: tests were added or updated first for the behavior being changed.
- [ ] **VII. Observable Systems**: logs, metrics, request IDs, tenant IDs, and redaction rules are preserved where relevant.
- [ ] **VIII. Reproducible & Versioned Releases**: no unapproved package, lockfile, schema, or migration changes.
- [ ] **IX. Source-of-Truth Model**: Global Catalog, Tenant Catalog, Store Override, SaleLine snapshot, and provenance boundaries are preserved where relevant.
- [ ] **X. Retail Temporal Semantics**: temporal fields and historical facts are handled explicitly where relevant.
- [ ] **XI. Idempotency & External IDs**: retryable mutations and external IDs are idempotent or justified.
- [ ] **XII. Authorization & Object Safety**: IDs in bodies are not trusted; mass-assignment fields remain protected; default deny.
- [ ] **XIII. Auditability & Provenance**: audit events preserve actor, tenant, store, operation, target, correlation ID, and outcome where relevant.
- [ ] **XIV. PII & Data Lifecycle Discipline**: PII, payment data, tokens, secrets, and payloads are not logged; retention rules are respected.

## Explicit approval check

Confirm these were not changed unless explicitly approved for this PR:

- [ ] No `package.json` changes.
- [ ] No `pnpm-lock.yaml` changes.
- [ ] No DB schema or SQL migration changes.
- [ ] No OpenAPI contract changes.
- [ ] No CI workflow changes.
- [ ] No source code outside the approved scope.
- [ ] No specs changes.
- [ ] No dashboard UI work.
- [ ] No POS-Pulse app work.
- [ ] No billing, analytics, reports, dbt, ClickHouse, or Dagster work.

## Notes

<!-- Risks, follow-ups, known test gaps, or reviewer context. -->
