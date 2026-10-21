# RT-719 — POS build identity per device: contract design and migration proposal

> **Status:** `[GATED]` contract PR plus a **migration proposal** (Work Mode: Implementation, contract step only).
> **Jira holds the live status.** This file records the 2026-10-21 design pass and is not a status tracker.
>
> This change is OpenAPI plus tests plus this note. It contains **no runtime code, no SQL under
> `packages/db/drizzle/` and no POS change**. The migration, the runtime and the POS change each need their own
> explicit approval (RT-719 constraints). The migration in §5 is a **proposal in prose**, not an applied or authored
> migration.
>
> **Sources:** Jira RT-719, RT-713, RT-327; RT-709 §C.1 (`pos-supported.yaml` format); Orchestrator
> `AD-DEVICE-001` (read-only); POS `contracts/backend-core/PIN` and `scripts/contracts-pin.ts` (read-only);
> Backend-Core `origin/main` `ce5b616c`.

---

## 1. The need

RT-713's no-false-green rule needs a fleet baseline as its authority: which POS builds are actually installed. Until
now Backend-Core records `deviceId`, `storeId`, `label`, `trustState`, `lastSeenAt` and `lastSeenSource` and no build
or version, so the baseline is a manual owner-attested inventory in Jira (RT-709 §C.1, "Prerequisite gap").

## 2. What the contract adds

| Piece | Where | Shape |
| --- | --- | --- |
| Report | optional request headers `X-POS-Build-Commit`, `X-POS-App-Version`, `X-POS-Contract-Pin` on the 13 operations behind `PosDeviceAuthGuard` (the RT-639 set) | commit: 40 lower-case hex; version: semver, at most 32, no build metadata; pin: 40 lower-case hex |
| Rules | `pos-terminal-pairing.openapi.yaml` 1.3.0-draft, "Build identity report (RT-719)" | stated once; no new operation |
| Read, per device | `consoleListDeviceBuilds` (`console-device-builds.openapi.yaml` 1.0.0-draft, contract-only) | one row per device: `buildIdentity` or an explicit `null` |
| Read, baseline | `consoleGetFleetBaseline` (same file, contract-only) | distinct builds on the active devices in scope, a device count each, and `unknownDeviceCount` |

`DeviceSummary` and `DeviceDetail` are **not** changed: both are closed projections whose every key is always present
(`devices.contract.spec.ts` pins it) and both operations are served, so a required key would fail the served runtime
and an optional one would break the rule. The Devices page joins the new rows by `deviceId`.

The baseline entries map one to one onto RT-709 §C.1 `fleet_baseline.installed`: `kind: release` with `posVersion`
when a version is known, else `kind: build` with `buildId` (the POS commit). `generatedAt` is the `captured_at`.
`unknownDeviceCount > 0` means the fleet is not fully known; RT-713 must treat that as not proven.

The identity is **three values, not one hash**: the POS PIN identifies a snapshot by the Backend-Core `commit` plus
per-file blob SHAs, and RT-713 resolves a build's snapshot from that build's own PIN. `contractPinCommit` is therefore a
cross-check and not the join key; the join key is `buildId` (or `posVersion`).

## 3. Privacy review

| Question | Answer |
| --- | --- |
| PII? | None. A commit, a version, a Backend-Core commit and a server timestamp. No user, cashier, hostname, machine id, IP, path or token. |
| Free text? | None. Every value is a closed pattern with a length bound; `additionalProperties: false` on every body. |
| Secret exposure? | A commit and a version are public build facts. Nothing is derived from a credential. |
| New egress? | None. Stored in Backend-Core's own database only. |
| Terminal time trusted? | No. `reportedAt` is the server clock. |
| Trust signal? | No. Self-reported; it never changes trust, rotation, an expiry, a grant or any refusal. It can be wrong or false; it is an inventory signal. |
| Cross-tenant read? | No. Both reads are tenant and store scoped (RLS plus the store predicate; store scope has no database backstop). |

## 4. Compatibility

- **Old POS.** Sends none of the headers; every route behaves as before; the device reads `buildIdentity: null` and is
  counted in `unknownDeviceCount`. Unknown is never a default, never "latest".
- **RT-370 activity writer.** `device-activity.ts` writes `last_seen_at` at most once per 5 minutes per device
  (in process and in the database, `UPDATE ... WHERE last_seen_at IS NULL OR last_seen_at < now() - interval`),
  best effort, never awaited, and never for a revoked device. The identity is stored by that same statement, so it
  inherits the throttle, the row-lock behaviour and the "failure never reaches the response" rule. Consequences the
  contract states: `reportedAt` is the server clock of the last store, not of the last request; a changed build shows
  after the next write window (up to 5 minutes); `lastSeenAt` and `lastSeenSource` are unchanged.
- **RT-639 rotate-soon headers.** Same 13 operations, response side; this is the request side. Neither touches the
  other. `posRotateTerminalToken` and `posPairTerminal` carry neither set.
- **RT-327 / AD-DEVICE-001 heartbeat.** Not pre-empted. The heartbeat's `app_version` is the same value, bound and
  name as `X-POS-App-Version`, so it can carry the three values later. This change fixes nothing about the heartbeat's
  body, its `device_health` table, its policy or its compliance reply. The two do not conflict: the headers are the
  per-request inventory signal; the heartbeat is the liveness-and-update-state channel. If the owner prefers one
  channel, RT-327 can absorb the three values and this rule can be retired in a later additive contract.
- **oasdiff.** Additive only: new optional request header parameters on existing operations, a new contract file,
  two new contract-only operations. No request body is touched, so the request-body-combinator pitfall does not apply.

## 5. Migration proposal (NOT authored, NOT applied; needs its own approval)

**Recommended: four nullable columns on `devices`**, no new table.

| Column | Type | Constraint |
| --- | --- | --- |
| `build_commit` | `text` | `NULL` or `~ '^[0-9a-f]{40}$'` |
| `app_version` | `text` | `NULL` or length 5..32 and the semver pattern in the contract |
| `contract_pin_commit` | `text` | `NULL` or `~ '^[0-9a-f]{40}$'` |
| `build_reported_at` | `timestamptz` | `NULL` exactly when `build_commit` is `NULL` |

Also a CHECK that `app_version` and `contract_pin_commit` are `NULL` when `build_commit` is `NULL` (the contract's
"ignored without a valid commit").

- **Why `devices`.** The write rides the existing RT-370 `UPDATE` on the same row, the table is already `FORCE` RLS by
  tenant, and the domain role already has table-level `UPDATE` (RT-365 grant), so no new RLS policy and no new grant.
  The store predicate is applied in the read query, as on the devices reads.
- **Lock profile.** `ADD COLUMN` nullable with no default is catalog-only, and every new column is `NULL`, so the CHECKs
  validate over an all-NULL column of a small table. The 0040 precedent adds its CHECKs plainly in one transaction
  (`ACCESS EXCLUSIVE` on `devices`, nothing rewritten); follow it, and state the lock in the migration header.
- **Rollback.** A `.down.sql` that drops the CHECKs then the columns. No data to preserve beyond the inventory.
- **No backfill.** Existing devices stay `NULL` (unknown) until they report.
- **Index.** None in v1: the baseline groups one tenant's devices, a small set. Revisit with real volumes.
- **Alternatives considered.** (1) A separate `device_build_identities` table: isolates the hot row but adds a table,
  RLS policy, grant and a join for a handful of bytes. (2) Waiting for RT-327's `device_health` table: the cleanest
  home long term, but it is not authored and RT-719 is a pre-monorepo prerequisite. If RT-327 ships first the owner can
  point the migration there instead; the contract does not change.

## 6. Runtime proposal (separate approval)

1. A pure `parseBuildIdentityHeaders(headers)`: exactly one value per header, each against its closed pattern; any
   failure of the commit yields `unknown`; the version and pin are kept only with a valid commit. Never throws.
2. Extend `TOUCH_SQL` in `device-activity.ts` to set the three columns and `build_reported_at` in the same guarded
   `UPDATE`, from the guard's request context; unknown writes `NULL`s. **Only the 13 documented operations may
   set or clear it.** `deviceActivity.record` is also reached by the rotate guard (`recordActivity`) and by the
   operator-context resolver, which carry no headers by contract; those callers must keep passing no identity and
   leave the stored columns untouched (a separate statement or a `COALESCE`-free variant, not the unknown path).
3. `consoleListDeviceBuilds` and `consoleGetFleetBaseline`, `cookieAuth`, roles `owner` / `tenant_admin` /
   `store_manager`, store scope as the devices reads; baseline from one snapshot over the active devices; audited
   `devices.builds_listed` and `devices.fleet_baseline_read`; rate-limit classes `cheapRead` and `expensiveRead`
   (the ratchet already lists them).
4. Tests: header parsing (valid, repeated, upper-case, short, version with build metadata), the throttled write, RLS
   and role tests for the reads (tenant A cannot see tenant B; `store_manager` out-of-scope store is the non-disclosing
   404; `store_staff` 404), an old-POS fixture without headers still accepted on each of the 13 routes, and the baseline
   arithmetic.
5. A lab terminal reports its build and the baseline lists it (RT-719 acceptance), after the POS change below.

## 7. POS dependency (not in this change)

POS sends the three headers on every device-token request after it repins this contract (`contracts/backend-core/PIN`;
the build commit and the PIN `commit` line are both available at build time). That change belongs to `Kemetra/POS` and
is coordinated through the contracts PIN; it is not started here.

## 8. Decisions for the owner

1. **Reporting channel.** Optional headers on the existing device routes (this proposal) or a dedicated report
   operation. The headers add no operation and ride the activity writer; a dedicated operation is a smaller contract
   diff but a second device-to-Backend-Core channel beside RT-327's heartbeat.
2. **Baseline scope.** Tenant and store scoped under the existing cookie guards (this proposal). A platform-wide,
   cross-tenant baseline is a new authorization surface and is not proposed; RT-713 would read per-tenant output.
3. **Storage.** Columns on `devices` (recommended) or a separate table, and whether to home it in RT-327's
   `device_health` once that exists.
4. **Missing means unknown.** A request to one of the 13 documented operations without a valid commit clears the
   stored identity at the next write window, so a rolled-back older build is never shown as the newer one. This
   requires the terminal to send the headers on every request to those operations. Other device-token routes (the
   rotation, operator paths) neither record nor clear it.
