### Added
- RT-368: runtime for the device retire (`DevicesService.retire`).
  `consoleRetireDevice` ships unchanged on the wire and loses
  `x-runtime-status: contract-only`. Under the lifecycle and row locks it
  decides with the shared evaluator on the impact read (409 with the retire
  preview; `already_retired` writes nothing), revokes an active device first
  through the shared cascade (reason `retired`) or cancels a revoked
  device's pending codes, sets the retire fields and writes
  `pos.device.retired` (no reason text; `cancelled_pairing_code_count` counts
  only the codes the retire step itself cancelled). `consoleListDevices`
  without `trust_state` now excludes retired devices, and the contract drops
  its pre-runtime `x-runtime-note`. The revoke and the retire check the store
  scope before taking a device's locks. No DELETE route; no migration.
