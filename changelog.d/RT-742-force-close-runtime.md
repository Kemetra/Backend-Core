### Added
- RT-742 `[GATED]` runtime, contract-only lift and migration 0070 (owner
  authorization RT-742 comment 13358, PR + CI only; storage shape and number
  by the wave coordinator 2026-10-22 under the owner's delegation): the
  runtime of `forceCloseShift` (`POST /api/pos/v1/shifts/{shift_id}/forced-close`,
  contract #884), which loses its `x-runtime-status: contract-only` marker. A
  manager or admin envelope (the only credential; every refusal is the
  generic 401) clears a stuck shift of the same tenant and store opened on any
  terminal, legacy shifts included, as NOT COUNTED: one append-only
  `shift_forced_closes` row (closing manager, calling terminal, server clock,
  reason, natural-key hash) and the shift moves to the existing
  `closed_forced` state, with no `shift_closes` row, no total and no variance.
  Another store or tenant is the non-disclosing 404; a shift that is not stuck
  (younger than the threshold, or its opening cashier holds a live session
  other than the caller's) is 409 `shift_not_stuck`; the same force close is
  a 200 replay, another reason 409 `shift_force_closed`, a cash-up close 409
  `shift_closed`. On the opening terminal a later `closeShift` and an
  `openShift` re-delivery are 409 `shift_force_closed`; a new movement keeps
  409 `shift_closed`. The audit row names the shift and both terminals, never
  the reason. Migration `0070_shift_forced_closes` adds the table (FORCED RLS,
  SELECT + INSERT only, composite FKs pinning the shift and the calling
  terminal to the tenant and store), UNIQUE targets on `shifts` and `devices`,
  and lets the shifts guard move a cash-up shift to `closed_forced` with its
  force close; its down refuses while a force close is recorded. Apply 0070
  and then `docs/operations/sql/shift-forced-closes-domain-grants.sql` before
  rolling the API (`DOMAIN_REQUIRED_GRANTS`).
