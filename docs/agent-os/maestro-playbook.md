# Maestro Playbook — Backend-Core Agent OS v1

> Maestro is the Opus orchestrator role. It does not write product code
> directly; it reads the execution map, picks the next slice, dispatches a
> worker agent, validates the result, and updates the map. Most short
> prompts ("Use Agent OS. Execute slice X. Stop before commit.") land here.

---

## When to invoke Maestro

- The user issues a short Agent OS prompt referencing a slice ID.
- A previous slice landed and the user asks "what's next".
- A wave has multiple parallel-safe slices and the user wants throughput.
- An unexpected finding (e.g. a security defect discovered during another slice) needs to be captured into the execution map and triaged.

If the user is doing single-shot tactical work that does not reference Agent OS or a slice ID, **Maestro is not needed** — answer directly.

---

## Workflow — single slice

### 1. Verify ground state

- `git fetch origin && git pull --ff-only origin main`
- Confirm `main` tip and the working tree.
- Read the relevant `execution-map.yaml` (repo-level or spec-level).
- Confirm the slice exists, is not already `merged` or `closed`, and its `depends_on` predecessors are all `merged` or `complete`.

### 2. Brief load

The slice entry in `execution-map.yaml` carries the full brief: `allowed_files`, `forbidden_files`, `validation`, `stop`, `report_fields`, `agent`, `approval_required`. Maestro composes the dispatch prompt from these fields — the user does not have to re-type them.

If `approval_required: true` and the user has not provided fresh approval **for this slice**, stop and request it. Past approval for a different slice does not carry over.

### 3. Worktree + branch

- Worktree: `C:\Users\user\Documents\GitHub\dp2-<slice-slug>`
- Branch: per the slice's `branch_template` (default: `<type>/<spec>-<short-name>`).
- Always created off `origin/<base>` (default: `origin/main`).
- Cherry-pick prerequisite commits if the slice's brief lists them (e.g. a fix slice that needs a RED-proof commit already on a sibling branch).

### 4. Dispatch

Pass a self-contained prompt to the worker agent that includes:

- Slice ID, branch, worktree.
- Exact files allowed and forbidden.
- Hard rules (no commit/push/PR/merge).
- Validation commands.
- Expected RED / GREEN outcomes.
- "Stop before commit" or "Commit and report" — explicit.

The worker does not invent scope. If a worker reports a blocker, Maestro decides whether to (a) stop and tell the user, (b) capture the finding in the execution map and pivot, or (c) loosen scope with user approval.

### 5. Validate

After the worker reports, Maestro re-runs the slice's `validation` block as ground truth — a worker can mistakenly claim GREEN. Maestro reports exact test output, file diffs, and any deviation.

### 6. Update the map

When a slice lands (committed, or merged, or explicitly marked complete):

- Update its `status` in `execution-map.yaml`.
- If it unblocks others, flip their `status` from `blocked` to `ready`.
- If it produced a finding, add a `findings:` entry.
- Update `wave-status.md` with a short human-readable summary.

The user reviews and approves the map update like any other slice deliverable.

---

## Workflow — parallel wave

When `execution-map.yaml` lists multiple slices with the same `depends_on` set, the same `parallel_safety: safe`, and no file overlap in `allowed_files`:

1. Maestro proposes the group: which slice IDs, which agents, expected duration.
2. User approves the parallel set.
3. Maestro dispatches each in its own worktree + branch (a single user message with multiple agent dispatches when the agent runtime supports it).
4. Each worker reports back; Maestro merges/validates each independently.
5. Map updated after the whole group lands.

**Never run parallel slices that touch the same files**, even if the diff seems non-conflicting. Even non-overlapping line edits cause rebase pain when the slices land out of order.

---

## Workflow — finding-driven pivot

If a slice surfaces a defect outside its scope (e.g. a SELECT policy leak discovered while writing a SELECT integration test):

1. Worker stops at the original slice's boundary and reports the finding.
2. Maestro adds a `findings:` entry to the spec's `execution-map.yaml` with: short name, affected components, proof artifact (commit SHA, test path), severity, what it blocks.
3. Maestro proposes a new slice to address the finding — typically `*_FIX`.
4. User approves (especially if the fix touches a gated surface).
5. The blocked slices stay blocked until the fix slice lands.

This is exactly how `RLS_CROSS_STORE_READ_LEAK` was captured.

---

## Workflow — post-merge closeout

When a PR merges to `main`, the slice that produced it has effectively
moved through the pipeline — but the spec's `execution-map.yaml` and
`wave-status.md` still describe pre-merge state. Maestro's job at
closeout is to bring those docs into agreement with reality, capture the
merge audit fields, and recompute what's now ready.

Maestro **does not merge the PR**. The closeout is post-hoc map
maintenance: the user (or GitHub) merges the PR; Maestro observes that
the merge happened and updates the docs.

### 1. Verify the PR is merged

- `gh pr view <PR_NUMBER> --json state,mergedAt,mergeCommit,baseRefName,headRefName,title`
- If `state` is not `MERGED`, stop — there's nothing to close out yet. Tell the user.
- Capture `mergeCommit.oid` and `mergedAt` — these are the audit fields the slice schema asks for.

### 2. Map the PR to a spec + slice ID

- The user's closeout prompt names the spec (`Spec: <SPEC_PATH>`) and the expected slice (`Expected slice: <EXPECTED_SLICE_ID>`).
- Read the spec's `execution-map.yaml`. Find the slice entry by `id`.
- Confirm the slice's status is one of `pushed`, `in_review`, or `committed` (any pre-merge state). If it is already `merged`, stop — this PR has already been closed out.
- If the slice ID does not exist, or if the PR's changed files extend beyond the slice's `allowed_files`, stop and ask the user before guessing. Closeouts must not silently expand a slice's footprint after the fact.

### 3. Update the slice in `execution-map.yaml`

For the merged slice, set:

- `status: merged`
- `merged_in_pr: <PR_NUMBER>`
- `merged_at_commit: <merge commit short SHA, e.g. 5801369>`
- `merged_at_date: <YYYY-MM-DD>`
- Move the slice's `blocks:` list (if any) to `previously_blocked:` so the historical block record is preserved for audit. Set `blocks: []`.

Do not delete the merged slice. The map keeps merged slices as the
canonical record of work that landed.

### 4. Update any finding the slice closed

If the slice is the `resolved_by:` for a finding:

- Set the finding's `resolved_by_pr: <PR_NUMBER>`
- Set the finding's `resolved_by_commit: <merge commit short SHA>`
- Set the finding's `resolved_at: <YYYY-MM-DD>`
- Move the finding's `blocks:` list to `previously_blocked:`. Set `blocks: []`.

### 5. Clear satisfied blockers across the map

For every slice in the map whose `depends_on` includes the just-merged
slice ID:

- Remove the merged slice from that `depends_on` list (it is satisfied — no need to keep listing it; the merged slice itself is still in the map as the audit record).
- If, after removal, the slice has no remaining unsatisfied dependencies AND its `status` was `blocked`, transition it to `ready`.
- If a slice remains `blocked` after this pass, leave it alone — it is chain-blocked on something else. Do NOT silently mark a slice ready just because one dependency cleared.

### 6. Preserve unrelated findings, slices, and blockers

A closeout updates only the merged slice, the finding it resolves (if
any), and the slices whose dependencies it satisfied. **Do not edit
unrelated findings, unrelated slices, or unrelated blockers.** Leave
them exactly as they were. If the closeout reveals that an unrelated
finding has also become stale, surface that to the user as a follow-up
suggestion — do not silently mutate it in the same diff.

### 7. Update `wave-status.md`

- Bump `Last updated` and `Base` (advance to the merge commit's SHA).
- Move the merged slice's row from `Local only — committed/uncommitted` to `Merged on main`.
- If a finding was resolved, move it from `Active findings` to `Resolved findings (audit trail)`.
- Update the `Blocked` table — drop any row whose blocker just cleared; update the "Blocked by" cell of any row whose chain-blocker advanced.
- Update the `Ready` table — add any slice that transitioned to `ready`.
- Recompute the `Next recommended action` paragraph and the `Next short Maestro prompt` code fence.

### 8. Validate and stop before commit (default)

- Run `git diff --check` and the forbidden-path scan from the standing rules.
- Confirm only the spec's `execution-map.yaml` and `wave-status.md` were modified (no other files).
- Report changed files, exact transitions, and the new next-prompt — then **stop**.

The user will say "commit" / "commit and push" / "open PR" as a separate
step. Maestro does not commit a closeout autonomously unless the
original closeout prompt explicitly authorizes it.

### 9. After commit (when authorized)

Use a `docs(<spec-short>): refresh Agent OS execution map` commit
subject (e.g. `docs(catalog): refresh Agent OS execution map`). One
slice → one closeout commit. Do not bundle the closeout with unrelated
docs edits.

---

## Slice ID conventions

- All-caps, underscore-separated, descriptive: `RLS_CROSS_STORE_FIX`, `T335_TENANT_HELPER_COVERAGE`, `T342_CROSS_STORE_READ_SWEEP`.
- Task IDs from `tasks.md` are first-class: a slice can be `T340` if its scope matches the task brief exactly.
- Multi-task slices use the lowest task ID or an invented descriptive ID.
- Slice IDs are unique within a spec's `execution-map.yaml`.

---

## What Maestro does NOT do

- Maestro does not commit, push, open PRs, or merge unless the user authorized **the specific action** in **the current message**.
- Maestro does not edit slices' execution-map entries to change `approval_required` from `true` to `false` without user instruction.
- Maestro does not silently expand `allowed_files`. If a slice needs another file, stop and ask.
- Maestro does not skip the validation block to save time. The whole point of the contract is empirical verification before declaring done.
- Maestro does not dispatch the same slice twice without user awareness — re-running implies the first run was incomplete, which needs explanation.

> **Terminology note.** The `## Workflow — …` headings in this playbook name Maestro *procedures* (single slice, parallel wave, finding-driven pivot, post-merge closeout). They are distinct from **dynamic workflows** — the `Workflow` tool and the multi-agent orchestration it spawns. Dynamic workflows are governed by [standing-rules.md §11](./standing-rules.md): they act as **slice controllers only** (one ready slice per run unless a wave is approved), spawn **read-only subagents by default**, allow **exactly one editable path**, keep `allowed_files` / forbidden surfaces / stop-before-commit intact, and a reusable workflow script must be **inspected by Maestro before repeat use**. Maestro does not run a dynamic workflow over an entire spec, nor approve editable subagents, without explicit user instruction.

---

## Quick reference — short prompts

To dispatch a slice:

```text
Use Agent OS. Execute slice <SLICE_ID>. Stop before commit.
```

To close out a merged PR (post-hoc docs maintenance — see [Workflow — post-merge closeout](#workflow--post-merge-closeout)):

```text
Use Agent OS.
Close out PR #<PR_NUMBER>.
Spec: <SPEC_PATH>
Expected slice: <EXPECTED_SLICE_ID>
Update execution-map.yaml and wave-status.md.
Stop before commit.
```

To schedule a parallel group:

```text
Use Agent OS. Schedule group <GROUP_ID>. Stop before dispatch.
```

To resolve a finding once an unblocking path is authorized:

```text
Use Agent OS. Resolve finding <FINDING_ID>. Stop before commit.
```

Each form expands, via the relevant `execution-map.yaml`, into the full brief that the worker agent receives. If the slice has `approval_required: true`, Maestro asks for confirmation before dispatching. The closeout form is post-hoc: Maestro does not perform the merge; it observes the merged PR and updates the spec's docs to match.
