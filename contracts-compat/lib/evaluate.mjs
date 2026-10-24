// RT-713: evaluator for contracts-compat/pos-supported.yaml (schema
// retail-tower/pos-compat@1, RT-709 §C.1). Pure: git access and the clock are
// injected so every state is unit-testable.
//
// States (RT-709 §C.1 + the RT-713 no-false-green amendment):
//   READY                                      matrix is valid and every snapshot blob verifies
//   NOT_PROVEN_NO_SUPPORTED_RELEASE_SNAPSHOT   nothing installed + valid bootstrap exception (never green)
//   FAIL_MISSING_SNAPSHOT                      installed build/release without a verifiable snapshot,
//                                              or nothing installed and no exception
//   FAIL_INVALID_MATRIX                        schema violation, unknown kind, contradictory exception
// FAIL_BREAKING and the final verdict come from check.mjs, after oasdiff ran.
import { createHash } from "node:crypto";

export const SCHEMA = "retail-tower/pos-compat@1";
export const KINDS = ["build", "release"];
export const FRESHNESS_DAYS = 7; // owner decision O-3 (RT-709 comment 12808)

const TOP_KEYS = ["schema", "fleet_baseline", "supported", "bootstrap_exception", "synthetic_snapshots"];
const BASELINE_KEYS = ["source", "captured_at", "evidence", "installed"];
const SUPPORTED_KEYS = [
  "kind", "build_id", "pos_version", "release_tag", "device_label", "pos_pin",
  "contract_ref", "snapshot_sha256", "status", "added_by",
];
const EXCEPTION_KEYS = ["approved_by", "approved_at", "jira", "residual_risk", "expires_when"];
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

/** sha256 over the sorted `<blob>  <path>` lines of a snapshot's file list. */
export function snapshotDigest(files) {
  const lines = files.map((f) => `${f.blob}  ${f.path}\n`).sort((a, b) => (a < b ? -1 : Number(a > b)));
  return createHash("sha256").update(lines.join("")).digest("hex");
}

export const snapshotId = (entry) =>
  entry.kind === "build"
    ? `pos-build-${String(entry.build_id).slice(0, 12)}`
    : `pos-release-${entry.pos_version}`;

const identityOf = (e) => `${e.kind}:${e.kind === "build" ? e.build_id : e.pos_version}`;

function unknownKeys(obj, allowed, where, problems) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) problems.push(`${where}: unknown key '${k}'`);
  }
}

function checkInstalledEntry(e, i, problems) {
  const where = `fleet_baseline.installed[${i}]`;
  if (!isObj(e) || !KINDS.includes(e.kind)) {
    problems.push(`${where}: unknown kind '${isObj(e) ? e.kind : e}' (expected ${KINDS.join("|")})`);
  } else if (e.kind === "build" ? !nonEmpty(e.build_id) : !nonEmpty(e.pos_version)) {
    problems.push(`${where}: ${e.kind === "build" ? "build_id" : "pos_version"} is required`);
  }
}

function checkSupportedEntry(e, i, problems) {
  const where = `supported[${i}]`;
  if (!isObj(e)) return problems.push(`${where}: must be a mapping`);
  unknownKeys(e, SUPPORTED_KEYS, where, problems);
  if (!KINDS.includes(e.kind)) {
    return problems.push(`${where}: unknown kind '${e.kind}' (expected ${KINDS.join("|")})`);
  }
  if (e.kind === "build" && !SHA1.test(e.build_id ?? "")) {
    problems.push(`${where}: build_id must be a full 40-hex POS commit SHA`);
  }
  if (e.kind === "release" && (!nonEmpty(e.pos_version) || !nonEmpty(e.release_tag))) {
    problems.push(`${where}: release entries need pos_version and release_tag`);
  }
  if (!["supported", "deprecated"].includes(e.status)) {
    problems.push(`${where}: status must be supported|deprecated`);
  }
  if (!nonEmpty(e.added_by)) problems.push(`${where}: added_by is required`);
  const ref = e.contract_ref;
  if (!isObj(ref) || !SHA1.test(ref.commit ?? "") || !nonEmpty(ref.root)) {
    return problems.push(`${where}: contract_ref needs a 40-hex commit and a root`);
  }
  if (!Array.isArray(ref.files) || ref.files.length === 0) {
    return problems.push(`${where}: contract_ref.files must list at least one path/blob`);
  }
  const seen = new Set();
  ref.files.forEach((f, j) => {
    if (!isObj(f) || !nonEmpty(f.path) || !SHA1.test(f.blob ?? "")) {
      problems.push(`${where}: contract_ref.files[${j}] needs path and a 40-hex blob`);
    } else if (f.path.includes("..") || f.path.startsWith("/") || seen.has(f.path)) {
      problems.push(`${where}: contract_ref.files[${j}] path '${f.path}' is unsafe or duplicated`);
    } else {
      seen.add(f.path);
    }
  });
  if (!SHA256.test(e.snapshot_sha256 ?? "")) problems.push(`${where}: snapshot_sha256 must be 64 hex`);
}

function checkException(ex, installedCount, problems) {
  if (ex === undefined) return;
  if (!isObj(ex)) return problems.push("bootstrap_exception: must be a mapping");
  unknownKeys(ex, EXCEPTION_KEYS, "bootstrap_exception", problems);
  for (const k of EXCEPTION_KEYS) {
    if (!nonEmpty(ex[k])) problems.push(`bootstrap_exception.${k} is required`);
  }
  // The exception only covers "nothing installed"; it is void once anything is.
  if (installedCount > 0) {
    problems.push("bootstrap_exception is invalid while fleet_baseline.installed is non-empty");
  }
}

const SYNTHETIC_KEYS = ["id", "snapshot", "candidate", "label", "expect"];

// Synthetic probes prove the harness, never real-client compatibility: they must say so.
function checkSynthetic(list, problems) {
  if (list === undefined) return;
  if (!Array.isArray(list)) return problems.push("synthetic_snapshots must be a list");
  list.forEach((s, i) => {
    const where = `synthetic_snapshots[${i}]`;
    if (!isObj(s)) return problems.push(`${where}: must be a mapping`);
    unknownKeys(s, SYNTHETIC_KEYS, where, problems);
    for (const k of ["id", "snapshot", "candidate"]) {
      if (!nonEmpty(s[k])) problems.push(`${where}.${k} is required`);
    }
    if (s.label !== "test-only") problems.push(`${where}.label must be 'test-only'`);
    if (!["breaking", "compatible"].includes(s.expect)) {
      problems.push(`${where}.expect must be breaking|compatible`);
    }
  });
}

export function validateStructure(matrix) {
  const problems = [];
  if (!isObj(matrix)) return ["matrix must be a mapping"];
  unknownKeys(matrix, TOP_KEYS, "top level", problems);
  if (matrix.schema !== SCHEMA) problems.push(`schema must be '${SCHEMA}', got '${matrix.schema}'`);
  const fb = matrix.fleet_baseline;
  if (!isObj(fb)) {
    problems.push("fleet_baseline is required");
  } else {
    unknownKeys(fb, BASELINE_KEYS, "fleet_baseline", problems);
    for (const k of ["source", "captured_at", "evidence"]) {
      if (!nonEmpty(fb[k])) problems.push(`fleet_baseline.${k} is required`);
    }
    if (nonEmpty(fb.captured_at) && Number.isNaN(Date.parse(fb.captured_at))) {
      problems.push("fleet_baseline.captured_at is not a valid timestamp");
    }
    if (Array.isArray(fb.installed)) fb.installed.forEach((e, i) => checkInstalledEntry(e, i, problems));
    else problems.push("fleet_baseline.installed must be a list (use [] when nothing is installed)");
  }
  if (Array.isArray(matrix.supported)) matrix.supported.forEach((e, i) => checkSupportedEntry(e, i, problems));
  else problems.push("supported must be a list");
  checkException(matrix.bootstrap_exception, Array.isArray(fb?.installed) ? fb.installed.length : 0, problems);
  checkSynthetic(matrix.synthetic_snapshots, problems);
  return problems;
}

/** Re-derive the digest and compare every listed blob with git history. */
function verifySnapshot(entry, blobAt) {
  const problems = [];
  const { commit, root, files } = entry.contract_ref;
  if (snapshotDigest(files) !== entry.snapshot_sha256) {
    problems.push(`${snapshotId(entry)}: snapshot_sha256 does not match the listed path/blob pairs`);
  }
  for (const f of files) {
    const actual = blobAt(commit, `${root}/${f.path}`);
    if (actual === null) {
      problems.push(`${snapshotId(entry)}: ${root}/${f.path} not found at ${commit}`);
    } else if (actual !== f.blob) {
      problems.push(`${snapshotId(entry)}: ${f.path} is blob ${actual} at ${commit}, matrix lists ${f.blob}`);
    }
  }
  return problems;
}

/**
 * @param matrix  parsed pos-supported.yaml
 * @param opts    { blobAt(commit, path) -> sha|null, now: Date, mode: 'pr'|'release' }
 * @returns { state, problems, warnings, supported }  supported = entries to diff when READY
 */
export function evaluateMatrix(matrix, { blobAt, now, mode = "pr" }) {
  const problems = validateStructure(matrix);
  const warnings = [];
  if (problems.length > 0) return { state: "FAIL_INVALID_MATRIX", problems, warnings, supported: [] };

  const installed = matrix.fleet_baseline.installed;
  if (installed.length === 0) {
    return matrix.bootstrap_exception === undefined
      ? {
          state: "FAIL_MISSING_SNAPSHOT",
          problems: ["no installed POS build or release recorded and no owner-approved bootstrap_exception"],
          warnings,
          supported: [],
        }
      : { state: "NOT_PROVEN_NO_SUPPORTED_RELEASE_SNAPSHOT", problems, warnings, supported: [] };
  }

  const have = new Map(matrix.supported.map((e) => [identityOf(e), e]));
  for (const inst of installed) {
    if (!have.has(identityOf(inst))) {
      problems.push(`installed ${identityOf(inst)} has no entry in supported`);
    }
  }
  for (const entry of matrix.supported) problems.push(...verifySnapshot(entry, blobAt));

  const ageDays = (now.getTime() - Date.parse(matrix.fleet_baseline.captured_at)) / 86_400_000;
  if (ageDays > FRESHNESS_DAYS) {
    const msg = `FAIL_STALE_FLEET: fleet_baseline.captured_at is ${ageDays.toFixed(1)} days old (limit ${FRESHNESS_DAYS})`;
    (mode === "release" ? problems : warnings).push(msg);
  }
  return {
    state: problems.length > 0 ? "FAIL_MISSING_SNAPSHOT" : "READY",
    problems,
    warnings,
    supported: matrix.supported,
  };
}

const ACCEPTED_TAG = /\bRT-\d+\b/;
const CONSUMER_TAG = /\bconsumer:[A-Za-z0-9_-]+\b/;

/**
 * Persistent accepted breaks, one line per finding: `<snapshot-id> <reason with RT-n and
 * consumer:NAME>: <oasdiff singleline finding>`. Unlike tools/oasdiff/breaking-ignore.txt
 * they do not expire with the PR: a snapshot is fixed, so a break accepted against it stays
 * true for every later PR until the snapshot is dropped from the matrix.
 * @returns { byId: Map<string,string[]>, problems: string[] }
 */
export function parseAcceptedBreaks(text, knownIds) {
  const byId = new Map();
  const problems = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const [id, ...rest] = line.split(/\s+/);
    const body = rest.join(" ");
    if (!knownIds.includes(id)) problems.push(`accepted-breaks.txt:${i + 1}: unknown snapshot id '${id}'`);
    else if (!ACCEPTED_TAG.test(body)) problems.push(`accepted-breaks.txt:${i + 1}: missing a Jira key (RT-<n>)`);
    else if (!CONSUMER_TAG.test(body)) problems.push(`accepted-breaks.txt:${i + 1}: missing a consumer:<NAME> tag`);
    else byId.set(id, [...(byId.get(id) ?? []), line]);
  });
  return { byId, problems };
}
