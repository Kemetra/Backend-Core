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

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_PATH = /^(?![/\\])(?!.*\.\.)[^\0\\]+$/;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";
const matches = (re) => (v) => typeof v === "string" && re.test(v);
const isSha1 = matches(SHA1);
const isSha256 = matches(SHA256);
const isSafePath = matches(SAFE_PATH);
const oneOf = (list) => (v) => list.includes(v);
const isTimestamp = (v) => nonEmpty(v) && !Number.isNaN(Date.parse(v));

// Per-object field rules: key -> predicate. Unknown keys are rejected separately.
const BASELINE_SPEC = { source: nonEmpty, captured_at: isTimestamp, evidence: nonEmpty, installed: Array.isArray };
const KIND_SPEC = {
  installed: { build: { build_id: nonEmpty }, release: { pos_version: nonEmpty } },
  supported: { build: { build_id: isSha1 }, release: { pos_version: nonEmpty, release_tag: nonEmpty } },
};
const SUPPORTED_COMMON = {
  status: oneOf(["supported", "deprecated"]),
  added_by: nonEmpty,
  snapshot_sha256: isSha256,
};
const REF_SPEC = { commit: isSha1, root: nonEmpty };
const FILE_SPEC = { path: isSafePath, blob: isSha1 };
const EXCEPTION_FIELDS = ["approved_by", "approved_at", "jira", "residual_risk", "expires_when"];
const EXCEPTION_SPEC = Object.fromEntries(EXCEPTION_FIELDS.map((k) => [k, nonEmpty]));
const SYNTHETIC_SPEC = {
  id: nonEmpty,
  snapshot: nonEmpty,
  candidate: nonEmpty,
  label: oneOf(["test-only"]),
  expect: oneOf(["breaking", "compatible"]),
};
const KEYS = {
  top: ["schema", "fleet_baseline", "supported", "bootstrap_exception", "synthetic_snapshots"],
  baseline: Object.keys(BASELINE_SPEC),
  installed: ["kind", "build_id", "pos_version"],
  supported: ["kind", "build_id", "pos_version", "release_tag", "device_label", "pos_pin", "contract_ref", ...Object.keys(SUPPORTED_COMMON)],
  exception: EXCEPTION_FIELDS,
  synthetic: Object.keys(SYNTHETIC_SPEC),
};

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

// ---- structural validation: tiny helpers, each pushes into `problems` -------------------------

const badFields = (obj, spec) =>
  Object.keys(spec).filter((k) => !(isObj(obj) && spec[k](obj[k])));

function checkShape(obj, spec, where, problems) {
  const bad = badFields(obj, spec);
  if (bad.length > 0) problems.push(`${where}: missing or invalid ${bad.join(", ")}`);
}

function checkKeys(obj, allowed, where, problems) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) problems.push(`${where}: unknown key '${k}'`);
  }
}

function checkKind(e, where, specs, problems) {
  if (isObj(e) && Object.hasOwn(specs, e.kind)) return true;
  problems.push(`${where}: unknown kind '${isObj(e) ? e.kind : e}' (expected ${KINDS.join("|")})`);
  return false;
}

function checkInstalled(list, problems) {
  list.forEach((e, i) => {
    const where = `fleet_baseline.installed[${i}]`;
    if (!checkKind(e, where, KIND_SPEC.installed, problems)) return;
    checkKeys(e, KEYS.installed, where, problems);
    checkShape(e, KIND_SPEC.installed[e.kind], where, problems);
  });
}

function checkBaseline(fb, problems) {
  if (!isObj(fb)) return problems.push("fleet_baseline is required");
  checkKeys(fb, KEYS.baseline, "fleet_baseline", problems);
  checkShape(fb, BASELINE_SPEC, "fleet_baseline", problems);
  if (Array.isArray(fb.installed)) checkInstalled(fb.installed, problems);
}

function checkContractRef(ref, where, problems) {
  checkShape(ref, REF_SPEC, `${where}.contract_ref`, problems);
  const files = isObj(ref) ? ref.files : undefined;
  if (!Array.isArray(files) || files.length === 0) {
    return problems.push(`${where}.contract_ref.files must list at least one path/blob`);
  }
  files.forEach((f, j) => checkShape(f, FILE_SPEC, `${where}.contract_ref.files[${j}]`, problems));
  const paths = files.map((f) => f?.path);
  if (new Set(paths).size !== paths.length) problems.push(`${where}.contract_ref.files has duplicate paths`);
}

function checkSupported(list, problems) {
  if (!Array.isArray(list)) return problems.push("supported must be a list");
  list.forEach((e, i) => {
    const where = `supported[${i}]`;
    if (!checkKind(e, where, KIND_SPEC.supported, problems)) return;
    checkKeys(e, KEYS.supported, where, problems);
    checkShape(e, { ...KIND_SPEC.supported[e.kind], ...SUPPORTED_COMMON }, where, problems);
    checkContractRef(e.contract_ref, where, problems);
  });
}

function checkException(ex, installedCount, problems) {
  if (ex === undefined) return;
  if (!isObj(ex)) return problems.push("bootstrap_exception: must be a mapping");
  checkKeys(ex, KEYS.exception, "bootstrap_exception", problems);
  checkShape(ex, EXCEPTION_SPEC, "bootstrap_exception", problems);
  // The exception only covers "nothing installed"; it is void once anything is.
  if (installedCount > 0) {
    problems.push("bootstrap_exception is invalid while fleet_baseline.installed is non-empty");
  }
}

// Synthetic probes prove the harness, never real-client compatibility: they must say so.
function checkSynthetic(list, problems) {
  if (list === undefined) return;
  if (!Array.isArray(list)) return problems.push("synthetic_snapshots must be a list");
  list.forEach((s, i) => {
    const where = `synthetic_snapshots[${i}]`;
    if (!isObj(s)) return problems.push(`${where}: must be a mapping`);
    checkKeys(s, KEYS.synthetic, where, problems);
    checkShape(s, SYNTHETIC_SPEC, where, problems);
  });
}

export function validateStructure(matrix) {
  if (!isObj(matrix)) return ["matrix must be a mapping"];
  const problems = [];
  checkKeys(matrix, KEYS.top, "top level", problems);
  if (matrix.schema !== SCHEMA) problems.push(`schema must be '${SCHEMA}', got '${matrix.schema}'`);
  checkSections(matrix, problems);
  return problems;
}

function checkSections(matrix, problems) {
  const fb = matrix.fleet_baseline;
  checkBaseline(fb, problems);
  checkSupported(matrix.supported, problems);
  const installedCount = Array.isArray(fb?.installed) ? fb.installed.length : 0;
  checkException(matrix.bootstrap_exception, installedCount, problems);
  checkSynthetic(matrix.synthetic_snapshots, problems);
}

// ---- evaluation --------------------------------------------------------------------------------

/** Re-derive the digest and compare every listed blob with git history. */
function verifySnapshot(entry, blobAt) {
  const problems = [];
  const { commit, root, files } = entry.contract_ref;
  const id = snapshotId(entry);
  if (snapshotDigest(files) !== entry.snapshot_sha256) {
    problems.push(`${id}: snapshot_sha256 does not match the listed path/blob pairs`);
  }
  for (const f of files) {
    const actual = blobAt(commit, `${root}/${f.path}`);
    if (actual === null) problems.push(`${id}: ${root}/${f.path} not found at ${commit}`);
    else if (actual !== f.blob) problems.push(`${id}: ${f.path} is blob ${actual} at ${commit}, matrix lists ${f.blob}`);
  }
  return problems;
}

function nothingInstalled(matrix) {
  if (matrix.bootstrap_exception === undefined) {
    const problems = ["no installed POS build or release recorded and no owner-approved bootstrap_exception"];
    return { state: "FAIL_MISSING_SNAPSHOT", problems, warnings: [], supported: [] };
  }
  return { state: "NOT_PROVEN_NO_SUPPORTED_RELEASE_SNAPSHOT", problems: [], warnings: [], supported: [] };
}

function uncoveredInstalled(matrix) {
  const have = new Set(matrix.supported.map(identityOf));
  return matrix.fleet_baseline.installed
    .filter((inst) => !have.has(identityOf(inst)))
    .map((inst) => `installed ${identityOf(inst)} has no entry in supported`);
}

function staleness(matrix, now) {
  const ageDays = (now.getTime() - Date.parse(matrix.fleet_baseline.captured_at)) / 86_400_000;
  if (ageDays <= FRESHNESS_DAYS) return null;
  return `FAIL_STALE_FLEET: fleet_baseline.captured_at is ${ageDays.toFixed(1)} days old (limit ${FRESHNESS_DAYS})`;
}

/**
 * @param matrix  parsed pos-supported.yaml
 * @param opts    { blobAt(commit, path) -> sha|null, now: Date, mode: 'pr'|'release' }
 * @returns { state, problems, warnings, supported }  supported = entries to diff when READY
 */
export function evaluateMatrix(matrix, { blobAt, now, mode = "pr" }) {
  const invalid = validateStructure(matrix);
  if (invalid.length > 0) return { state: "FAIL_INVALID_MATRIX", problems: invalid, warnings: [], supported: [] };
  if (matrix.fleet_baseline.installed.length === 0) return nothingInstalled(matrix);

  const problems = [
    ...uncoveredInstalled(matrix),
    ...matrix.supported.flatMap((e) => verifySnapshot(e, blobAt)),
  ];
  const warnings = [];
  const stale = staleness(matrix, now);
  if (stale) (mode === "release" ? problems : warnings).push(stale);
  const state = problems.length > 0 ? "FAIL_MISSING_SNAPSHOT" : "READY";
  return { state, problems, warnings, supported: matrix.supported };
}

// ---- accepted breaks -----------------------------------------------------------------------------

const JIRA_KEY = /\bRT-\d+\b/;
const CONSUMER_TAG = /\bconsumer:[A-Za-z0-9_-]+\b/;

function acceptedProblem(id, body, knownIds) {
  if (!knownIds.includes(id)) return `unknown snapshot id '${id}'`;
  if (!JIRA_KEY.test(body)) return "missing a Jira key (RT-<n>)";
  if (!CONSUMER_TAG.test(body)) return "missing a consumer:<NAME> tag";
  return null;
}

/**
 * Persistent accepted breaks, one line per finding: `<snapshot-id> <reason with RT-n and
 * consumer:NAME>: <oasdiff singleline finding>`. Unlike tools/oasdiff/breaking-ignore.txt
 * they do not expire with the PR: a snapshot is fixed, so a break accepted against it stays
 * true for every later PR until the snapshot is dropped.
 * @returns { byId: Map<string,string[]>, problems: string[] }
 */
export function parseAcceptedBreaks(text, knownIds) {
  const byId = new Map();
  const problems = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const [id, ...rest] = line.split(/\s+/);
    const problem = acceptedProblem(id, rest.join(" "), knownIds);
    if (problem) problems.push(`accepted-breaks.txt:${i + 1}: ${problem}`);
    else byId.set(id, [...(byId.get(id) ?? []), line]);
  });
  return { byId, problems };
}
