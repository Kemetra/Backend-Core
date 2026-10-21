/**
 * RT-805 — CHANGELOG fragments: one file per change under `changelog.d/`,
 * assembled into a version section at release. Dependency-free so the CLI
 * (`assemble.cjs`) runs with plain `node` and the api Jest suite can require it.
 *
 * Fragment format:
 *   file name  `RT-<n>-<slug>.md` or `no-ticket-<slug>.md` (slug: a-z, 0-9, -)
 *   content    one `### <Section>` heading, then the entry, starting with `- `
 */
"use strict";

const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

/** Keep a Changelog sections, in the order a release renders them. */
const SECTIONS = Object.freeze(["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]);
const FRAGMENT_NAME = /^(?:RT-\d+|no-ticket)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const UNRELEASED_HEADING = "## [Unreleased]";
/** Files in changelog.d that are documentation, not fragments. */
const NON_FRAGMENTS = new Set(["README.md"]);

/** Windows checkouts (core.autocrlf) read as CRLF; everything here works on LF. */
function lf(text) {
  return text.replace(/\r\n/g, "\n");
}

function fail(name, problem) {
  throw new Error(`changelog.d/${name}: ${problem}`);
}

function trimBlankEdges(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end);
}

/** @returns {{ name: string, section: string, body: string }} */
function parseFragment(name, text) {
  if (!FRAGMENT_NAME.test(name)) {
    fail(name, "file name must be RT-<number>-<slug>.md or no-ticket-<slug>.md (slug: a-z, 0-9, -)");
  }
  const lines = trimBlankEdges(lf(text).split("\n"));
  const heading = /^### (\S+)$/.exec(lines[0] ?? "");
  if (!heading || !SECTIONS.includes(heading[1])) {
    fail(name, `first line must be a section heading, one of: ${SECTIONS.map((s) => `### ${s}`).join(", ")}`);
  }
  const bodyLines = trimBlankEdges(lines.slice(1));
  if (!(bodyLines[0] ?? "").startsWith("- ")) fail(name, "the entry must start with a `- ` bullet");
  if (bodyLines.some((line) => line.startsWith("### "))) fail(name, "a fragment holds exactly one section");
  return { name, section: heading[1], body: bodyLines.join("\n") };
}

/** By file name, numbers compared as numbers (RT-3 before RT-20). */
function compareFragments(a, b) {
  return a.name.localeCompare(b.name, "en", { numeric: true });
}

function readFragments(dir) {
  return readdirSync(dir)
    .filter((name) => !NON_FRAGMENTS.has(name))
    .map((name) => parseFragment(name, readFileSync(join(dir, name), "utf8")))
    .sort(compareFragments);
}

/** The `### Section` blocks for a set of fragments, each block ending with a blank line. */
function renderSections(fragments) {
  const sorted = [...fragments].sort(compareFragments);
  return SECTIONS.flatMap((section) => {
    const bodies = sorted.filter((f) => f.section === section).map((f) => f.body);
    return bodies.length === 0 ? [] : [`### ${section}`, ...bodies, ""];
  }).join("\n");
}

/** Splits `### Section` markdown into one entry per top-level `- ` bullet. */
function splitSections(markdown) {
  const entries = [];
  let section = null;
  let current = null;
  const flush = () => {
    if (current) entries.push({ section: current.section, body: trimBlankEdges(current.lines).join("\n") });
    current = null;
  };
  for (const line of lf(markdown).split("\n")) {
    const heading = /^### (\S+)$/.exec(line);
    if (heading) {
      flush();
      section = heading[1];
    } else if (line.startsWith("- ")) {
      flush();
      current = { section, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return entries;
}

function unreleasedBounds(changelog) {
  const start = changelog.indexOf(UNRELEASED_HEADING);
  if (start < 0) throw new Error(`CHANGELOG.md has no "${UNRELEASED_HEADING}" heading`);
  const bodyStart = start + UNRELEASED_HEADING.length + 1;
  const next = changelog.indexOf("\n## [", bodyStart - 1);
  return { bodyStart, end: next < 0 ? changelog.length : next + 1 };
}

/** The text between `## [Unreleased]` and the next version heading. */
function unreleasedBlock(text) {
  const changelog = lf(text);
  const { bodyStart, end } = unreleasedBounds(changelog);
  return changelog.slice(bodyStart, end);
}

/** The changelog with a `## [version] — date` section built from the fragments. */
function release(text, fragments, version, date) {
  const changelog = lf(text);
  if (fragments.length === 0) throw new Error("no fragments in changelog.d to release");
  const { end } = unreleasedBounds(changelog);
  const section = `## [${version}] — ${date}\n\n${renderSections(fragments)}\n`;
  return changelog.slice(0, end) + section + changelog.slice(end);
}

/** Everything a `[Unreleased]` block may hold once its entries are in fragments. */
const UNRELEASED_POINTER = [
  "Unreleased changes are one file each in [`changelog.d/`](changelog.d/README.md),",
  "assembled here at release by `node tools/changelog/assemble.cjs --release <version>`.",
].join("\n");

function fragmentName(text, section, taken) {
  const key = /^- (RT-\d+)\b/.exec(text)?.[1] ?? "no-ticket";
  const base = `${key}-${section.toLowerCase()}`;
  let name = `${base}.md`;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}.md`;
  taken.add(name);
  return name;
}

/** Lines of the block that are neither the pointer, a heading, an entry nor blank. */
function strayLines(block) {
  let inEntry = false;
  return block.replace(UNRELEASED_POINTER, "").split("\n").filter((line) => {
    if (/^### \S+$/.test(line)) inEntry = false;
    else if (line.startsWith("- ")) inEntry = true;
    return !inEntry && line.trim() !== "" && !line.startsWith("### ");
  });
}

/**
 * Moves entries written straight into `[Unreleased]` into fragment files
 * (`<RT-key|no-ticket>-<section>[-n].md`, avoiding `existingNames`) and
 * leaves only the pointer. Each file is re-parsed, so the result is valid.
 */
function migrateUnreleased(text, existingNames) {
  const changelog = lf(text);
  const { bodyStart, end } = unreleasedBounds(changelog);
  const block = changelog.slice(bodyStart, end);
  const stray = strayLines(block);
  if (stray.length > 0) throw new Error(`cannot migrate [Unreleased] text outside an entry: ${stray[0]}`);
  const entries = splitSections(block);
  const pointerBlock = `\n${UNRELEASED_POINTER}\n\n`;
  if (entries.length === 0 && block === pointerBlock) return { changelog, files: [] };
  const taken = new Set(existingNames);
  const files = entries.map(({ section, body }) => {
    if (!SECTIONS.includes(section)) throw new Error(`cannot migrate an entry outside a known section: ${body.split("\n")[0]}`);
    const name = fragmentName(body, section, taken);
    const text = `### ${section}\n${body}\n`;
    parseFragment(name, text);
    return { name, text };
  });
  return { changelog: changelog.slice(0, bodyStart) + pointerBlock + changelog.slice(end), files };
}

module.exports = {
  SECTIONS,
  UNRELEASED_POINTER,
  migrateUnreleased,
  parseFragment,
  readFragments,
  renderSections,
  splitSections,
  unreleasedBlock,
  release,
};
