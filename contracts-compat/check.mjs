#!/usr/bin/env node
// POS compatibility gate (RT-713, RT-707 G4). Usage:
//   node contracts-compat/check.mjs [--mode pr|release] [--now <iso>]
//
// For each supported POS build/release in pos-supported.yaml it re-reads the pinned
// Backend-Core contract files from git history (commit + blob, verified), then:
//   1. runs oasdiff (composed, --fail-on WARN, tools/oasdiff/severity-levels.txt) from the
//      snapshot to the current packages/contracts/openapi;
//   2. runs the envelope/idempotency-key rules (lib/semantics.mjs) snapshot -> current;
//   3. replays the snapshot's fixtures (replay/<snapshot-id>/*.yaml) against both, offline.
// Reported separately: harness correctness (synthetic test-only probes), real-snapshot
// oasdiff, envelope/idempotency, and replay with its counts by provenance. Replay is at
// contract level (no running Backend-Core). `--mode release` also requires at least one
// `recorded` fixture per snapshot. Needs `oasdiff` on PATH (or OASDIFF=…) and full git history.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateMatrix, parseAcceptedBreaks, snapshotId } from "./lib/evaluate.mjs";
import { mutate } from "./lib/mutations.mjs";
import { diffTrees, writeIgnoreFile } from "./lib/oasdiff.mjs";
import { proveSnapshot } from "./lib/proof.mjs";
import { fixtureFiles } from "./lib/replay.mjs";
import { loadDocs, loadDocsTolerant } from "./lib/spec.mjs";
import { parseYamlSubset } from "./lib/yaml-subset.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CONTRACTS = "packages/contracts/openapi";
const SEVERITY_FILE = path.join(ROOT, "tools/oasdiff/severity-levels.txt");
const REPLAY_DIR = path.join(HERE, "replay");
const SKIPPED = (why) => ({ label: `SKIPPED (${why})`, ok: true });
const proofSkipped = (why) => ({ envelope: SKIPPED(why), replay: SKIPPED(why), proven: false, recorded: false });

// `git` comes from the runner's PATH, like oasdiff and node in tools/oasdiff/check.sh: this
// job runs only in CI or on a developer machine, never on untrusted input.
const git = (args) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }); // NOSONAR

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

function runProbes(probes, ctx) {
  let ok = probes.length > 0;
  for (const p of probes) {
    const r = diffTrees({
      baseDir: path.join(HERE, p.snapshot),
      headDir: path.join(HERE, p.candidate),
      severityFile: ctx.severityFile,
      ignoreFile: ctx.emptyIgnore,
    });
    const pass = r.status === (p.expect === "breaking" ? "breaking" : "ok");
    ok &&= pass;
    ctx.out.push(`  [${pass ? "OK" : "FAIL"}] ${p.id} (test-only): expected ${p.expect}, oasdiff said ${r.status}`);
    if (!pass) ctx.out.push(r.output);
  }
  return ok;
}

// Each synthetic envelope/replay probe applies one named regression to the synthetic snapshot
// and must make the rules fail (or, for `none`, pass): proof that the rules can fail.
function runSemanticProbes(probes, ctx) {
  let ok = true;
  for (const p of probes) {
    const snapshotDocs = loadDocs(path.join(HERE, p.snapshot));
    const result = proveSnapshot({
      snapshotDocs,
      candidateDocs: mutate(snapshotDocs, p.mutation),
      fixtureFiles: [path.join(HERE, p.fixture)],
      snapshotId: "synthetic",
    });
    const problems = [...result.semantics.problems, ...result.replay.problems];
    const pass = (problems.length === 0) === (p.expect === "pass") && result.replay.events > 0;
    ok &&= pass;
    ctx.out.push(`  [${pass ? "OK" : "FAIL"}] ${p.id} (test-only): ${p.mutation} expected ${p.expect}, ${problems.length} problem(s)`);
    if (!pass) ctx.out.push(...problems);
  }
  return ok;
}

function runHarness(matrix, ctx) {
  ctx.out.push("harness correctness (synthetic, test-only; says nothing about real clients):");
  const diffOk = runProbes(matrix.synthetic_snapshots ?? [], ctx);
  const semanticOk = runSemanticProbes(matrix.synthetic_semantics ?? [], ctx);
  const ok = diffOk && semanticOk;
  if (!ok) ctx.out.push("::error::harness probes missing or wrong: the gate cannot be trusted");
  return { label: ok ? "PASS" : "FAIL", ok };
}

function runCompat(entries, accepted, ctx) {
  ctx.out.push("real-snapshot oasdiff (supported POS builds/releases vs current contracts):");
  let ok = true;
  for (const entry of entries) {
    const id = snapshotId(entry);
    const dir = path.join(ctx.work, "snapshots", id);
    extractSnapshot(entry, dir);
    const ignoreFile = path.join(ctx.work, `${id}.ignore.txt`);
    writeIgnoreFile(ignoreFile, accepted.byId.get(id) ?? []);
    const r = diffTrees({ baseDir: dir, headDir: path.join(ROOT, CONTRACTS), severityFile: ctx.severityFile, ignoreFile });
    ok &&= r.status === "ok";
    const verdict = { ok: "compatible", breaking: "FAIL_BREAKING", "tool-error": "FAIL_TOOL" }[r.status];
    ctx.out.push(`  [${r.status === "ok" ? "OK" : "FAIL"}] ${id} (${entry.status}): ${verdict}`);
    if (r.status !== "ok") ctx.out.push(r.output);
  }
  const n = entries.length;
  return { label: ok ? `PASS (${n} snapshot${n === 1 ? "" : "s"})` : "FAIL", ok };
}

// Envelope/idempotency rules and offline replay for every supported snapshot (already extracted
// by runCompat). Zero fixtures for a snapshot is NOT_PROVEN for it, never a pass (RT-709 §C.2).
function runProof(entries, ctx) {
  ctx.out.push("envelope/idempotency + replay (contract level, offline):");
  const { docs: candidateDocs, skipped } = loadDocsTolerant(path.join(ROOT, CONTRACTS));
  if (skipped.length > 0) ctx.out.push(`::warning::oasdiff could not flatten ${skipped.length} current contract file(s): ${skipped.join(", ")}`);
  const total = { operations: 0, events: 0, recorded: 0, derived: 0, problems: [], unproven: 0, unrecorded: 0 };
  for (const entry of entries) {
    const id = snapshotId(entry);
    const files = fixtureFiles(REPLAY_DIR, id);
    const r = proveSnapshot({ snapshotDocs: loadDocs(path.join(ctx.work, "snapshots", id)), candidateDocs, fixtureFiles: files, snapshotId: id });
    total.operations += r.semantics.operations;
    total.events += r.replay.events;
    total.recorded += r.replay.counts.recorded;
    total.derived += r.replay.counts["contract-derived"];
    total.unproven += r.replay.counts.recorded + r.replay.counts["contract-derived"] > 0 ? 0 : 1;
    total.unrecorded += r.replay.counts.recorded > 0 ? 0 : 1;
    total.problems.push(...r.semantics.problems.map((m) => `${id} envelope: ${m}`), ...r.replay.problems.map((m) => `${id} replay: ${m}`));
  }
  total.problems.forEach((m) => ctx.out.push(`  [FAIL] ${m}`));
  return summarizeProof(total);
}

function summarizeProof(t) {
  const failed = t.problems.length > 0;
  const counts = `${t.events} event(s): ${t.recorded} recorded, ${t.derived} contract-derived`;
  const replayLabel = t.unproven > 0 ? `NOT_PROVEN (a supported snapshot has no eligible fixture; ${counts})` : `PASS (${counts})`;
  return {
    envelope: { label: failed ? "FAIL" : `PASS (${t.operations} operation(s) across the snapshots)`, ok: !failed },
    replay: { label: failed ? "FAIL" : replayLabel, ok: !failed },
    proven: !failed && t.unproven === 0,
    recorded: t.unrecorded === 0,
  };
}

function loadMatrix(matrixText, out) {
  try {
    return parseYamlSubset(matrixText ?? readFileSync(path.join(HERE, "pos-supported.yaml"), "utf8"));
  } catch (e) {
    out.push(`::error::FAIL_INVALID_MATRIX: ${e.message}`);
    return null;
  }
}

function loadAccepted(acceptedText, matrix, out) {
  const entries = Array.isArray(matrix.supported) ? matrix.supported : [];
  const ids = entries.map((e) => (e && typeof e === "object" ? snapshotId(e) : ""));
  const accepted = parseAcceptedBreaks(acceptedText ?? readFileSync(path.join(HERE, "accepted-breaks.txt"), "utf8"), ids);
  accepted.problems.forEach((p) => out.push(`::error::${p}`));
  return accepted;
}

function announce(result, out) {
  out.push(`matrix state: ${result.state}`);
  result.warnings.forEach((w) => out.push(`::warning::${w}`));
  result.problems.forEach((p) => out.push(`::error::${result.state}: ${p}`));
}

// VERIFIED (RT-709 §C.1: oasdiff + envelope tests pass for every snapshot) is only printed when
// every supported snapshot also has an eligible replay fixture; release mode additionally needs
// a `recorded` one, because contract-derived fixtures are not terminal recordings.
function verdictOf({ failed, proof, mode }) {
  if (failed) return { text: "FAIL", exit: 1 };
  if (!proof.proven) return { text: "NOT_VERIFIED (replay NOT_PROVEN)", exit: mode === "release" ? 1 : 0 };
  if (mode === "release" && !proof.recorded) {
    return { text: "NOT_VERIFIED (release mode needs a recorded fixture per snapshot)", exit: 1 };
  }
  return { text: "VERIFIED (contract level; replay is offline)", exit: 0 };
}

function summarize({ out, result, accepted, harness, compat, proof, mode }) {
  const failed =
    result.state.startsWith("FAIL_") || accepted.problems.length > 0 || ![harness, compat, proof.envelope, proof.replay].every((r) => r.ok);
  const verdict = verdictOf({ failed, proof, mode });
  if (verdict.exit === 1 && !failed) out.push(`::error::${verdict.text}`);
  out.push(
    "",
    `harness correctness  : ${harness.label}`,
    `real-snapshot oasdiff: ${compat.label}`,
    `envelope/idempotency : ${proof.envelope.label}`,
    `replay               : ${proof.replay.label}`,
    `compatibility verdict: ${verdict.text}`,
  );
  return { exit: verdict.exit, lines: out };
}

/** @returns { exit: number, lines: string[] } */
export function run({ mode = "pr", now = new Date(), matrixText, acceptedText } = {}) {
  const out = [];
  const matrix = loadMatrix(matrixText, out);
  if (!matrix) return { exit: 1, lines: out };
  const result = evaluateMatrix(matrix, { blobAt, now, mode });
  announce(result, out);
  const accepted = loadAccepted(acceptedText, matrix, out);

  const work = mkdtempSync(path.join(tmpdir(), "contracts-compat-"));
  try {
    const emptyIgnore = path.join(work, "empty.ignore.txt");
    writeIgnoreFile(emptyIgnore, []);
    const ctx = { out, work, severityFile: SEVERITY_FILE, emptyIgnore };
    const harness = result.state === "FAIL_INVALID_MATRIX" ? SKIPPED("matrix invalid") : runHarness(matrix, ctx);
    const compat = result.state === "READY" ? runCompat(result.supported, accepted, ctx) : SKIPPED(result.state);
    const proof = result.state === "READY" && compat.ok ? runProof(result.supported, ctx) : proofSkipped(result.state);
    return summarize({ out, result, accepted, harness, compat, proof, mode });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const mode = get("--mode") ?? "pr";
  const now = get("--now") ? new Date(get("--now")) : new Date();
  if (!["pr", "release"].includes(mode)) return { error: `unknown --mode '${mode}' (expected pr or release)` };
  if (Number.isNaN(now.getTime())) return { error: "--now is not a valid timestamp" };
  return { mode, now };
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(`::error::${args.error}`);
    return 1;
  }
  const { exit, lines } = run(args);
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### POS compatibility (RT-713)\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`);
  }
  return exit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
