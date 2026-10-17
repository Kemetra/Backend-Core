// Consumer-impact check on oasdiff acknowledgements (RT-674, contracts-sync S1).
//
// Every NEW line in breaking-ignore.txt acknowledges a contract break. This
// script ties each line to the consumers that pin the affected contract: it
// reads each consumer's public PIN file (tools/oasdiff/consumers.txt), builds
// the consumer's API path set from the pinned files AT THE CONSUMER'S OWN PIN
// COMMIT (what the consumer actually built against, so a path the PR removes
// still counts), and requires each line to carry a `consumer:<NAME>` tag (or
// `consumer:none`) in its free-text prefix.
//
// No dependencies and Node 20-compatible: the `oasdiff` job has no install step.
//
// Usage: node tools/oasdiff/consumer-impact.mjs <ignore-file>
//   CONSUMER_IMPACT_MODE=report (default)  violations are ::warning::, exit 0
//   CONSUMER_IMPACT_MODE=enforce           violations are ::error::, exit 1
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_CONSUMERS_FILE = path.join(HERE, "consumers.txt");

const CONTRACTS_REPO = "Kemetra/Backend-Core";
const CONTRACTS_ROOT = "packages/contracts/openapi";
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

// ---- PIN (same grammar as Kemetra/POS scripts/contracts-pin.ts) --------------

const SHA1 = /^[0-9a-f]{40}$/;
const PIN_LINE = /^([a-z]+):\s+(\S.*)$/;
const OPENAPI_FILE = /\.(ya?ml|json)$/;

function assertSafeRelativePath(p) {
  const broken =
    p.startsWith("/") ||
    p.includes("\\") ||
    p.split("/").some((s) => s === "" || s === "." || s === "..") ||
    !OPENAPI_FILE.test(p);
  if (broken) throw new Error(`contracts PIN: unsafe or non-OpenAPI path "${p}"`);
}

function parseFileEntry(value) {
  const parts = value.split(/\s+/);
  const [filePath, blobSha] = parts;
  if (parts.length !== 2 || !SHA1.test(blobSha ?? "")) {
    throw new Error(`contracts PIN: malformed file line "file: ${value}"`);
  }
  assertSafeRelativePath(filePath);
  return { path: filePath, blobSha };
}

/** Parse a consumer PIN file. Throws on a malformed or incomplete PIN. */
export function parsePin(text) {
  const draft = { repo: undefined, commit: undefined, source: undefined, files: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = PIN_LINE.exec(line);
    if (match === null) throw new Error(`contracts PIN: unparseable line "${line}"`);
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (key === "file") draft.files.push(parseFileEntry(value));
    else if (key === "repo" || key === "commit" || key === "source") draft[key] = value;
    else throw new Error(`contracts PIN: unknown key "${key}"`);
  }
  if (draft.repo === undefined) throw new Error("contracts PIN: repo is required");
  if (draft.source === undefined) throw new Error("contracts PIN: source is required");
  if (!SHA1.test(draft.commit ?? "")) throw new Error("contracts PIN: commit must be a full SHA");
  if (draft.files.length === 0) throw new Error("contracts PIN: no files pinned");
  if (new Set(draft.files.map((f) => f.path)).size !== draft.files.length) {
    throw new Error("contracts PIN: duplicate file entry");
  }
  return draft;
}

// ---- consumers.txt ---------------------------------------------------------

/** `<NAME> <raw PIN URL>` per line; `#` comments and blank lines are skipped. */
export function parseConsumers(text) {
  const consumers = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(\S+)\s+(https:\/\/\S+)$/.exec(line);
    if (match === null) throw new Error(`consumers.txt: malformed line "${line}"`);
    consumers.push({ name: match[1], url: match[2] });
  }
  return consumers;
}

// ---- OpenAPI paths ---------------------------------------------------------

const KEY = /^(?:'([^']*)'|"([^"]*)"|([^\s:'"]\S*?)):(?:\s|$)/;

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Keys of the top-level `paths:` block (`/api/pos/v1/...`). Indentation-based,
 * no YAML library: only lines at the block's first child indent are keys, so
 * nested text and a `components:` block can never contribute.
 */
export function collectApiPaths(yamlText) {
  const found = new Set();
  let inPaths = false;
  let childIndent = null;
  for (const raw of yamlText.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = indentOf(raw);
    if (indent === 0) {
      inPaths = /^paths:/.test(raw);
      childIndent = null;
      continue;
    }
    if (!inPaths) continue;
    childIndent ??= indent;
    if (indent !== childIndent) continue;
    const match = KEY.exec(trimmed);
    const key = match === null ? undefined : (match[1] ?? match[2] ?? match[3]);
    if (key?.startsWith("/")) found.add(key);
  }
  return found;
}

// ---- acknowledgement lines -------------------------------------------------

const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE";
const IN_API = new RegExp(`\\bin API (${METHODS}) (/\\S*)`);
const BARE_OPERATION = new RegExp(`\\b(${METHODS}) (/\\S*)`);
const TAG = /(?<![\w:])consumer:([A-Za-z0-9][\w-]*)/g;
const JIRA = /\bRT-\d+\b/g;

const unique = (matches) => [...new Set(matches)];

/**
 * Method and path come from `in API <METHOD> <path>` or, in older lines, the
 * bare `<METHOD> <path>`. A `components` finding has neither (both null).
 */
export function parseAckLine(line) {
  const operation = IN_API.exec(line) ?? BARE_OPERATION.exec(line);
  return {
    method: operation?.[1] ?? null,
    path: operation?.[2] ?? null,
    tags: unique([...line.matchAll(TAG)].map((m) => m[1])),
    jira: unique(line.match(JIRA) ?? []),
  };
}

const verdict = (ok, affected, reason) => ({ ok, affected, reason });

/** Judge one parsed acknowledgement against each consumer's pinned path set. */
export function assessLine(ack, impactByConsumer) {
  const affected =
    ack.path === null
      ? []
      : [...impactByConsumer].filter(([, paths]) => paths.has(ack.path)).map(([name]) => name);
  const who = affected.length > 0 ? `affects ${affected.join(", ")}: ` : "";

  if (ack.tags.length === 0) {
    return verdict(false, affected, `${who}no consumer: tag (add consumer:<NAME> or consumer:none)`);
  }
  if (ack.tags.includes("none") && ack.tags.length > 1) {
    return verdict(false, affected, `${who}consumer:none contradicts the other consumer: tags`);
  }
  if (ack.path === null) {
    return verdict(true, affected, "impact not computable (no API path); tag not verified");
  }
  if (affected.length === 0) return verdict(true, affected, "no consumer pins this path");
  if (ack.tags.includes("none")) {
    return verdict(false, affected, `${who}consumer:none, but the pinned contracts contain this path`);
  }
  const missing = affected.filter((name) => !ack.tags.includes(name));
  if (missing.length > 0) {
    return verdict(false, affected, `${who}missing ${missing.map((n) => `consumer:${n}`).join(" ")}`);
  }
  if (ack.jira.length === 0) {
    return verdict(false, affected, `${who}needs a Jira key (RT-<n>) on the line`);
  }
  return verdict(true, affected, `${who}tagged`);
}

// ---- I/O -------------------------------------------------------------------

async function defaultFetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function defaultGitShow(commit, file) {
  const { stdout } = await execFileAsync("git", ["show", `${commit}:${file}`], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : undefined);

async function withRetries(attempts, delayMs, fn) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

async function readPin(consumer, io) {
  try {
    const text = await withRetries(FETCH_ATTEMPTS, io.retryDelayMs, () => io.fetchText(consumer.url));
    return { pin: parsePin(text) };
  } catch (error) {
    return { error: `consumer PIN unreadable: ${consumer.name} (${consumer.url}): ${messageOf(error)}` };
  }
}

async function pathsAtPinCommit(consumer, pin, io) {
  const unresolvable = (why) => ({
    error: `consumer pin unresolvable: ${consumer.name} (${why})`,
  });
  if (pin.repo !== CONTRACTS_REPO || pin.source !== CONTRACTS_ROOT) {
    return unresolvable(`PIN names ${pin.repo} ${pin.source}, expected ${CONTRACTS_REPO} ${CONTRACTS_ROOT}`);
  }
  try {
    const texts = await Promise.all(
      pin.files.map((f) => io.gitShow(pin.commit, `${CONTRACTS_ROOT}/${f.path}`)),
    );
    return { paths: new Set(texts.flatMap((text) => [...collectApiPaths(text)])) };
  } catch (error) {
    return unresolvable(`${pin.commit.slice(0, 7)}: ${messageOf(error)}`);
  }
}

async function loadImpact(consumer, io) {
  const read = await readPin(consumer, io);
  if (read.error !== undefined) return { name: consumer.name, error: read.error };
  const resolved = await pathsAtPinCommit(consumer, read.pin, io);
  return { name: consumer.name, ...resolved };
}

const annotation = (level, message) =>
  `::${level}::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`;

const excerpt = (line) => (line.length > 160 ? `${line.slice(0, 60)}...${line.slice(-95)}` : line);

function readAckLines(ignoreFile) {
  return readFileSync(ignoreFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * Returns the process exit code. `report` mode always returns 0 (violations and
 * consumer errors are warnings); `enforce` returns 1 on any of them.
 */
export async function main(ignoreFile, options = {}) {
  const mode = options.mode || process.env.CONSUMER_IMPACT_MODE || "report";
  if (mode !== "report" && mode !== "enforce") {
    throw new Error(`unknown CONSUMER_IMPACT_MODE "${mode}" (expected report or enforce)`);
  }
  const io = {
    fetchText: options.fetchText ?? defaultFetchText,
    gitShow: options.gitShow ?? defaultGitShow,
    retryDelayMs: options.retryDelayMs ?? 1000,
  };
  const log = options.log ?? ((message) => console.log(message));
  const level = mode === "enforce" ? "error" : "warning";

  const lines = readAckLines(ignoreFile);
  if (lines.length === 0) {
    log("consumer-impact: no acknowledged breaks added by this change.");
    return 0;
  }

  const consumers = parseConsumers(readFileSync(options.consumersFile ?? DEFAULT_CONSUMERS_FILE, "utf8"));
  const loaded = await Promise.all(consumers.map((consumer) => loadImpact(consumer, io)));
  const impact = new Map(loaded.filter((l) => l.paths).map((l) => [l.name, l.paths]));
  const errors = loaded.filter((l) => l.error).map((l) => l.error);

  const violations = lines
    .map((line) => ({ line, result: assessLine(parseAckLine(line), impact) }))
    .filter(({ result }) => !result.ok);

  for (const error of errors) log(annotation(level, `consumer-impact: ${error}`));
  for (const { line, result } of violations) {
    log(annotation(level, `consumer-impact: ${result.reason}: ${excerpt(line)}`));
  }
  log(
    `consumer-impact (${mode}): ${lines.length} acknowledged line(s), ` +
      `${violations.length} violation(s), ${errors.length} consumer error(s).`,
  );
  return mode === "enforce" && violations.length + errors.length > 0 ? 1 : 0;
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint) {
  const ignoreFile = process.argv[2];
  if (ignoreFile === undefined) {
    console.error("usage: node tools/oasdiff/consumer-impact.mjs <ignore-file>");
    process.exitCode = 2;
  } else {
    main(ignoreFile).then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        console.error(annotation("error", `consumer-impact: ${messageOf(error)}`));
        process.exitCode = 1;
      },
    );
  }
}
