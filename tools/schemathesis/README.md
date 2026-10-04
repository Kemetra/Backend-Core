# API fuzz (Schemathesis)

`.github/workflows/api-fuzz.yml` runs [Schemathesis](https://github.com/schemathesis/schemathesis)
against an ephemeral Backend-Core stack on every pull request. It generates
boundary and edge-case inputs from the OpenAPI contracts and sends them to the
real API, with a real Postgres behind it.

It was adopted after the RT-38 PoC, which found the int4 `version` overflow 5xx
that the fixture-based tests missed, and the RT-59 noise measurement. The
decision was a 5xx gate plus report-only contract checks.

## What runs

| Step | Check | Effect |
| --- | --- | --- |
| Gate | `not_a_server_error` | **Fails the PR** on any 5xx not listed in `5xx-baseline.json` |
| Report | `positive_data_acceptance` | Findings **never fail the PR.** Lists requests the contract allows but the server rejects, in the job summary, except those in `report-baseline.json` |

Either step **fails if Schemathesis could not run** a contract file (schema
load, network or tool error), so a broken check never looks green.

Surface: every `cookieAuth` operation in `packages/contracts/openapi/`. `ops.py`
builds the list from the contracts, so new operations are covered automatically.

- Operations whose `403` response says the caller "is not a platform admin"
  (`@PlatformAdminOnly`: tenant create/delete, outbox dead letters) run with a
  **platform-admin session**; everything else runs with the **tenant owner**.
- Skipped: `signOut` and `refreshSession` (they would end the test session) and
  operations marked `x-runtime-status: contract-only` (no route is shipped).

Settings: seed 38, 200 examples per operation, phases `examples,coverage,fuzzing`,
one worker.

`response_schema_conformance` is not run until RT-53 settles `nullable: true`
semantics.

## Files

| File | Purpose |
| --- | --- |
| `compose.yml` | Postgres 16, Redis 7 and the API image. The API is published on 127.0.0.1 only |
| `pg-init/01-roles.sh` | Domain role (NOBYPASSRLS) and auth lookup role (BYPASSRLS), as in `docs/operations/database-roles.md` |
| `stack-up.sh` | Build, migrate, grant, seed (`bootstrap-pilot`, an owner and a platform admin), sign both in, and switch tenant |
| `run.sh` | `gate` or `report` pass |
| `ops.py` | Lists the cookieAuth operations per contract file (runs inside the Schemathesis image) |
| `5xx-baseline.json` | Accepted known 5xx findings |
| `report-baseline.json` | Accepted `positive_data_acceptance` findings that the contract cannot express (RT-66) |

## Safety

- Every credential is generated per run (`openssl rand`) and masked in the logs.
  The Clerk key is a dummy, because this surface never calls Clerk.
- The worker is not started, so nothing drains the outbox and no request can
  reach ERPNext or any external system. Everything is torn down with `down -v`.
- Raw Schemathesis NDJSON reports are **never** written or uploaded, because they
  contain the session cookie. Only the console output (credentials filtered) and
  a summary are kept.
- Schemathesis runs from `schemathesis/schemathesis:4.28.0`, pinned by digest.

## The 5xx baseline

Each entry accepts **one known 5xx on one operation** until it is fixed. The
baseline is currently **empty**: the last entry (`e92dac`, a second credential
issue returning 500) was removed when RT-62 mapped it to `409 conflict`.

An entry matches on operation + check + failure type + status (`500`). **While an
entry exists, any 500 on that operation is accepted**, not only the known one. Keep
the list short and remove entries as soon as the fix lands:

```bash
BASELINE_UPDATE=1 bash tools/schemathesis/run.sh gate   # records current failures
# edit 5xx-baseline.json: keep only entries with a tracked issue
```

After a fix, run the gate with `--baseline-prune` (or delete the entry by hand)
and confirm it still passes.

## The report baseline

RT-66 aligned the contracts with the server's request validation, so the report
step lists no findings on `main` except the entries in `report-baseline.json`.
Each entry exists because the rule cannot be expressed in the contract, or because
of a Schemathesis artifact. An entry matches the same way as in the 5xx baseline:
**while it exists, any `positive_data_acceptance` 400 on that operation is
accepted.**

| Operation | Why it is baselined |
| --- | --- |
| `POST /api/v1/catalog/erpnext-product-reconciliation/repairs` | Cross-field rule: `confirm` and `re_point` need `mappingId` + `version` (RT-59 class D) |
| `PATCH /api/v1/memberships/{membership_id}` | Cross-field rule: `store_ids` must be empty for `all` and non-empty for `specific` |
| `POST /api/inventory/v1/stores/{storeId}/movements` | Cross-field rule: the quantity sign must match `movementType`, and `adjustment` needs a non-blank `reason` |
| `POST /api/v1/memberships/invite` | `role_code` must name an existing role (state-dependent; answered 400 `Unknown role_code`) |
| `GET /api/v1/audit/events` | Opaque base64url `cursor` whose decoded content is validated; not expressible as a pattern |
| `GET /api/v1/admin/outbox/dead-letters` | Same opaque base64url `cursor` |
| `GET /api/v1/catalog/erpnext-sync-ops/reconciliation-runs` | `cursor` shape left undeclared on purpose: a shape-valid token with an out-of-range timestamp returns 500 today. Declare it once that is fixed |
| `POST /api/v1/catalog/unknown-items/bulk-dismiss` | Schemathesis 4.28 artifact: a fuzzing case with a negative component is relabelled positive after a resource-pool draw and sent without the declared, required `Idempotency-Key` |
| `POST /api/v1/connector/instances/{id}/credentials/rotate` | Same Schemathesis artifact |
| `POST /api/v1/connector/credentials/{credentialId}/revoke` | Same Schemathesis artifact |

Record or refresh entries with `BASELINE_UPDATE=1 bash tools/schemathesis/run.sh report`,
then keep only entries with a reason in this table.

## Running locally

```bash
bash tools/schemathesis/stack-up.sh          # builds images, prints "Stack ready"
bash tools/schemathesis/run.sh gate
bash tools/schemathesis/run.sh report
set -a; . "${TMPDIR:-/tmp}/api-fuzz/stack.env"; set +a
API_IMAGE=api-fuzz-api:local docker compose -p api-fuzz -f tools/schemathesis/compose.yml down -v
```

Needs Docker, `curl` and `openssl`. Output, including the session cookie, goes to
`$FUZZ_OUT` (default `${TMPDIR:-/tmp}/api-fuzz`, outside the repo).
