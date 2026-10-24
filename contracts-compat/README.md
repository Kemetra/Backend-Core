# contracts-compat: POS compatibility matrix (RT-713, gate G4)

Installed POS terminals never update atomically, so every Backend-Core change must stay
compatible with every **supported, actually installed** POS contract snapshot. The
`contracts-compat (POS supported snapshots)` job in `.github/workflows/ci.yml` enforces it.
Design: RT-709 §C.1 (Confluence page 43712707). Owner authorization: RT-713 comment 13209.

## What the job does

`node contracts-compat/check.mjs [--mode pr|release]`

1. Parses `pos-supported.yaml` (strict YAML subset, no dependencies) and validates it.
2. For every `supported` entry, checks `git rev-parse <commit>:<root>/<path>` equals the
   listed blob, and that `snapshot_sha256` matches the listed path/blob pairs. A snapshot is
   **referenced by commit and blob, never copied**, so it cannot drift from history.
3. Extracts those files with `git show` and runs `oasdiff breaking --composed --fail-on WARN`
   (same severity file as `tools/oasdiff/check.sh`) from the snapshot to the current
   `packages/contracts/openapi`.
4. Runs the idempotency rules (`lib/semantics.mjs`) snapshot -> current. Only rules oasdiff does
   not already enforce live there (probes show oasdiff passes each regression): an operation
   the snapshot marks `x-idempotency: required` still does, and still requires the
   `Idempotency-Key` header if the snapshot did; every non-2xx status the snapshot declares is
   still declared. A required `error.code` being removed is already an oasdiff ERR.
5. Replays the snapshot's fixtures (`replay/<snapshot-id>/*.yaml`, RT-709 §C.2) **at contract
   level, offline**. Each event is checked on its own, first against the snapshot (a fixture
   must be valid there), then against the current contracts: the operation exists, the
   `Idempotency-Key` fits the header schema, the body validates against the request schema (a
   small fail-closed validator: an unimplemented schema keyword is an error), and the expected
   status is still declared. Nothing simulates the server: Backend-Core's runtime idempotency
   behavior stays covered by `apps/api/test/idempotency/replay.spec.ts` (db-integration).
6. Runs the synthetic **test-only** probes (`synthetic/`): a deliberately breaking candidate
   must fail and a compatible one must pass (oasdiff), and each named regression in
   `lib/mutations.mjs` must make the idempotency/replay rules fail. This proves the harness,
   not real clients.

The output keeps these results apart: harness correctness, real-snapshot oasdiff,
envelope/idempotency, and replay with its counts by provenance.

**Verdict.** `VERIFIED (contract level; replay is offline)` means oasdiff and the idempotency
rules pass for every snapshot **and** each has at least one eligible fixture. A snapshot with no
fixture makes replay `NOT_PROVEN` (verdict `NOT_VERIFIED`, never a pass). `--mode release`
additionally needs one `recorded` fixture per snapshot, because `contract-derived` fixtures are
authored from the pinned contract, not recorded from a terminal; today there are none, so
release mode exits non-zero.

### Fixture provenance

`recorded` (scrubbed capture from a supported terminal), `contract-derived` (authored from the
snapshot's own contract and validated against it; the POS persists sale ids in its outbox and
builds wire payloads at drain time, so there is no stored payload to record), `synthetic`
(test-only, never allowed for a real snapshot's coverage).

## States

| State | Meaning | PR gate |
| --- | --- | --- |
| `FAIL_INVALID_MATRIX` | schema violation, unknown kind, exception while something is installed | fail |
| `FAIL_MISSING_SNAPSHOT` | installed build/release without a verifiable snapshot, or nothing installed and no exception | fail |
| `FAIL_BREAKING` | oasdiff WARN/ERR against a supported snapshot, not in `accepted-breaks.txt` | fail |
| `NOT_PROVEN_NO_SUPPORTED_RELEASE_SNAPSHOT` | nothing installed, valid owner-approved `bootstrap_exception` | pass, never green |
| `FAIL_STALE_FLEET` | `fleet_baseline.captured_at` older than 7 days (owner decision O-3) | warning on PR, fail in release mode |

## Adding or dropping a POS build

- **Add:** record the terminal inventory on RT-713 (device label, POS commit, capture date), then
  add an `installed` and a `supported` entry. Take `contract_ref` from that POS commit's
  `contracts/backend-core/PIN` (commit + the pinned files' blobs), copy the PIN blob and the BC commit it pins into
  `pos_pin` (`bc_commit` must equal `contract_ref.commit`), add a replay fixture under
  `replay/<snapshot-id>/`, and compute `snapshot_sha256` (sha256 of the sorted `<blob>  <path>\n` lines).
- **Drop:** delete the entry and its `accepted-breaks.txt` lines in a reviewed PR. Never drop a
  version that is still installed.

## Accepted breaks

`accepted-breaks.txt` lines are keyed by snapshot id and need a Jira key and a `consumer:` tag.
They do **not** expire with the PR (unlike `tools/oasdiff/breaking-ignore.txt`): a snapshot is
fixed, so an accepted break stays true for every later PR until the snapshot is dropped.

## Known gaps

- No `recorded` fixture yet (needs scrubbed captures from the lab terminal); replay never runs
  against a live Backend-Core here. Release gating on this result is RT-863.
- Shadow monorepo: `contracts-compat/` arrives by re-import; the `commit` references point at
  standalone Backend-Core history, and the graph tier/job keys are a separate policy change.

Run locally (needs `oasdiff` on PATH and full git history):
`node --test contracts-compat/__tests__/compat.spec.mjs && node contracts-compat/check.mjs`
