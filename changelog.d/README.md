# Unreleased changelog fragments (RT-805)

Every unreleased change is one file here, never a line in `CHANGELOG.md`.
Parallel PRs then add different files and never conflict on the changelog.

## Adding an entry

Create `changelog.d/RT-<number>-<slug>.md` (slug: lower-case `a-z`, `0-9`,
`-`; use `no-ticket-<slug>.md` only for a change with no Jira issue). It holds
one Keep a Changelog section heading and the entry, written exactly as it
should appear in the release:

```markdown
### Added
- RT-123 `[GATED]`, owner authorization ...: what changed and why.
  Continuation lines are indented two spaces.
```

Sections: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.
Use one file per entry; a second entry for the same ticket gets its own slug.

## Checking and releasing

```bash
node tools/changelog/assemble.cjs                 # validate (also run by the api Jest suite)
node tools/changelog/assemble.cjs --preview       # print the next release's sections
node tools/changelog/assemble.cjs --migrate       # move entries written into [Unreleased] into fragments
node tools/changelog/assemble.cjs --release 0.2.0 # write "## [0.2.0] — <today>" and delete the fragments
```

At release, the sections are rendered in the order above. Within a section,
entries are ordered by file name, with numbers compared numerically
(`RT-3` before `RT-20`). `CHANGELOG.md`'s `[Unreleased]` holds only the
pointer to this directory. `apps/api/test/tooling/changelog-fragments.spec.ts`
fails if an entry is written there or if a fragment is malformed.
