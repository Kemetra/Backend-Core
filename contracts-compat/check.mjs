#!/usr/bin/env node
// POS compatibility gate (RT-713, RT-707 G4). Usage:
//   node contracts-compat/check.mjs [--mode pr|release] [--now <iso>]
//
// For each supported POS build/release in pos-supported.yaml it re-reads the pinned
// Backend-Core contract files from git history (commit + blob, verified), then runs
// oasdiff (composed, --fail-on WARN, tools/oasdiff/severity-levels.txt) from that
// snapshot to the current packages/contracts/openapi. Three results are reported
// separately: harness correctness (synthetic test-only probes), real-snapshot
// compatibility (oasdiff), and envelope/replay status. The last is NOT_PROVEN until
// recorded outbox fixtures and envelope tests exist, so the verdict is never VERIFIED
// and `--mode release` fails. Needs `oasdiff` on PATH (or OASDIFF=…) and full git history.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateMatrix, parseAcceptedBreaks, snapshotId } from "./lib/evaluate.mjs";
import { diffTrees, writeIgnoreFile } from "./lib/oasdiff.mjs";
import { parseYamlSubset } from "./lib/yaml-subset.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONTRACTS = "packages/contracts/openapi";
const REPLAY_STATUS =
  "NOT_PROVEN (no recorded outbox fixtures and no envelope/idempotency tests yet; RT-713 stays open)";

const git = (args) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });

function blobAt(commit, file) {
  try {
    return git(["rev-parse", "--verify", "--quiet", `${commit}:${file}`]).toString().trim() || null;
  } catch {
    return null;
  }
}

function extractSnapshot(entry, dir) {
  const { commit, root, files } = entry.contract_ref;
  for (const f of files) {
    const dest = path.join(dir, f.path);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, git(["show", `${commit}:${root}/${f.path}`]));
  }
}

function runProbes(synthetic, severityFile, emptyIgnore, out) {
  let ok = true;
  for (const p of synthetic) {
    const r = diffTrees({
      baseDir: path.join(HERE, p.snapshot),
      headDir: path.join(HERE, p.candidate),
      severityFile,
      ignoreFile: emptyIgnore,
    });
    const want = p.expect === "breaking" ? "breaking" : "ok";
    const pass = r.status === want;
    ok &&= pass;
    out.push(`  [${pass ? "OK" : "FAIL"}] ${p.id} (test-only): expected ${p.expect}, oasdiff said ${r.status}`);
    if (!pass) out.push(r.output);
  }
  return ok;
}

function runSnapshots(entries, accepted, work, severityFile, out) {
  let ok = true;
  const head = path.join(ROOT, CONTRACTS);
  for (const entry of entries) {
    const id = snapshotId(entry);
    const dir = path.join(work, "snapshots", id);
    extractSnapshot(entry, dir);
    const ignoreFile = path.join(work, `${id}.ignore.txt`);
    writeIgnoreFile(ignoreFile, accepted.byId.get(id) ?? []);
    const r = diffTrees({ baseDir: dir, headDir: head, severityFile, ignoreFile });
    ok &&= r.status === "ok";
    const label = { ok: "compatible", breaking: "FAIL_BREAKING", "tool-error": "FAIL_TOOL" }[r.status];
    out.push(`  [${r.status === "ok" ? "OK" : "FAIL"}] ${id} (${entry.status}): ${label}`);
    if (r.status !== "ok") out.push(r.output);
  }
  return ok;
}

/** @returns { exit: number, lines: string[] } */
export function run({ mode = "pr", now = new Date(), matrixText, acceptedText } = {}) {
  const out = [];
  const fail = (m) => out.push(`::error::${m}`);
  const severityFile = path.join(ROOT, "tools/oasdiff/severity-levels.txt");
  let matrix;
  try {
    matrix = parseYamlSubset(matrixText ?? readFileSync(path.join(HERE, "pos-supported.yaml"), "utf8"));
  } catch (e) {
    fail(`FAIL_INVALID_MATRIX: ${e.message}`);
    return { exit: 1, lines: out };
  }
  const result = evaluateMatrix(matrix, { blobAt, now, mode });
  out.push(`matrix state: ${result.state}`);
  result.warnings.forEach((w) => out.push(`::warning::${w}`));
  result.problems.forEach((p) => fail(`${result.state}: ${p}`));
  let failed = result.state.startsWith("FAIL_");

  const ids = result.supported.map(snapshotId);
  const accepted = parseAcceptedBreaks(
    acceptedText ?? readFileSync(path.join(HERE, "accepted-breaks.txt"), "utf8"),
    (Array.isArray(matrix.supported) ? matrix.supported : []).map((e) => (e && typeof e === "object" ? snapshotId(e) : "")),
  );
  accepted.problems.forEach((p) => fail(p));
  failed ||= accepted.problems.length > 0;

  const work = mkdtempSync(path.join(tmpdir(), "contracts-compat-"));
  try {
    let harness = "SKIPPED (matrix invalid)";
    if (result.state !== "FAIL_INVALID_MATRIX") {
      const empty = path.join(work, "empty.ignore.txt");
      writeIgnoreFile(empty, []);
      out.push("harness correctness (synthetic, test-only; says nothing about real clients):");
      const probes = matrix.synthetic_snapshots ?? [];
      const harnessOk = probes.length > 0 && runProbes(probes, severityFile, empty, out);
      harness = harnessOk ? "PASS" : "FAIL";
      if (!harnessOk) fail("harness probes missing or wrong: the gate cannot be trusted");
      failed ||= !harnessOk;
    }
    let compat = `SKIPPED (${result.state})`;
    if (result.state === "READY") {
      out.push("real-snapshot oasdiff (supported POS builds/releases vs current contracts):");
      const snapshotsOk = runSnapshots(result.supported, accepted, work, severityFile, out);
      compat = snapshotsOk ? `PASS (${ids.length} snapshot${ids.length === 1 ? "" : "s"})` : "FAIL";
      failed ||= !snapshotsOk;
    }
    const notGreen = !failed && mode === "release";
    if (notGreen) fail("release mode: envelope/replay status is NOT_PROVEN, so the release gate is not green");
    out.push(
      "",
      `harness correctness : ${harness}`,
      `real-snapshot oasdiff: ${compat}`,
      `envelope/replay      : ${REPLAY_STATUS}`,
      `compatibility verdict: ${failed ? "FAIL" : "NOT_VERIFIED (never VERIFIED until envelope/replay are proven)"}`,
    );
    return { exit: failed || notGreen ? 1 : 0, lines: out };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main(argv) {
  const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const mode = get("--mode") ?? "pr";
  if (!["pr", "release"].includes(mode)) {
    console.error(`::error::unknown --mode '${mode}' (expected pr or release)`);
    return 1;
  }
  const now = get("--now") ? new Date(get("--now")) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error("::error::--now is not a valid timestamp");
    return 1;
  }
  const { exit, lines } = run({ mode, now });
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### POS compatibility (RT-713)\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`);
  }
  return exit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
