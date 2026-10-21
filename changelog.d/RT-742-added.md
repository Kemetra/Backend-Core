### Added
- RT-742 `[GATED]`, owner authorization 2026-10-21 (RT-554 follow-up, owner
  decision 2026-10-19): contract-only manager forced close of a stuck shift
  from any terminal of the same store. `pos-shifts.openapi.yaml`
  1.4.0-draft adds `forceCloseShift` (`POST /api/pos/v1/shifts/{shift_id}/forced-close`,
  manager/admin envelope only, store-scoped, the shift must be stuck now, 409
  `shift_not_stuck` otherwise). It records the shift as NOT COUNTED (`cashCount:
  not_counted`: closing manager, calling terminal, opening terminal, reason;
  no cash-up and no `ShiftClose`), because the manager's terminal does not hold
  the drawer's totals and the server never computes a POS cash-up. It is never a
  counted zero and is excluded from every variance flag and from the R-9
  cash-refund cross-check. On the opening device, a later `closeShift`, or an
  `openShift` re-delivered under another `Idempotency-Key`, is the distinct 409
  `shift_force_closed` (final for the POS); any other device keeps the
  non-disclosing 404, and the same-key open replay returns the stored
  response. A later new `recordCashMovement` keeps 409 `shift_closed`.
  `forceCloseShift` states its evaluation order. `closeShift`, the
  stuck list and every existing schema are unchanged. No runtime, migration,
  Console or POS change: the runtime and its storage are a separate `[GATED]`
  ticket.
