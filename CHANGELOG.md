# Changelog

All notable changes to Data-Pulse-2 are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- RT-427 on `[GATED]` migration `0063_inventory_effects_activation` (owner-approved
  2026-10-21: migration as proposed, decisions 1–6 as recommended). Sale, void
  and return Inventory Effects are written in the same transaction as their
  `erpnext.posting.requested` intent (RT-289 DC-1 / DC-2), per tenant behind
  `tenant_inventory_settings.sale_effects_activated_at`, which is OFF (NULL) for
  every tenant; with it OFF nothing changes. A sale line writes `-q` at the
  store's primary location / sellable (`sale_line:<id>`), a void compensates
  each sale effect at its position (`void:<voidId>:<lineId>`), a return writes
  `+q` in the tenant's return landing status (`return_line:<id>`), a refund
  writes nothing. Effects start `not_posted` and the posting-requested consumer
  links them `pending` / `rejected` when it creates the posting row; RT-426
  moves them from there. Lines that cannot be written exactly are skipped
  (`inventory_sale_effect_skipped_total`), never stall the sale. Activation is
  the operator CLI `packages/db/dist/cli/inventory-effects.js activate`: it
  refuses unless every store has a fresh complete Bin snapshot and no posting
  in flight, takes an Inventory Anchor per store (`inventory_anchors` /
  `inventory_anchor_lines`) and backfills no sale; `compare` prints the
  read-only anchor + effects vs latest Bin comparison. The dead
  `InventoryBackfillProcessor` is deleted. Deploy: run
  `docs/operations/sql/inventory-anchors-domain-grants.sql` in step 2.
- Phase 1 workspace setup: `pnpm-workspace.yaml`, `tsconfig.base.json`,
  `.eslintrc.cjs`, `.prettierrc`, `.nvmrc`, root `package.json`,
  `docker-compose.dev.yml`, Constitution-Check PR template.
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
  cash-refund cross-check. A later `closeShift` or `openShift` replay for that
  shift is the distinct 409 `shift_force_closed` (final for the POS); a later
  new `recordCashMovement` keeps 409 `shift_closed`. `closeShift`, the
  stuck list and every existing schema are unchanged. No runtime, migration,
  Console or POS change: the runtime and its storage are a separate `[GATED]`
  ticket.
- RT-490 `[GATED]`, owner authorization 2026-10-21 (RT-271 F-1, decisions
  R-1 to R-12): contract-only refund allocation, refund execution and return
  reads. `pos-sales/sales.yaml` 1.13.0-draft re-describes `RefundTender` as a
  refund allocation with optional `allocationRef`, `originalTenderRef` and
  `instrument` (cash), and states the instrument and cumulative
  refundable-balance rules on `recordReturn` (422
  `refund_instrument_not_allowed`, `refund_allocation_exceeds_tender`; the 422
  response is renamed `ReturnUnprocessable`). It adds `recordRefundExecution`,
  `readReturnByProvenance` and `listSaleReturns` (all contract-only until F-2)
  and documents the legacy `recordRefund` as gated off from F-4.
  `erpnext-connector/posting-feed.yaml` 1.9.0-draft states settle-before-post
  for returns behind a deploy flag, with no schema change. `pos-shifts.openapi.yaml`
  1.3.0-draft adds the R-9 close cross-check (422 `refund_ref_unsettled`,
  `cash_refunds_total_mismatch`) from F-3. Ref-less return bodies stay valid.
  No runtime, migration, Connector or POS change.
- RT-113 BC1: OpenAPI contract `pos-cashier-admissions.openapi.yaml`
  (1.0.0-draft, contract-only). It defines the device-authenticated cashier
  admission, admission end and cashier roster routes that replace the cashier
  path's use of the operator-identity-gated roster and active-session routes.
- RT-414 runtime (RT-391 P0-a, D2) on `[GATED]` migration
  `0062_platform_support_sessions` (approved 2026-10-21 under the owner's
  delegation). The four support-session operations ship and their
  `contract-only` markers are lifted (`platform-support-sessions.openapi.yaml`
  1.2.0-draft). A platform admin in a tenant they are not a member of is
  admitted to every `TenantContextGuard` route, `switchActiveStore`,
  `listMembers` and `updateTenant` only through an active support session;
  expiry is refused server-side and renewal is explicit (capped at opened + 8
  hours). Each such request writes one `platform.cross_tenant.accessed` row,
  and open, renew and end write `platform.support_session.*` rows, all visible
  to the tenant's owner and tenant_admin. A suspended tenant opens a read-only
  session (`support_session_read_only`); on it `updateTenant` is admitted only
  for a status-only body, so the tenant can be reactivated. `switchActiveTenant` refuses a non-member
  platform admin (403 `support_session_required`), and sign-out and tenant
  switch end the session. Deploy: run
  `docs/operations/sql/platform-support-sessions-domain-grants.sql` in step 2.
- RT-414 `[GATED]`, owner-approved 2026-10-12 (decisions 1–5 on RT-414): OpenAPI contract
  `platform-support-sessions.openapi.yaml` (1.0.0-draft, contract-only). It
  defines the platform support session (RT-391 P0-a, D2): open with a
  mandatory purpose, read current, explicit renew and end, a 60-minute
  server-set expiry, the cross-cutting `support_session_required` /
  `support_session_expired` refusal on tenant-scoped routes (including
  `listMembers`, `updateTenant` and `switchActiveStore`), an `Origin` check
  (`origin_rejected`) on the surface's POSTs and on unsafe-method requests a
  support session admits, and the
  `platform.support_session.*` and `platform.cross_tenant.accessed` audit
  metadata allowlists. `context.openapi.yaml` 1.1.0-draft adds a
  platform-admin-only 403 on `switchActiveTenant` and a nullable
  `support_session` on `ContextResponse`. No runtime or migration change.
- RT-383 `[GATED]`, pending owner approval: OpenAPI contract
  `shift-closes.openapi.yaml` (1.0.0-draft, contract-only). It defines the
  admin-facing read of recorded RT-17 shift closes for Admin-Console RT-18:
  `GET /api/v1/shift-closes` (filtered, keyset-paginated list) and
  `GET /api/v1/shift-closes/{shiftId}` (one close with its movements). No
  runtime change; the POS shift operations are unchanged.
- RT-383: runtime for the admin shift-close reads (`ShiftClosesModule`). Both
  operations ship unchanged on the wire and lose `x-runtime-status:
  contract-only`. Dashboard session, roles owner / tenant_admin /
  store_manager, the operator store scope as a SQL predicate, one
  non-disclosing 404 body for every refusal, and a tenant-bound keyset cursor
  that keeps `closedAt` at microsecond precision. No migration; the POS shift
  operations are unchanged.
- RT-384 `[GATED]`, pending owner approval (AD-CASH-001 follow-up 1): OpenAPI
  contract `cash-variance-policy.openapi.yaml` (1.0.0-draft, contract-only).
  It defines the shift variance policy: the device read of the resolved policy
  (`GET /api/pos/v1/store/cash-variance-policy`, ETag/304), and the
  cookie-session Console reads, revision lists and publishes for the tenant
  default and the store override (owner / tenant_admin; a permanent override
  is owner-only; stricter-only; 90-day horizon). `pos-shifts.openapi.yaml`
  1.2.0-draft adds an optional `frozenPolicy` object on `openShift` and
  optional recorded / derived values on `Shift` / `ShiftClose`, and
  replaces the stale "default 0" text. `shift-closes.openapi.yaml`
  1.1.0-draft adds the same optional values and three optional filters.
  Strictly additive; no runtime or migration change (RT-385 / RT-387).
- RT-530 `[GATED]`, owner-approved 2026-10-15 (RT-530 comment 11988):
  manager-approved sale void. `POST /api/pos/v1/sales/{saleRef}/void` now
  needs a bound RT-114 manager approval (`approval`) and the void's
  `businessDate`; without a valid one it is refused. `pos-sales/sales.yaml`
  1.8.0-draft adds both fields as optional in shape (additive) and the 403
  `void_approval_required` / `void_self_approval` / `void_approver_not_eligible`
  and 422 `void_approval_invalid` / `void_outside_business_day` refusals. The
  approver must be an owner, tenant_admin or store_manager of the tenant with
  access to the sale's store, and neither the requester nor the selling
  operator; the requester must be the authenticated envelope operator (403
  `void_requester_mismatch`) and a user of the tenant with access to the store; the void must be on the sale's business day. A replay answers
  before these checks. Migration 0046 adds the approval evidence columns to
  `sale_voids` (all NULL for earlier voids); the `sale.voided` audit event
  carries the approver. The server re-validates every claim of the evidence but
  cannot prove that a PIN was typed on the terminal.
- RT-538 `[GATED]`, owner-authorized 2026-10-16 for implement and merge, not
  deploy (RT-538 comment 12079): storage for the store-wide sale history
  (RT-537 contract). Migration 0047 adds the nullable receipt snapshot columns
  on `sales` (`receipt_*`), `sale_lines.line_seq` and the append-only,
  tenant-RLS `sale_reprints` table; migration 0048 builds
  `idx_sales_tenant_store_business_date` (tenant, store, business date DESC,
  occurred at DESC, id DESC) with `CREATE INDEX CONCURRENTLY`, as a
  single-statement file so the runner does not wrap it in a transaction. No
  backfill, no runtime or contract change; the routes stay contract-only until
  RT-539.
- RT-539 (RT-534 S3; owner decisions OD-534-1..8): the store-wide POS sale
  history runtime on the RT-538 schema. `GET /api/pos/v1/sale-history`
  (business-date range, at most 31 days, keyset pages), `GET
  /api/pos/v1/sale-history/{saleRef}` (the full recorded detail) and `POST
  /api/pos/v1/sale-history/{saleRef}/reprints` (authorize / record), behind
  `SaleHistoryAuthGuard`: the manager/admin envelope sees every sale of its
  store; the device bearer plus `X-Cashier-Admission` sees only the admitted
  cashier's own sales, from every till of the store. Per-device rate limits
  (`posReadSaleHistory`, `posWriteSaleReprint`). `captureSale` accepts the
  optional `receipt` snapshot (kept out of `payload_hash`, first write wins)
  and stores each line's position as `line_seq`. Deploy step 2 gains
  `sale-reprints-domain-grants.sql`; the API refuses to boot without it. The
  contract's `x-runtime-status: contract-only` markers are unchanged ([GATED]).
- RT-365 `[GATED]`, pending owner approval (RT-287 F2; decisions D-Q3 and
  D-Q4 as amended, RT-287 comments 11488 / 11493 / 11499): OpenAPI contract
  `devices.openapi.yaml` (1.0.0-draft, contract-only). It defines the
  Console device registry for Admin-Console RT-371 / RT-372:
  `GET /api/v1/devices` (store and trust-state filters, exception-first
  keyset pages), `GET /api/v1/devices/{deviceId}` and
  `POST /api/v1/devices/{deviceId}/revoke` (structured reason, operator-session
  and pending-pairing-code cascade, idempotent, and the Cash Session rule:
  security revokes always succeed, a `hardware_failure` recovery revoke needs
  owner / tenant_admin, a note and an acknowledgement, every other reason is
  409 `unresolved_cash_session` while the device has an open shift). The
  custody exception is derived (a revoked device with an open shift), not
  stored. No runtime or migration change.
- RT-365: runtime for the Console device registry (`DevicesModule`). The
  three operations ship unchanged on the wire and lose `x-runtime-status:
  contract-only`. Dashboard session, roles owner / tenant_admin /
  store_manager, the operator store scope, one non-disclosing 404 body. The
  revoke locks the device row, applies the RT-287 D-Q4 (amended) decision,
  sets the revoke fields, revokes the device's live `pos_operator` tokens,
  cancels its pending pairing codes and writes `pos.device.revoked` (RT-135
  allowlist: reason, counts, custody flag, shift id) in one transaction; it
  never writes a shift or cash fact. `packages/db` now declares the 0040
  device lifecycle columns (0040 must be applied before this deploys), and the
  read-down audits (`catalog.snapshot.read`, `catalog.deltas.read`) carry the
  reading `device_id` (RT-138 L8). The revoke, the cash-up shift open and the
  audit-ingest `shift.open` share a per-device advisory lock
  (`device-lifecycle-lock.ts`), and a shift open rechecks `revoked_at` under
  it, so a shift never opens on a device after its revoke commits (the
  cash-up open is refused with the revoked-device 401). Projections carry
  `lastSeenSource` (`activity` when `lastSeenAt` is set). No migration.
- RT-366 `[GATED]`, pending owner approval (RT-287 F3; D-Q1, D-Q2 and D-Q4
  as amended): `devices.openapi.yaml` 1.1.0-draft adds
  `GET /api/v1/devices/{deviceId}/impact?action=revoke|replace|move|retire`
  (`consoleGetDeviceImpact`, contract-only). It is the read-only lifecycle
  impact preview for Admin-Console RT-372. It returns the verdict
  (`allowed`, `allowed_with_custody_exception`, `blocked` with a
  `blockCode`, `forbidden_recovery` or `no_change`), the recovery-revoke
  `requires` list, the open shift with its server-received cash-up facts,
  the operator-session and pending-pairing-code cascade counts, and the
  replace links. The verdict maps one-to-one onto the revoke's outcome. The
  revoke and the RT-367 / RT-368 mutations must decide with the same
  evaluator. The revoke's 409 gains an optional `error.details` holding the
  preview. Additive only. No runtime or migration change.
- RT-366: runtime for the device impact preview. `consoleGetDeviceImpact`
  ships unchanged on the wire and loses `x-runtime-status: contract-only`.
  One pure evaluator (`device-lifecycle.evaluator.ts`) decides
  revoke / replace / move / retire, and `decideRevoke` is now that verdict
  plus the body's note and acknowledgement checks (revoke behaviour
  unchanged). A revoke with `other` previews `requires: [note]`, matching
  the body schema's 400. The preview reads the device, its open shift, the shift's
  server-received cash-up facts and the cascade counts in one statement,
  over the same predicates the revoke's cascade updates. It takes no lock and
  writes nothing (audited `devices.impact_read`). The revoke now decides from
  that same read under its locks, and its 409 carries the refused state's
  preview as `error.details`. No migration.
- RT-367 `[GATED]` (RT-287 F4 + F9; D-Q1 and D-Q4 as amended; decisions C1
  and C2 owner-approved 2026-10-17, the PR itself pending the owner's GATED
  approval): `devices.openapi.yaml` 1.2.0-draft adds the Console pairing
  codes, contract-only: `POST /api/v1/pairing-codes`
  (`consoleIssuePairingCode`; required non-replayable `Idempotency-Key`; the
  code is returned once and never stored), `GET /api/v1/pairing-codes`
  (`consoleListPairingCodes`, live pending codes in scope) and
  `POST /api/v1/pairing-codes/{pairingCodeId}/cancel`
  (`consoleCancelPairingCode`, idempotent). A code with `replacesDeviceId`
  replaces (same store) or moves (another store) the device; the issue and
  the redemption decide with the shared lifecycle evaluator, and a blocked
  replace / move is 409 with the preview; a device is replaced at most once
  (409 `replacement_already_pending` / `device_already_replaced`).
  `pos-terminal-pairing.openapi.yaml` 1.1.0-draft: `terminal_id` survives
  rotation, not re-pairing; the token is no longer "long-lived"; `expires_at`
  is populated; and a new 409 `REPLACEMENT_BLOCKED` for the pair-time Cash
  Session re-check. That last one is NOT additive: it is a POS-visible value
  added to the closed `error.code` enum, which oasdiff grades as breaking
  (cross-repo POS contract change; POS must handle `REPLACEMENT_BLOCKED`,
  tracked as RT-591). The owner approved it on 2026-10-17, and
  `tools/oasdiff/breaking-ignore.txt` acknowledges the five findings. No
  runtime or migration change.
- RT-367: runtime for the Console pairing codes (`PairingCodesController` /
  `PairingCodesService` in `DevicesModule`). The three operations ship
  unchanged on the wire and lose `x-runtime-status: contract-only`. The issue
  generates a 16-character code, stores only its hash, returns it once
  (`@Idempotent` with `replay: "forbid"`) and, for `replacesDeviceId`, decides
  replace / move with the shared lifecycle evaluator under the replaced
  device's lifecycle lock. `posPairTerminal` re-decides in its burn
  transaction (refusal: 409 `REPLACEMENT_BLOCKED`, code left pending), then
  auto-revokes a still-active replaced device through the RT-365 cascade
  (reason `replaced` / `moved`, no actor user) and writes `pos.device.paired`;
  it now returns `expires_at`. The revoke's SQL and cascade moved to
  `device-lifecycle.store.ts`, shared by the revoke, the issue and the pair;
  the revoke's 409 code is now the evaluator's `blockCode`. One replacement
  per device: the issue refuses a second (409 `replacement_already_pending` /
  `device_already_replaced`) and the redemption cancels sibling codes on
  every path. The issue's 201 is `Cache-Control: no-store`. A
  `REPLACEMENT_BLOCKED` redemption gives its per-code attempt back, so a
  blocked replacement code stays redeemable once the shift closes. Deploy:
  `docs/operations/sql/device-lifecycle-domain-grants.sql` (step 2) now also
  grants the domain role SELECT / INSERT / UPDATE on `pairing_codes`, which
  `DOMAIN_REQUIRED_GRANTS` checks at boot; the lookup role may hold SELECT
  only on it (`AUTH_LOOKUP_FORBIDDEN_GRANTS`). No migration.
- RT-572 `[GATED: contract posture lift]`: runtime for `consoleUpdatePayerAccount`
  (`PATCH /api/v1/settlement/payer-accounts/{payerRef}`, `settlement.yaml` 2.1.0);
  the operation is no longer contract-only. `PayerAccountsService.update` runs one
  transaction: lock the payer row, then 404 (absent / other tenant / store-scoped
  outside the caller's stores), 403 `payer_scope_insufficient` (a `status` or
  `externalRef` field on a tenant-wide payer without tenant-wide store scope; by
  presence), 409 `payer_version_conflict`, then a no-op returns the unchanged
  payer, else `version + 1` and `settlement.payer_account.updated` in the same
  transaction (tenant-level, `store_id` null, for a tenant-wide payer; field
  names, status and `externalRef` before / after, never the display name).
  `payerRef` is validated as a uuid before any SQL cast. No migration (it uses the
  existing `payer_account.version`; 0053 is not consumed) and no new grant
  (`payer_account` `UPDATE` and `audit_events` `INSERT` already exist; comments
  and `docs/operations/database-roles.md` updated).
- RT-572 `[GATED]`, pending owner approval: `settlement/settlement.yaml` 2.1.0 adds
  `consoleUpdatePayerAccount` (`PATCH /api/v1/settlement/payer-accounts/{payerRef}`,
  contract-only), so a payer created without `externalRef` (its ERPNext Customer
  link) can be repaired instead of failing every credit sale with
  `sale_responsibility_payer_invalid`. Additive to 2.0.0: no existing operation
  or schema changes. Body `PayerAccountUpdate`: `expectedVersion` (the existing
  `PayerAccount.version`, int4-bounded, so no new column) plus at least one of
  `displayName`, `externalRef` (set or replace, never cleared; an identifier of
  1..140 characters with no surrounding whitespace, control, zero-width or separator characters) and
  `status` (active / suspended); `category` and `storeId` are immutable. A stale
  `expectedVersion` is 409 `payer_version_conflict`; a no-op is 200 with the
  version unchanged. A `status` or `externalRef` change of a tenant-wide payer
  needs tenant-wide store scope (else 403 `payer_scope_insufficient`). `suspended` also
  fails credit reversals of that payer's sales closed under RT-577 D12. An
  effective update writes `settlement.payer_account.updated` in the same
  transaction as the update (field names, status and `externalRef` before / after, never the
  displayName). A changed `externalRef` never touches a posting that already
  froze its payer link (RT-332); an operator re-resolution re-reads the live
  value. Runtime follows in the RT-572 runtime PR.
- RT-368 `[GATED]`, pending owner approval (RT-287 F5; D-Q2 and D-Q4 as
  amended): `devices.openapi.yaml` 1.3.0-draft adds
  `POST /api/v1/devices/{deviceId}/retire` (`consoleRetireDevice`,
  contract-only). Retire is a closeout, never a delete: it decides with the
  shared lifecycle evaluator under the device lifecycle lock (409
  `unresolved_cash_session` / `unresolved_custody_exception` with the retire
  preview), revokes an active device first with reason `retired` through the
  revoke cascade, cancels the device's pending codes, sets the retire
  attribution and writes `pos.device.retired`. Idempotent (`already_retired`),
  terminal, no un-retire, no DELETE. No runtime or migration change.
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
- RT-369 `[GATED]`, pending owner approval (RT-287 F6; RT-138 L4 / DL-4,
  owner-ratified 2026-10-02 with the grace clarification):
  `pos-terminal-pairing.openapi.yaml` 1.2.0-draft adds
  `POST /api/pos/v1/terminals/rotate` (`posRotateTerminalToken`,
  contract-only), authenticated by the device bearer. It returns a new token
  once (SHA-256 at rest), `expires_at = now() + 90 days`, the unchanged
  `terminal_id` and the hint `rotate_after = expires_at - 15 days`. The
  presented token stays valid for a 10-minute overlap on every
  device-authenticated route; a retry with the previous token replaces the
  undelivered new token without extending the window. An expired, unrevoked
  device may rotate for 7 days after `expires_at` (the only route that reads
  expiry until RT-370; literal L4, not gated on the enforcement flag); a
  revoked or retired device never. One generic 401, a per-device rotation
  budget (429 `RATE_LIMITED` with `Retry-After`), required non-replayable
  `Idempotency-Key` scoped to the device (409 `idempotency_key_conflict` on
  a same-key retry), `Cache-Control: no-store` / `Pragma: no-cache` on the
  200, its own `RotateError` code set, the client rules (one rotation in
  flight, first-start rotation), and the `pos.device.rotated` /
  `pos.device.rotation_rejected` audit allowlists (reasons `revoked`,
  `retired`, `grace_elapsed`, `previous_expired`, `token_replaced`).
  Decisions coordinator-approved under owner delegation 2026-10-17.
  Additive; no runtime or migration change.
- RT-369: runtime for the device token rotation (`DeviceRotationModule`).
  `posRotateTerminalToken` ships unchanged on the wire and loses
  `x-runtime-status: contract-only`. `DeviceRotationAuthGuard` (a reviewed
  device-bearer composite) resolves the current or previous hash, applies
  the rotation decision (retired, revoked, previous_expired /
  token_replaced, 7-day grace) and writes `pos.device.rotation_rejected`
  for a known token it refuses; `PosWriteRateLimitGuard` applies the
  per-device `posRotateDevice` budget (10 / hour, 429 `RATE_LIMITED`); the
  200 is sent `Cache-Control: no-store` / `Pragma: no-cache`; every
  `rotation_rejected` row is written in its own transaction and spends from
  a separate per-device `posRotateRefusalAudit` budget first (20 / hour;
  once spent: still 401, no row, a warn log), so a refused token never
  429s a valid rotation; the
  service re-decides under the device lifecycle lock and the row lock
  (constant-time hash compare), swaps the token and writes
  `pos.device.rotated`. Every device-authenticated route now accepts the
  previous token until `previous_valid_until` (`DeviceRepository`).
  `@Idempotent` gains the opt-in `clientScope: "device"`, so rotate keys are
  per device; every other route keeps its store key. No migration (0040
  already has the rotation columns) and no grant change (the domain role
  already holds SELECT / UPDATE on `devices`).
- RT-542 `[GATED]`, owner-approved 2026-10-16 (RT-542 comment 12124): the three
  sale-history operations (`listSaleHistory`, `readSaleHistoryDetail`,
  `recordSaleReprint`) lose `x-runtime-status: contract-only` now that the RT-539
  runtime serves them. `sale-history.yaml` stays `1.0.0-draft`; no new field, no
  other operation, no runtime or migration change.
- RT-561 `[GATED]`, pending owner approval (RT-556 F1): OpenAPI contract
  `console-sales.openapi.yaml` (1.0.0-draft, contract-only). It defines the
  console read of received sales for Admin-Console spec 012:
  `GET /api/v1/sales` (`consoleListSales`: one required `store_id`, an
  inclusive business-date range of at most 31 days, sale-number and status
  filters, keyset pages) and `GET /api/v1/sales/{saleRef}` (`consoleGetSale`:
  the recorded detail without the POS-only receipt-facts and reprint parts).
  Dashboard session only, roles owner / tenant_admin / store_manager, the
  operator store scope and one non-disclosing 404; audit actions
  `console_sales.listed` / `console_sales.detail_read`. No runtime or
  migration change; `pos-sales/sale-history.yaml` is unchanged.
- RT-562 (RT-556 F2): runtime for the console sales read
  (`ConsoleSalesModule`). Both operations ship unchanged on the wire and lose
  `x-runtime-status: contract-only`. Dashboard session only, roles owner /
  tenant_admin / store_manager, the operator store scope with an explicit
  `store_id` predicate (sales RLS is tenant-only), one non-disclosing 404 body,
  an inclusive 31-day range, and a cursor bound to the operation, tenant,
  store and every filter. A filtered request (`sale_number`, `sync_status`,
  `voided`, `return_state`, `erp_posting_state`) reads at most 500 sales, so
  a page may be short or empty with a non-null cursor. Reuses the RT-539
  sale-history query and projections; the list reads migration 0048's index.
  No migration; `sale-history.yaml` and `sales.yaml` are unchanged.
- RT-418 `[GATED]` migration `0051_sale_responsibilities`, pending owner
  approval: the runtime for the RT-417 contracts (owner decisions R-1 and
  option A). Migration: append-only, RLS-forced `sale_responsibilities`
  (composite FKs to `sales` and to `payer_account (id, tenant_id)`, amount
  > 0, one row per payer and per sequence), `sales.responsibility_count`
  (0..1, the feed's visibility guard), `erpnext_posting_resolution
  .payer_external_ref` (the payer's ERPNext Customer link frozen with each
  resolution version), and `payer_account.credit_terms` dropped. Capture
  (`pos-sales/sales.yaml` 1.10.0-draft) accepts `responsibilities` (one
  payer), hashes them into the payload, and decides, after a replay
  resolves: 403 `sale_responsibility_role_refused` (envelope operator not an
  active owner / tenant_admin / store_manager of the store), 422
  `sale_responsibility_offline_refused` (the RT-224 device path), the combined
  coverage rule (422 `sale_responsibility_mismatch`; it replaces the RT-76
  tender rule, and the tender rule now also runs after the replay check, so a
  replay with different tenders is a 409, never a 422), the line price
  invariant, then one non-disclosing 422
  `sale_responsibility_payer_invalid`; a replay with different
  responsibilities is a 409. `Sale.responsibilities` on capture and read.
  Posting feed (`posting-feed.yaml` 1.8.0-draft): `sale.responsibilities
  [{payerExternalRef, amount, sequence}]` from the frozen resolution
  (`payloadHash` unchanged); a responsibility-bearing `sale_post` is held
  until `ERPNEXT_FEED_RESPONSIBILITIES_ENABLED` is on (after RT-419), its
  reversals are always held, its `sale_post` is held while a void, refund or
  return exists, and the feed fails closed: a sale whose responsibility rows
  are not all visible, or whose (frozen) payer link is NULL or blank, is
  held, never offered as cash or to the store Customer. Lifting the gate
  hold needs `docs/operations/sql/sale-responsibilities-feed-rehead.sql`
  (deploy/README.md "Enabling credit posting"); the flag is not yet mapped
  into the api container (unmapped = held). Payer routes (`settlement/settlement.yaml` 2.0.0)
  `consoleCreatePayerAccount` / `consoleListPayerAccounts` ship
  (`PayerAccountsModule`) and lose `x-runtime-status: contract-only`.
  Deploy: run `docs/operations/sql/sale-responsibilities-domain-grants.sql`
  after `migrate up` (`DOMAIN_REQUIRED_GRANTS` now lists
  `sale_responsibilities` SELECT / INSERT and `payer_account` SELECT /
  INSERT / UPDATE).
- RT-577 `[GATED]` migration `0054_sale_credit_reversals` + contract posture
  lift, pending owner approval: credit-sale reversals
  (`pos-sales/sales.yaml` 1.11.0-draft; owner V1 decision and rulings D6 /
  D7 / D8, 2026-10-17). `recordVoid`, `recordReturn` and `recordRefund`
  refuse a sale with payer responsibilities for every operator (403
  `credit_sale_reversal_restricted`, after the sale and a provenance replay;
  nothing recorded). `recordCreditSaleReversal`
  (`POST /api/pos/v1/sales/{saleRef}/credit-reversals`) ships and loses
  `x-runtime-status: contract-only`: Manager/Admin only (live standing), RT-530
  for a void, a pro-rata floor allocation in exact minor units (D7), payer
  settlement, a second approval for a cash-paying return (D6), mirrored void
  tenders and cash-only returns (D8); fail-closed 422s write nothing. The
  reversal reuses the `sale_voids` / `sale_returns` row (the posting feed's
  hold on credit-sale reversals is unchanged). Migration: append-only,
  RLS-forced `sale_credit_reversals`, `sale_credit_reversal_tenders` and the
  shared single-use ledger `sale_approval_uses` (backfilled per tenant, kept
  filled for voids by the `SECURITY DEFINER` trigger
  `sale_voids_record_approval_use`). Deploy: run
  `docs/operations/sql/sale-credit-reversals-domain-grants.sql` after
  `migrate up` (`DOMAIN_REQUIRED_GRANTS` now lists the three tables, SELECT /
  INSERT).
- RT-387 `[GATED: contract posture lift]`: the shift variance policy runtime
  (AD-CASH-001 F3) on the RT-385 migration 0050; no new migration.
  `CashVariancePolicyModule` ships the seven operations of
  `cash-variance-policy.openapi.yaml` 1.0.0-draft unchanged on the wire, and
  they lose `x-runtime-status: contract-only`: the POS device read (resolved
  policy, strong ETag over the resolved value, `If-None-Match` → 304), the
  tenant default and store override reads, keyset revision lists and
  idempotent publishes (session cookie only; owner / tenant_admin configure,
  store_manager reads its own stores; one non-disclosing 404). Resolution is
  stricter-wins with the tie to the store; publishes check, in the contract's
  order and on the database clock, EGP only, the expiry, an active override
  to clear, stricter-only and the owner rule for a permanent override, then
  `expectedRevisionId` (409), and write the revision with its
  `cash_variance_policy.changed` audit row in one transaction. An expired
  override writes `cash_variance_policy.override_expired` once, lazily, at
  the store's next resolution. Cash-up (`pos-shifts.openapi.yaml`
  1.2.0-draft): `openShift` accepts the optional `frozenPolicy`, records it
  verbatim with its accept-and-flag findings and hashes it only when present
  (a legacy open keeps its exact hash); a close records
  `approvalRequiredByPolicy` / `approvalMissing` from the frozen value
  (`unknown` without one) and persists the post-commit approver verdict in
  `shift_close_approver_checks`, which the 201 carries. Admin shift-close
  reads (`shift-closes.openapi.yaml` 1.1.0-draft) carry `frozenPolicy`, the
  derived values and `approverCheck`, and accept the `approval_required`,
  `approval_missing` and `approver_check` filters. Deploy: run
  `docs/operations/sql/shift-variance-policy-domain-grants.sql` after
  `migrate up` (`DOMAIN_REQUIRED_GRANTS` now lists
  `cash_variance_policy_revisions` and `shift_close_approver_checks` SELECT /
  INSERT).
- RT-620 `[GATED]`, owner-approved 2026-10-18 (RT-574 issue 2, O7): every
  cookieAuth operation not on the shared console rate-limit exemption list
  (`signOut`, `requestEmailVerification`, `refreshSession`) documents the 429
  the RT-619 `ConsoleRateLimitGuard` can return: 103 operations in 24
  contract files (`auth.openapi.yaml` holds only exempt operations and is
  unchanged). Each file gains a `TooManyRequests` response (code
  `rate_limited`, the canonical envelope, required `Cache-Control: no-store`
  and `X-Request-Id`) and its
  own `ConsoleRetryAfter` header (required integer, 1 to 3600, not the POS
  `RetryAfter`); audit, context, memberships and tenants also gain the
  canonical `Error` schema; tenant-branding, whose `Error` code enum is
  closed, gets a `RateLimitedError` for its 429; the text-only closed code
  sets name `rate_limited`. No budget number appears in any contract. The
  console-sales "no 429" sentence is gone and the status mappings name the
  429. Each changed file takes an additive minor version. A new contract
  sweep imports the runtime exemption list. No runtime or migration change.
- RT-492 `[GATED]`, pending owner approval (RT-114 MA-BC1; owner decision
  RT-114 comment 11888, reconciled with RT-284 comment 11887): OpenAPI
  contract `pos-approvers.openapi.yaml` (1.0.0-draft, contract-only).
  `posCheckApproverEligibility` (`POST /api/pos/v1/approvers/eligibility`,
  `device` bearer only, tenant and store from the device row) takes 1 to 50
  distinct `user_ids` and answers one `{ user_id, eligible }` per id, in
  request order. V1 eligibility: not deleted, an active membership in the
  device's tenant, a role in `{owner, tenant_admin, store_manager}` and
  access to the device's store. Unknown, cross-tenant and every other
  ineligible user are the same `eligible: false`, with no cause. The
  optional `action_kinds` is reserved for RT-284 P-A: the server omits it in
  1.0.0-draft, and clients honour it when present. Read-only, not audited,
  `Cache-Control: no-store`. The runtime ships in MA-BC2. No runtime or
  migration change.
- RT-738 (CAT-W1 + CAT-W2 of RT-281): runtime for the seven interim console
  catalog writes (`ConsoleCatalogWriteController` / `ConsoleCatalogWriteService`
  in `apps/api/src/catalog/console-catalog/`); they lose `x-runtime-status:
  contract-only` and ship unchanged on the wire. Each write is one RLS tenant
  transaction holding the change, its `audit_events` row and the detail it
  answers with; POS propagation stays on the 0015 `catalog_change_log`
  triggers. `expectedUpdatedAt` compares at millisecond precision and a write
  reruns its transaction rather than reuse its row's `updated_at`
  millisecond, so every accepted write's `updatedAt` is strictly later. Price
  is never written; store data follows the operator store scope, and a
  soft-deleted store is a 404. `ConsoleCatalogReadService.detailIn` lets a
  write answer from its own transaction. No migration, package or CI change.
- RT-738 `[GATED]`, owner-approved 2026-10-19 (CAT-W1 + CAT-W2 of RT-281):
  `catalog/console-catalog.yaml` 1.1.0-draft (additive) adds seven interim,
  audited console catalog writes, contract-only until the RT-738 runtime:
  `consoleCreateCatalogProduct` (`Idempotency-Key`),
  `consoleUpdateCatalogProduct` and `consoleRetireCatalogProduct`
  (`expectedUpdatedAt` → 409 `stale_write`), `consoleAddProductIdentifier`
  (non-disclosing 409 `alias_conflict`) and `consoleRetireProductIdentifier`
  (owner / tenant_admin), and `consoleUpsertStoreOverride` /
  `consoleRetireStoreOverride` (availability for store_manager on in-scope
  stores; tax category owner / tenant_admin only). No price field (O-2), no
  identifier move, 403 `origin_rejected` on cookie writes, soft-deleted
  stores a 404. Labelled interim, pre Change Sets (decision 400). No runtime
  or migration change.
- RT-729 `[GATED]`, owner-approved 2026-10-19 (CAT-R1 of RT-281): OpenAPI
  contract `catalog/console-catalog.yaml` (1.0.0-draft, contract-only). It
  defines the console read of the Tenant Catalog for Admin-Console RF-3 and
  the RT-724 link product picker: `consoleListCatalogProducts` (search by
  exact active barcode / sku / plu or case-insensitive name substring, status
  and category filters, an optional store's effective view, keyset cursor),
  `consoleGetCatalogProduct` (identifiers and store overrides in the caller's
  store scope) and `consoleListCatalogCategories`. Dashboard session only,
  roles owner / tenant_admin / store_manager, non-disclosing 404, no per-read
  audit. No runtime or migration change; the runtime ships in RT-730.
- RT-730 (CAT-R2 of RT-281): runtime for the console catalog read
  (`ConsoleCatalogModule`, `apps/api/src/catalog/console-catalog/`). All three
  operations ship unchanged on the wire and lose `x-runtime-status:
  contract-only`. Reads run under the RLS tenant context; store data
  (`storeView`, store-scoped identifiers, overrides) carries an explicit
  store predicate from the operator store scope. The Tenant ⊕ Store Override
  resolver is extracted from the POS read-down into
  `catalog/store-resolution/store-product-resolution.ts` and shared by both
  reads (a Testcontainers parity test pins `storeView` to the read-down
  projection). The keyset cursor is a compact, filter-bound byte layout. A
  soft-deleted store is absent on this surface for every scope (owner
  decision): its `store_id` is a 404 and its overrides and store-scoped
  identifiers are never shown or matched, unlike console-sales. No
  migration, package or CI change.
- RT-649 `[GATED]`, owner-approved 2026-10-19 (BC-009-1, RT-642 D0 P3):
  OpenAPI contract `console-sales-summary.openapi.yaml` (1.0.0-draft,
  contract-only). `consoleGetSalesSummary` (`GET /api/v1/sales-summary`) is
  the deterministic sales KPI read for Admin-Console spec 009 P-6 and a
  future Daily Briefing: per store, per business date (store timezone, DST
  via the tz database) and per currency, received-sale count and gross
  total, voids, returns, legacy refunds, shift-close outcomes and sync /
  ERP-posting attention counts, with `asOf`, `completeness: received_only`,
  explicit `unknown` buckets, exact four-digit decimal money, a 31-day
  range, store paging and server scope totals. Dashboard session, roles
  owner / tenant_admin / store_manager, non-disclosing 404, audited
  `console_sales.summary_read`. No runtime or migration change.
- RT-435 `[GATED: OpenAPI contract + migration]`, owner-approved 2026-10-19
  (RT-435 comment 12993, D1–D4; RT-290 Gate 4): inventory status moves and
  relocations. `inventory.yaml` 1.6.0-draft adds `createStatusMove`
  (`POST /api/inventory/v1/stores/{storeId}/status-moves`),
  `createRelocation` (`POST .../relocations`) and the tenant return landing
  policy (`GET`/`PUT /api/inventory/v1/settings/return-landing`, `sellable`
  default | `return_inspection`). Each move is one `adjustment` event with an
  `inventory_position_events` record and exactly two effects (`-q` from,
  `+q` to; DC-1 keys `<kind>:<eventId>:from|to`), `erp_neutral` in the same
  transaction under the V1 mapping profile (M-5, Q10); a non-zero per-bucket
  net fails closed. Physical on-hand never changes. Governed Reason Codes
  (D1); moves out of damaged / expired / a hold are owner / tenant_admin only
  (D2). `StockMovement.integrationState` gains `erp_neutral` (5 acknowledged
  oasdiff findings, `consumer:none`). Migration `0056_inventory_position_events`
  (+ guarded down) and `docs/operations/sql/inventory-position-events-domain-grants.sql`
  (deploy step 2; boot check). No package or CI change.
- RT-662 `[GATED]`, owner-approved 2026-10-19 (RT-644 ENT-BC1,
  AD-AI-ENT-001): OpenAPI contract `ai-entitlements.openapi.yaml`
  (1.0.0-draft, contract-only). `consoleGetTenantAiEntitlements`
  (`GET /api/v1/tenants/{tenant_id}/ai/entitlements`) returns the `full`
  view to owner / tenant_admin (state, effective dates, per-feature
  availability, tenant opt-outs, UTC request meters) and the `minimal`
  `available | unavailable` view to store_manager; store_staff, another
  tenant and an absent tenant get the same non-disclosing 404, decided
  before any entitlement read; 503 `entitlement_unavailable` fails closed.
  `consolePutTenantAiFeatureOptOut` (`PUT .../ai/entitlements/opt-outs/
  {feature_id}`) is the owner-only, subtract-only opt-out write (D-5):
  required `reason`, `Idempotency-Key`, audited
  `ai_entitlement.opt_out_changed`, guarded by its own `optOutVersion`
  (never `entitlementVersion`), 403 `origin_rejected`, 409 on a stale
  revision, 422 `not_entitled` for an opt-in beyond the plan. The full view
  and every `check` decision report both `entitlementVersion` and
  `optOutVersion`. Also the closed AI reason-code set (§4.4 plus `feature_disabled_tenant`)
  and the server-internal `check` input and decision schemas
  (`x-internal`, no HTTP route). No price, currency, plan name, quota size,
  billing event or grace duration. No runtime or migration change; the
  runtime ships in RT-664.
- RT-649 / RT-739: runtime for `consoleGetSalesSummary` (`ConsoleSalesSummaryController`
  and service in `ConsoleSalesModule`); the operation loses
  `x-runtime-status: contract-only`. One SQL statement (one snapshot) counts
  and sums every fact per store, business date, currency and state through
  tenant RLS and the explicit operator store scope; legacy refunds and shift
  closes are bucketed by the store-local date of their instant (`AT TIME
  ZONE`, DST-correct); sums are added as exact BigInt decimals. Audited
  `console_sales.summary_read` (read kind), console rate limit class
  `expensiveRead`. No migration, package, lockfile or CI change. RT-739
  lands the runtime of #861, which had merged into a stacked branch rather
  than `main`.
- RT-565 `[GATED]`, owner-approved 2026-10-19 (RT-565 comment 12969, D1–D7 of
  `docs/planning/rt-565-posting-freshness-read.md`):
  `erpnext-sync-ops/console-sync-ops.yaml` 1.2.0-draft (additive).
  `consoleGetSyncOpsSummary` gains a required top-level `asOf` and a
  required `postingFreshness`: `lastPosted` (`state` `known` / `unknown` /
  `none` and its ERP confirmation time), `pendingCount`, `oldestPendingAt`
  and `oldestPendingAgeSeconds`. Facts only, no current / behind verdict;
  the `posting` domain rule, roles, session, RLS, store scope and the
  out-of-scope 404 are unchanged. No runtime or migration change; the read
  and its indexes ship in the RT-565 runtime PR.
- RT-663 `[GATED]` migration `0055_ai_entitlements_usage` (owner-approved
  2026-10-19 for authoring and CI verification only; not applied to any lab
  or live database). It is storage only, for AD-AI-ENT-001 and
  AD-AI-PROV-001 D-6, and has no runtime until RT-664. It adds:
  - the code-owned, versioned, default-deny AI plan catalog (seed `core@1`
    grants no feature and no meter);
  - immutable `tenant_ai_entitlements` revisions on a tenant-wide
    `entitlement_version` chain, platform-admin INSERT only;
  - the tenant owner opt-out chain `tenant_ai_feature_opt_outs` (D-5);
  - `ai_usage_counters` per tenant, store, meter and UTC window;
  - the single append-only `ai_usage_ledger`: `reserved`, then
    `committed` / `released`, unique (tenant, feature, kind, idempotency_key),
    with the AI-09 run metadata. A dispute is settled by a platform-admin-only
    compensating `adjusted` row (T20).

  Every table forces RLS. There is no price column and no grant.
- RT-565 `[GATED]` migrations 0057-0061, owner-approved 2026-10-19 (RT-565
  comment 12969): runtime for the console posting freshness. The sync-ops
  summary now serves `asOf` and `postingFreshness`
  (`apps/api/src/catalog/erpnext-sync-ops/posting-freshness.read.ts`): one
  statement, so one snapshot, with `asOf` = `clock_timestamp()` taken inside
  it; tenant-wide probes, or one `LATERAL ... LIMIT 1` probe per store for a
  `store_id` filter or an RT-192 membership scope. Five partial indexes on
  `erpnext_posting_status` (D7), one `CREATE INDEX CONCURRENTLY` file each
  (the 0048 rule): posted_at tenant-first and store-first, pending created_at
  tenant-first and store-first, and the fixed-size pre-0042 legacy-posted
  set. Roles, RLS, store scope and the 404 are unchanged. No package or CI
  change.
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

### Changed
- RT-616: successful `GET /api/v1/health/live` probes are no longer logged
  (owner decision on RT-600, 2026-10-17; VN-S6 POS terminals probe every
  10 s). `LoggingInterceptor` skips the "request completed" line for a < 400
  answer on that route template; a failure on it is still logged and HTTP
  metrics are still emitted. The `Caddyfile` proxies the route through its own
  `handle` block whose `handle_response` sets `log_skip` for a 2xx/3xx
  upstream answer only, so an upstream error, timeout or 4xx/5xx still writes
  an access-log line. `/ready` and every other route log as before. No
  contract or response change. Applying the `Caddyfile` on the pilot edge is a
  separate deploy step.
- RT-368 `[GATED]`, pending owner approval: `consoleListDevices` without
  `trust_state` no longer lists retired devices (RT-368 scope, decision R1):
  a default-behaviour change to a live operation. Retired devices stay
  queryable with `trust_state=retired` and by id. Admin-Console RT-371's fleet
  table stops showing them unless it filters for them; RT-372 adds a retired
  filter. Production keeps the old default until the RT-368 runtime ships
  (an `x-runtime-note` says so until then).
- RT-113 BC1: `pos-operators.openapi.yaml` 1.1.1-draft is a prose-only fix.
  The roster and active-session descriptions now match the `security` block
  and the runtime (RT-182): an operator-identity JWT, an RT-150
  manager-eligible caller, a `branch_id` the runtime requires, and no device
  token read.
- RT-208 `[GATED]`: `pos-operators.openapi.yaml` 1.2.0-draft declares the
  roster `branch_id` query parameter `required: true`, matching the runtime's
  `branch_id_required` refusal (still the generic 401). Acknowledged oasdiff
  ERR `request-parameter-became-required`. No runtime change.
- RT-417 `[GATED]`, owner-authorized 2026-10-12 (RT-417 comment 11671; owner
  decision R-1, RT-413 comment 11669): the contracts for payer
  responsibilities captured on the sale (035 narrowed to Option B).
  `settlement/settlement.yaml` 2.0.0 is BREAKING, replacing the stale
  1.0.0-draft: only `consoleCreatePayerAccount` and `consoleListPayerAccounts`
  remain (still contract-only until RT-418); `consoleApplyPayment`,
  `consoleSubmitClaim`, `consoleReconcileRemittance`,
  `posRecordSettlementIntent`, `consoleGetReceivable` and
  `consoleListReceivables` are removed (listed in `x-retired-operations`; the
  runtime keeps serving them until RT-422); `PayerAccountCreate.creditTerms` is
  removed and `externalRef` is the ERPNext Customer link.
  `pos-sales/sales.yaml` 1.10.0-draft (additive): optional
  `CaptureSaleRequest.responsibilities[{payerRef, amount, sequence}]`, the
  coverage rule `sum(tenders) + sum(responsibilities) = posTotal` (422
  `sale_responsibility_mismatch`), 422 `sale_responsibility_payer_invalid`,
  hashed into the payload, and an optional `Sale.responsibilities`.
  Responsibilities are accepted only on the `operatorAuthorization` path,
  captured synchronously before finalize; on the device path they are 422
  `sale_responsibility_offline_refused` (owner decision 2026-10-16, option A),
  and an envelope operator outside owner / tenant_admin / store_manager gets 403
  `sale_responsibility_role_refused` (the capture 403 is now `CaptureForbidden`,
  carrying it and the RT-224 `refused`). One payer per sale in this version
  (`maxItems: 1`: one Sales Invoice and one `documentRef` per work item), and a
  non-null `PayerAccountCreate.externalRef` must be nonblank.
  `erpnext-connector/posting-feed.yaml` 1.8.0-draft (additive):
  `Sale.responsibilities[{payerExternalRef, amount, sequence}]`, failing closed
  for an unmapped payer; such sales and their reversals are held off the feed
  until the Connector supports them (RT-419). Acknowledged oasdiff findings for
  the settlement removals. Recorded as Amendment A2 in the 035 decision record.
  No runtime or migration change.

### Security
- RT-430 `[GATED]`, owner-approved 2026-10-12 (decisions recorded on RT-430):
  CSRF hardening. Every `POST`, `PUT`, `PATCH` or `DELETE` authenticated by
  the `dp2_session` cookie must carry an `Origin` that is the API's own
  origin (from `Host`; `https` wherever the cookie is `Secure`) or is listed
  in `ALLOWED_ORIGINS`; otherwise 403 `origin_rejected`, before the session
  lookup. A missing `Origin` is refused. Sign-in refuses a foreign `Origin`
  and admits a missing one. Bearer, POS device-token and operator-envelope
  requests are not checked. One implementation (`auth/origin-check.ts`)
  serves this and the RT-414 support-session rule. The cookie-auth contracts
  document the 403 (additive under oasdiff). Non-browser cookie clients must
  now send `Origin`; the Schemathesis harness does. No migration.

## [0.1.0] — Foundation backend — 2026-05-12

### Added

#### Workspace and package layer
- pnpm workspace with two deployable services (`apps/api`, `apps/worker`)
  and four internal packages (`packages/auth`, `packages/contracts`,
  `packages/db`, `packages/shared`).
- Shared primitives: Zod base schemas, error envelope, pino logger factory
  with `tenant_id`/`request_id` binding, OpenTelemetry SDK setup (HTTP,
  Postgres, Redis, BullMQ instrumentations), UUIDv7 generator with UUIDv4
  fallback, idempotency key store (Redis-primary, Postgres-mirror).

#### Database schema and migrations
- Drizzle schema for all foundation entities: `users`, `tenants`, `stores`,
  `memberships`, `store_access`, `roles`, `permissions`, `role_permissions`,
  `sessions`, `auth_tokens` (with reserved `device_id` POS seam column),
  `invitations`, `audit_events`, `idempotency_keys`.
- Explicit SQL migration `packages/db/drizzle/0000_initial.sql` with
  rollback: `citext` extension, tables in dependency order, FK and CHECK
  constraints, `updated_at` triggers, RLS enabled and policies applied.
- `withTenant` query proxy and DB-session middleware that issues
  `SET LOCAL app.current_tenant` and `SET LOCAL app.is_platform_admin`
  per transaction.
- Testcontainers-backed migration integration test verifying all tables,
  FKs, partial uniques, CHECK constraints, RLS policies, and triggers.

#### API — auth
- `AuthGuard` (cookie + bearer token paths), `AuthService` (sign-in,
  password verify, argon2id, account lockout), `AuthController` (sign-in,
  sign-out, refresh, password-reset request/confirm,
  email-verify request/confirm).
- `SessionRepository` (PostgreSQL source of truth, Redis read-through cache),
  `AuthTokenRepository` (opaque SHA-256 token hash, revocation, expiry).
- Rate-limit helper: per-account 5/15 min, per-IP 30/hour (Redis-backed).
- `@Roles()` decorator + `RolesGuard`; predefined v1 role catalog with
  forward-compatible permissions table.

#### API — tenants, stores, and memberships
- `TenantsController` + `TenantsService`: CRUD, slug uniqueness,
  cross-tenant isolation, platform-admin gating, soft-delete.
- `StoresController` + `StoresService`: CRUD within active tenant,
  store-code uniqueness, cross-store isolation.
- `InvitationsController` + `InvitationsService`: create, accept, revoke,
  expiry; invitation token visible once, only hash persisted.
- `MembershipsController` + `MembershipsService`: role and store-access
  updates, membership revocation with audit.

#### API — active context
- `TenantContextGuard` and `ContextController`/`ContextService`: active
  tenant switch, active store switch/clear; cross-tenant store attempts
  return 404 indistinguishable from not-found (FR-ISO-4).
- DB middleware wires `app.current_tenant` GUC into the NestJS request
  lifecycle for every authenticated request.

#### API — audit
- `AuditEmitter` interceptor enqueues a BullMQ job for each auditable
  action: auth sign-in (success/failure), role/access changes, context
  switch, soft-delete, platform-admin cross-tenant operations.
- `AuditController` + `AuditService`: filters by action prefix, actor,
  store, time range; cursor pagination; tenant-scoped; tenant-admin gated.
- PII/credential redaction enforced at the logger boundary; audit rows
  are insert-only at the application layer.

#### API — common infrastructure
- `RequestIdInterceptor` (UUID assignment + response header),
  `LoggingInterceptor` (pino per-request line, no secrets),
  global `ExceptionFilter` (uniform error envelope; 404 = 403 = cross-tenant
  per FR-ISO-4), Zod `ValidationPipe`.
- OpenAPI loader reads YAMLs from `packages/contracts/openapi/` at startup.

#### Worker foundations
- NestJS standalone worker bootstrap with BullMQ connection and graceful
  shutdown.
- BullMQ default options module with configurable retry/backoff/DLQ
  defaults across all queues.
- Email processor (verify + password-reset flows) with provider-agnostic
  adapter interface (no concrete provider chosen — PQ-1 stub).
- `audit-fanout` processor: consumes BullMQ, inserts `audit_events` row;
  retry/backoff; DLQ on terminal failure.
- `session-revoke` processor: admin-initiated session revocation propagates
  within ≤5 minutes (FR-AUTH-6); processor and registry layer complete.
- Soft-delete sweep processor layer (T312): processor slice scaffolded;
  runtime scheduling is not yet wired (Layer A only).
- OpenTelemetry trace context propagation from API → worker via BullMQ
  job payload (`trace_id`/`span_id` flows through `audit-fanout`,
  `session-revoke`, and email queues).

#### Contracts and conformance
- OpenAPI 3.1 YAML contracts of record under `packages/contracts/openapi/`
  for auth, tenants, stores, context, memberships, and audit domains.
- Contract-conformance test coverage for `GET /tenants`, `GET /stores`,
  and `PATCH /memberships` endpoints (additional slices in progress).

#### Coverage and quality
- Jest coverage threshold ≥ 80% configured at repo root and per-app.
- Unit coverage established across all core repositories, services,
  controllers, guards, interceptors, and worker processors.
- Codecov reporting integrated via CI.

#### Documentation
- `README.md` quickstart pointer links to
  `specs/001-foundation-auth-tenant-store/quickstart.md`.
- Foundation spec, plan, data model, contracts, and 140-task implementation
  plan under `specs/001-foundation-auth-tenant-store/`.

### Notes
- Dashboard UI and POS application are out of scope and not implemented.
- POS sync API endpoints are not implemented; `/api/pos/v1/*` namespace
  is reserved (returns the standard not-found envelope).
- T311 audit log retention policy is not yet implemented (pending
  retention schema and design decisions).
- T312 soft-delete sweep processor layer is complete; runtime scheduling
  is not yet wired.
- T309 SC-1..SC-9 verification and T308 Constitution post-implementation
  sign-off are not yet recorded.
- Product catalog, inventory, orders, payments, billing, reports,
  analytics, dbt, and ClickHouse are explicitly out of scope.

## [0.1.0-foundation] — Planning baseline

### Added
- Project Constitution v2.0.0 (`.specify/memory/constitution.md`).
- Foundation feature spec, plan, contracts (OpenAPI 3.1), data model,
  quickstart, and 140-task implementation plan under
  `specs/001-foundation-auth-tenant-store/`.

### Notes
- No application code shipped at this baseline.
- Dashboard UI, POS app, POS sync, product catalog, inventory, orders,
  payments, billing, reports, and analytics/dbt are explicitly out of
  scope of the foundation feature.
