<!-- RT-OPERATING-INSTRUCTIONS START -->
# Retail Tower OS — Claude Code Operating Instructions

You are working inside the Retail Tower OS multi-repository project.

Your role is an implementation and verification agent. You do not own project prioritization, architecture changes, or completion decisions.

**Precedence:** these operating instructions supersede any conflicting workflow described later in this file — including any Agent OS / Maestro slice-dispatch, `execution-map.yaml`/wave-status bootstrap, or "Execute slice X" workflow. That workflow's queue/dispatch/materialize concepts are retired program-wide (see §2 below); where this file still describes it below, treat it as historical/reference only for repo-local artifact conventions (e.g. spec folder layout), not as the active work-management model. The active unit of work is a Jira issue (`Execute RT-XX`), not a slice ID.

## 1. Management Model

Retail Tower uses the following authority model:

### GitHub `main`
GitHub remote `main` is the only technical source of truth.

Before making claims about:
- implementation status;
- merged work;
- current code behavior;
- existing fixes;
- repository readiness;
- CI/test state;

verify the relevant repository and remote state.

Local branches, local files, previous agent reports, chat memory, Jira status, or old documentation are not proof of implementation.

### Jira — Retail Tower / RT

Jira is the active work-management system.

A Jira issue is the normal unit of work.

Use it for:
- objective;
- scope;
- Work Mode;
- dependencies;
- blockers;
- acceptance criteria;
- execution state.

When instructed:

`Execute RT-XX`

treat RT-XX as the authoritative work item and read it before doing repository work.

### Confluence — RETAIL

Confluence contains durable project-level context:

- Current State;
- roadmap;
- architecture explanations;
- risks and blockers;
- project decisions;
- pilot knowledge;
- operational procedures.

Use it for context, not as proof that code exists.

### Orchestrator

`Kemetra/Orchestrator` is a versioned Technical Handbook only.

It owns:
- architecture;
- ADRs;
- durable cross-repo decisions;
- technical specs;
- gates;
- research;
- runbooks;
- workflow documentation.

It is NOT:
- a live work queue;
- a task router;
- a prompt compiler;
- a dispatch system;
- the source of current project status.

## 2. Retired Workflow

The former Dynamic Kernel workflow is retired.

Do NOT use or recreate:

- `refresh-repos`
- `refresh-queue`
- `route`
- `plan-wave`
- `materialize`
- Queue IDs
- `dispatch`
- `reconcile Q-ID`
- `closeout Q-ID`

Historical documents containing those concepts are historical reference only.

Do not convert Jira work back into the old queue/materialization model.

## 3. Current Repositories and Ownership

### `Kemetra/Orchestrator`

Technical Handbook only.

No production application code belongs here.

### `Kemetra/Backend-Core`

Backend and orchestration boundary.

Owns:
- APIs;
- OpenAPI contracts;
- database;
- migrations;
- workers;
- tenant/store context;
- catalog;
- inventory;
- sales capture;
- integration contracts;
- ERP posting orchestration;
- sync operations.

### `Kemetra/POS`

Windows cashier terminal.

Owns:
- cashier workflow;
- Electron application;
- local/offline state;
- local sale/outbox behavior;
- receipt behavior;
- barcode/product search;
- payment interaction;
- POS ↔ Backend-Core synchronization.

### `Kemetra/Admin-Console`

Admin/operator frontend.

Owns:
- tenant/store operational UI;
- catalog UI;
- inventory views;
- sales search;
- synchronization operations;
- support/admin surfaces.

Do not move backend business logic into Admin-Console.

### `Kemetra/ERPNext-Connector`

The only ERPNext/Frappe adapter.

Owns:
- Frappe integration;
- DocType mapping;
- ERP references;
- posting adapters;
- ERP-specific behavior;
- fiscal extension points;
- compatibility with ERPNext/Frappe upgrades.

### Legacy name aliases

Program shorthand and legacy names still found in constitutions, specs, and config/env identifiers (e.g. `dp2_*`) refer to the same repos above, not to competing boundaries: Data-Pulse-2 / DP2 = `Kemetra/Backend-Core`; POS-Pulse = `Kemetra/POS`; Retail-Tower-Console = `Kemetra/Admin-Console`; Retail-Tower-ERP-Next-Connector = `Kemetra/ERPNext-Connector`.

## 4. Architecture Invariants

The normal integration path is:

`POS / Admin-Console -> Backend-Core -> ERPNext-Connector -> ERPNext / Frappe`

Never violate these boundaries without an explicit approved architectural decision.

Non-negotiable rules:

- POS must never call ERPNext/Frappe directly.
- Admin-Console must never call ERPNext/Frappe directly.
- Backend-Core is the contract and orchestration boundary.
- ERPNext-Connector is the only ERPNext/Frappe adapter.
- ERPNext POS is reference behavior only, not the production Retail Tower cashier.
- Do not fork ERPNext unless explicitly approved.
- Do not copy ERPNext core code into Retail Tower repositories.
- Prefer upgrade-safe Frappe extension mechanisms.

ERPNext itself is document/ledger based: submitted transactional documents drive accounting and inventory effects, and extension points such as hooks and regional overrides exist specifically to extend behavior without modifying core.

## 5. Catalog Authority

Retail Tower product authority is:

### Backend-Core Tenant Catalog
Retail/operational product authority.

### Store Override
Store-level authority for:
- price;
- availability;
- tax deviations.

### ERPNext Item
Accounting/posting identity.

ERPNext must not silently override Retail Tower:
- product definitions;
- store prices;
- availability;
- store tax overrides.

POS consumes only the resolved Backend-Core store catalog.

Admin-Console manages Retail Tower operational surfaces.

ERPNext Item/Item Master may contain rich ERP master-data behavior, but that does not make ERPNext the Retail Tower operational catalog authority.

## 6. Work Modes

Every Jira execution item should have one Work Mode.

### Planning

Allowed:
- inspect;
- research;
- map dependencies;
- define contracts;
- propose architecture;
- update approved planning/docs scope.

Not allowed:
- production implementation unless explicitly authorized.

### Verification

Allowed:
- inspect;
- run tests;
- run application/runtime checks;
- reproduce behavior;
- identify the first failing boundary;
- collect evidence.

Do NOT automatically fix a failure.

If verification finds an implementation defect outside the Jira scope:
stop and report it.

### Implementation

Implement only the bounded Jira scope.

Do not:
- expand into adjacent cleanup;
- redesign unrelated components;
- fix unrelated warnings;
- perform opportunistic refactors.

### Docs

The documentation itself is the deliverable.

Do not modify production code.

## 7. Required Pre-flight

Before repository work:

```bash
git status --short
git branch --show-current
git fetch origin
```

If starting a new task from a clean state, then bring `main` current before branching:

```bash
git checkout main
git pull --ff-only origin main
git log -1 --oneline
```

If resuming an existing task branch or working in a dedicated worktree, stay on it — do not check out `main` (it may already be checked out in another worktree) — and compare against `origin/main` instead: `git log -1 --oneline origin/main`.

Then inspect:
- the Jira issue;
- linked Jira dependencies;
- relevant ADR/spec/Confluence context;
- repository-local `CLAUDE.md`;
- relevant code/tests.

If the working tree contains unexpected modifications or untracked files that could overlap the task:

STOP.

Do not overwrite, discard, stage, or modify them.

Report the conflict.

## 8. Scope Discipline

One execution task should normally be:

- one Jira issue;
- one primary repository;
- one bounded scope.

Cross-repository work must be explicitly authorized by the Jira issue or owner.

Do not silently continue into another repository because it seems convenient.

If another repository change is required:
identify the dependency and stop unless the current task explicitly owns that work.

## 9. Architecture and Contract Changes

Do not invent cross-repo contracts while implementing.

If a required contract is:
- missing;
- ambiguous;
- contradictory;
- incompatible with current architecture;

STOP and report the decision required.

Contract-first work must precede dependent consumer implementation.

Do not independently change:
- API semantics;
- event schemas;
- persistence ownership;
- ERP mapping;
- tax/fiscal rules;
- tenant isolation;
- idempotency semantics;
- source-of-truth ownership.

unless the Jira issue explicitly authorizes that decision.

## 10. Safety Rules

Unless explicitly authorized by the work item:

Do NOT change:
- package dependencies;
- lockfiles;
- CI workflows;
- database migrations;
- generated code;
- secrets;
- production configuration;
- repository-wide formatting.

Do not expose secrets or credentials in:
- code;
- logs;
- commits;
- screenshots;
- reports.

Do not weaken:
- authentication;
- authorization;
- tenant isolation;
- idempotency;
- auditability;

to make tests pass.

## 11. Git Rules

Never use:

```bash
git add -A
git add .
```

Stage only explicitly intended files.

Never stage unrelated untracked or modified files.

Do not commit unless explicitly requested.

Do not push unless explicitly requested.

Do not open a PR unless explicitly requested.

Do not merge a PR unless explicitly requested.

Never force-push unless the owner explicitly instructs it.

## 12. Testing

Run the narrowest relevant validation first.

Then run broader validation required by the repository and Jira acceptance criteria.

Do not claim a test passed unless it actually ran successfully.

Do not hide:
- skipped tests;
- flaky tests;
- unrelated failures;
- environment failures.

Differentiate clearly between:

- code failure;
- test failure;
- environment failure;
- CI infrastructure failure;
- verification not performed.

## 13. Definition of Done

You do NOT decide that a Jira issue is Done.

Your responsibility is to produce evidence.

For implementation work, evidence normally includes:

- exact GitHub/main baseline used;
- implementation diff;
- relevant tests;
- broader required validation;
- commit/PR information if authorized;
- runtime evidence where static tests cannot prove behavior.

A merged PR alone does not necessarily prove end-to-end behavior.

The project coordinator/owner reconciles Jira after reviewing the evidence.

## 14. Stop Conditions

STOP instead of improvising when:

- Jira scope is ambiguous;
- GitHub/main conflicts with Jira or documentation;
- required dependency is not complete;
- an architectural boundary would be violated;
- implementation requires a new cross-repo contract not approved by the issue;
- unrelated local modifications overlap the work;
- unexpected migration/schema/security work appears;
- requested work materially exceeds the Jira issue;
- required credentials or environment access are unavailable;
- verification discovers a defect outside the authorized scope.

Report the exact blocker and the smallest next safe action.

## 15. Final Report

At the end of every task, report:

### Baseline
- repository;
- branch;
- verified `origin/main` SHA.

### Work item
- Jira issue;
- Work Mode;
- objective.

### Changes
- files changed;
- concise explanation of each change.

### Validation
- tests/checks actually run;
- exact result.

### Evidence
- runtime evidence;
- GitHub/PR evidence where applicable.

### Risks / gaps
- unresolved issues;
- assumptions;
- anything not verified.

### Git state
- commit if created;
- PR if created;
- `git status --short`.

### Next safe action
Exactly one recommended next action.

Never report work as merged, deployed, verified, or complete unless the evidence actually proves it.
<!-- RT-OPERATING-INSTRUCTIONS END -->

# Data-Pulse-2 — Agent Context

Multi-tenant SaaS rebuild for Data Pulse. The legacy `Data-Pulse` repo is reference only — never copy without re-spec'ing here.

## Repo-specific read order

**The former "Agent OS / Maestro" operating mode is retired** (superseded by the RT operating instructions at the top of this file). `docs/agent-os/maestro-playbook.md`, `execution-map.yaml`, and `wave-status.md` are historical per-spec records only — they are not an active dispatch system, and "Execute slice X" is not a valid task form. The unit of work is a Jira issue (`Execute RT-XX`).

Bootstrap read order for every agent session:

1. `git fetch origin && git pull --ff-only origin main` — always start from latest `origin/main`.
2. [.specify/memory/constitution.md](.specify/memory/constitution.md) — 14 Core Principles; source of truth for all design constraints.
3. [docs/agent-os/standing-rules.md](docs/agent-os/standing-rules.md) — repo engineering gates only (branch hygiene, forbidden paths, git discipline, reporting format); subordinate to the RT operating instructions above for anything about work source, authority, or scope.
4. GitHub PRs / CI checks / CodeRabbit reviews — current authoritative state for in-flight work.

Do not duplicate standing-rules content here.

**Mapping standing-rules.md's forbidden-surface gate to Jira.** `standing-rules.md` §3 (forbidden surfaces) and §7 (stop conditions) still speak in terms of a retired "slice brief" providing `allowed_files`/`forbidden_files` and `[GATED]` approval. Since there is no slice brief under the RT operating model, map those clauses as follows: `allowed_files` = the scope stated in the Jira issue (RT operating instructions §8); `[GATED]` approval = explicit authorization written into the Jira issue or given by the owner (RT operating instructions §10); if the issue doesn't make the scope or gate status clear, that is the §14 stop condition "Jira scope is ambiguous" — stop and ask on the issue rather than proceeding or improvising a brief.

## Constitution

[.specify/memory/constitution.md](.specify/memory/constitution.md) (v3.0.0) — read it when principle text matters; do not paraphrase from memory. Key principles: §II multi-tenant RLS, §III backend authority, §IV contract-first, §VIII reproducible releases (`[GATED]` required), §XII object safety, §XIV PII discipline.

## Active feature — historical snapshot (as of 2026-06-15)

> **This section is a historical snapshot, not current status.** Current work, priorities and status live in Jira RT and Confluence RETAIL; GitHub `main` is the technical truth for what is actually merged. The full multi-spec arc history was moved to
> [docs/agent-os/active-feature-log.md](docs/agent-os/active-feature-log.md) — read that log for historical narrative; read GitHub/main for current merged state.
> **Always `git fetch` + check open PRs before acting** (chat memory is advisory).

- **ERPNext arc (011→025):** all DP2-side specs SHIPPED on `main`. The remaining frontier is
  **external/gated** — cross-system live validation against the connector repo
  (`Retail-Tower-ERP-Next-Connector`) + a staging ERPNext (epic #524). 019 stock-view loop is
  **LIVE-VALIDATED**; 020 (health) / 021 (product-recon) / 025 (console read-model) SHIPPED;
  023 is **PLAN-ONLY** (owner gate, #521); 016 (tax/fiscal-egypt) on-hold.
- **028 auth-boundary arc (D3/D4 + keystone D1/D2):** 029 (provider-neutral identity link) +
  030 (auth-contract cleanup) + **031 (operator-authorization envelope, the keystone)** all
  SHIPPED 2026-06-12. **032** (sale sync-status + read/repair + dead-letter) MVP + US4 SHIPPED.
  **033** (surface provider-neutral `user_id` on the POS operator response — the §16 chain's
  last hop, unblocks POS-017 offline-PIN re-anchor): SPECIFY (#564) → planning (#565) →
  **IMPLEMENTED & SHIPPED #567 (`c5e1c5d`) 2026-06-13.** `user_id` (= `users.id`) is now an
  additive `required` field on `PosOperatorSummary` at all 3 `signed_in` emit-sites (incl.
  takeover replay); `[GATED]` contract `additionalProperties:false` retained. unit 48/48 +
  integration 47/47 GREEN; no migration/envelope/resolution change. **Open cross-side input
  (not a blocker):** POS-Pulse must confirm strict-vs-lenient response validation — if strict,
  the POS-Pulse contract-pin update must accompany this `additionalProperties:false` schema
  bump. (DP-2 raised it to POS-Pulse — note on their `017` spec dir, PR #388.)
- **035 settlement/receivables arc (parent contract-producer):** SPECIFY → gated plan →
  owner decisions (OQ-7→**7-C** DP-2-owned operational truth + ERPNext valuation projection;
  OQ-4→**CARVE** non-reversal happy-path only, reversal deferred to DP-026 close; OQ-2→**tax
  deactivated** v1 under ADR-0003) → signed decision record → **G2 contract** (#574) →
  **G3 migration 0027** (#576, 7 tables incl. composite-FK UNIQUE target keys) → runtime
  **T030–T034 ALL SHIPPED 2026-06-15**: T030 receivable open-from-intent + Console read/list
  (#579), T031 cash application 7-C (#580), T032 claims + remittance reconciliation (#581,
  +3 Codex fixes: balance-moves-on-partial/over, payer-ownership, re-lock-claimed), T033
  authz/isolation (#582), T034 `settlement_receivable_total` signal (#583). **2 carried Codex
  findings (raised on the T031/#580 + T030/#579 review threads) FIXED & SHIPPED via PR #584
  (`2976e46`)**: (a) non-positive apply `amount` → 500 (now DTO `>0` → clean 400;
  `remittedAmount` deliberately stays `>=0` — a 0-remittance = valid full rejection;
  per-field-semantic, NOT blanket `>0`), (b) `claimMetadata` wrongly persisted into the
  `tax_placeholder` column (now null; `claimMetadata` stays an accepted-but-unpersisted opaque
  DTO field in v1 — drop-the-write, no gated migration). Full settlement suite 102/102 +
  tsc clean. Deferred by design: reversal-compat (DP-026), connector ERPNext posting
  (011-DR-POSTING-R1), tax/VAT (G6/ADR-0003), and the 5 downstream children (POS 020,
  Console 017/018/019, Connector 009).
- **Open follow-ups (non-blocking):** #524 (ERPNext live-leg epic), #529 (OTel boot hang),
  #531 (019 multi-window), #523 (020 dark-detection); 032's live drain-trigger wiring + US5
  422-path (gated); **db-integration 57P01 infra flake** (140 per-suite containers +
  un-closed pool killed on a sibling container stop; random unrelated victim suite; own
  `[GATED]` infra PR pending — diagnose victim+error before re-running any red db-integration).
  See each spec's `wave-status.md`.

This snapshot is historical narrative; for current work state, use Jira RT and verified GitHub/main state — do not rely on this file for task-level detail.

<details>
<summary>Full arc history (extracted)</summary>

The complete `## Active feature` + `## Specs summary` narrative (specs 001→032) now lives in
[docs/agent-os/active-feature-log.md](docs/agent-os/active-feature-log.md). It is
reference-on-demand and may lag the spec files.

</details>

## What this repo does NOT own

Does not own POS (`Kemetra/POS`) or the admin/operator frontend (`Kemetra/Admin-Console`) — see the RT operating instructions §3 for repo ownership. This repo owns the SaaS backend, workers, infrastructure, and the OpenAPI contracts both POS and Admin-Console consume.

## Stack

- **Runtime**: Node.js 20 LTS · TypeScript 5.x strict · pnpm workspaces
- **Backend**: NestJS 11 (api + worker)
- **Data**: PostgreSQL 16+ with RLS · Drizzle ORM · explicit SQL migrations · Redis 7+ · BullMQ
- **Contracts**: OpenAPI 3.1 of record · Zod for runtime validation
- **Test**: Jest + Supertest + Testcontainers · `MIGRATION_TEST_ALLOW_SKIP=1` for Docker-less local runs
- **Observability**: pino · OpenTelemetry · Prometheus exporter (API `:9464`, worker `127.0.0.1:9091`)
- **Auth**: argon2id (`argon2` npm) · opaque revocable bearer tokens (API/POS) · httpOnly cookie sessions (dashboard humans)
- **IDs**: UUIDv7 with UUIDv4 fallback

The admin/operator dashboard is `Kemetra/Admin-Console`, a separate repo. OpenAPI contracts produced here are the only thing it depends on.

## Working agreement

See [docs/agent-os/standing-rules.md](docs/agent-os/standing-rules.md) for repo engineering gates (subordinate to the RT operating instructions above for work-management authority). Critical gates:

- Never commit / stage / push / merge / open PR without explicit instruction.
- Forbidden paths require `[GATED]` approval: `package.json`, `pnpm-lock.yaml`, SQL migrations, `packages/contracts/openapi/**`, `.github/**`.
- Untracked `bin/` and `externals/` are not part of any Jira issue's scope — leave them alone.
- Stop conditions named in the Jira issue mean stop and report. Do not silently expand scope.
