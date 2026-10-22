### Added
- RT-383: runtime for the admin shift-close reads (`ShiftClosesModule`). Both
  operations ship unchanged on the wire and lose `x-runtime-status:
  contract-only`. Dashboard session, roles owner / tenant_admin /
  store_manager, the operator store scope as a SQL predicate, one
  non-disclosing 404 body for every refusal, and a tenant-bound keyset cursor
  that keeps `closedAt` at microsecond precision. No migration; the POS shift
  operations are unchanged.
