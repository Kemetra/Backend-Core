// RT-713: spec for contracts-compat/. Plain ESM + node:test, no dependencies (the
// contracts-compat job has no install step). Tests that need the oasdiff binary skip
// locally when it is absent, but fail when CONTRACTS_COMPAT_REQUIRE_OASDIFF=1 (CI).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../check.mjs";
import {
  evaluateMatrix,
  parseAcceptedBreaks,
  snapshotDigest,
  snapshotId,
} from "../lib/evaluate.mjs";
import { diffTrees, writeIgnoreFile } from "../lib/oasdiff.mjs";
import { parseYamlSubset } from "../lib/yaml-subset.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPAT = path.resolve(HERE, "..");
const SEVERITY = path.resolve(COMPAT, "../tools/oasdiff/severity-levels.txt");
const MATRIX_TEXT = readFileSync(path.join(COMPAT, "pos-supported.yaml"), "utf8");
const NOW = new Date("2026-10-25T00:00:00Z"); // one day after the baseline capture

const oasdiffBin = process.env.OASDIFF ?? "oasdiff";
const haveOasdiff = !spawnSync(oasdiffBin, ["--version"]).error;
const needsOasdiff = { skip: !haveOasdiff && process.env.CONTRACTS_COMPAT_REQUIRE_OASDIFF !== "1" && "oasdiff not installed" };

const fresh = () => structuredClone(parseYamlSubset(MATRIX_TEXT));
// A blobAt stub that agrees with every file the matrix lists.
const honestBlobAt = (matrix) => {
  const known = new Map();
  for (const e of matrix.supported) {
    for (const f of e.contract_ref.files) known.set(`${e.contract_ref.commit}:${e.contract_ref.root}/${f.path}`, f.blob);
  }
  return (commit, file) => known.get(`${commit}:${file}`) ?? null;
};
const evaluate = (matrix, extra = {}) =>
  evaluateMatrix(matrix, { blobAt: honestBlobAt(parseYamlSubset(MATRIX_TEXT)), now: NOW, ...extra });

// ---- YAML subset parser ----------------------------------------------------------------------

test("parser reads the committed matrix; hex-looking scalars stay strings", () => {
  const m = parseYamlSubset(MATRIX_TEXT);
  assert.equal(m.schema, "retail-tower/pos-compat@1");
  assert.equal(m.supported[0].contract_ref.files.length, 8);
  assert.equal(typeof m.supported[0].contract_ref.commit, "string");
});

test("parser fails closed on unsupported syntax", () => {
  assert.throws(() => parseYamlSubset("a:\n\t- b"), /tab/);
  assert.throws(() => parseYamlSubset("a: &anchor x"), /unsupported YAML syntax/);
  assert.throws(() => parseYamlSubset("a: [1, 2]"), /unsupported YAML syntax/);
  assert.throws(() => parseYamlSubset("a: 1\na: 2"), /duplicate key/);
  assert.throws(() => parseYamlSubset("---\na: 1"), /document markers/);
  assert.throws(() => parseYamlSubset("# only a comment\n"), /empty/);
});

// ---- evaluator -------------------------------------------------------------------------------

test("matching snapshot: READY", () => {
  const r = evaluate(fresh());
  assert.equal(r.state, "READY");
  assert.deepEqual(r.problems, []);
  assert.equal(snapshotId(r.supported[0]), "pos-build-9dfd7d977267");
});

test("digest is derived from the listed path/blob pairs", () => {
  const m = fresh();
  assert.equal(snapshotDigest(m.supported[0].contract_ref.files), m.supported[0].snapshot_sha256);
});

test("missing blob: FAIL_MISSING_SNAPSHOT", () => {
  const r = evaluate(fresh(), { blobAt: () => null });
  assert.equal(r.state, "FAIL_MISSING_SNAPSHOT");
  assert.match(r.problems[0], /not found at 1711813d/);
});

test("blob that differs from git history: FAIL_MISSING_SNAPSHOT", () => {
  const r = evaluate(fresh(), { blobAt: () => "0".repeat(40) });
  assert.equal(r.state, "FAIL_MISSING_SNAPSHOT");
  assert.match(r.problems[0], /matrix lists/);
});

test("edited blob list without a new digest: FAIL_MISSING_SNAPSHOT", () => {
  const m = fresh();
  m.supported[0].contract_ref.files[0].blob = "f".repeat(40);
  const r = evaluate(m, { blobAt: honestBlobAt(m) });
  assert.equal(r.state, "FAIL_MISSING_SNAPSHOT");
  assert.match(r.problems[0], /snapshot_sha256 does not match/);
});

test("unknown snapshot kind: FAIL_INVALID_MATRIX", () => {
  const m = fresh();
  m.supported[0].kind = "nightly";
  assert.equal(evaluate(m).state, "FAIL_INVALID_MATRIX");
  const n = fresh();
  n.fleet_baseline.installed[0].kind = "nightly";
  assert.equal(evaluate(n).state, "FAIL_INVALID_MATRIX");
});

test("empty matrix with no exception: FAIL_MISSING_SNAPSHOT", () => {
  const m = fresh();
  m.fleet_baseline.installed = [];
  m.supported = [];
  assert.equal(evaluate(m).state, "FAIL_MISSING_SNAPSHOT");
});

test("empty matrix with a valid exception: NOT_PROVEN, never green", () => {
  const m = fresh();
  m.fleet_baseline.installed = [];
  m.supported = [];
  m.bootstrap_exception = {
    approved_by: "owner", approved_at: "2026-10-24", jira: "RT-713 comment 1",
    residual_risk: "none installed", expires_when: "first installed release or build",
  };
  assert.equal(evaluate(m).state, "NOT_PROVEN_NO_SUPPORTED_RELEASE_SNAPSHOT");
});

test("installed build with no supported entry: FAIL_MISSING_SNAPSHOT", () => {
  const m = fresh();
  m.fleet_baseline.installed.push({ kind: "build", build_id: "a".repeat(40) });
  const r = evaluate(m, { blobAt: honestBlobAt(m) });
  assert.equal(r.state, "FAIL_MISSING_SNAPSHOT");
  assert.match(r.problems[0], /has no entry in supported/);
});

test("bootstrap exception while something is installed: invalid", () => {
  const m = fresh();
  m.bootstrap_exception = {
    approved_by: "owner", approved_at: "2026-10-24", jira: "RT-713 comment 1",
    residual_risk: "x", expires_when: "y",
  };
  const r = evaluate(m);
  assert.equal(r.state, "FAIL_INVALID_MATRIX");
  assert.match(r.problems.join("\n"), /non-empty/);
});

test("stale fleet baseline warns on a PR and fails in release mode", () => {
  const late = new Date("2026-11-01T00:00:00Z"); // 7.6 days after capture
  const pr = evaluate(fresh(), { now: late });
  assert.equal(pr.state, "READY");
  assert.match(pr.warnings[0], /FAIL_STALE_FLEET/);
  const rel = evaluate(fresh(), { now: late, mode: "release" });
  assert.equal(rel.state, "FAIL_MISSING_SNAPSHOT");
  assert.match(rel.problems[0], /FAIL_STALE_FLEET/);
});

test("synthetic probes must be labelled test-only", () => {
  const m = fresh();
  m.synthetic_snapshots[0].label = "real";
  assert.equal(evaluate(m).state, "FAIL_INVALID_MATRIX");
});

// ---- accepted breaks -------------------------------------------------------------------------

test("accepted breaks need a snapshot id, a Jira key and a consumer tag", () => {
  const ids = ["pos-build-aaaaaaaaaaaa"];
  const ok = parseAcceptedBreaks("# c\n\npos-build-aaaaaaaaaaaa RT-9 consumer:POS intentional: GET /x removed", ids);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.byId.get(ids[0]).length, 1);
  const bad = parseAcceptedBreaks(
    ["nope RT-9 consumer:POS x", "pos-build-aaaaaaaaaaaa consumer:POS x", "pos-build-aaaaaaaaaaaa RT-9 x"].join("\n"),
    ids,
  );
  assert.equal(bad.problems.length, 3);
});

// ---- oasdiff-backed ---------------------------------------------------------------------------

test("introduced breaking change turns the diff red; compatible one passes", needsOasdiff, () => {
  const work = mkdtempSync(path.join(tmpdir(), "compat-spec-"));
  try {
    const ignoreFile = path.join(work, "ignore.txt");
    writeIgnoreFile(ignoreFile, []);
    const base = path.join(COMPAT, "synthetic/base");
    const broke = diffTrees({ baseDir: base, headDir: path.join(COMPAT, "synthetic/breaking-01"), severityFile: SEVERITY, ignoreFile });
    assert.equal(broke.status, "breaking");
    const fine = diffTrees({ baseDir: base, headDir: path.join(COMPAT, "synthetic/compatible-01"), severityFile: SEVERITY, ignoreFile });
    assert.equal(fine.status, "ok");

    // An accepted break (persistent, keyed by snapshot) is honoured; one finding at a time.
    const findings = broke.output.split("\n").filter((l) => /^(error|warning)/i.test(l) || l.includes("probe"));
    assert.ok(findings.length > 0);
    writeIgnoreFile(ignoreFile, findings.map((f) => `synth RT-1 consumer:none intentional: ${f}`));
    const accepted = diffTrees({ baseDir: base, headDir: path.join(COMPAT, "synthetic/breaking-01"), severityFile: SEVERITY, ignoreFile });
    assert.equal(accepted.status, "ok");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("run(): committed matrix passes against current contracts, verdict is never VERIFIED", needsOasdiff, () => {
  const r = run({ now: NOW });
  assert.equal(r.exit, 0, r.lines.join("\n"));
  const text = r.lines.join("\n");
  assert.match(text, /harness correctness : PASS/);
  assert.match(text, /real-snapshot oasdiff: PASS \(1 snapshot\)/);
  assert.match(text, /envelope\/replay\s+: NOT_PROVEN/);
  assert.doesNotMatch(text, /\bVERIFIED\b(?!\s*until)/);
  assert.equal(run({ now: NOW, mode: "release" }).exit, 1, "release mode must not go green while replay is NOT_PROVEN");
});

test("run(): a tampered blob, an unknown kind or an empty matrix fail the job", needsOasdiff, () => {
  const tampered = MATRIX_TEXT.replace("blob: bd8e3abf4f02760d267bc74efc72c7e6ebd72768", `blob: ${"1".repeat(40)}`);
  assert.equal(run({ now: NOW, matrixText: tampered }).exit, 1);
  const unknown = MATRIX_TEXT.replace("  - kind: build\n    build_id", "  - kind: nightly\n    build_id");
  assert.equal(run({ now: NOW, matrixText: unknown }).exit, 1);
  const empty = "schema: retail-tower/pos-compat@1\nfleet_baseline:\n  source: x\n  captured_at: 2026-10-24T00:00:00Z\n  evidence: x\n  installed: []\nsupported: []\n";
  const r = run({ now: NOW, matrixText: empty });
  assert.equal(r.exit, 1);
  assert.match(r.lines.join("\n"), /FAIL_MISSING_SNAPSHOT/);
});
