# SDK Handoff Packet — Downstream Consumers

| Field | Value |
|---|---|
| Ref | 004-platform-production-readiness (T625, T626) |
| Status | Draft — copy-pastable handoff packet for downstream repos (dashboard, POS, operator tooling) |
| Audience | Maintainers of downstream-repo CI |

This document is the operating handoff for any repo that needs a typed client
for the Backend-Core API. The full design rationale lives in
[`docs/sdk/strategy.md`](./strategy.md).

---

## 1. Where the OpenAPI contracts live

- **Source**: `packages/contracts/openapi/` in this repo ([`Kemetra/Backend-Core`](https://github.com/Kemetra/Backend-Core)).
- **Files** (current as of 2026-05-16):
  - `auth.openapi.yaml`
  - `context.openapi.yaml`
  - `tenants.openapi.yaml`
  - `stores.openapi.yaml`
  - `memberships.openapi.yaml`
  - `audit.openapi.yaml`
  - POS-specific:
    - `pos-operators.openapi.yaml`
    - `pos-shifts.openapi.yaml`
    - `pos-audit-events.openapi.yaml`

These files are the single source of truth. They are **never edited in
downstream repos**. Any change to the API surface flows through a PR against
this repo; downstream regeneration follows.

---

## 2. How to run `openapi-typescript`

Pin the generator in your downstream repo:

```
npx openapi-typescript@<pinned-version> <path-to-yaml> -o <output.ts>
```

- Recommended pinned version: latest minor of `openapi-typescript@7.x` at the
  time your downstream repo locks in.
- Pin in `package.json` `devDependencies` and lock the resolution in
  `package-lock.json` / `pnpm-lock.yaml`.
- Output: a single `.ts` file containing `paths` and `components` types.
  **No runtime code is emitted by the type generator.**

If you consume multiple YAML files, run the generator per file (or use the
multi-file mode supported by the generator version you pin) and import each
generated module separately. Mixing surfaces into a single `paths` union is
discouraged because it hides which contract owns which route.

---

## 3. How to configure `openapi-fetch`

Install in the downstream repo (NOT in this repo):

```
npm install openapi-fetch
```

Illustrative usage (NOT executable code in this repo, no SDK file is created
here):

```ts
// illustrative only — lives in the downstream consumer
import createClient from "openapi-fetch";
import type { paths } from "./generated/dp2-api";

const client = createClient<paths>({ baseUrl: "https://api.example.com" });

const { data, error } = await client.POST("/api/v1/memberships/invite", {
  body: { email: "x@y.z" },
  headers: { "Idempotency-Key": "<uuidv7>" },
});
```

The fetch wrapper is intentionally thin. Cross-cutting concerns (auth header
injection, idempotency-key generation, retry policy) belong in a small adapter
inside the downstream repo, not in the generated artifact.

---

## 4. Drift-detection CI recipe (illustrative)

Pseudocode for a downstream-repo CI job. Adapt to your CI runner of choice.

1. Fetch the pinned contracts:
   ```
   git clone --depth 1 https://github.com/Kemetra/Backend-Core contracts-src
   ```
   (or download a pinned contract artifact — see §5.)
2. Regenerate against the pinned source:
   ```
   npx openapi-typescript@<pinned> contracts-src/packages/contracts/openapi/auth.openapi.yaml -o ./generated/dp2-auth.ts.new
   # ...repeat per yaml file
   ```
3. Diff against the committed generated output:
   ```
   diff -u ./generated/dp2-auth.ts ./generated/dp2-auth.ts.new
   ```
   A non-zero exit fails CI.
4. If a diff is detected: open a PR in the downstream repo to regenerate.
   The PR reviewer cross-references the corresponding contract change in this
   repo (link the upstream PR / commit in the description).

---

## 5. OpenAPI versioning recommendation (T626 — future work)

To let downstream repos pin by version rather than by commit SHA, this repo
SHOULD publish tagged contract artifacts (for example, GitHub releases) once
the contracts stabilize.

- Recommended tag scheme: `contracts-v<semver>` (for example,
  `contracts-v1.0.0-draft`).
- Recommended artifact: a tarball of `packages/contracts/openapi/` for the
  tagged commit, plus the resolved bundle (single-file form) if useful.

**This is future work and is NOT implemented in this phase.** It is documented
here so downstream maintainers know the direction and can structure their CI
to switch from SHA-pin to version-pin without a rewrite.

---

## 6. Tenant / store context handling

- The SDK consumer is responsible for establishing tenant context before
  making tenant-scoped calls.
- Recommended flow:
  1. `POST /api/v1/auth/signin` → obtain bearer token.
  2. `POST /api/v1/context/tenant` → establish tenant context server-side.
  3. Subsequent calls inherit the context via the bearer token; no header
     juggling on the client.
- Some endpoints accept explicit `X-Tenant-Id` / `X-Store-Id` headers per the
  OpenAPI definitions. The SDK SHOULD expose these as explicit per-call
  options, not as automatic headers derived from a global. Implicit global
  state on a client that may run inside multi-tenant workers is a known
  cross-tenant footgun.

---

## 7. Idempotency expectations

- Mutating calls (`POST`, `PATCH`, narrow `DELETE`) SHOULD expose an
  `Idempotency-Key` option per call.
- The SDK MUST NOT auto-generate keys. The application owns the intent of
  "this is the same logical operation."
- Auto-retry on `425 Too Early` is opt-in; honor `Retry-After`.
- Auto-retry on `5xx` is opt-in and disabled by default.
- `409 Conflict` is terminal — never auto-retried.
- See [`docs/idempotency/strategy.md`](../idempotency/strategy.md) for the
  server-side semantics, including the `Idempotent-Replayed: true` response
  header that the SDK SHOULD surface to callers.

---

## 8. What is NOT in this packet

- No generated `.ts` artifact lives in this repo. Generation is the downstream
  consumer's responsibility (FR-E-007).
- No `packages/sdk` package exists in this repo. Confirmed absent at handoff
  time. This is intentional and locked by spec §1.5 Q3 for the first slice.
- No CI workflow change in this repo as part of this phase. Drift detection
  is a downstream-repo concern in the first slice.
