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

const unsupported = (n, why) => new Error(`pos-supported.yaml line ${n}: ${why}`);

function scalar(raw, n) {
  const v = raw.trim();
  if (v === "[]") return [];
  if (v === "{}") return {};
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (v.startsWith('"')) {
    if (v.length < 2 || !v.endsWith('"')) throw unsupported(n, "unterminated double-quoted scalar");
    return JSON.parse(v);
  }
  if (v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith("'")) throw unsupported(n, "unterminated single-quoted scalar");
    return v.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[&*!|>{[%@`]/.test(v)) throw unsupported(n, `unsupported YAML syntax '${v[0]}'`);
  return v.replace(/\s+#.*$/, "");
}

function tokenize(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const n = i + 1;
    if (/^\s*(#.*)?$/.test(line)) return;
    if (line.includes("\t")) throw unsupported(n, "tab character");
    if (/^(---|\.\.\.)/.test(line)) throw unsupported(n, "document markers are not supported");
    const indent = line.length - line.trimStart().length;
    out.push({ n, indent, text: line.trim() });
  });
  return out;
}

function splitKey(text, n) {
  const m = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(text);
  if (!m) throw unsupported(n, `expected 'key: value', got '${text}'`);
  return { key: m[1], rest: m[2] };
}

export function parseYamlSubset(text) {
  const lines = tokenize(text);
  let pos = 0;

  function parseValue(indent) {
    if (pos >= lines.length || lines[pos].indent < indent) return null;
    return lines[pos].text.startsWith("- ") || lines[pos].text === "-"
      ? parseSequence(lines[pos].indent)
      : parseMapping(lines[pos].indent);
  }

  function parseMapping(indent, first) {
    const obj = {};
    const entry = (tok, text) => {
      const { key, rest } = splitKey(text, tok.n);
      if (Object.hasOwn(obj, key)) throw unsupported(tok.n, `duplicate key '${key}'`);
      if (rest !== undefined && rest !== "") {
        obj[key] = scalar(rest, tok.n);
        return;
      }
      const next = lines[pos];
      obj[key] = next && next.indent > tok.indent ? parseValue(next.indent) : null;
    };
    if (first) entry(first.tok, first.text);
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith("- ")) {
      const tok = lines[pos++];
      entry(tok, tok.text);
    }
    if (pos < lines.length && lines[pos].indent > indent) {
      throw unsupported(lines[pos].n, "unexpected indentation");
    }
    return obj;
  }

  function parseSequence(indent) {
    const arr = [];
    while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith("-")) {
      const tok = lines[pos++];
      const body = tok.text === "-" ? "" : tok.text.slice(2);
      if (body === "") {
        arr.push(parseValue(indent + 1));
      } else if (/^[A-Za-z0-9_.-]+:(\s|$)/.test(body)) {
        // `- key: v` opens a mapping whose further keys sit at indent + 2.
        arr.push(parseMapping(indent + 2, { tok, text: body }));
      } else {
        arr.push(scalar(body, tok.n));
      }
    }
    return arr;
  }

  if (lines.length === 0) throw new Error("pos-supported.yaml is empty");
  const root = parseValue(lines[0].indent);
  if (pos < lines.length) throw unsupported(lines[pos].n, "unexpected content");
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("pos-supported.yaml: top level must be a mapping");
  }
  return root;
}
