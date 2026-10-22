### Added
- RT-664 (RT-644 ENT-BC3): the `ai-entitlements` runtime on the 0055
  storage. Decisions: AD-AI-ENT-001 D-1 to D-9. It adds:
  - the internal `check` (layers 1, 4, 6, 7), fail closed. It records
    `entitlement_unavailable` and reserves nothing when the store cannot be
    read;
  - the Option A reserve / commit / release. A conditional counter UPDATE
    is safe at the limit. A replay of the same `Idempotency-Key` is counted
    once. Only a validated `ok` is charged (D-8). Writes are serialised by
    advisory locks, because the ledger grants no UPDATE, so a locking read is
    impossible;
  - platform-admin entitlement revisions with a reason, `expectedVersion`, a
    SHA-256 `content_hash` and an audit row. Dispute adjustments are capped at
    the committed units. Both are a service API with no route yet;
  - the RT-662 Console read and owner-only opt-out runtime, so the two
    operations lose `x-runtime-status: contract-only`;
  - the worker's TTL sweep, `ai-usage-reservation-sweep` (T17).

  The AI gateway now checks the kill switch first (layer 0), then the
  entitlement, the budget and the quota reservation. It settles every
  reservation it took, and its deny-all entitlement stub is replaced. v1
  reserves one counter per request, so a feature with zero or several meters
  fails closed. No billing, price or tenant-visible rollout.

  The domain-role grants ship as an owner-gated operator script,
  `docs/operations/sql/ai-entitlements-domain-grants.sql` (owner decision
  2026-10-20, option B). It is not in the routine deploy step 2, and the
  tables are not in `DOMAIN_REQUIRED_GRANTS`, so the API boots without them.
  Until the script runs, the routes answer 503 `entitlement_unavailable`,
  every AI run fails closed and the sweep is a no-op.
