# HTTP Idempotency Strategy

**Ref**: 004-platform-production-readiness (Phase 5, tasks T500–T506)
**Status**: Draft — Phase 5 design artifact (docs only; no runtime code, no tests, no contract changes)
**Constitution**: v3.0.0
**Date**: 2026-05-16
**Owner**: Ahmed Shaaban
**Cross-references**:
- Spec §1.5 (clarifications Q1/Q2/Q3), §9 (Track D requirements)
- Plan §3.4 (Track D strategy), §3.4.3 (interceptor flow), §3.4.5 (rollout), §3.4.6 (dedup tuple)
- Research §2 (replay window, first endpoint), §3 (in-progress marker), §10 (middleware shape)
- `docs/observability/signals.md` (idempotency counters)
- `.specify/memory/redaction-matrix.md` (logger boundary policy)

> This document is a **planning / specification artifact**. Nothing here
> authorizes implementation. Per `plan.md §5`, every artifact called out
> as future (the interceptor, decorator, in-progress marker, OpenAPI
> extension, store TTL change) is `[GATED]` and requires its own approval
> PR. The runtime layer described here is the design contract that the
> Phase 5 implementation tasks (T510–T525) will materialize once approved.

---

## 1. Scope of HTTP idempotency  (T500)

This document defines the **HTTP-layer** retry-safety contract for selected
mutating endpoints exposed by the Backend-Core SaaS API. It is the design
basis for the future NestJS interceptor (T520), the `@Idempotent` decorator
(T521), and the in-progress marker (T522), all building on the existing
`packages/shared/src/idempotency/store.ts::IdempotencyKeyStore`.

### 1.1 In scope
- HTTP-layer detection of client retries via the `Idempotency-Key` header.
- Replay of the original response when a retry matches the original.
- Conflict (`409`) when a retry reuses a key with a different payload.
- In-progress signaling (`425 Too Early`) when a duplicate arrives while
  the original is still executing.
- Per-endpoint opt-in via decorator + OpenAPI policy declaration.
- The dedup tuple `(tenantId, route, clientId, key)` (plan §3.4.6).
- The emission of three observability counters per `docs/observability/signals.md`.

### 1.2 Out of scope
- **Worker-level idempotency** — that's Track C / outbox-consumer territory
  (`event_id` as the per-consumer dedup key, plan §3.3.5).
- **DB-level upserts and unique constraints** — those are domain-level
  integrity primitives, not HTTP retry safety. The HTTP layer never
  replaces them; both layers coexist.
- **Token replay protection** — auth has its own `jti` / refresh
  semantics; the HTTP idempotency layer must not shadow them
  (research §2 explicitly excludes `POST /api/v1/auth/signin` and
  `POST /api/v1/auth/refresh` from the first slice).
- **`PUT`** as a default class — PUT is RFC-idempotent by HTTP semantic;
  it MAY adopt the decorator on a per-endpoint basis for observability
  and explicit conflict detection, but it is not auto-enrolled.
- **`GET` / `HEAD` / `OPTIONS`** — never. HTTP already classifies them
  as safe.

### 1.3 Defers to
- **`IdempotencyKeyStore`** (already present in `packages/shared/`) for
  the persistent layer: fingerprint comparison, Redis-primary storage,
  Postgres mirror, and TTL on completed responses.
- **`.specify/memory/redaction-matrix.md`** for everything log-boundary
  related (raw key never logged; fingerprint only).
- **Uniform error envelope** from Constitution §III for 400 / 409 / 425
  response shape — this document does not redefine the envelope.

---

## 2. `Idempotency-Key` header semantics  (T500)

### 2.1 Header
- **Name**: `Idempotency-Key` (HTTP header, case-insensitive per RFC).
- **Format**: an opaque client-generated token. **UUIDv7** is the
  recommended format (matches platform UUID policy from 001) but the
  server treats the value as opaque.
- **Length**: 16–128 characters. Values shorter than 16 are rejected at
  validation time as a defense against accidental collisions; values
  longer than 128 are rejected to bound the storage cost.
- **Character set**: printable ASCII excluding whitespace. Server
  rejects with `400 Bad Request` if it sees anything else (uniform
  error envelope).

### 2.2 Cardinality
- **One key per logical retry intent.** A retry of the same operation
  reuses the same key; a different operation MUST use a fresh key.
- Reusing a key for two different bodies is a **client bug**, not a
  retry — the server signals this with `409 Conflict` (§7).

### 2.3 Per-endpoint policy
Each in-scope endpoint declares its policy as an OpenAPI extension on
the operation:

```
x-idempotency: required    # missing header → 400 Bad Request
x-idempotency: optional    # missing header → pass-through, no replay
x-idempotency: forbidden   # missing header → pass-through; presence is ignored
```

(`forbidden` is a documentation aid for read-only and auth endpoints to
explicitly state "this endpoint is not in scope." It is the OpenAPI-side
analogue of "endpoint not enrolled.")

The extension is authored per endpoint as part of the gated OpenAPI
contract change in T524. **It is NOT auto-applied across the contract.**

---

## 3. Methods in scope  (T500)

Per spec §9.2.3:

| Method | Status | Notes |
|---|---|---|
| **POST** | In scope when the endpoint creates a resource | Primary target. The first-slice endpoint (`POST /api/v1/memberships/invite`) is in this class. |
| **PATCH** | In scope when the operation is **non-monotonic** | Setting a state (`status = active`) is safe to replay; incrementing a counter is not. Per-endpoint review decides eligibility. |
| **DELETE** | In scope **only** for endpoints that target a specific resource ID | Bulk or filter-based DELETE is excluded from the first slice. A specific-ID DELETE is naturally idempotent (the second call observes "already gone"); the decorator still adds observability and conflict-detection. |
| **PUT** | In scope on opt-in only | PUT is RFC-idempotent, but the decorator still gives us replay accounting + payload-mismatch detection. |
| **GET / HEAD / OPTIONS** | **Never** | Already safe by HTTP semantic. The decorator MUST refuse to register on these methods. |

The decorator MUST refuse (compile-time or boot-time) to bind to a
controller method whose HTTP verb is `GET`/`HEAD`/`OPTIONS`. (Future
implementation detail; documented here so reviewers can spot violations
at the T521 PR.)

---

## 4. Dedup tuple  (T500)

Per plan §3.4.6, the **effective dedup tuple at the HTTP layer** is:

```
(tenantId, route, clientId, key)
```

| Component | Source | Required? | Notes |
|---|---|---|---|
| `tenantId` | Established tenant context (from token / membership) | **Yes** | Multi-tenant isolation invariant (FR-D-002). A request without tenant context cannot replay against another request that did have one. |
| `route` | HTTP method + route **template** (not the rendered path) | **Yes** | E.g., `POST /api/v1/memberships/invite`. Path params are not in the route component; they appear in the request body or in the fingerprint. |
| `clientId` | Bearer token's client identifier; falls back to a stable per-token identifier | **Yes** (effectively) | Two distinct clients of the same tenant retrying the same key on the same route are treated independently. |
| `key` | The `Idempotency-Key` header value | **Yes** | Opaque to the server. |

### 4.1 Comparison-only fields
- **`storeId`** — present in the existing `IdempotencyKeyStore` schema but
  NOT a dedup-tuple component at the HTTP layer. A request to one store
  retried with the same key but redirected to another store is treated
  as a payload-different retry → **`409 Conflict`** (the safe behavior).
  This is the recommendation locked in research §2 follow-ups.
- **`payload_hash`** (a.k.a. `fingerprint`) — sha256 of the canonicalized
  validated request body. **Not** part of the dedup tuple itself; it is
  the **collision detector** used to distinguish "same key + same body =
  replay" from "same key + different body = 409."

### 4.2 Tuple composition vs. storage
- The interceptor composes the tuple into the **`key` argument** passed to
  `IdempotencyKeyStore.findOrCreate(...)` (e.g., as a deterministic
  string `${method}:${route}:${clientId}:${key}`). This preserves
  SC-X-001 (no schema change in this slice).
- The store sees the composed string; the surrounding components
  (`tenantId`, `storeId`) continue to flow into the existing columns.

---

## 5. First endpoint  (T500, T504)

### 5.1 Endpoint
**`POST /api/v1/memberships/invite`** (OpenAPI `operationId: createInvitation`).

This is the **only** endpoint enrolled in idempotency in the first slice.
**Never global** (FR-D-007, plan §3.4.5).

### 5.2 Rationale (research §2)
- **Retry-safe by design.** Creating an invitation has no money side
  effect and no inventory impact. "The same invitation was meant to be
  sent twice" is naturally the same invitation.
- **Low blast radius.** No POS dependency, no catalog dependency, no
  payment dependency. A misbehaving idempotency layer here cannot break
  retail traffic or money flows.
- **Already covered by 001 contract tests.** The conformance surface is
  well understood; adding idempotency does not destabilize a green
  contract baseline.
- **Audit-emitting code path.** This is the critical validation: a
  replayed invitation MUST NOT emit a second audit event. The first
  slice proves the no-double-emission invariant on a familiar pipeline
  before any catalog or governance endpoint adopts the same wrapper.

### 5.3 Alternatives considered and rejected
- `POST /api/v1/auth/refresh` — tokens carry their own retry semantics
  (jti). Wrapping it would shadow auth.
- `POST /api/v1/auth/signin` — security-sensitive; idempotency-replay
  semantics interact poorly with rate-limiting and credential probing.
- Role-grant / role-revoke endpoints — audit-heavy; higher blast radius
  if double-emission slips through. Defer until the first slice is
  validated.
- Any catalog or inventory endpoint — those don't exist yet (003 is
  still in planning); violates the §6 parallelism contract.

### 5.4 Expansion
Each additional endpoint requires:
1. An explicit approval PR (per `plan.md §5` gating table).
2. A T504-equivalent rationale recorded in this strategy doc (or in a
   follow-up doc; reviewer's choice).
3. The OpenAPI `x-idempotency` extension authored on the operation.
4. A repeat of the replay / conflict / 425 / cross-tenant test suite
   (T510–T518 pattern) for the new endpoint.

---

## 6. Replay semantics  (T500)

### 6.1 Match condition
A retry replays the original response when **all** of the following hold:
1. The dedup tuple `(tenantId, route, clientId, key)` matches.
2. The `payload_hash` (fingerprint) matches.
3. The original record has not expired (within the 72h retention window
   — see §10).
4. No in-progress marker exists for the same tuple (in-progress takes
   precedence; see §8).

### 6.2 Response
- **Status**: identical to the original.
- **Body**: identical to the original.
- **Headers**: semantically equivalent (response timestamps, `Date`, and
  trace identifiers may differ; payload-bearing headers preserved).
- **Replay indicator**: an explicit response header
  `Idempotent-Replayed: true` is added so clients can distinguish a
  replay from a fresh processing. Absence of the header means "freshly
  processed."

### 6.3 Authorization preservation  (FR-D-009)
The replay returns the **original** authorization decision, not a fresh
one. Concretely:
- The replayed body / status reflects whether the **original requester**
  was authorized at the time of the original request.
- If the retrier's authorization has since changed (role revoked, token
  rotated, membership downgraded), the replay is **not** re-evaluated.
- If the original request was denied (403/401), the replay returns the
  same denial.

This is the safer semantic: a successful invitation, once issued, must
not be retroactively un-issued because the actor's role later changed.
The retrier's authorization decision was already made by the original
request — the retry is asking for the same answer, not a new one.

### 6.4 Audit double-emission prevention  (T534)
The replay path MUST NOT emit a second audit event for the same logical
operation. Concretely: the audit emitter sits inside the handler; the
replay short-circuits the handler entirely; therefore no second audit
event is emitted. This invariant is the basis of test T534.

The same principle applies to outbox events (future Track C), webhook
callouts, and any side-effect-bearing pipeline that the handler triggers:
**a replay re-emits nothing**; the original side effects are the only
ones recorded.

### 6.5 Expired key
A key past the 72h replay window is **gone**; the original response is
no longer available. The request is treated as a brand-new request and
proceeds to the handler. (This is a known data-loss-by-design: 72h is
the agreed business-staleness horizon — see §10.)

---

## 7. Conflict semantics — `409 Conflict`  (T500)

### 7.1 Match condition
The interceptor returns `409 Conflict` when:
1. The dedup tuple `(tenantId, route, clientId, key)` matches an
   existing record.
2. The `payload_hash` does **not** match.
3. The original record has not expired.

### 7.2 Response shape
- **Status**: `409 Conflict`.
- **Body**: uniform error envelope (Constitution §III), with an error
  code such as `idempotency_key_conflict` and a human-readable message
  noting that the key has been used for a different request.
- **No leak**: the body MUST NOT contain any field from the original
  request or the original response. The conflicting retry sees only
  "this key was used for a different request."

### 7.3 Terminal from the client's perspective
A `409` is **terminal** for that key. The client cannot recover by
retrying — the payload mismatch indicates a client-side bug:
1. The client reused a key for a different operation, or
2. The client recomputed the body in a way that changed the canonical
   form.

The remedy is to **generate a new key** and resubmit. The OpenAPI
description for the `409` response MUST surface this guidance.

### 7.4 Original mutation preserved
The conflicting retry does **nothing**. The original request's side
effects remain as they were. The `409` is purely informational from the
server-state perspective.

---

## 8. In-progress semantics — `425 Too Early`  (T501)

Locked by Q1 (`spec.md §1.5`).

### 8.1 Match condition
The interceptor returns `425 Too Early` when:
1. The dedup tuple `(tenantId, route, clientId, key)` matches an
   **in-progress marker** (§9).
2. No completed record exists yet for the same tuple.

### 8.2 Response shape
- **Status**: `425 Too Early`.
- **Body**: uniform error envelope (Constitution §III), with an error
  code such as `idempotency_in_progress` and a human-readable hint that
  the client should retry shortly.
- **Headers**: `Retry-After` set to a small non-negative integer
  (seconds). Recommended value: `min(remaining_marker_ttl, 2)`, clamped
  to at least `1`. The client SHOULD honor `Retry-After`. (Research §3
  open follow-up.)

### 8.3 Non-blocking
The 425 returns **immediately**. The server does NOT hold the connection
waiting for the original request to complete. This is critical to keep
worker threads available under retry storms.

### 8.4 Leak-proof  (FR-D-002)
The 425 body MUST NOT include any of the following:
- The original requester's identity or `actor_id`.
- The original `request_id`.
- Whether the original is being processed in a different store / store
  context.
- Any field that would reveal the original's body.

A 425 received in tenant A in response to a key collision with tenant
A's own original request is fine; a 425 received in tenant B in response
to a key collision with **tenant A's** original request is impossible
because cross-tenant key collisions don't exist (§11).

### 8.5 Retryable
A 425 is **retryable** by the client. The interceptor, the OpenAPI
contract description, and the eventual generated SDK (Track E, T624)
MUST all surface this as a retryable result type — never as a terminal
error. After `Retry-After`, the client may retry with the **same key**;
the second retry will:
- Replay (200/201) if the original completed in the meantime.
- Conflict (409) if the original completed and the client now sends a
  different body.
- Process anew if the original failed and the marker has cleared.
- Hit 425 again if the original is still running.

---

## 9. In-progress marker design  (T502)

### 9.1 Storage
- **Engine**: Redis (reuses the existing connection used by
  `IdempotencyKeyStore`; no new package, no new connection).
- **Key**: `idem:inflight:<sha256(tuple)>` where `<tuple>` is the same
  composed string used in §4.2.
- **Atomic creation**: `SET key 1 NX EX <ttl_seconds>` — `NX` ensures
  exactly one writer wins; concurrent racers see the existing marker
  and respond `425`.

### 9.2 Default TTL
- **60 seconds** (research §3 recommendation).
- Per-endpoint override permitted via `@Idempotent(..., { inflightTtlSec })`
  for known-slow paths (future bulk import, long-running export).
- Rationale: roughly 12x the p99 latency target for foundation
  endpoints. Long enough to bridge realistic slow runs; short enough
  that a crashed worker self-heals within ~1 minute.

### 9.3 Lifecycle
1. **Set** the marker atomically *before* invoking the handler.
2. **Run** the handler; on success, write the completed response into
   `IdempotencyKeyStore` (which carries the 72h TTL).
3. **Delete** the marker in a `finally`, best-effort. If the deletion
   fails (Redis transient error), the marker's TTL ensures it
   self-clears no later than `inflightTtlSec` after creation.

### 9.4 Marker payload
- Recommended payload: empty or a single byte `1`. No PII, no
  fingerprint, no original-request fields.
- A trace correlation identifier (`request_id`) MAY be stored
  alongside the marker for observability; it MUST NOT leak into the
  425 response (§8.4).

### 9.5 Best-effort cleanup
The marker deletion is best-effort. The TTL is the authoritative
cleanup. A worker crashing after the handler completes but before
`IdempotencyKeyStore.save(...)` runs leaves the marker in place for up
to `inflightTtlSec`; subsequent retries see 425 until the TTL expires,
then are treated as fresh requests. This is consistent with
"replay-record TTL is authoritative; in-progress marker TTL is
transitional" (research §3).

### 9.6 Cross-tenant isolation
The marker key includes `tenantId` (via the composed tuple). Two
tenants sending the **same `Idempotency-Key`** to the **same route**
NEVER share a marker. (See also §11.)

---

## 10. Replay retention window  (T503)

### 10.1 Decision
**72 hours** from the first successful processing (research §2).

### 10.2 Why 72h
- The existing `IdempotencyKeyStore` `defaultTtlMs` is 24h. That covers
  in-session retries but not the "client disconnected Friday evening,
  retries Monday morning" pattern that POS / integration clients
  exhibit.
- 72h covers the realistic worst-case retry interval without ballooning
  storage. At expected foundation-endpoint RPS, this is well under 10 GB
  of replay records.
- Beyond 72h, the original transaction is almost certainly
  business-stale (the user changed their mind, or the integration was
  reconfigured). Treating the late retry as a new request is the safer
  semantic — explicit data-loss-by-design rather than ambiguous replay.

### 10.3 Implementation note
- No schema change is required. The existing `idempotency_keys.expires_at`
  column supports any TTL.
- The change is a runtime config update to `IdempotencyKeyStore`'s
  `defaultTtlMs` (T525, future gated). No code constant change.

### 10.4 Per-endpoint override (future)
The decorator option `replayTtlSec` (§12) allows per-endpoint override.
For the first-slice endpoint, the default 72h applies; no override is
needed.

### 10.5 PII lifecycle  (FR-D-006)
The 72h replay window does **not** override PII lifecycle obligations.
A replay record whose stored body contains PII is subject to the
platform's right-to-erasure flow (Constitution §XIV). The redaction is
applied to the stored replay body in place; the existence of the record
(for replay accounting / audit) is retained but the PII-bearing fields
are scrubbed before the 72h expiry, if erasure is requested.

---

## 11. Cross-tenant isolation

### 11.1 Tuple-level isolation  (FR-D-002)
`tenantId` is part of the dedup tuple. Therefore:
- Tenant A's key `X` on route `R` and tenant B's key `X` on route `R`
  are **distinct records** with distinct in-progress markers.
- A retry in tenant A NEVER replays against tenant B's original.
- A 425 in tenant A NEVER signals that tenant B is processing the same
  key.

### 11.2 Cross-tenant 404 default  (Constitution §XII)
If a client attempts to read or operate on a key that exists in
another tenant (impossible from a properly-scoped tenant token but
documented for completeness), the server returns the same response as
"no such key" — never "exists in another tenant." This is the
safe-404 default from Constitution §XII.

### 11.3 Tenant context required
A request without an established tenant context cannot establish a
meaningful `tenantId` in the tuple. The recommended posture:
- For endpoints whose tenant context is established by auth (the
  default), this is automatic.
- For endpoints that legitimately have no tenant context (none in the
  first slice), the operator MUST NOT enroll them in idempotency
  without an explicit per-endpoint review. The decorator MUST refuse
  registration in that case at boot time. (Future T521 detail.)

---

## 12. Decorator design  (T505)

### 12.1 API shape

```typescript
// Future. Documented here for design alignment with T521.
@Idempotent('required')                                    // required header
@Idempotent('optional')                                    // header optional
@Idempotent('required', { replayTtlSec: 86400 })           // override 72h default
@Idempotent('required', { inflightTtlSec: 300 })           // override 60s marker
@Idempotent('required', {
  replayTtlSec: 86400,
  inflightTtlSec: 300,
})
```

### 12.2 Modes
| Mode | Behavior on missing `Idempotency-Key` |
|---|---|
| `required` | `400 Bad Request` — uniform error envelope, error code such as `idempotency_key_required`. |
| `optional` | Pass-through to the handler; no replay protection for this retry. The endpoint behaves as if not enrolled for this specific request. |

### 12.3 Options
| Option | Default | Override condition |
|---|---|---|
| `replayTtlSec` | 72h (=`259_200`) | Long-running webhook / integration where the consumer needs more replay headroom. Requires per-endpoint review at T521 PR. |
| `inflightTtlSec` | 60 | Known-slow path (bulk import, long export). Requires per-endpoint review. |

### 12.4 Registration discipline
- **Route-level only** — registered on a controller method, never on a
  controller class and never globally. Missing the decorator means "no
  idempotency" — never "accidental global rollout" (FR-D-007, research
  §10).
- **Refuses safe HTTP verbs** — see §3.
- **Refuses endpoints without tenant context** — see §11.3.

### 12.5 What the decorator does NOT do
- It does not expose an `IdempotencyContext` to the handler. The
  handler MUST remain unaware of whether it is behind idempotency
  (research §10 follow-up: handler-side state would couple business
  logic to retry infrastructure).
- It does not modify the response body. Replay returns the bytes
  recorded for the original response; the `Idempotent-Replayed: true`
  header is added by the interceptor, not the handler.

---

## 13. Client retry guidance  (T506)

### 13.1 Response taxonomy

| Server response | Client interpretation | Retry safe? |
|---|---|---|
| `2xx` + `Idempotent-Replayed: false` (or header absent) | Fresh processing succeeded. | Not needed; you got your answer. |
| `2xx` + `Idempotent-Replayed: true` | Replay of an earlier success. | Not needed. The original side effects are recorded once. |
| `400` with `idempotency_key_required` code | The endpoint requires the header and the client did not send one. | Client bug. Fix the client; do not retry the same call. |
| `400` with `idempotency_key_malformed` code | The header value failed format validation (length, charset). | Client bug. Regenerate a valid key. |
| `409` with `idempotency_key_conflict` code | Same key, different body. The client reused a key for a different operation. | **Terminal.** Generate a new key, fix the payload, and resubmit. |
| `425` with `idempotency_in_progress` code | Original request still running. | **Retryable.** Honor `Retry-After`, then retry with the same key. |
| Any other `4xx` / `5xx` | Not an idempotency-layer response; standard error semantics apply. | Per the error envelope's normal retry guidance. |

### 13.2 Expired-key scenario
If a key falls outside the 72h replay window and the client retries
with the same key:
- The server treats the retry as a new request and processes it.
- If the original mutation actually happened (the most common case
  after a long delay), the new processing may create a duplicate
  business effect (a second invitation, for instance) — but only
  because the client retried after the documented retention.
- **Recommendation**: clients SHOULD treat success after the 72h
  window as confirmation of an earlier success and SHOULD NOT retry
  past 72h.

### 13.3 Optional-mode missing header
On an endpoint with `x-idempotency: optional`, a missing header means
the client opted out of replay protection for that retry. The server
processes the request normally; subsequent retries (still without a
header) re-execute the handler and may produce duplicate effects. This
is exactly the pre-idempotency-layer behavior.

### 13.4 SDK responsibilities  (Track E, T624)
The generated client (research §5, Q3) MUST:
- Attach `Idempotency-Key` automatically when the operation declares
  `x-idempotency: required` or `optional` (typed parameter recommended;
  research §5 open follow-up).
- Surface `425` as a retryable result type, NOT as a terminal error
  (research §3, plan §3.4.4).
- Surface `409` as a terminal "client-bug" type with the original-key
  reused; clients catch this and regenerate.

---

## 14. Observability signals

The three idempotency counters are already enumerated in
`docs/observability/signals.md` (T444):

| Signal | Type | Labels | Increment trigger |
|---|---|---|---|
| `idempotency_replay_total` | counter | `route` | Every replayed response (200/201 emitted from a stored record). |
| `idempotency_conflict_total` | counter | `route` | Every `409 Conflict` from a payload mismatch. |
| `idempotency_in_progress_total` | counter | `route` | Every `425 Too Early` from an in-progress marker. |

### 14.1 Cardinality discipline  (FR-B-006, spec §7.7)
The three counters are labeled by `route` **only**. They MUST NOT carry
`tenant_id`, `store_id`, `user_id`, or `actor_id` labels. Per-tenant
analysis lives in logs and traces, not metrics.

### 14.2 Emission point
The interceptor emits the counter just before returning the response. A
replay record write success that fails the counter emission MUST NOT
roll back the response — the counter emission is best-effort
observability, not transactional state.

### 14.3 What is NOT a separate signal
- `idempotency_handler_success_total` — implicit in `http_request_count`
  with status_class `2xx`. Adding a separate counter would double-count.
- `idempotency_marker_set_total` — implicit in
  `idempotency_in_progress_total` from the perspective of the next
  retry. Internal marker churn is not externally observable.

---

## 15. Redaction and logging

### 15.1 Defer to redaction matrix
All logger-boundary redaction obligations defer to
`.specify/memory/redaction-matrix.md`. Track D adds no new
redaction class; it inherits the existing matrix entries:
- **Raw `Idempotency-Key` value** — MUST NOT be logged. Log the
  SHA-256 fingerprint (`key_fingerprint`) only. (Matrix §3.1 /
  field-level row "idempotency conflict handler".)
- **Request body** — never logged in full at the idempotency layer.
  Log the `payload_hash` (fingerprint) instead.
- **Response body** — never logged in full; the stored replay body
  is bytes the redaction matrix authorizes for storage, not for
  emission to logs.

### 15.2 Fields the idempotency layer MAY log
Per the matrix's idempotency-conflict handler entry:
- `request_id`
- `tenant_id` (when established)
- `store_id` (when established)
- `route`
- `client_id`
- `key_fingerprint` (SHA-256 of the `Idempotency-Key` header)
- `fingerprint_mismatch: true/false` (i.e., whether the body matched)
- `outcome: 'replay' | '409' | '425'`

### 15.3 Replay log inheritance
A replay records the same fields as the original — the structured log
entry is conceptually about "the original request whose response is
being served," not about the retrier. The retrier's `request_id` and
`actor_id` are logged as separate fields on the replay event
(`replay_of_request_id`, `retried_by_actor_id`) so investigators can
trace both sides without conflating them.

### 15.4 Trace correlation
The 425 / 409 / replay responses preserve W3C trace context (the
retrier's `traceparent`), so distributed-trace investigators can see
both the original processing span and the retrier's short-circuited
span linked by trace state.

---

## 16. Out-of-scope for this slice

The following are explicitly deferred to future, separately gated work.
**Listing them here is NOT approval to execute.**

| Item | Where it lands | Gate |
|---|---|---|
| Tests T510–T518 (replay, conflict, in-progress, cross-tenant, marker TTL, expiry, missing-header, observability, authorization) | `apps/api/test/idempotency/**` | `[GATED]` source under `apps/**` |
| `IdempotencyInterceptor` (T520) | `apps/api/src/idempotency/idempotency.interceptor.ts` | `[GATED]` source under `apps/**` |
| `@Idempotent` decorator (T521) | `apps/api/src/idempotency/idempotent.decorator.ts` | `[GATED]` source under `apps/**` |
| In-progress marker module (T522) | `apps/api/src/idempotency/` (Redis client reuse) | `[GATED]` source under `apps/**` |
| Controller wiring on `POST /api/v1/memberships/invite` (T523) | `apps/api/src/modules/memberships/` | `[GATED]` source under `apps/**` |
| OpenAPI `x-idempotency: required` declaration (T524) | `packages/contracts/openapi/foundation/memberships.yaml` (or equivalent) | `[GATED]` contract change |
| `IdempotencyKeyStore.defaultTtlMs` config change to 72h (T525) | Runtime config (no schema change) | `[GATED]` per `plan §5` |
| Idempotency on any other endpoint | Per-endpoint future slice | `[GATED]`; one endpoint at a time |
| In-repo CI drift check for idempotency policy in OpenAPI | n/a | `[GATED]` CI workflow |
| Global rollout / opt-out model | n/a — explicitly forbidden by FR-D-007 | Not eligible at any slice |

---

## 17. Validation checklist for the future implementation slice

This is a reference for reviewers of the gated implementation PRs
(T510–T525), not part of this docs slice. Captured here so the
strategy is internally complete.

- [ ] All P5 tests (T510–T518) pass GREEN.
- [ ] Cross-tenant + cross-store sweep tests from 001 still pass on the
      affected route.
- [ ] OpenAPI contract test fixture is updated; the `x-idempotency: required`
      extension is honored by client expectations.
- [ ] `@Idempotent` decorator appears exactly **once** in the
      implementation slice (only on `POST /api/v1/memberships/invite`).
- [ ] No audit double-emission on replay (T534).
- [ ] No new entry in `package.json` (the interceptor uses existing
      NestJS / Redis primitives).
- [ ] No DB schema change (`idempotency_keys` table unchanged; only
      `defaultTtlMs` config changes).
- [ ] Redaction matrix entries for the idempotency conflict handler are
      enforced at the logger boundary (T473).
- [ ] The three observability counters appear in `/metrics` and carry
      only the `route` label.
- [ ] Constitution principles §II, §III, §VII, §XI, §XII, §XIII, §XIV
      are all satisfied per `plan §9`.

---

*End of strategy.*
