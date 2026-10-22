# Contributing

Thanks for helping make Data-Pulse-2 better. This repository is governed by
the foundation specification and Constitution checks in the pull request
template, so changes should stay small, reviewed, and testable.

## Before You Start

1. Read [CLAUDE.md](CLAUDE.md) for the active feature, stack defaults, and
   ownership boundaries.
2. Read the relevant artifact under `specs/001-foundation-auth-tenant-store`
   before changing behavior.
3. Confirm whether the change touches tenant isolation, backend authority,
   contracts, workers, observability, or migrations.
4. For project rules and architectural decisions, see
   [.specify/memory/constitution.md](.specify/memory/constitution.md). The
   `.specify/` directory holds governance artifacts — Constitution, architecture
   impact rules, and decision records. These are not product runtime code.

## Local Setup

```bash
pnpm install
pnpm db:up
pnpm build
pnpm test
```

Use these local service URLs when running the API and worker:

```bash
DATABASE_URL=postgres://dp2:dp2_dev_password@localhost:5432/data_pulse_2
REDIS_URL=redis://localhost:6379
```

## Development Rules

- Apps can depend on packages; packages must not import from `apps/*`.
- `apps/api` and `apps/worker` should not import from each other.
- Keep PostgreSQL as the source of truth. Redis is disposable runtime support.
- Keep OpenAPI YAML in `packages/contracts/openapi` aligned with API behavior.
- Add tests for behavior changes. Cross-tenant and cross-store isolation tests
  are required when tenant-owned data is touched.
- Do not introduce dashboard UI, POS app code, analytics, billing, inventory,
  or unrelated domains without an explicit spec update.

## Pull Requests

Every PR should include:

- A short summary of what changed and why.
- A completed Constitution Check from `.github/pull_request_template.md`.
- A test plan with commands run locally.
- Migration/deployment notes when schema, queues, environment variables, or
  runtime wiring changes.

Prefer small PRs that map to a specific spec task or reviewable behavior slice.

### Changelog entries and contract-only operations (RT-805)

Parallel PRs must not edit shared lines, so a merge never makes its siblings
conflict:

- **Changelog.** Do not edit `CHANGELOG.md`. Add one file per entry,
  `changelog.d/RT-<number>-<slug>.md`, holding one `### Added` / `Changed` /
  `Deprecated` / `Removed` / `Fixed` / `Security` heading and the entry. See
  [changelog.d/README.md](changelog.d/README.md). `node tools/changelog/assemble.cjs`
  validates them, and `--migrate` moves an entry written into `[Unreleased]`
  by mistake. The release runs `--release <version>`.
- **Contract-only operations.** Mark the operation `x-runtime-status:
  contract-only` with an `x-runtime-note` naming the ticket that ships the
  runtime. That is the whole registration: the route-conformance spec derives
  the set from the markers. When the runtime ships, delete both keys. The
  spec fails if a marked operation already has a route, or if an unmarked one
  has none.
- **Console rate-limit classes.** Every `cookieAuth` operation, runtime or
  contract-only, has its class in its contract's own file,
  `apps/api/test/console-rate-limit/classes/<contract>.rate-limit.yaml`
  (`audit.openapi.yaml` → `audit.rate-limit.yaml`; subdirectories mirror
  `packages/contracts/openapi/`). Add the entry with the contract. Shipping
  the runtime removes only the `x-runtime-status` marker; the class entry
  stays, and the ratchet then checks that the handler resolves to it. The
  ratchet fails on an unclassified operation, a class mismatch, a
  contract-only operation that is routed, or a stale, duplicated or unknown
  entry.

### Migrations, grants and metrics (RT-812)

The same rule holds for migrations: a migration PR adds its own files and edits
no shared list, so two migration PRs merge in either order without a conflict.
Each registry below has a frozen `baseline` holding everything registered before
RT-812 (origin/main 7847a9e9). **Never add to a baseline**; a test fails if one
gains an entry. Removing a retired entry from it is fine. Migration numbering is
unchanged: two PRs that pick the same number still renumber at merge.

- **Migration.** Add `packages/db/drizzle/<NNNN>_<name>.sql` and its
  `.down.sql`, plus `packages/db/__tests__/cli/migrations/<NNNN>_<name>.ts`
  exporting `MIGRATION = { id, probe }`.
  - The probe's `measure` reads only this migration's own objects (helpers in
    `migration-probes.ts`). `applied` is the reading after `up`; `rolledBack` is
    the reading right after its own `down`, and it must differ from `applied`.
  - `migrate.spec.ts` then checks:
    - after `up`, every probe reads `applied`;
    - after one `down`, the head reads `rolledBack` and every other probe still
      reads `applied`;
    - in the full unwind, each probe reads `rolledBack` right after its own down.
  - Nothing else is edited: not `migrate.spec.ts` and not the
    `migration_0001.spec.ts` down chain, which is derived from the drizzle
    directory.
  - The registry fails on a stray, deleted or down-less migration, a misnamed
    fragment and a head without a biting probe.
  - If your migration changes objects an earlier probe reads, update that
    probe's `applied` value.
- **Domain-role grants.** Add `docs/operations/sql/<slug>-domain-grants.sql`.
  - Its header documents the tables, the privileges and what must never be
    granted. It also carries the line `-- deploy: every-release`.
  - `deploy/apply-domain-grants.sh` (README deploy step 2) applies every marked
    script in name order. `release-bundle.sh` ships the same set.
  - A script without the marker, such as an owner-gated one, is never run by
    step 2.
- **Boot-checked grants.** Add `apps/api/src/auth/grants/<slug>.grants.ts`
  exporting `GRANTS`:
  - `deployScripts`: your script.
  - `domainRequired`: exactly the script's `GRANT`s. The API refuses to boot
    without them, and a test compares them with the script.
  - `lookupForbidden`: the new tables the BYPASSRLS auth lookup role must not
    touch (`ALL_TABLE_PRIVILEGES`).
  - `lookupAllowed`: tables the lookup role may be granted on, **each with a
    written reason**.
  - **Every table a migration after the baseline creates must be in
    `lookupForbidden` or `lookupAllowed`; a test fails on an unclassified table.**
  - No section in `docs/operations/database-roles.md`, no README or bundle edit.
- **Metric.** Add
  `packages/shared/src/observability/metric-labels/<slug>.labels.ts` exporting
  `METRIC_LABELS = { <metric>: [<label keys>] }`.
  - Create and record the metric in its own domain module, as
    `apps/api/src/ai/gateway/ai-gateway.metrics.ts` does. Do not append it to
    `api.metrics.ts` or `worker.metrics.ts`.
  - A metric registered twice, a malformed fragment or a stray file fails at
    import.

The grant and label fragments are loaded from their directory at import, the
compiled `.js` siblings in `dist` and the `.ts` sources under ts-jest. Loading
fails closed: a missing directory or baseline, or a stray file, refuses to boot.
After deleting a fragment, rebuild from a clean `dist`: tsc does not remove the
old `.js`, which would still load.

### CodeRabbit review

CodeRabbit is the primary AI reviewer, but it is capped at about one review per
hour, so `.coderabbit.yaml` reviews only the first push of a PR automatically
(`auto_incremental_review: false`). Add the `skip-coderabbit` label to opt a PR
out. For High-tier PRs (the risk tiers in `.github/scripts/ci-tier.sh`,
RT-582), comment `@coderabbitai review` on the final head once it is pushed.
