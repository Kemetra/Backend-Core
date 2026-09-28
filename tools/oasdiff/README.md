# OpenAPI breaking-change gate

`.github/workflows/openapi-breaking.yml` runs [oasdiff](https://github.com/oasdiff/oasdiff)
on every pull request. It compares all contracts under `packages/contracts/openapi/`
at the PR merge-base with the PR head, in composed mode, and fails when it finds a
change at **WARN** or **ERR** that the PR has not acknowledged.

The configuration comes from the RT-37 history backtest (Jira RT-37, RT-52).

## Files

| File | Purpose |
| --- | --- |
| `check.sh` | The gate. `bash tools/oasdiff/check.sh <base-ref>` |
| `severity-levels.txt` | Overrides of oasdiff's default check levels |
| `breaking-ignore.txt` | Acknowledged breaks, honoured only for the PR that adds them |

## Why fail on WARN

oasdiff cannot prove that a regex became narrower, so a changed request `pattern`
is a WARN (`request-property-pattern-changed`). Failing only on ERR would have
missed 4ae6231, which narrowed the sale-line `quantity` pattern.

## Severity overrides

- `response-property-pattern-changed` → INFO. A narrower response pattern is safe
  for consumers. In RT-37 this was the only source of noise inside real breaking
  PRs (9 findings in #626 and #630). The request-side check stays at WARN.
- `api-security-added` and `api-security-component-type-changed` → WARN. By
  default these are INFO, so adding auth to an open endpoint or changing a scheme's
  type would pass a WARN gate.

Security-scheme **renames** are not downgraded. oasdiff reports a cosmetic rename
(#551, `clerkJwt` → `device`/`operator-identity`, same bearer wire) with the same
`api-security-removed` ERR as a real credential change (202d253). No severity rule
can tell the two apart, so each rename needs a reviewed, per-PR acknowledgement.

## Acknowledging an intentional break

1. Read the finding in the job log.
2. Get its line: `oasdiff breaking --composed --format singleline "<base>/**/*.yaml" "<head>/**/*.yaml"`.
3. Add that line to `breaking-ignore.txt` with the reason and the Jira/PR key, for example:

   ```
   RT-123 intentional: POST /api/v1/example added the new required request header 'X-Example'
   ```

4. The line is part of the PR diff, so the reviewer approves the break with the rest of the change.

An entry matches one finding: the method and path (or `components`) plus the finding
text. Other findings in the same PR still fail.

### Lifecycle

`check.sh` applies only the ignore lines that are **new relative to the merge-base**.
After the PR merges, its lines are on the base of every later PR, so they stop
applying automatically and cannot hide a later break. The script prints a note
when inherited lines remain; delete them in any later PR.

## Known limits (RT-37)

- A credential change behind an unchanged security scheme name (13d7bd2, #488) is
  not detected. It exists only in description text and needs human/ADR review.
- `oasdiff validate` rejects the `(?!` lookahead in `settlement.yaml` (Go RE2).
  Diffing still works; pattern checks there compare text only.
- `nullable: true` (OAS 3.0 keyword) inside the 3.1 contracts is treated as nullable
  by oasdiff. See RT-53.

## Running locally

```bash
# oasdiff 1.32.1 from https://github.com/oasdiff/oasdiff/releases (verify checksums.txt)
bash tools/oasdiff/check.sh "$(git merge-base origin/main HEAD)"
```

Set `OASDIFF=/path/to/oasdiff` if the binary is not on `PATH`.

## Upgrading oasdiff

Change `OASDIFF_VERSION` and `OASDIFF_SHA256` in the workflow together. Take the
checksum from the release's `checksums.txt`, then rerun the backtest cases above
before merging.
