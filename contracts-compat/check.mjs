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
const SEVERITY_FILE = path.join(ROOT, "tools/oasdiff/severity-levels.txt");
const REPLAY_STATUS =
  "NOT_PROVEN (no recorded outbox fixtures and no envelope/idempotency tests yet; RT-713 stays open)";
const SKIPPED = (why) => ({ label: `SKIPPED (${why})`, ok: true });

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

function runHarness(matrix, ctx) {
  ctx.out.push("harness correctness (synthetic, test-only; says nothing about real clients):");
  const ok = runProbes(matrix.synthetic_snapshots ?? [], ctx);
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

function summarize({ out, result, accepted, harness, compat, mode }) {
  const failed = result.state.startsWith("FAIL_") || accepted.problems.length > 0 || !harness.ok || !compat.ok;
  const notGreen = !failed && mode === "release";
  if (notGreen) out.push("::error::release mode: envelope/replay status is NOT_PROVEN, so the release gate is not green");
  out.push(
    "",
    `harness correctness : ${harness.label}`,
    `real-snapshot oasdiff: ${compat.label}`,
    `envelope/replay      : ${REPLAY_STATUS}`,
    `compatibility verdict: ${failed ? "FAIL" : "NOT_VERIFIED (never VERIFIED until envelope/replay are proven)"}`,
  );
  return { exit: failed || notGreen ? 1 : 0, lines: out };
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
    return summarize({ out, result, accepted, harness, compat, mode });
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
