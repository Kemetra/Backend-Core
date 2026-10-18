#!/usr/bin/env node
// RT-703: verify a published Backend-Core release for the manual lab deploy
// workflow (.github/workflows/deploy-lab.yml) and write a planned-deployment
// ledger. Slice 1 is a dry run: this script only reads evidence files the
// workflow collected from the GitHub API. It makes no network calls, reads no
// secrets, changes nothing anywhere and writes only under --out.
//
// Evidence directory (written by the workflow):
//   release.json            gh release view --json tagName,targetCommitish,isDraft,isPrerelease,isImmutable
//   tag-commit.txt          git rev-parse refs/tags/<tag>^{commit}
//   release/                the release assets: tarball, release-manifest.json, SHA256SUMS
//   bundle/<name>/          the tarball, extracted after `sha256sum -c` and an entry-type scan
//   compare.json            {status, ahead_by, behind_by, merge_base} for <sha>...main
//   check-runs.json         [{name, conclusion, slug, started_at}] on <sha>
//   attest-<target>.json    gh attestation verify --format json output (absent = not verified)
//   migrations-target.txt   git ls-tree <sha> packages/db/drizzle/ (blob IDs catch in-place edits)
//   source-tree.txt         git ls-tree -r <sha>: every bundled file must be the file at that commit
//   environment.json        {status: present|not-visible|unknown, reviewers}
//   collect-error.txt       only when collection stopped early: why (each line a refusal)
//   current-release.json, current-tag-commit.txt, compare-current.json,
//   migrations-current.txt  only with --current-release
//
// Usage:
//   node deploy/lab/verify-release.cjs --evidence DIR --out DIR --release backend-core-<sha12>
//     --jira-key RT-<n> --target lab-01 --mode dry-run [--current-release TAG]
//     [--actor NAME] [--run-url URL]
//
// Exit 0: every check passed, the ledger outcome is "planned". Exit 1: refused,
// the ledger lists each refusal. Exit 2: usage error. Fails closed: missing,
// unreadable or non-regular evidence is a refusal, never a pass.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REPO = "Kemetra/Backend-Core";
const TARGETS = ["api", "worker", "migrate"];
const LAB_TARGETS = ["lab-01"];
// The ci.yml jobs that run on a push to main; the same list release-images.yml requires.
const REQUIRED_CHECKS = [
  "fast (build + Docker-free tests)",
  "db-integration (Testcontainers + RLS + migrations)",
];
const REQUIRED_FILES = ["docker-compose.release.yml", "release.env"];
const SIGNER_WORKFLOW = `https://github.com/${REPO}/.github/workflows/release-images.yml@refs/heads/main`;
const SLSA_PROVENANCE = "https://slsa.dev/provenance/v1";
const ENV_VARS = { api: "DP2_API_IMAGE", worker: "DP2_WORKER_IMAGE", migrate: "DP2_MIGRATE_IMAGE" };
const SHA_RE = /^[0-9a-f]{40}$/;
const TAG_RE = /^backend-core-[0-9a-f]{12}$/;
const JIRA_RE = /^RT-[1-9]\d*$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SUMS_LINE_RE = /^([0-9a-f]{64}) [ *](\S+)$/;
const LS_TREE_RE = /^\d{6} (blob|tree) ([0-9a-f]{40})\t(.+)$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ROLE_ARN_RE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]+$/;
const SSM_NODE_RE = /^mi-[0-9a-f]{17}$/;

const LIVE_STEPS = [
  "Prove host identity and the release it runs from trusted runtime evidence",
  "Confirm an independent, restorable backup and record its reference (never a secret)",
  "Run migrate from the migrate image digest with the migration-owner role",
  "Apply every domain-grant script for this release (deploy/README.md, Deploy step 2)",
  "Start api and worker from their image digests (docker-compose.release.yml)",
  "Run the catch-up scripts (deploy/README.md, Deploy step 4)",
  "Smoke: readiness, synthetic sale, replay and ERPNext posting",
  "Record this ledger on the Jira issue",
];

const imageRef = (target, digest) => `ghcr.io/kemetra/backend-core-${target}@${digest}`;
const bundleName = (sha) => `backend-core-release-${sha.slice(0, 12)}`;
const isSafeRelative = (p) => !path.isAbsolute(p) && !p.startsWith("/") && !p.split(/[\\/]/).includes("..");
// Deterministic order for file and migration names (explicit, not the default coercing sort).
const byText = (a, b) => a.localeCompare(b, "en");
// A missing, non-numeric or zero reviewer count never counts as a reviewer.
const hasReviewer = (count) => typeof count === "number" && count >= 1;

/** Reads a regular file only: never follows a symlink, and never reads a FIFO or device. */
function readBuffer(file) {
  try {
    return fs.lstatSync(file).isFile() ? fs.readFileSync(file) : null;
  } catch {
    return null;
  }
}

function readText(file) {
  const buf = readBuffer(file);
  return buf === null ? null : buf.toString("utf8");
}

function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readLines(file) {
  const text = readText(file);
  return text === null ? null : text.split(/\r?\n/).filter(Boolean);
}

function sha256File(file) {
  const buf = readBuffer(file);
  return buf === null ? null : crypto.createHash("sha256").update(buf).digest("hex");
}

function checkInputs(ctx) {
  const problems = [];
  if (!TAG_RE.test(ctx.release ?? "")) problems.push("backend_release must be backend-core-<12 hex>");
  if (!JIRA_RE.test(ctx.jiraKey ?? "")) problems.push("jira_key must be RT-<number>");
  if (!LAB_TARGETS.includes(ctx.target)) problems.push(`target must be one of: ${LAB_TARGETS.join(", ")}`);
  if (ctx.currentRelease && !TAG_RE.test(ctx.currentRelease)) {
    problems.push("current_release must be empty or backend-core-<12 hex>");
  }
  if (!["dry-run", "live"].includes(ctx.mode)) problems.push("mode must be dry-run or live");
  return problems;
}

/** Release metadata: immutable, final, tagged backend-core-<sha12> of a full commit SHA. */
function checkReleaseMeta(meta, tag, label) {
  if (!meta || typeof meta !== "object") return [`${label} metadata missing or not JSON`];
  const problems = [];
  if (meta.tagName !== tag) problems.push(`${label} tag is '${meta.tagName}', expected '${tag}'`);
  if (meta.isImmutable !== true) problems.push(`${label} ${tag} is not an immutable release`);
  if (meta.isDraft !== false || meta.isPrerelease !== false) problems.push(`${label} ${tag} is a draft or prerelease`);
  const sha = meta.targetCommitish ?? "";
  if (!SHA_RE.test(sha)) problems.push(`${label} target is not a 40-hex commit SHA`);
  else if (tag !== `backend-core-${sha.slice(0, 12)}`) problems.push(`${label} tag does not match its commit ${sha}`);
  return problems;
}

/** The git tag itself, not only the release metadata, must point at the release commit. */
function checkTagCommit(text, sha, label) {
  const commit = (text ?? "").trim();
  return commit === sha ? [] : [`${label} git tag does not point at ${sha} (resolves to '${commit || "nothing"}')`];
}

/** The SHA must be reachable from protected main (compare <sha>...main). */
function checkCompare(cmp, sha, label = "release") {
  if (!cmp || typeof cmp !== "object") return [`${label} ancestry evidence missing (compare <sha>...main)`];
  const problems = [];
  if (!["ahead", "identical"].includes(cmp.status)) {
    problems.push(`${label} SHA is not reachable from main (compare status '${cmp.status}')`);
  }
  if (cmp.behind_by !== 0) problems.push(`${label} SHA has ${cmp.behind_by} commit(s) that are not on main`);
  if (cmp.merge_base !== sha) problems.push(`merge base of the ${label} SHA and main is not the ${label} SHA`);
  return problems;
}

/** The most recent github-actions run of each required check must be a success. */
function checkCiRuns(runs) {
  if (!Array.isArray(runs)) return ["CI check-run evidence missing or not a list"];
  return REQUIRED_CHECKS.flatMap((name) => {
    const latest = runs
      .filter((r) => r?.name === name && r.slug === "github-actions")
      .sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)))
      .at(-1);
    const result = latest?.conclusion ?? "missing";
    return result === "success" ? [] : [`required check '${name}' is '${result}' on the release SHA`];
  });
}

function parseSums(text, label) {
  const sums = new Map();
  const problems = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const m = SUMS_LINE_RE.exec(line);
    if (!m) {
      problems.push(`${label}: malformed line`);
      continue;
    }
    const [, hash, name] = m;
    if (!isSafeRelative(name)) problems.push(`${label}: unsafe path '${name}'`);
    else if (sums.has(name)) problems.push(`${label}: duplicate entry '${name}'`);
    else sums.set(name, hash);
  }
  return { sums, problems };
}

/** A SHA256SUMS file must list exactly `expected` and every hash must match the regular file on disk. */
function checkSums(dir, text, expected, label) {
  if (text === null) return [`${label} missing`];
  const { sums, problems } = parseSums(text, label);
  const listed = [...sums.keys()].sort(byText);
  const wanted = [...expected].sort(byText);
  if (JSON.stringify(listed) !== JSON.stringify(wanted)) {
    problems.push(`${label} lists [${listed.join(", ")}], expected [${wanted.join(", ")}]`);
  }
  for (const [name, hash] of sums) {
    const actual = sha256File(path.join(dir, name));
    if (actual === null) problems.push(`${label}: '${name}' missing or not a regular file`);
    else if (actual !== hash) problems.push(`${label}: checksum mismatch for '${name}'`);
  }
  return problems;
}

function checkManifestHeader(m, sha, tag) {
  const problems = [];
  if (m.schemaVersion !== 1) problems.push(`manifest schemaVersion is ${m.schemaVersion}, expected 1`);
  if (m.repository !== REPO) problems.push(`manifest repository is '${m.repository}'`);
  if (m.sha !== sha) problems.push(`manifest sha '${m.sha}' is not the release commit ${sha}`);
  if (m.releaseTag !== tag) problems.push(`manifest releaseTag '${m.releaseTag}' is not ${tag}`);
  if (m.published !== true) problems.push("manifest is not a published release (dry-run bundle)");
  if (m.digestKind !== "registry-manifest-digest") problems.push("manifest digests are not registry digests");
  const files = m.files && typeof m.files === "object" ? Object.keys(m.files) : [];
  for (const required of REQUIRED_FILES) {
    if (!files.includes(required)) problems.push(`manifest file list does not include ${required}`);
  }
  if (/latest/i.test(JSON.stringify(m))) problems.push("manifest mentions a floating 'latest' tag");
  return problems;
}

/** Every image is a digest ref of its own repository, tagged sha-<release sha>. */
function checkManifestImages(m, sha) {
  const problems = [];
  const images = {};
  for (const target of TARGETS) {
    const img = m.images?.[target];
    const digest = img?.digest ?? "";
    const ok =
      DIGEST_RE.test(digest) &&
      img.repository === `ghcr.io/kemetra/backend-core-${target}` &&
      img.tag === `sha-${sha}` &&
      img.ref === imageRef(target, digest);
    if (ok) images[target] = { digest, ref: img.ref };
    else problems.push(`manifest ${target} image is missing or not a digest ref tagged sha-${sha}`);
  }
  return { problems, images };
}

function checkManifest(m, sha, tag) {
  if (!m || typeof m !== "object") return { problems: ["release manifest missing or not JSON"], images: {} };
  const header = checkManifestHeader(m, sha, tag);
  const { problems, images } = checkManifestImages(m, sha);
  return { problems: [...header, ...problems], images };
}

/** release.env carries exactly the three image refs from the manifest. Never echoes its raw content. */
function checkReleaseEnv(text, images) {
  if (text === null) return ["bundle release.env missing or not a regular file"];
  const problems = [];
  const vars = new Map();
  for (const line of text.split(/\r?\n/).filter((l) => l && !l.startsWith("#"))) {
    const at = line.indexOf("=");
    vars.set(at > 0 ? line.slice(0, at) : line, at > 0 ? line.slice(at + 1) : "");
  }
  for (const [target, variable] of Object.entries(ENV_VARS)) {
    const want = images[target]?.ref;
    if (!want || vars.get(variable) !== want) problems.push(`release.env ${variable} does not match the manifest ${target} ref`);
  }
  for (const key of vars.keys()) {
    if (Object.values(ENV_VARS).includes(key)) continue;
    problems.push(ENV_KEY_RE.test(key) ? `release.env has an unexpected variable '${key}'` : "release.env has a line that is not an expected KEY=value");
  }
  return problems;
}

/** Lists every entry under dir; anything but a regular file or directory (a symlink, FIFO, device) is a problem. */
function walkBundle(dir, rel = "") {
  const files = [];
  const problems = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const sub = walkBundle(dir, name);
      files.push(...sub.files);
      problems.push(...sub.problems);
    } else if (entry.isFile()) files.push(name);
    else problems.push(`bundle entry '${name}' is not a regular file or directory`);
  }
  return { files, problems };
}

/** The extracted bundle: only regular files, nothing unlisted, the same manifest, matching checksums. */
function checkBundle(dir, manifestBuf, manifest, images) {
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) return ["extracted release bundle missing"];
  const files = Object.keys(manifest.files ?? {});
  const walked = walkBundle(dir);
  const problems = [...walked.problems];
  const known = new Set([...files, "release-manifest.json", "SHA256SUMS"]);
  for (const name of walked.files) if (!known.has(name)) problems.push(`bundle has an unlisted file '${name}'`);
  const inner = readBuffer(path.join(dir, "release-manifest.json"));
  if (inner === null || !inner.equals(manifestBuf)) {
    problems.push("bundle release-manifest.json differs from the release asset");
  }
  const innerSums = readText(path.join(dir, "SHA256SUMS"));
  problems.push(...checkSums(dir, innerSums, [...files, "release-manifest.json"], "bundle SHA256SUMS"));
  for (const name of files) {
    const ok = isSafeRelative(name) && sha256File(path.join(dir, name)) === manifest.files[name];
    if (!ok) problems.push(`manifest file hash mismatch for '${name}'`);
  }
  problems.push(...checkReleaseEnv(readText(path.join(dir, "release.env")), images));
  return problems;
}

/** git's blob ID for file content, to compare with `git ls-tree`. */
const gitBlobId = (buf) => crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");

/** `git ls-tree -r <sha>` of the release commit as path -> blob ID, or null without that evidence. */
function readSourceTree(file) {
  const lines = readLines(file);
  if (lines === null) return null;
  const tree = new Map();
  for (const line of lines) {
    const m = LS_TREE_RE.exec(line);
    if (m && m[1] === "blob") tree.set(m[3], m[2]);
  }
  return tree;
}

/**
 * Every shipped file except the generated release.env must be byte-for-byte the
 * file at the release commit. The manifest's own hashes only prove the bundle
 * is self-consistent, not that it came from that commit.
 */
function checkSourceBinding(bundleDir, files, tree) {
  if (tree === null || tree.size === 0) return ["release source tree evidence missing (git ls-tree -r <sha>)"];
  const problems = [];
  for (const name of files.filter((f) => f !== "release.env")) {
    const buf = isSafeRelative(name) ? readBuffer(path.join(bundleDir, name)) : null;
    if (!tree.has(name)) problems.push(`bundled '${name}' is not in the release commit`);
    else if (buf === null || gitBlobId(buf) !== tree.get(name)) problems.push(`bundled '${name}' does not match the release commit`);
  }
  return problems;
}

/** A verified SLSA attestation binds the image digest to the release commit, built on main by release-images.yml. */
function checkAttestation(results, target, digest, sha) {
  if (!Array.isArray(results) || results.length === 0) return [`no verified attestation for the ${target} image`];
  const hex = digest.slice("sha256:".length);
  const ok = results.some((r) => {
    const statement = r?.verificationResult?.statement;
    const cert = r?.verificationResult?.signature?.certificate;
    return (
      statement?.predicateType === SLSA_PROVENANCE &&
      Array.isArray(statement.subject) &&
      statement.subject.some((s) => s?.digest?.sha256 === hex) &&
      cert?.sourceRepositoryDigest === sha &&
      cert?.sourceRepositoryRef === "refs/heads/main" &&
      cert?.buildSignerURI === SIGNER_WORKFLOW
    );
  });
  return ok ? [] : [`${target} attestation does not bind ${digest} to ${sha} built by release-images.yml on main`];
}

/**
 * Forward (up) migrations from `git ls-tree` output, as name -> blob ID, so an
 * in-place edit shows up as a change. The *.down.sql companions are not
 * separate migrations. Null when any line is not ls-tree output.
 */
function upMigrations(lines) {
  const blobs = new Map();
  for (const line of lines) {
    const m = LS_TREE_RE.exec(line);
    if (!m) return null;
    const [, type, blob, file] = m;
    if (type === "blob" && file.endsWith(".sql") && !file.endsWith(".down.sql")) blobs.set(path.posix.basename(file), blob);
  }
  return blobs;
}

/** Redeploying older application digests is safe only when no migration was added, removed or edited between the releases. */
function assessRollback(added, removed, changed = []) {
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return { allowed: true, reason: "no schema change; app-only rollback still needs a contract-compatibility review" };
  }
  return { allowed: false, reason: "schema changed: no automatic database downgrade; restore or forward-fix decision" };
}

const unknownPlan = (targetCount, reason) => ({
  targetCount,
  added: null,
  removed: null,
  changed: null,
  rollback: { allowed: false, reason },
});

function planMigrations(targetLines, currentLines) {
  const target = targetLines === null ? null : upMigrations(targetLines);
  if (!target || target.size === 0) {
    return { problems: ["target migration list missing, empty or not git ls-tree output"], plan: null };
  }
  if (currentLines === null) return { problems: [], plan: unknownPlan(target.size, "unknown: no verified current release") };
  const current = upMigrations(currentLines);
  if (!current) {
    return { problems: ["current release migration list is not git ls-tree output"], plan: unknownPlan(target.size, "unknown: unreadable current migrations") };
  }
  const names = (m) => [...m.keys()].sort(byText);
  const added = names(target).filter((n) => !current.has(n));
  const removed = names(current).filter((n) => !target.has(n));
  const changed = names(target).filter((n) => current.has(n) && current.get(n) !== target.get(n));
  const problems = removed.length
    ? [`target release lacks ${removed.length} migration(s) the current release has: a schema downgrade is never automatic`]
    : [];
  return { problems, plan: { targetCount: target.size, added, removed, changed, rollback: assessRollback(added, removed, changed) } };
}

/** Deployment identity for a live run. Never root, never a user key, always a reviewed environment. */
function checkTransport(identity) {
  if (!identity) {
    return ["no deployment identity: GitHub OIDC role and SSM managed node are not provisioned (separate owner gate)"];
  }
  const problems = [];
  if (!ROLE_ARN_RE.test(identity.roleArn ?? "")) {
    problems.push("deployment identity must be an IAM role ARN assumed through OIDC (never root or an access key)");
  }
  if (!SSM_NODE_RE.test(identity.ssmNodeId ?? "")) problems.push("target must be a registered SSM managed node (mi-...)");
  if (!hasReviewer(identity.environmentReviewers)) problems.push("the aws-lab environment must require at least one reviewer");
  return problems;
}

function verifyRelease(dir, ctx, sha) {
  const problems = [
    ...checkTagCommit(readText(path.join(dir, "tag-commit.txt")), sha, "release"),
    ...checkCompare(readJson(path.join(dir, "compare.json")), sha),
    ...checkCiRuns(readJson(path.join(dir, "check-runs.json"))),
  ];
  const releaseDir = path.join(dir, "release");
  const outerSums = readText(path.join(releaseDir, "SHA256SUMS"));
  problems.push(...checkSums(releaseDir, outerSums, [`${bundleName(sha)}.tar.gz`, "release-manifest.json"], "release SHA256SUMS"));
  const manifestBuf = readBuffer(path.join(releaseDir, "release-manifest.json"));
  const manifest = readJson(path.join(releaseDir, "release-manifest.json"));
  const checked = checkManifest(manifest, sha, ctx.release);
  problems.push(...checked.problems);
  if (manifest && manifestBuf) {
    const bundleDir = path.join(dir, "bundle", bundleName(sha));
    const tree = readSourceTree(path.join(dir, "source-tree.txt"));
    problems.push(
      ...checkBundle(bundleDir, manifestBuf, manifest, checked.images),
      ...checkSourceBinding(bundleDir, Object.keys(manifest.files ?? {}), tree),
    );
  }
  for (const [target, image] of Object.entries(checked.images)) {
    problems.push(...checkAttestation(readJson(path.join(dir, `attest-${target}.json`)), target, image.digest, sha));
  }
  return { problems, images: checked.images, files: Object.keys(manifest?.files ?? {}) };
}

/** The operator-asserted current release must itself be an immutable release reachable from main. */
function readCurrent(dir, ctx) {
  if (!ctx.currentRelease) return { problems: [], current: null, lines: null };
  const meta = readJson(path.join(dir, "current-release.json"));
  const problems = checkReleaseMeta(meta, ctx.currentRelease, "current release");
  const sha = SHA_RE.test(meta?.targetCommitish ?? "") ? meta.targetCommitish : null;
  if (sha) {
    problems.push(
      ...checkTagCommit(readText(path.join(dir, "current-tag-commit.txt")), sha, "current release"),
      ...checkCompare(readJson(path.join(dir, "compare-current.json")), sha, "current release"),
    );
  }
  const lines = readLines(path.join(dir, "migrations-current.txt"));
  if (lines === null) problems.push("current release migration list missing");
  const current = { tag: ctx.currentRelease, sha, source: "operator-asserted, not host-verified" };
  return { problems, current, lines: problems.length ? null : lines };
}

function pendingApprovals(ctx, environment, transportProblems) {
  const pending = [];
  if (environment?.status !== "present" || !hasReviewer(environment.reviewers)) {
    pending.push("Owner: create the aws-lab environment with a required reviewer and a main-only branch policy");
  }
  if (transportProblems.length) {
    pending.push("Owner: approve and provision GitHub OIDC -> least-privilege IAM role -> SSM on lab-01 (after cost and access review)");
  }
  pending.push(
    "Operator: prove the release lab-01 runs from trusted host evidence",
    "Operator: confirm an independent, restorable backup",
    `Owner: approve the live lab deploy of ${ctx.release} under ${ctx.jiraKey}`,
  );
  return pending;
}

function buildLedger({ ctx, sha, images, files, migrations, current, environment, transportProblems, refusals }) {
  return {
    schemaVersion: 1,
    kind: "rt703-lab-deploy-ledger",
    mode: ctx.mode,
    outcome: refusals.length ? "refused" : "planned",
    jiraKey: ctx.jiraKey,
    actor: ctx.actor ?? null,
    runUrl: ctx.runUrl ?? null,
    generatedAt: new Date().toISOString(),
    target: { host: ctx.target, environment: "aws-lab" },
    release: { tag: ctx.release, sha },
    current,
    images,
    plan: {
      steps: LIVE_STEPS.map((step) => ({ step, status: "not-run (dry run)" })),
      grants: files.filter((f) => /^docs\/operations\/sql\/[\w-]+-domain-grants\.sql$/.test(f)).sort(byText),
      catchups: files.filter((f) => /^docs\/operations\/sql\/[\w-]+-catchup\.sql$/.test(f)).sort(byText),
      migrations,
    },
    gates: {
      environment: environment ?? { status: "unknown" },
      transport: transportProblems.length ? { status: "not-provisioned", problems: transportProblems } : { status: "present" },
      hostEvidence: "Needs verification",
      backup: "Needs verification",
    },
    pendingApprovals: pendingApprovals(ctx, environment, transportProblems),
    results: { backupReference: null, migration: "not-run", grants: "not-run", smoke: "not-run", rollback: "not-applicable" },
    failureBoundary: refusals[0] ?? null,
    refusals,
  };
}

/** Check everything, collect every refusal, and build the ledger. Never throws on bad evidence. */
function evaluate(dir, ctx) {
  // Why evidence collection stopped early, if it did: the first and most specific refusal.
  const collectErrors = readLines(path.join(dir, "collect-error.txt")) ?? [];
  const refusals = [...collectErrors.map((e) => `evidence collection refused: ${e}`), ...checkInputs(ctx)];
  const meta = readJson(path.join(dir, "release.json"));
  refusals.push(...checkReleaseMeta(meta, ctx.release, "release"));
  const sha = SHA_RE.test(meta?.targetCommitish ?? "") ? meta.targetCommitish : null;
  const verified = sha ? verifyRelease(dir, ctx, sha) : { problems: [], images: {}, files: [] };
  refusals.push(...verified.problems);
  const cur = readCurrent(dir, ctx);
  refusals.push(...cur.problems);
  const mig = planMigrations(readLines(path.join(dir, "migrations-target.txt")), cur.lines);
  refusals.push(...mig.problems);
  const transportProblems = checkTransport(ctx.transport ?? null);
  if (ctx.mode === "live") {
    refusals.push(...transportProblems, "live execution is not implemented in RT-703 slice 1 (dry run only)");
  }
  const environment = readJson(path.join(dir, "environment.json"));
  const ledger = buildLedger({ ctx, sha, images: verified.images, files: verified.files, migrations: mig.plan, current: cur.current, environment, transportProblems, refusals });
  return { refusals, ledger };
}

/** Escapes release-derived text for the Markdown run summary: no links, images, HTML or tables. */
const md = (value) =>
  String(value)
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_{}[\]()#+!|<>~]/g, String.raw`\$&`)
    .slice(0, 300);

function renderSummary(ledger) {
  const lines = [
    `## Lab deploy ${md(ledger.mode)}: ${ledger.outcome.toUpperCase()}`,
    "",
    `Release ${md(ledger.release.tag)} (${md(ledger.release.sha ?? "unknown SHA")}) -> ${md(ledger.target.host)}, ${md(ledger.jiraKey)}. Nothing was deployed.`,
    "",
  ];
  if (ledger.refusals.length) lines.push("### Refused", "", ...ledger.refusals.map((r) => `- ${md(r)}`), "");
  lines.push("### Images", "", "| target | digest ref |", "|---|---|");
  for (const [target, image] of Object.entries(ledger.images)) lines.push(`| ${target} | \`${image.ref}\` |`);
  const mig = ledger.plan.migrations;
  if (mig) {
    // added is null when no current release was given or its evidence did not verify
    const since = Array.isArray(mig.added)
      ? `${mig.added.length} added and ${mig.changed.length} edited in place since ${md(ledger.current?.tag)} (${ledger.current?.source})`
      : "no verified current release";
    lines.push("", "### Schema", "", `${mig.targetCount} migrations in the release; ${since}. Rollback to the current release: ${mig.rollback.reason}.`);
  }
  lines.push(
    "",
    "### Planned steps (not run)",
    "",
    ...ledger.plan.steps.map((s, i) => `${i + 1}. ${s.step}`),
    "",
    "### Pending approvals",
    "",
    ...ledger.pendingApprovals.map((p) => `- ${md(p)}`),
    "",
  );
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--") || i + 1 >= argv.length) throw new Error(`bad argument: ${key}`);
    args[key.slice(2)] = argv[i + 1];
  }
  for (const required of ["evidence", "out", "release", "jira-key", "target", "mode"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`verify-release: ${err.message}`);
    return 2;
  }
  const ctx = {
    release: args.release,
    jiraKey: args["jira-key"],
    target: args.target,
    mode: args.mode,
    currentRelease: args["current-release"] || null,
    actor: args.actor ?? null,
    runUrl: args["run-url"] ?? null,
  };
  const { refusals, ledger } = evaluate(args.evidence, ctx);
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`);
  fs.writeFileSync(path.join(args.out, "summary.md"), renderSummary(ledger));
  console.log(`verify-release: ${ledger.outcome} (${refusals.length} refusal(s)); ledger in ${args.out}`);
  return refusals.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  REQUIRED_CHECKS,
  SIGNER_WORKFLOW,
  assessRollback,
  checkAttestation,
  checkCiRuns,
  checkCompare,
  checkInputs,
  checkManifest,
  checkReleaseEnv,
  checkReleaseMeta,
  checkSums,
  checkTransport,
  evaluate,
  main,
  planMigrations,
  renderSummary,
};
