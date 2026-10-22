/**
 * RT-812 — load a registry assembled from one file per entry, so parallel PRs
 * add different files instead of editing the same list.
 *
 * A fragment directory holds `<slug><suffix>.ts` sources; tsc compiles each to
 * `<slug><suffix>.js` beside its `.js.map`, `.d.ts` and `.d.ts.map`. The caller
 * passes its own file name: a `.ts` caller (ts-jest) loads the sources, a `.js`
 * caller (`dist`, the images) loads the compiled siblings, never both.
 *
 * Fails closed. A missing directory, a missing `baseline<suffix>` fragment or
 * any file it does not expect throws, so a registry the API checks at boot can
 * never come back empty or partial. Order is fixed: the baseline first, then
 * the other fragments by file name (readdir order differs between filesystems).
 *
 * After deleting a fragment, rebuild from a clean `dist`: tsc does not remove
 * the old `.js`, which would still load.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

export interface LoadedFragment {
  /** The slug: the file name without `<suffix>.<ext>`. */
  readonly name: string;
  /** The fragment module's exports, for the caller to validate. */
  readonly exports: unknown;
}

const BASELINE = "baseline";
const SLUG = "[a-z0-9][a-z0-9-]*";
/** What tsc writes beside a compiled fragment (declaration + source maps). */
const COMPILED_SIDECARS = [".js.map", ".d.ts", ".d.ts.map"];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Layout {
  /** `.ts` when loading sources, `.js` when loading compiled output. */
  readonly ext: string;
  /** Captures the slug of a loadable fragment file. */
  readonly fragment: RegExp;
  /** A tsc sidecar the directory may hold (compiled layout only). */
  readonly sidecar: RegExp | null;
}

function layoutFor(suffix: string, callerFile: string): Layout {
  if (!/^\.[a-z]+$/.test(suffix)) {
    throw new Error(`fragment suffix must be a lower-case ".word", got "${suffix}"`);
  }
  const fromSource = callerFile.endsWith(".ts") && !callerFile.endsWith(".d.ts");
  const ext = fromSource ? ".ts" : ".js";
  const sidecars = COMPILED_SIDECARS.map(escapeRegExp).join("|");
  return {
    ext,
    fragment: new RegExp(`^(${SLUG})${escapeRegExp(suffix + ext)}$`),
    sidecar: fromSource ? null : new RegExp(`^${SLUG}${escapeRegExp(suffix)}(${sidecars})$`),
  };
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`fragment directory ${dir} is missing; refusing an empty registry`);
    }
    throw err;
  }
}

/** The fragment slugs in `dir`; throws on any file the layout does not expect. */
function fragmentNames(dir: string, layout: Layout): string[] {
  const names: string[] = [];
  for (const file of listDir(dir)) {
    const slug = layout.fragment.exec(file)?.[1];
    if (slug) names.push(slug);
    else if (!layout.sidecar?.test(file)) throw new Error(`unexpected file ${file} in fragment directory ${dir}`);
  }
  return names;
}

export function loadFragmentDir(dir: string, suffix: string, callerFile: string): LoadedFragment[] {
  const layout = layoutFor(suffix, callerFile);
  const names = fragmentNames(dir, layout);
  if (!names.includes(BASELINE)) {
    throw new Error(`fragment directory ${dir} has no ${BASELINE}${suffix}${layout.ext}`);
  }
  const ordered = [BASELINE, ...names.filter((n) => n !== BASELINE).sort()];
  return ordered.map((name) => ({
    name,
    // A non-literal require is the point: the directory is the registry.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    exports: require(join(dir, `${name}${suffix}${layout.ext}`)) as unknown,
  }));
}
