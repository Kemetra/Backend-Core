# RT-231 — Retail Tower Mobile: Product & Architecture Package

| | |
|---|---|
| **Jira** | RT-231 (Planning, parent RT-7). Post-pilot productization planning. This is **not** implementation authorization. |
| **Baseline** | `Kemetra/Backend-Core` `origin/main` @ `ddae78a7` (2026-10-15). |
| **Durable home** | This package updates Confluence RETAIL page 21233665, "Retail Tower Mobile — Product & Architecture Plan". It does not replace it. |
| **Status** | PROPOSED, awaiting owner rulings on D1–D9 (§16). The PD-1..PD-3 decisions and all recommendations are proposals, not ratified decisions. Confluence 21233665 is updated only after the rulings. |
| **Delegates to** | RT-230 (continuity semantics), RT-18 (Admin shift/cash review), RT-232 (authority matrix), RT-138 (device trust), RT-135 (audit). |

---

## 0. Fixed inputs (ratified, not reopened here)

These decisions are already owner-approved. This package builds on them and does not re-litigate them.

| # | Fixed input | Source |
|---|---|---|
| F1 | Mobile is an **additional client** of Backend-Core and never calls ERPNext. No BFF by preference. | RT-231 description |
| F2 | Manager Mobile MVP is **read-heavy**. Privileged writes are deferred to a bounded Phase 2 and reuse server authority plus full audit. | RT-232 / comment 10969 |
| F3 | Mobile shows **high-signal audit/ops summaries**, not the full audit log, in V1. | 10969 |
| F4 | Mobile may **review/approve** return-related work but **never executes refunds** in V1. | 10969 |
| F5 | Multi-store V1 uses the existing `owner` / `tenant_admin` roles plus store scope. There is **no Area Manager role** and no new hard-coded V1 role. | 10969; Org 183 |
| F6 | Store managers acknowledge Operational Attention within their store scope. **Acknowledge = "seen"** only; it is never approve, accept or resolve. | Operational Support §C/§K |
| F7 | Mobile is never a dependency for safe POS operation or for RT-114 offline manager approval. | Authority matrix Rule D |
| F8 | Leading technology hypothesis: **React Native + TypeScript + Expo (dev builds)**. Flutter is not rejected. Native Kotlin/Swift is not the default. A bounded PoC confirms the choice. | comment 10953 |
| F9 | A **Marketplace Reuse Scan** is mandatory before any PoC. | comment 10959 |
| F10 | Mobile devices are future **managed clients of the Device Registry**. Device actions stay semantically distinct, with **no generic "Deactivate"**. | Device Registry page |
| F11 | Chain / Store Group / Store scopes govern the capability matrix. | Policy §2 |

---

## 1. Personas and role/capability matrix

### 1.1 Personas mapped to existing authority

| Persona | Backed by (no new role, per F5) | Scope | Mobile posture |
|---|---|---|---|
| **Cashier** | `store_staff` via cashier admission (RT-113/RT-224) | one store | **No normal mobile access.** Continuity Mode only, owned by RT-230. |
| **Store Manager** | `store_manager`, or `tenant_admin` with specific stores | granted stores | Primary MVP persona. |
| **Owner / Area Manager** | `owner` (always all-store) or `tenant_admin` (all-store or multi-specific) | all or multiple stores | Phase 4 multi-store, using the same reads aggregated across scope. |

### 1.2 Capability matrix

Legend: **M-RO** = Mobile read-only · **M-ACT** = Mobile action allowed · **ADM** = Admin Console only · **POS** = POS only. The Phase column gives the earliest phase in which the capability appears on Mobile.

| Capability | Cashier | Store Mgr | Owner/TA | Class | Phase | Notes |
|---|---|---|---|---|---|---|
| Store/today snapshot | — | ✓ | ✓ | M-RO | **MVP** | Needs a projection (G6). |
| Active shift status | — | ✓ | ✓ | M-RO | **MVP** | Needs a dashboard read of open shifts (G4). |
| Cash variance / shift exception view | — | ✓ | ✓ | M-RO | **MVP** | Same facts as RT-18 (`shift-closes`). No second model. |
| Variance acceptance | — | (POS) | (POS/ADM) | POS / ADM | later | RT-114 offline POS path stays primary. A Mobile action waits on RT-236 and the owning domain. |
| Terminal/device health | — | ✓ | ✓ | M-RO | **MVP** | RT-138 `last_seen_at` only; Unknown is never shown as Healthy (G3). |
| Device revoke (lost/compromised) | — | ✓ granted stores | ✓ | M-ACT | Phase 2 (first) | RT-138 authority. A security action that is valuable on mobile. |
| Pairing-code issue / re-pair / retire | — | — | — | ADM | — | Ceremony belongs on Admin and POS. |
| High-signal alerts (view) | — | ✓ | ✓ | M-RO | **MVP** (in-app list) | Push delivery is Phase 1b (D5). |
| Attention acknowledge ("seen") | — | ✓ | ✓ | M-ACT | Phase 1b | Authority decided (F6). Needs Attention persistence (G7). |
| Sale lookup | — | ✓ | ✓ | M-RO | **MVP** | No store_manager-usable read exists today (G5). |
| Return/refund review & approve | — | ✓ | ✓ | M-ACT | Phase 2 | F4: never executes. |
| Refund execution | — | — | — | POS | — | RT-14/RT-15. |
| Staff / active-session visibility | — | ✓ | ✓ | M-RO | **MVP** | Today only POS-device-scoped reads exist (G8). |
| End a cashier admission remotely | — | — | — | ADM | later | Classify under the cashier-admissions domain first. |
| Inventory glance (on-hand, movements) | — | ✓ | ✓ | M-RO | **MVP** | Existing route is reusable once a credential exists. Product search is a gap (G9). |
| Inventory / catalog mutation | — | — | — | ADM | — | RT-132 / ratified catalog authority. |
| Manager approval (discount, pay-in/out, PIN unlock) | — | — | — | POS | — | RT-114. Remote mobile approval is "later, optional, never required" (F7). |
| Audit / ops summaries | — | ✓ store-scoped | ✓ | M-RO | Phase 2 | F3. Full audit log stays ADM. |
| ERP / connector / sync-ops health summary | — | — | ✓ all-store | M-RO | Phase 4 | Existing routes are owner/tenant_admin only (RT-132 all-store rule). Recovery stays ADM. |
| Store / staff / membership administration | — | — | — | ADM | — | |
| Multi-store overview, KPIs, exceptions | — | — | ✓ | M-RO | Phase 4 | F5. Store scope is applied per store. |
| Continuity sale | ✓ (authorized) | — | — | M-ACT | Phase 3 | **RT-230 owns the semantics.** |

---

## 2. Surface responsibility matrix

| Concern | Electron POS | Admin Console | Retail Tower Mobile |
|---|---|---|---|
| Sale execution, tender, receipts, peripherals | **Owner** | — | Continuity only (RT-230) |
| Offline durability / outbox | **Owner** | — | None for Manager/Owner. Continuity only, under RT-230. |
| Local manager approval (RT-114) | **Owner** | — | Never required (F7) |
| Configuration, catalog, stores, staff, ERP mapping | — | **Owner** | — |
| Deep investigation, large tables, bulk | — | **Owner** | — |
| Shift/cash variance review | Close flow | **Deep review (RT-18)** | Fast review over the same facts |
| Alerts / Attention | Local recovery only | Inbox + recovery actions | Notification → view → ack → bounded typed action |
| Device fleet | Rotation (self) | Registry workbench, pairing | Health glance; revoke on loss (Phase 2) |
| Multi-store oversight | — | Full | Summary + drill-down (Phase 4) |

Rule: **same Backend-Core facts and contracts → Admin deep workflow plus Mobile fast workflow**. Mobile never defines business authority (Authority matrix Rule A).

---

## 3. Manager Mobile MVP (Phase 1)

**Goal:** within about 10 seconds of opening the app, a store manager knows whether the store is healthy and what needs attention, without walking to the back-office PC.

**In scope (all M-RO, connected-first):**
1. Store/today snapshot for one granted store, with a switcher across granted stores.
2. Active shift status: which terminals have an open shift, since when, and whether a stale or stuck shift exists.
3. Cash variance / shift exception list and detail, read-only, over `shift-closes`.
4. Terminal/device health: last seen, with Online/Stale/Unknown kept as separate states.
5. In-app alerts list (pull). This is an in-app view, not push.
6. Sale lookup by sale reference, plus a recent-sales list for the store. Lookup by a human-readable sale/receipt number depends on the sale-number concept the sibling POS planning item RT-249 is defining.
7. Staff/session visibility: who is signed in on which terminal now.
8. Inventory glance: on-hand for a product at the store.

**Explicitly out of MVP:** every write (ack, revoke, approvals, return review), push notifications, multi-store aggregate, audit summaries, cashier access, offline mode and any peripheral use.

**MVP success criteria (proposed):** a pilot manager uses it daily, no MVP read becomes a POS dependency, every read is store-scope-correct (tested), and no business data persists on the device beyond the session (§6.6, §7).

**Priority if the MVP must shrink:** 3 → 2 → 4 → 1 → 6 → 7 → 5 → 8. Shift/cash visibility is the strongest manager pain point and reuses the most existing facts.

---

## 4. Future Owner / Area Manager scope (Phase 4)

- Multi-store overview built from the same per-store reads and projections, aggregated only across the caller's resolved scope. There is no all-tenant shortcut for a `tenant_admin` with specific stores.
- Exception-first: stores with open variances, stale devices, posting backlog or open Attention.
- KPI snapshot (sales count/amount today vs. comparison period). The KPI definitions need their own contract, and mobile is not the BI system.
- Drill-down lands in the single-store manager screens. There is no Admin Console clone.
- Delegated "area scope" is introduced only when a concrete multi-store customer requires it (F5). Until then, an area manager is a `tenant_admin` with specific stores.

---

## 5. Integration architecture

```
Retail Tower Mobile (one app, capabilities gated by role + store scope)
  └─ Shared Mobile Core: auth · device identity · secure storage · API client ·
     capability resolution · notification intake · audit/request context · telemetry
                │  HTTPS, bearer credential (see §6), X-Request-Id, client/version header
                ▼
          Backend-Core  (authority: authn, authz, store scope, domain facts, audit)
                │
                ▼
       ERPNext-Connector → ERPNext   (never reached from Mobile)
```

- **No BFF.** Mobile consumes the same domain read contracts as Admin. Where one screen would need many round-trips (the store snapshot), add a **shared projection** in Backend-Core that Admin can also use, not a mobile-only service. A BFF is introduced only on a measured contract, security or operability need (F1).
- **Store scope is a service-layer duty.** Backend-Core RLS enforces **tenant** isolation only, and store-level authorization has no DB backstop. Every new route a mobile client consumes must apply the operator-surface store-scope rule in the service, as `shift-closes` and inventory already do, with non-disclosing 404s. Tests must prove that a store outside the caller's scope is refused. This matters most for Phase 4 aggregates.
- **Capability resolution:** the app derives visible features from `GET /api/v1/context/me` (role + store scope) and hides what the caller cannot use. Hiding is UX only. The server still decides on every request.
- **Deep links:** `retailtower://` and verified app links carry **opaque IDs only** (attention id, saleRef, store id), never PII or tokens. Opening a link re-runs auth and authorization, and a link to an out-of-scope object shows the same not-found as the API.

### 5.1 Backend-Core reuse map for the MVP (verified on `ddae78a7`)

| MVP item | Existing route(s) | Guard / credential today | Roles | Store scope | Verdict |
|---|---|---|---|---|---|
| Snapshot | — (no aggregate) | — | — | — | **Gap G6** |
| Active shifts | `GET /api/pos/v1/shifts/stuck` only (stale open shifts). `/api/pos/v1/shifts` is `POST` (open shift), not a read. | `@ClerkBearer` / POS operator identity | POS operator | operator's store | POS-only, and there is no general open-shift read at all → **Gap G4** (a new read, not an auth adaptation) |
| Variance / exceptions | `GET /api/v1/shift-closes`, `/{shiftId}` | `SessionOnlyAdminGuard`: **cookie only, any bearer → 401** | owner, tenant_admin, store_manager | service-enforced, 404 | Facts reusable; **blocked by G1/G2**. Covers **closed** shifts only (open → 404). |
| Device health | `POST /api/pos/v1/terminals/pair` only | device ceremony | — | — | RT-138 is Done as a plan. Migration `0040_device_lifecycle.sql` (RT-364, Done) already adds `last_seen_at`, `expires_at`, revoke attribution and `retired_at`, but `devices.ts` does not declare them yet and nothing writes `last_seen_at`. List/detail/revoke routes are not on main → **G3**, tracked by RT-365 + RT-370. **No new migration.** |
| Alerts | — (no Attention aggregate, no push registration) | — | — | — | **Gap G7** (deferred by design until triggered) |
| Sale lookup | `GET /api/pos/v1/sales/{saleRef}`; `GET /api/v1/catalog/sale-sync-ops/sales/{saleRef}/status`, `/audit-timeline` | `PosOperatorAuthGuard`; `DashboardAuthGuard` + `@Roles(owner, tenant_admin)` | POS operator; owner/TA | — | **store_manager excluded; no search → Gap G5** |
| Staff/sessions | `/api/pos/v1/operators/active-session`, `/roster`; `/api/pos/v1/cashier-admissions/roster` | POS device / operator | POS | device's store | POS-only; **Gap G8** |
| Inventory glance | `GET /api/inventory/v1/on-hand/{storeId}/{productId}`, `/stores/{storeId}/movements`, `/locations` | `DashboardAuthGuard` (cookie **or** `dashboard_api` bearer) + `TenantContextGuard` | per service | object-level, 404 | **Reusable once G1 exists**, but it needs a `productId`. There is **no dashboard-surface product list/search route on main** (catalog product reads exist only as POS `snapshot`/`deltas`) → **G9**. |

---

## 6. Auth, device-trust and session model

### 6.1 Finding: no mobile-usable human credential exists on `main`

- `POST /api/v1/auth/signin` issues only the HttpOnly `dp2_session` **cookie** (`auth.openapi.yaml`).
- The `dashboard_api` bearer scope is accepted by `AuthGuard`/`DashboardAuthGuard`, but **no route mints it**. `AuthService` issues only `password_reset` and `email_verify` tokens.
- RT-430 (`origin-check.ts`, owner decision 2026-10-12) refuses any **cookie-authenticated** POST/PUT/PATCH/DELETE whose `Origin` is missing or unlisted. That includes `/auth/refresh`. Native apps send no browser `Origin`.
- `SessionOnlyAdminGuard` (on `shift-closes`) rejects **all** bearers by design.
- Clerk JWTs (`ClerkBearerGuard`) are used today for POS operator sign-in and shift routes. Spec 029 established a provider-neutral identity link.

**Conclusion:** a native app cannot use the dashboard cookie path as designed, and there is no bearer for humans. Every MVP read is blocked on this. It is gap **G1** and the first decision (D1).

### 6.2 Options for the mobile human credential (D1)

| Option | Summary | Assessment |
|---|---|---|
| A. Reuse cookie session in the app | Cookie jar plus a hard-coded allowlisted `Origin` | **Reject.** It abuses a CSRF control as a client identifier, binds no device, gives no per-device revoke, and fights RT-430. |
| **B. Device-bound mobile bearer (recommended)** | Sign-in (same human credential as Admin) from an **enrolled mobile device** returns a short-lived opaque access token plus a rotating refresh token, scoped e.g. `mobile`, bound to `user_id` + `device_id`. Stored hashed (same pattern as RT-138). Routes opt in explicitly. | Reuses existing opaque-token, hash-at-rest and revocation patterns. Revoke-device kills all sessions on it. No new IdP dependency. Needs a GATED contract plus likely a migration (new scope value, device kind). |
| C. External IdP (OIDC + PKCE via Clerk), Backend-Core verifies JWT | Phone signs in with the IdP; Backend-Core maps identity through the 029 link | Viable later for SSO/MFA customers. Today it adds an IdP dependency for managers and still needs device binding for revoke. Keep as a future login factor feeding B, not a replacement. |

**Route opt-in policy (part of D1):** the mobile scope is admitted only on routes that explicitly allow it. It is not silently accepted wherever `dashboard_api` is. Credential-minting surfaces (connector credentials, pairing-code issue, membership/role changes) stay **human-cookie-session only**. For `shift-closes`, the owner must decide whether to admit the mobile scope, which changes that route's guard (GATED contract change), or to expose a separate mobile-admissible read over the same facts.

### 6.3 Device trust and enrollment (D2)

- Each app install is enrolled as a **Device Registry managed client** (`kind = mobile`; F10), separate from POS terminals. There is no reuse of terminal credentials (RT-230 security rule).
- **Recommended enrollment (consistent with the ratified Device Registry baseline):** enrollment is a **ceremony, not human sign-in**. An owner, a tenant_admin, or a store_manager within its granted stores issues a one-shot, cancellable **mobile enrollment code** for a named user. The code reuses RT-138 pairing-code rules: default TTL 60 min, max 24 h, attempt controls. The user then signs in on the new install and presents the code. The result is one trusted mobile device identity bound to that user and tenant and audited (`mobile.device.enrolled`). There are **no extra lifecycle tiers**: the states are trusted or revoked, as in RT-138. Self-enrollment by an issuer is allowed (an owner enrolling their own phone still issues a code to themselves, audited).
- **Alternative (a proposed deviation from a ratified baseline; listed so the owner can rule on it knowingly):** self-enrollment at first sign-in with a "pending → confirmed" trust tier, reads allowed while pending and writes only after confirmation. Adoption friction is lower, but it **conflicts with** the Device Registry rules "pairing is an enrollment ceremony… not human sign-in" and "Suspend/Resume and extra lifecycle states DEFERRED". Adopting it requires an explicit amendment of that page.
- Revocation is immediate and cascades to that device's mobile sessions and push registration. Re-enrollment creates a new device identity (RT-138 semantics). There is no generic Deactivate (F10).
- BYOD vs company-managed phones and whether MDM is required are open (D2). Recommendation: support BYOD for MVP reads, with no MDM dependency. The Device Registry is not an MDM (Device page "OUT OF SCOPE").

### 6.4 Session lifecycle

- Access token about 15 minutes. Refresh token rotates on each use with reuse detection (a reused refresh token revokes the device session). Idle and absolute caps align with RT-139 dashboard values (12 h idle / 24 h absolute) unless D8 sets mobile-specific values.
- **App-level biometric/PIN re-open lock** is local UX convenience on top of the server session, not a server auth factor.
- Membership, role or store-scope changes take effect on the next request (server-resolved), never cached in the token.
- Sign-out revokes the refresh token server-side. Remote "sign out this phone" equals device revoke.

### 6.5 Relationship to the 031 operator-authorization envelope

Spec 031 mints an opaque `pos_operator` bearer at POS operator sign-in. The identity proof is a Clerk JWT, and the bearer is bound to `(tenant, user, device, store)` with an 8 h TTL and no refresh. It authorizes POS sale-sync writes through `PosOperatorAuthGuard`, which rejects cookie, `dashboard_api` and any other scope.

- **Manager Mobile does not ride the 031 envelope.** It is a POS-device + operator credential for cashier-side writes. Phase-2 manager actions from Mobile (device revoke, return review/approve) use the mobile credential (G1) on routes that admit it, under each owning domain's authority. Mobile must never mint or hold a `pos_operator` token.
- **Cashier Continuity (RT-230) is the open case.** A continuity sale is a cashier write, so RT-230 must decide one of two paths. Either the continuity device obtains a 031-style operator envelope bound to the *continuity* device identity, so the sale routes keep a single authorization path. Or continuity gets a distinct scheme. Either way, 031's "single session per (device, store)" and takeover semantics are inputs to RT-230's fencing design, not something RT-231 decides.

### 6.6 Secure local storage

- Tokens are kept only in OS secure storage (Android Keystore / iOS Keychain, via the PoC-chosen library).
- **No durable business cache** for Manager/Owner. Screen data lives in memory with an "as of" timestamp. Optional encrypted short-lived cache lifetime is open (D4).
- Customer PII (sale lookup) is never written to disk, logs or crash reports. Sentry or other crash scrubbing is mandatory.
- Card data is never stored or processed (no change from current policy).

---

## 7. Connected / offline stance (per capability)

| Capability | Stance | Offline behavior |
|---|---|---|
| All MVP reads | Connected-first | Show the last in-memory data with an "as of" time and a Stale banner. Never fabricate Healthy or zero. Reads re-fetch on reconnect. |
| Attention ack (1b) | Online only | Disabled offline. An ack is not queued. |
| Phase-2 actions (revoke, return review/approve) | Online only | Refused offline with a clear message. **No offline queue of privileged writes.** |
| Continuity sale (Phase 3) | **RT-230 decides** (connected-first vs bounded offline) | Under RT-230 rules only: one offline writer per Cash Location, distinct continuity Cash Location or cashless mode. |
| POS local approval | POS-owned, offline-capable | Mobile is not involved (F7). |

No SQLite or outbox exists in Manager/Owner surfaces (comment 10953). Continuity complexity stays isolated in the Phase-3 module.

---

## 8. Notification / alert model

- **Source of truth:** source domains (Operational Support §A). Mobile renders Attention, not raw domain state copies.
- **MVP:** in-app pull list built from existing domain signals (for example variance closes, stale devices, negative-on-hand where the role permits). There is no persistence and no push.
- **Phase 1b:** push plus a shared ack across Admin and Mobile. This **meets the Operational Support §G persistence trigger** ("Admin↔Mobile shared acknowledgement, notification deduplication"), so it needs a bounded Attention persistence slice first (G7).
- **Push contract principles:** a provider-neutral notification capability in Backend-Core (§O). Retail policy decides eligibility. Push payloads carry **only** an opaque attention id plus generic text ("Store X needs attention"), with **no amounts, names or PII**. The app fetches detail with auth. Delivery failure never hides or resolves an Attention. Device push tokens are registered against the enrolled mobile device and removed on revoke.
- **Alert-storm control:** source-owned aggregation (§J). One backlog Attention, not one push per row. Per-user quiet hours and cooldowns are configurable policy later.
- **Provider:** FCM / APNs through the PoC-chosen toolchain. Selection is a PoC output, not chosen here.

---

## 9. Audit and security requirements

- RT-135 envelope for every mobile-originated privileged action: actor, **client kind = mobile**, device ref, tenant/store, target, request id, server time. No tokens, PINs or PII in audit rows.
- New event names to be added to the RT-135 catalogue (proposed): `mobile.device.enrollment_code.issued`, `mobile.device.enrolled`, `mobile.device.revoked`, `mobile.session.signed_in`, `mobile.session.refresh_reuse_detected`, `attention.acknowledged`. Domain actions (device revoke, return approval) audit under **their own** domain events (Support §R).
- **Read-audit:** whether sale lookup (customer-facing data) on mobile emits read-audit rows is open (D4), per RT-135 read-audit rules.
- Rate limiting on mobile sign-in and refresh (same posture as dashboard sign-in). Generic 401s with no account-existence leaks.
- Minimum-supported app version: the server can refuse below-minimum clients with an explicit compliance error, mirroring Device page fleet rules. OTA updates must not bypass store-reviewed native changes or the minimum version.
- Threats to cover in the PoC: lost/stolen phone, device-to-device token theft, screenshot/notification-preview leakage, rooted/jailbroken devices (warn vs block is an owner policy, recommended warn for reads and block for Phase-2 writes) and deep-link spoofing.

### 9.1 Observability and support evidence

- Every request carries `X-Request-Id`, plus a client header (app version, OS, device id) for support correlation.
- Crash/exception reporting (Sentry, consistent with POS) with PII scrubbing. Backend side stays on OTel.
- The support view can answer "which app version, which device, last seen" from the Device Registry, not from vendor dashboards (Support §N).

---

## 10. Backend-Core contract gap list (not implemented; each is `[GATED]` contract/migration work)

| ID | Gap | Why Mobile needs it | Notes / existing anchor |
|---|---|---|---|
| **G1** | Mobile human credential: sign-in from enrolled device → access + rotating refresh bearer; refresh/sign-out; route opt-in | Nothing in the MVP works without it | §6. Likely a new scope + migration. **Shared with RT-230.** |
| **G2** | Mobile device enrollment as a Device Registry managed client (`kind = mobile`): enrollment-code issue/cancel + enroll | Revoke-on-loss, push binding | RT-138 pairing-code patterns; Device page F10. Trusted or revoked only, with no confirmation tier (unless the owner picks the §6.3 alternative under D2). |
| **G3** | Device Registry read (list + trust state + `last_seen_at`) and revoke routes, plus the throttled `last_seen_at` writer | Device health MVP; Phase-2 revoke | Schema has already landed: migration `0040_device_lifecycle.sql` (RT-364, Done) adds the columns, but `devices.ts` does not declare them yet. **Remaining work is already tracked: RT-365** (list/detail + revoke, contract-first) **and RT-370** (`last_seen_at` writer). No new migration and no new decision. |
| **G4** | Dashboard read of open/active shifts per store (and stuck/stale) | Active-shift MVP | `shift-closes` is closed-only; `/pos/v1/shifts` is POS-scoped. Must reuse RT-17 facts, with no second shift model. |
| **G5** | Store-scoped sale lookup/search admissible to `store_manager` | Sale lookup MVP | `sale-sync-ops` is owner/TA-only; POS sale read is operator-only. PII and read-audit per D4. |
| **G6** | Store operational snapshot projection (shared Admin + Mobile) | Snapshot MVP and Phase 4 | READ/PROJECT, not mirror (Support §A). D6 decides projection vs N calls. |
| **G7** | Operational Attention persistence + ack + notification capability + push-token registration | Phase 1b | Support §G trigger met by Mobile; deferred until 1b approved |
| **G8** | Dashboard read of active POS operator sessions per store | Staff/session MVP | Today POS-device-scoped only |
| **G9** | Dashboard-surface product lookup/search (name / barcode / SKU) for the inventory glance | Inventory glance MVP | Confirmed absent on `main`: no dashboard `@Get` for products. Product reads exist only as POS `catalog/snapshot` and `deltas`. Likely shared with Admin catalog UI needs. |
| **G10** | `shift-closes` admissibility for a non-cookie client | Variance MVP | Guard decision under D1 (admit mobile scope vs separate read) |

---

## 11. Relationship to RT-230 (Cashier Continuity)

- RT-230 **owns** continuity session and device fencing, exactly-once sale reconciliation, cash-drawer/tender during failover, and the connected vs bounded-offline decision for continuity.
- RT-231 **owns** the shared Mobile Core that continuity would run inside: credential (G1), device enrollment (G2), secure storage, telemetry, and the rule that **continuity complexity is isolated in its own module** and never leaks into Manager surfaces.
- Shared dependency: RT-230 should reuse G1/G2 or record a deliberate divergence (for example, a continuity device needing a stronger enrollment ceremony than a manager read-only device). A note for the RT-230 session is in the shared notes folder.
- Cashier on mobile = continuity only. A `store_staff` user has no normal mobile session.

---

## 12. Technology decision criteria and PoC gate

The hypothesis is fixed (F8). This section defines **what the PoC must prove**. It does not re-run the comparison.

**Prerequisites (gate in):** this package is approved, D1–D3 are decided, the Marketplace Reuse Scan is complete (§12.2), and the G1 contract is at least drafted. The PoC may run against a **mock server implementing the proposed G1 contract** if G1 runtime is not yet built.

### 12.1 PoC must demonstrate (pass/fail)

1. **Auth:** G1 flow (sign-in, access/refresh rotation, reuse detection, revoke → immediate 401) with tokens only in Keystore/Keychain.
2. **Device enrollment** (G2) and device revoke killing sessions and push registration.
3. **Push** on Android via the toolchain's notification path, with a PII-free payload and an authenticated detail fetch from a deep link.
4. **Arabic RTL** plus the Retail Tower design tokens on two real screens (variance list, sale lookup), at the quality bar of the UX Constitution.
5. **Update model:** store release plus OTA policy that cannot bypass the minimum-supported version or native changes.
6. **E2E:** an automated mobile E2E run (tool chosen in the PoC) in CI-capable form, without changing CI in the PoC.
7. **Android-first device matrix** (low-end Android in pilot stores). iOS build proven compilable if D3 requires iOS.
8. **No peripherals** in Manager scope. Continuity peripheral needs (scanner via camera, receipt sharing) are an RT-230 input, re-checked before Phase 3.

**Gate out:** pass all → confirm the stack → owner approves implementation decomposition. A failure on 1–4 → re-evaluate Flutter as the documented alternative.

### 12.2 Marketplace Reuse Scan (mandatory before the PoC; findings not yet gathered)

| Capability | Candidate | Decision (Build/Reuse/Adapt/Reference) | Why | License / security / maintenance | Architecture fit |
|---|---|---|---|---|---|
| Approval / notification UX | NotiBell (Frappe Marketplace) | *pending scan* | — | review required | Reference only. It must not assume a direct Frappe connection. |
| Shift/cash, POS workflows | Retail Suite (Frappe Marketplace) | *pending scan* | — | review required | Reference only |
| Mobile stock / inventory flows | WMS (Frappe Marketplace) | *pending scan* | — | review required | Reference only |
| Dashboards / KPI patterns | Frappe Insights | *pending scan* | — | review required | Reference for Phase 4 |
| Admin / POS / inventory RN+Expo templates, scanner, notifications | CodeCanyon / Envato candidates | *pending scan* | — | review required | UI acceleration only. Retail Tower keeps its own design system and RTL. |

No candidate may bypass Backend-Core, call ERPNext, or become a second authority (comment 10959).

---

## 13. Phased roadmap

| Phase | Content | Entry gate |
|---|---|---|
| **0 — Decide & contract-plan** | Owner rules on D1–D9; Confluence 21233665 updated; G1/G2 contract planning; RT-138 G3 scheduled; Marketplace Scan | This package approved |
| **0.5 — PoC** | §12.1 | Phase-0 decisions + scan |
| **1 — Manager Companion MVP** | §3 reads, single + switchable store | G1, G2, G3, G4, G5, G8 (+ G6/G9 or fallbacks) runtime on `main` |
| **1b — Alerts** | Push + shared ack | G7 approved and built |
| **2 — Bounded actions** | Device revoke first, then return review/approve, audit summaries | Each action's domain row Decided + server authority + audit |
| **3 — Cashier Continuity** | RT-230 design inside the shared Mobile Core | RT-230 approved go/no-go |
| **4 — Owner / multi-store** | Aggregates, KPIs, exception board | Phase 1 proven useful; KPI contract |

Not a pilot (RT-20) blocker at any phase.

---

## 14. Implementation decomposition proposal (for owner approval only; open no issues yet)

Candidate Jira items, each one issue / one primary repo / bounded:

1. **Backend-Core Planning:** mobile credential + device-enrollment contract (G1, G2, G10). `[GATED]` contract and migration.
2. **Backend-Core Implementation (already ticketed):** RT-365 device list/detail/revoke and RT-370 `last_seen_at` writer (G3). Schema already landed via RT-364 / migration 0040.
3. **Backend-Core Planning→Impl:** open-shift dashboard read (G4), coordinated with RT-18/RT-236.
4. **Backend-Core Planning→Impl:** store-scoped manager sale lookup (G5) incl. PII/read-audit decision.
5. **Backend-Core Planning→Impl:** active operator-session read (G8).
6. **Backend-Core Planning:** store operational snapshot projection (G6) + product lookup check (G9).
7. **Mobile Planning:** Marketplace Reuse Scan (§12.2).
8. **Mobile Spike:** bounded PoC (§12.1), throwaway, with no repo for production until confirmed.
9. **Backend-Core Planning (Phase 1b):** Operational Attention persistence + notification capability (G7).
10. **Orchestrator Docs:** record PD-1..PD-3 below as an ADR (Orchestrator owns ADRs; Backend-Core has no ADR directory).

---

## 15. Proposed decisions (ADR draft, to be recorded in Orchestrator after approval)

### PD-1 — Mobile human credential is a device-bound opaque bearer, not the dashboard cookie
- **Context:** cookie-only human sign-in; RT-430 Origin rule refuses non-browser cookie writes; no route mints a human bearer; mobile needs per-device revoke.
- **Decision (proposed):** Option B (§6.2). A new mobile scope bound to user + enrolled device, with short access + rotating refresh, explicit route opt-in, and credential-minting surfaces staying cookie-only.
- **Alternatives:** A (cookie + spoofed Origin) rejected; C (external OIDC) deferred as a future login factor.
- **Consequences:** GATED contract plus migration. Every MVP route needs an explicit admission decision. RT-230 inherits it.

### PD-2 — No mobile BFF; shared projections in Backend-Core
- **Decision (proposed):** Mobile consumes domain contracts. Aggregated reads (store snapshot) are shared Admin+Mobile projections. A BFF needs measured evidence.
- **Consequences:** Admin benefits from the same projections. Mobile latency is managed by projection design, not a new service.

### PD-3 — Manager/Owner Mobile is connected-first with no durable business cache
- **Decision (proposed):** in-memory data plus "as of" staleness only. No offline writes. Privileged actions are online-only. Offline semantics exist only in the RT-230 continuity module.
- **Consequences:** no SQLite/outbox in the manager app. A simpler security posture for lost devices.

---

## 16. Open owner decisions

| # | Decision | Recommendation |
|---|---|---|
| **D1** | Mobile human credential model and route opt-in policy (incl. `shift-closes` admissibility, G10) | PD-1 / Option B |
| **D2** | Device enrollment ceremony; BYOD vs managed; MDM | Issued one-shot enrollment code, per RT-138 rules and the Device Registry baseline (§6.3). BYOD allowed. No MDM. *Self-enrollment at first sign-in is a deviation from the ratified Device Registry baseline and needs an explicit amendment if the owner prefers it.* |
| **D3** | Android-first; when iOS is required | Android-first MVP; iOS when a paying customer requires it (keep the build compilable) |
| **D4** | Sale lookup PII on phone, read-audit, and cache lifetime | Show minimal customer data (masked); emit read-audit for lookups; no disk cache |
| **D5** | Push in MVP or Phase 1b (triggers Attention persistence) | Phase 1b; MVP uses an in-app pull list |
| **D6** | Store snapshot as one shared projection vs client-side composition | Shared projection (PD-2) |
| **D7** | Rooted/jailbroken device policy | Warn for reads; block Phase-2 writes |
| **D8** | Mobile session TTLs (access/refresh/idle/absolute) | 15 min access; RT-139 idle 12 h / absolute 24 h unless the owner prefers longer for convenience with re-open lock |
| **D9** | First Phase-2 action | Device revoke on lost/stolen device |

---

## 17. Next safe action

**Owner reviews this package and rules on D1–D9.** After approval: update Confluence RETAIL page 21233665 with §§1–16 and post the drafted RT-231 comment (Appendix A). Open no implementation issues until the owner approves §14.

---

## Appendix A — Draft RT-231 Jira comment (not posted)

> **RT-231 Planning package — draft for owner review (2026-10-15)**
>
> Baseline: Backend-Core `origin/main` `ddae78a7`. Package: `docs/superpowers/specs/2026-10-15-rt-231-retail-tower-mobile-design.md` in Kemetra/Backend-Core (docs-only PR). On approval it becomes the update to Confluence page 21233665.
>
> **Covered (all 14 required outputs):** persona and capability matrix; surface matrix; Manager MVP (8 read-only items, connected-first, no writes); Owner/multi-store scope; integration architecture (no BFF, shared projections, store scope enforced in the service layer because RLS is tenant-only); auth/device-trust/session model; per-capability offline stance; notification model; audit/security; Backend-Core gap list G1–G10; RT-230 split; PoC gate plus Marketplace Scan skeleton; phased roadmap; decomposition proposal (not opened).
>
> **Key finding:** Backend-Core has **no human credential a native app can use**. Sign-in is cookie-only, nothing mints a human bearer, RT-430 refuses non-browser cookie writes, and `shift-closes` (RT-18's read) rejects all bearers. Every MVP read is blocked on gap **G1**. The recommendation is a device-bound mobile bearer (PD-1). RT-230 shares this dependency.
>
> **Other gaps:** RT-138 device list/revoke is not on main. The columns already landed via migration 0040 (RT-364); the remaining work is tracked as RT-365 + RT-370 (G3). There is no dashboard product search (G9). Manager Mobile does not use the 031 `pos_operator` envelope; whether continuity does is RT-230's call. There is no dashboard read for open shifts (G4), manager sale lookup (G5; sale-sync-ops is owner/tenant_admin only), store snapshot (G6), Attention/push (G7, Phase 1b) or active operator sessions (G8). Inventory on-hand is reusable once G1 exists.
>
> **Owner decisions needed:** D1 credential model · D2 enrollment ceremony / BYOD (self-enrollment would deviate from the Device Registry baseline) · D3 Android-first · D4 sale-lookup PII / read-audit · D5 push in 1b · D6 snapshot projection · D7 rooted-device policy · D8 session TTLs · D9 first Phase-2 action.
>
> No implementation, repo, contract or Jira issue was created. **Next safe action:** owner rules on D1–D9. Then Confluence 21233665 is updated and decomposition is reviewed.
