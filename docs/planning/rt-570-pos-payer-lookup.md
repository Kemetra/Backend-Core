# RT-570 — POS-facing payer lookup for the till: decision record and contract

> **Status:** decision record + `[GATED]` contract (Work Mode: **Planning** then contract-only; owner authorization
> Jira RT-570 comment 13213, 2026-10-21; the contract PR is still reviewed before merge).
> **Jira holds the live status.** This file records the 2026-10-21 planning pass and is not a status tracker.
>
> No runtime, migration, package, CI, Connector or POS change. The contract is
> `packages/contracts/openapi/pos-payers.openapi.yaml` (`1.0.0-draft`, operation `posListChargeablePayers`,
> `x-runtime-status: contract-only`).
>
> **Sources:** Jira RT-570, RT-417 (Done), RT-418 (runtime, In Review), RT-420 (POS re-scope, To Do);
> Backend-Core `origin/main` **`ce5b616c`** (read-only inspection of `settlement/settlement.yaml` 2.2.0,
> `pos-sales/sales.yaml` 1.13.0-draft, `pos-sales/sale-history.yaml`, `pos-approvers.openapi.yaml`,
> `apps/api/src/catalog/sales/sale-responsibilities.ts`, `packages/shared/src/observability/span-redaction.ts`).
> POS, Connector and Admin-Console were **not inspected**. No runtime was exercised.

---

## 1. The need

Under the RT-417 owner decision (option A, 2026-10-16) a manager or admin at the till attaches
`responsibilities[]` with `payerRef`s to a sale and captures it synchronously, online, on the
`operatorAuthorization` envelope path. The till has no way to obtain a valid `payerRef`: the only payer read,
`consoleListPayerAccounts`, accepts the dashboard cookie only. Without a read, POS RT-420 would hit 422
`sale_responsibility_payer_invalid` (an unknown, suspended, other-store or unlinked payer) in the normal case.

## 2. Options for what the read returns

What `main` makes true: ERPNext owns credit limits, balances and terms (settlement.yaml, Payment & Receivables
baseline). Backend-Core holds no balance. Capture's payer check (`assertResponsibilityPayersEligible`) is
structural only: `active`, same tenant, scoped to the sale's store or tenant-wide, non-blank `external_ref`.

| Option | Returns | Verdict |
| --- | --- | --- |
| **O1** | Only payers that pass the capture predicate, no flags | Smallest, but an unlinked payer is silently missing: the manager cannot tell "not linked, ask an admin" from "no such payer". |
| **O2** | Active payers in the store scope, each with `erpCustomerLinked` and a server `chargeable` | **Chosen.** Answers "may I charge this payer now" and shows the one fixable cause. |
| **O3** | Every status, with an `eligible` + reason enum | Rejected: discloses suspended payers and a reason taxonomy the till does not need. |
| **O4** | A real credit decision (limit, balance, terms) | Rejected: the data is in ERPNext; a synchronous Connector call from the till breaks `POS -> Backend-Core -> Connector`, and it contradicts option A's offline posture. |

**Decision: O2.** "Credit decision" in v1 is the structural `chargeable` flag only, stated normatively as not a
credit-limit or balance decision.

## 3. The contract (summary; the YAML is normative)

`GET /api/pos/v1/payer-accounts`, `operatorAuthorization` only, no device scheme.

- **Scope:** tenant and store from the verified envelope; no scope parameter. Items: payers of the tenant that
  are `active` and store-scoped to this store or tenant-wide. Suspended, other-store and other-tenant payers are
  **absent** (no 404, no marker), so the read is not a probe.
- **Role:** the operator must NOW be an active `owner` / `tenant_admin` / `store_manager` with access to the
  store, else 403 `sale_responsibility_role_refused` (the code and body capture uses; one POS mapping). The server
  can issue an envelope to a cashier (RT-417 / RT-530), which is why this is a 403 and not the generic 401 the
  `sale-history.yaml` scheme text describes. Outcome order: 401, 403, 400, 200; 429 from the rate limit.
- **Item (minimum disclosure):** `payerRef`, `displayName`, `category`, `erpCustomerLinked`, `chargeable`. Never
  `externalRef`, `storeId`, `status`, `version`, credit data, contact data or tenant. A schema guard makes
  `erpCustomerLinked: false` imply `chargeable: false`.
- **`chargeable` == capture's refusal-4 predicate, one shared implementation.** In v1 it equals
  `erpCustomerLinked` (every item is already active and in scope). The flag exists so a later predicate (a credit
  hold) is not a breaking change.
- **Advisory, not a reservation.** The read changes and locks nothing; capture re-checks under lock and stays the
  authority (a stale read surfaces as the 422 before finalize). `asOf` reports freshness.
- **Paging:** `payerRef` descending, keyset, `category`, `cursor`, `page_size` 1..200 (default 50). The cursor
  holds only an id. `Cache-Control: no-store`.
- **No audit event, no idempotency key** (read-only; a charge is audited by its sale).

### 3.1 Offline (explicit)

Option A forbids offline credit (device-path `responsibilities` is 422 `sale_responsibility_offline_refused`).
This read is an online call made when a manager attaches payers, so **v1 defines no offline freshness, expiry,
cache-validity or staleness rule**, and the till must not persist the result for offline use. A later
offline-credit mode needs its own decision and a new contract version (RT-413 R-1).

### 3.2 Why there is no `q` search in v1

A name typed into a query string would put a payer (a `credit_customer` can be a person) in a URL, and an
ordered-by-name keyset cursor would carry a name. OpenTelemetry spans have URL queries stripped at the export
boundary (`span-redaction.ts`, RT-609) and the app logger logs route templates, but reverse-proxy and
access logs are outside what this repository can prove. The till filters a page on the device (payer counts per
store are expected small; **NOT VERIFIED**). `q` can be added later as an optional query parameter, which is not a
breaking change.

## 4. Open points and follow-ups

- **Runtime issue (not authorized here):** the controller, an envelope guard with the role standing check, the
  shared payer predicate extracted from `assertResponsibilityPayersEligible` so read and capture cannot drift, and
  the rate limit. No migration expected: `payer_account` already carries `store_id`, `status`, `external_ref`.
  Whether `payer_account` has an index serving `(tenant_id, id DESC)` with the store predicate was **not checked**.
- **POS RT-420** consumes this contract; it must treat `chargeable: true` as advisory.
- **Console repair path** already exists (`consoleUpdatePayerAccount`, RT-572); the till only points the manager
  at it.
- The envelope-role / 403 wording differs from `sale-history.yaml`'s "every refusal is a generic 401" scheme text;
  that file is not edited here. A later cleanup can align the wording.
