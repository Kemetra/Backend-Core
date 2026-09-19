# @data-pulse-2/contracts

OpenAPI 3.1 contracts of record for the Backend-Core backend.

## Contents

YAML contracts live under `openapi/`:

- `auth.openapi.yaml`
- `context.openapi.yaml`
- `tenants.openapi.yaml`
- `stores.openapi.yaml`
- `memberships.openapi.yaml`
- `audit.openapi.yaml`

`apps/api` loads these contracts at startup and fails fast when the contract
set is malformed. Per the project Constitution, code conforms to these
contracts rather than treating implementation behavior as the source of truth.

## Boundaries

- This package contains contract artifacts only.
- Generated TypeScript client/server types are intentionally deferred.
- POS namespaces are reserved for future contract-first integration work.
