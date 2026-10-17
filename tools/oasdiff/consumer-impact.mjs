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
// Usage: node tools/oasdiff/consumer-impact.mjs < <ignore-file>
//   The acknowledged lines come in on stdin, so the script takes no path argument.
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
const STDIN_FD = 0;

const CONTRACTS_REPO = "Kemetra/Backend-Core";
const CONTRACTS_ROOT = "packages/contracts/openapi";
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 15_000;
const MODES = new Set(["report", "enforce"]);

// ---- text helpers ----------------------------------------------------------

const isContent = (trimmed) => trimmed !== "" && !trimmed.startsWith("#");

/** Lines as written (indentation kept), without blanks and `#` comments. */
const rawContentLines = (text) =>
  text.split(/\r?\n/).filter((line) => isContent(line.trim()));

/** Trimmed lines without blanks and `#` comments. */
const contentLines = (text) => rawContentLines(text).map((line) => line.trim());

const unique = (values) => [...new Set(values)];
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

// ---- PIN (same grammar as Kemetra/POS scripts/contracts-pin.ts) --------------

const SHA1 = /^[0-9a-f]{40}$/;
const PIN_LINE = /^([a-z]+):\s+(\S.*)$/;
const OPENAPI_FILE = /\.(ya?ml|json)$/;
const DOT_SEGMENTS = new Set(["", ".", ".."]);

const PATH_RULES = [
  { reason: "absolute", broken: (p) => p.startsWith("/") },
  { reason: "backslash", broken: (p) => p.includes("\\") },
  { reason: "empty, . or .. segment", broken: (p) => p.split("/").some((s) => DOT_SEGMENTS.has(s)) },
  { reason: "not .yaml/.yml/.json", broken: (p) => !OPENAPI_FILE.test(p) },
];

function assertSafeRelativePath(p) {
  const rule = PATH_RULES.find((r) => r.broken(p));
  if (rule === undefined) return;
  throw new Error(`contracts PIN: unsafe or non-OpenAPI path "${p}" (${rule.reason})`);
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

const FIELD_READERS = {
  repo: (draft, value) => {
    draft.repo = value;
  },
  commit: (draft, value) => {
    draft.commit = value;
  },
  source: (draft, value) => {
    draft.source = value;
  },
  file: (draft, value) => {
    draft.files.push(parseFileEntry(value));
  },
};

function readPinLine(draft, line) {
  const match = PIN_LINE.exec(line);
  if (match === null) throw new Error(`contracts PIN: unparseable line "${line}"`);
  const read = FIELD_READERS[match[1]];
  if (read === undefined) throw new Error(`contracts PIN: unknown key "${match[1]}"`);
  read(draft, match[2].trim());
}

const PIN_CHECKS = [
  { message: "repo is required", ok: (d) => d.repo !== undefined },
  { message: "source is required", ok: (d) => d.source !== undefined },
  { message: "commit must be a full SHA", ok: (d) => SHA1.test(d.commit ?? "") },
  { message: "no files pinned", ok: (d) => d.files.length > 0 },
  {
    message: "duplicate file entry",
    ok: (d) => new Set(d.files.map((f) => f.path)).size === d.files.length,
  },
];

/** Parse a consumer PIN file. Throws on a malformed or incomplete PIN. */
export function parsePin(text) {
  const draft = { repo: undefined, commit: undefined, source: undefined, files: [] };
  for (const line of contentLines(text)) readPinLine(draft, line);
  const failed = PIN_CHECKS.find((check) => !check.ok(draft));
  if (failed !== undefined) throw new Error(`contracts PIN: ${failed.message}`);
  return draft;
}

// ---- consumers.txt ---------------------------------------------------------

const CONSUMER_LINE = /^(\S+)\s+(https:\/\/\S+)$/;

function parseConsumerLine(line) {
  const match = CONSUMER_LINE.exec(line);
  if (match === null) throw new Error(`consumers.txt: malformed line "${line}"`);
  return { name: match[1], url: match[2] };
}

/** `<NAME> <raw PIN URL>` per line; `#` comments and blank lines are skipped. */
export const parseConsumers = (text) => contentLines(text).map(parseConsumerLine);

// ---- OpenAPI paths ---------------------------------------------------------

// A top-level path key, bare or quoted: `/api/x:`, `'/api/x/{id}':`, `"/api/x":`.
const PATH_KEY = /^(['"]?)(\/[^'"\s]*)\1:(?:\s|$)/;

const indentOf = (line) => line.length - line.trimStart().length;
const pathKeyOf = (line) => PATH_KEY.exec(line.trim())?.[2];

/** The lines indented under the first top-level `paths:` header. */
function pathsBlock(lines) {
  const start = lines.findIndex((line) => line.startsWith("paths:"));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => indentOf(line) === 0);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Keys of the top-level `paths:` block (`/api/pos/v1/...`). Indentation-based,
 * no YAML library: only lines at the block's first child indent are keys, so
 * nested text and a `components:` block can never contribute.
 */
export function collectApiPaths(yamlText) {
  const block = pathsBlock(rawContentLines(yamlText));
  if (block.length === 0) return new Set();
  const childIndent = indentOf(block[0]);
  return new Set(
    block
      .filter((line) => indentOf(line) === childIndent)
      .map(pathKeyOf)
      .filter((key) => key !== undefined),
  );
}

const jsonPathKeys = (text) => new Set(Object.keys(JSON.parse(text).paths ?? {}));

/** Path keys of one pinned contract, parsed according to its file extension. */
export const collectPathsFromFile = (filePath, text) =>
  filePath.endsWith(".json") ? jsonPathKeys(text) : collectApiPaths(text);

// ---- acknowledgement lines -------------------------------------------------

const METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE";
const IN_API = new RegExp(String.raw`\bin API (${METHODS}) (/\S*)`);
const BARE_OPERATION = new RegExp(String.raw`\b(${METHODS}) (/\S*)`);
const TAG = /(?<![\w:])consumer:([A-Za-z0-9][\w-]*)/g;
const JIRA = /\bRT-\d+\b/g;

/**
 * Method and path come from `in API <METHOD> <path>` or, in older lines, the
 * bare `<METHOD> <path>`. A `components` finding has neither (both null).
 */
function operationOf(line) {
  const match = IN_API.exec(line) ?? BARE_OPERATION.exec(line);
  return match === null ? { method: null, path: null } : { method: match[1], path: match[2] };
}

export function parseAckLine(line) {
  return {
    ...operationOf(line),
    tags: unique([...line.matchAll(TAG)].map((m) => m[1])),
    jira: unique([...line.matchAll(JIRA)].map((m) => m[0])),
  };
}

// ---- assessment ------------------------------------------------------------

const verdict = (ok, affected, reason) => ({ ok, affected, reason });

const hasNoneTag = (ack) => ack.tags.includes("none");

function affectedConsumers(ack, impactByConsumer) {
  if (ack.path === null) return [];
  return [...impactByConsumer].filter(([, paths]) => paths.has(ack.path)).map(([name]) => name);
}

const asTag = (name) => `consumer:${name}`;

const fail = (ctx, reason) => verdict(false, ctx.affected, `${ctx.who}${reason}`);
const pass = (ctx, reason) => verdict(true, ctx.affected, reason);

const unknownTags = (ctx) =>
  ctx.ack.tags.filter((tag) => tag !== "none" && !ctx.known.includes(tag));

const unknownTagVerdict = (ctx) => {
  const unknown = unknownTags(ctx);
  if (unknown.length === 0) return undefined;
  const tags = unknown.map(asTag).join(" ");
  return fail(ctx, `unknown consumer tag(s) ${tags} (known: ${[...ctx.known, "none"].join(", ")})`);
};

// Each rule returns a verdict, or undefined to defer to the next rule.
const RULES = [
  (c) =>
    c.ack.tags.length === 0
      ? fail(c, "no consumer: tag (add consumer:<NAME> or consumer:none)")
      : undefined,
  unknownTagVerdict,
  (c) =>
    hasNoneTag(c.ack) && c.ack.tags.length > 1
      ? fail(c, "consumer:none contradicts the other consumer: tags")
      : undefined,
  (c) =>
    c.ack.path === null
      ? pass(c, "impact not computable (no API path); tag not verified")
      : undefined,
  (c) => (c.affected.length === 0 ? pass(c, "no consumer pins this path") : undefined),
  (c) =>
    hasNoneTag(c.ack)
      ? fail(c, "consumer:none, but the pinned contracts contain this path")
      : undefined,
  (c) => {
    const missing = c.affected.filter((name) => !c.ack.tags.includes(name));
    return missing.length > 0
      ? fail(c, `missing ${missing.map(asTag).join(" ")}`)
      : undefined;
  },
  (c) => (c.ack.jira.length === 0 ? fail(c, "needs a Jira key (RT-<n>) on the line") : undefined),
];

/**
 * Judge one parsed acknowledgement against each consumer's pinned path set.
 * `knownConsumers` are the configured names (default: those with a loaded set),
 * so a consumer whose PIN could not be read still counts as a valid tag.
 */
export function assessLine(ack, impactByConsumer, knownConsumers = [...impactByConsumer.keys()]) {
  const affected = affectedConsumers(ack, impactByConsumer);
  const ctx = { ack, affected, known: knownConsumers, who: affected.length > 0 ? `affects ${affected.join(", ")}: ` : "" };
  for (const rule of RULES) {
    const result = rule(ctx);
    if (result !== undefined) return result;
  }
  return pass(ctx, `${ctx.who}tagged`);
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

async function withRetries(attempts, delayMs, fn, attempt = 1) {
  try {
    return await fn();
  } catch (error) {
    if (attempt >= attempts) throw error;
    await sleep(delayMs * attempt);
    return withRetries(attempts, delayMs, fn, attempt + 1);
  }
}

async function readPin(consumer, io) {
  try {
    const text = await withRetries(FETCH_ATTEMPTS, io.retryDelayMs, () => io.fetchText(consumer.url));
    return { pin: parsePin(text) };
  } catch (error) {
    return { error: `consumer PIN unreadable: ${consumer.name} (${consumer.url}): ${messageOf(error)}` };
  }
}

const pinMismatch = (pin) =>
  pin.repo === CONTRACTS_REPO && pin.source === CONTRACTS_ROOT
    ? undefined
    : `PIN names ${pin.repo} ${pin.source}, expected ${CONTRACTS_REPO} ${CONTRACTS_ROOT}`;

async function pathsOfPinnedFile(pin, file, io) {
  const text = await io.gitShow(pin.commit, `${CONTRACTS_ROOT}/${file.path}`);
  return collectPathsFromFile(file.path, text);
}

async function pathsAtPinCommit(consumer, pin, io) {
  const unresolvable = (why) => ({ error: `consumer pin unresolvable: ${consumer.name} (${why})` });
  const mismatch = pinMismatch(pin);
  if (mismatch !== undefined) return unresolvable(mismatch);
  try {
    const sets = await Promise.all(pin.files.map((f) => pathsOfPinnedFile(pin, f, io)));
    return { paths: new Set(sets.flatMap((set) => [...set])) };
  } catch (error) {
    return unresolvable(`${pin.commit.slice(0, 7)}: ${messageOf(error)}`);
  }
}

async function loadImpact(consumer, io) {
  const read = await readPin(consumer, io);
  if (read.error !== undefined) return { name: consumer.name, error: read.error };
  return { name: consumer.name, ...(await pathsAtPinCommit(consumer, read.pin, io)) };
}

async function loadImpacts(consumersFile, io) {
  const consumers = parseConsumers(readFileSync(consumersFile, "utf8"));
  const loaded = await Promise.all(consumers.map((consumer) => loadImpact(consumer, io)));
  return {
    names: consumers.map((consumer) => consumer.name),
    impact: new Map(loaded.filter((l) => l.paths).map((l) => [l.name, l.paths])),
    errors: loaded.filter((l) => l.error).map((l) => l.error),
  };
}

// ---- reporting -------------------------------------------------------------

const annotation = (level, message) =>
  `::${level}::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`;

const excerpt = (line) => (line.length > 160 ? `${line.slice(0, 60)}...${line.slice(-95)}` : line);

const findViolations = (lines, impact, names) =>
  lines
    .map((line) => ({ line, result: assessLine(parseAckLine(line), impact, names) }))
    .filter(({ result }) => !result.ok);

function report({ log, mode, lines, violations, errors }) {
  const level = mode === "enforce" ? "error" : "warning";
  for (const error of errors) log(annotation(level, `consumer-impact: ${error}`));
  for (const { line, result } of violations) {
    log(annotation(level, `consumer-impact: ${result.reason}: ${excerpt(line)}`));
  }
  log(
    `consumer-impact (${mode}): ${lines.length} acknowledged line(s), ` +
      `${violations.length} violation(s), ${errors.length} consumer error(s).`,
  );
}

function resolveMode(requested) {
  const mode = requested || process.env.CONSUMER_IMPACT_MODE || "report";
  if (!MODES.has(mode)) {
    throw new Error(`unknown CONSUMER_IMPACT_MODE "${mode}" (expected report or enforce)`);
  }
  return mode;
}

function buildIo(options) {
  return {
    fetchText: options.fetchText ?? defaultFetchText,
    gitShow: options.gitShow ?? defaultGitShow,
    retryDelayMs: options.retryDelayMs ?? 1000,
  };
}

const exitCodeFor = (mode, problems) => (mode === "enforce" && problems > 0 ? 1 : 0);

/**
 * `ackSource` is a file path (tests) or a file descriptor (the CLI passes stdin).
 * Returns the process exit code: `report` mode always returns 0 (violations and
 * consumer errors are warnings); `enforce` returns 1 on any of them.
 */
export async function main(ackSource, options = {}) {
  const mode = resolveMode(options.mode);
  const log = options.log ?? ((message) => console.log(message));
  const lines = contentLines(readFileSync(ackSource, "utf8"));
  if (lines.length === 0) {
    log("consumer-impact: no acknowledged breaks added by this change.");
    return 0;
  }
  const { impact, errors, names } = await loadImpacts(
    options.consumersFile ?? DEFAULT_CONSUMERS_FILE,
    buildIo(options),
  );
  const violations = findViolations(lines, impact, names);
  report({ log, mode, lines, violations, errors });
  return exitCodeFor(mode, violations.length + errors.length);
}

// ---- CLI -------------------------------------------------------------------

const isEntryPoint = () =>
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

function runCli() {
  main(STDIN_FD).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(annotation("error", `consumer-impact: ${messageOf(error)}`));
      process.exitCode = 1;
    },
  );
}

if (isEntryPoint()) runCli();
