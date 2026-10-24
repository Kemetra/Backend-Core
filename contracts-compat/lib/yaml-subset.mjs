// RT-713: strict parser for the small YAML subset contracts-compat/pos-supported.yaml
// uses. The compat job has no install step, so it cannot import a YAML package.
//
// Supported: block mappings, block sequences (of scalars or mappings), full-line
// comments, trailing ` #` comments on plain scalars, '…' and "…" scalars, the
// empty flow collections `[]` and `{}`. Every scalar is a string, except
// true/false/null and the empty collections (a hex SHA made of digits must stay
// a string).
// Anything else (tabs, anchors, tags, flow collections, block scalars, document
// markers, duplicate keys, odd indentation) throws: fail closed, never guess.

const KEY_START = /^[A-Za-z0-9_.-]+:(\s|$)/;
const KEY_LINE = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/;
const FORBIDDEN_START = /^[&*!|>{[%@`]/;
const CONSTANTS = new Map([
  ["[]", () => []],
  ["{}", () => ({})],
  ["true", () => true],
  ["false", () => false],
  ["null", () => null],
  ["~", () => null],
]);
const REJECTED_LINES = [
  [/\t/, "tab character"],
  [/^(---|\.\.\.)/, "document markers are not supported"],
];

const unsupported = (n, why) => new Error(`pos-supported.yaml line ${n}: ${why}`);

const isQuoted = (v) => /^["']/.test(v);

function quoted(v, n) {
  if (v.length < 2 || !v.endsWith(v[0])) throw unsupported(n, "unterminated quoted scalar");
  return v[0] === '"' ? JSON.parse(v) : v.slice(1, -1).replaceAll("''", "'");
}

function scalar(raw, n) {
  const v = raw.trim();
  if (CONSTANTS.has(v)) return CONSTANTS.get(v)();
  if (isQuoted(v)) return quoted(v, n);
  if (FORBIDDEN_START.test(v)) throw unsupported(n, `unsupported YAML syntax '${v[0]}'`);
  return v.replace(/\s+#.*$/, "");
}

function tokenLine(line, n) {
  if (/^\s*(#.*)?$/.test(line)) return null;
  const rejected = REJECTED_LINES.find(([re]) => re.test(line));
  if (rejected) throw unsupported(n, rejected[1]);
  return { n, indent: line.length - line.trimStart().length, text: line.trim() };
}

const tokenize = (text) =>
  text.split(/\r?\n/).map((line, i) => tokenLine(line, i + 1)).filter((t) => t !== null);

const isSeqItem = (t) => t.text === "-" || t.text.startsWith("- ");
const peek = (c) => c.lines[c.pos];

function nestedValue(c, tok) {
  const next = peek(c);
  return next && next.indent > tok.indent ? parseValue(c, next.indent) : null;
}

function splitKey(text, n) {
  const m = KEY_LINE.exec(text);
  if (!m) throw unsupported(n, `expected 'key: value', got '${text}'`);
  return [m[1], m[2]];
}

function addEntry(c, obj, tok, text) {
  const [key, rest] = splitKey(text, tok.n);
  if (Object.hasOwn(obj, key)) throw unsupported(tok.n, `duplicate key '${key}'`);
  obj[key] = rest ? scalar(rest, tok.n) : nestedValue(c, tok);
}

function atKey(c, indent) {
  const t = peek(c);
  return t !== undefined && t.indent === indent && !isSeqItem(t);
}

function parseMapping(c, indent, first) {
  const obj = {};
  if (first) addEntry(c, obj, first.tok, first.text);
  while (atKey(c, indent)) {
    const tok = c.lines[c.pos++];
    addEntry(c, obj, tok, tok.text);
  }
  rejectDeeper(c, indent);
  return obj;
}

function rejectDeeper(c, indent) {
  const next = peek(c);
  if (next && next.indent > indent) throw unsupported(next.n, "unexpected indentation");
}

function parseItem(c, tok, indent) {
  const body = tok.text === "-" ? "" : tok.text.slice(2);
  if (body === "") return parseValue(c, indent + 1);
  // `- key: v` opens a mapping whose further keys sit at indent + 2.
  if (KEY_START.test(body)) return parseMapping(c, indent + 2, { tok, text: body });
  return scalar(body, tok.n);
}

function parseSequence(c, indent) {
  const arr = [];
  while (peek(c)?.indent === indent && isSeqItem(peek(c))) {
    arr.push(parseItem(c, c.lines[c.pos++], indent));
  }
  return arr;
}

function parseValue(c, indent) {
  const t = peek(c);
  if (!t || t.indent < indent) return null;
  return isSeqItem(t) ? parseSequence(c, t.indent) : parseMapping(c, t.indent);
}

const isMapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function parseRoot(c) {
  if (c.lines.length === 0) throw new Error("pos-supported.yaml is empty");
  const root = parseValue(c, c.lines[0].indent);
  if (c.pos < c.lines.length) throw unsupported(peek(c).n, "unexpected content");
  return root;
}

export function parseYamlSubset(text) {
  const root = parseRoot({ lines: tokenize(text), pos: 0 });
  if (!isMapping(root)) throw new Error("pos-supported.yaml: top level must be a mapping");
  return root;
}
