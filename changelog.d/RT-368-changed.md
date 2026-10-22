### Changed
- RT-368 `[GATED]`, pending owner approval: `consoleListDevices` without
  `trust_state` no longer lists retired devices (RT-368 scope, decision R1):
  a default-behaviour change to a live operation. Retired devices stay
  queryable with `trust_state=retired` and by id. Admin-Console RT-371's fleet
  table stops showing them unless it filters for them; RT-372 adds a retired
  filter. Production keeps the old default until the RT-368 runtime ships
  (an `x-runtime-note` says so until then).
