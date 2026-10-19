/**
 * RT-655 — CI import boundary + no-network evidence.
 *
 * 1. Vendor model SDKs / gateway frameworks may be imported ONLY under
 *    apps/<app>/src/ai/adapters/<vendor>/** (vendor = any directory except
 *    fake, recorded, disabled). The same list drives the ESLint
 *    `no-restricted-imports` rule in .eslintrc.cjs (which only scans
 *    apps/{api,worker}/src); this test also covers packages/*\/src and dynamic
 *    import() / require().
 * 2. Nothing under apps/api/src/ai/** (outside a vendor adapter dir) may use a
 *    network primitive. RT-655 ships no egress.
 *
 * Negative self-tests prove the scanners can actually fail.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const denylist = require("../../../../tools/ai-vendor-sdk-denylist.json") as {
  packages: string[];
  scopes: string[];
};

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const NON_VENDOR_ADAPTER_DIRS = new Set(["fake", "recorded", "disabled"]);
const VENDOR_ADAPTER_PATH = /^apps\/[^/]+\/src\/ai\/adapters\/([^/]+)\/.+/;

/** A source file under scan. The scanners take this, not loose strings. */
interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => entry !== "node_modules" && entry !== "dist")
    .flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith(".ts") && !full.endsWith(".d.ts") ? [full] : [];
    });
}

function sourceRoots(): string[] {
  return ["apps", "packages"].flatMap((group) =>
    readdirSync(join(REPO_ROOT, group))
      .map((name) => join(REPO_ROOT, group, name, "src"))
      .filter((src) => existsSync(src) && statSync(src).isDirectory()),
  );
}

function readSources(paths: readonly string[]): SourceFile[] {
  return paths.map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s+["']([^"']+)["']/g, // import / import type / export ... from
  /\bimport\s+["']([^"']+)["']/g, // side-effect import
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import()
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require()
];

function importedSpecifiers(file: SourceFile): string[] {
  return SPECIFIER_PATTERNS.flatMap((pattern) =>
    [...file.text.matchAll(pattern)].map((match) => match[1] as string),
  );
}

function vendorSpecifiers(specifiers: readonly string[]): string[] {
  const isVendor = (specifier: string): boolean => {
    const bare = specifier.replace(/^node:/, "");
    const exact = denylist.packages.some((pkg) => bare === pkg || bare.startsWith(`${pkg}/`));
    return exact || denylist.scopes.some((scope) => bare.startsWith(scope));
  };
  return specifiers.filter(isVendor);
}

/** True when the file lives under apps/<app>/src/ai/adapters/<vendor>/... */
function isVendorAdapterFile(file: SourceFile): boolean {
  const posixPath = relative(REPO_ROOT, file.path).split(sep).join("/");
  const vendor = VENDOR_ADAPTER_PATH.exec(posixPath)?.[1];
  return vendor !== undefined && !NON_VENDOR_ADAPTER_DIRS.has(vendor);
}

function violationsIn(file: SourceFile): string[] {
  if (isVendorAdapterFile(file)) return [];
  return vendorSpecifiers(importedSpecifiers(file)).map(
    (specifier) => `${relative(REPO_ROOT, file.path)} imports ${specifier}`,
  );
}

const NETWORK_MODULES = new Set([
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "dns",
  "undici",
  "axios",
  "node-fetch",
  "got",
  "ws",
]);
const NETWORK_TOKENS: readonly RegExp[] = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bnew\s+WebSocket\b/,
  /\bEventSource\b/,
];

/** The file's code with `//` and block comments removed (prose may name a primitive). */
function codeOf(file: SourceFile): string {
  let out = "";
  let rest = file.text;
  for (;;) {
    const open = rest.indexOf("/*");
    if (open === -1) break;
    const close = rest.indexOf("*/", open + 2);
    out += rest.slice(0, open);
    rest = close === -1 ? "" : rest.slice(close + 2);
  }
  return (out + rest).replace(/\/\/.*$/gm, "");
}

function findNetworkUse(file: SourceFile): string[] {
  const modules = importedSpecifiers(file)
    .map((spec) => spec.replace(/^node:/, ""))
    .filter((spec) => NETWORK_MODULES.has(spec));
  const code = codeOf(file);
  const tokens = NETWORK_TOKENS.filter((token) => token.test(code)).map((token) => token.source);
  return [...modules, ...tokens];
}

const FIXTURE_IMPORTS: SourceFile = {
  path: "fixture.ts",
  text: [
    'import Anthropic from "@anthropic-ai/sdk";',
    'import type { Foo } from "openai/resources";',
    'import "@langchain/core";',
    'export * from "litellm";',
    'const a = await import("@ai-sdk/openai");',
    'const b = require("@aws-sdk/client-bedrock-runtime");',
    'import { ok } from "./fine";',
    'import { z } from "zod";',
  ].join("\n"),
};

describe("vendor SDK import boundary", () => {
  it("no vendor model SDK is imported anywhere outside apps/*/src/ai/adapters/<vendor>/**", () => {
    const files = readSources(sourceRoots().flatMap((root) => walk(root)));
    expect(files.flatMap(violationsIn)).toEqual([]);
  });

  it("scanner self-test: catches static, type, side-effect, re-export, dynamic and require imports", () => {
    expect(vendorSpecifiers(importedSpecifiers(FIXTURE_IMPORTS)).sort()).toEqual(
      [
        "@ai-sdk/openai",
        "@anthropic-ai/sdk",
        "@aws-sdk/client-bedrock-runtime",
        "@langchain/core",
        "litellm",
        "openai/resources",
      ].sort(),
    );
  });

  const adapter = (...segments: string[]): SourceFile => ({ path: join(REPO_ROOT, ...segments), text: "" });
  const adaptersDir = ["apps", "api", "src", "ai", "adapters"];

  it.each([
    { file: adapter(...adaptersDir, "anthropic", "client.ts"), exempt: true },
    { file: adapter(...adaptersDir, "fake", "x.ts"), exempt: false },
    { file: adapter(...adaptersDir, "recorded", "x.ts"), exempt: false },
    { file: adapter(...adaptersDir, "disabled", "x.ts"), exempt: false },
    { file: adapter(...adaptersDir, "anthropic.ts"), exempt: false },
    { file: adapter("apps", "api", "src", "ai", "gateway", "x.ts"), exempt: false },
    { file: adapter("apps", "api", "src", "other", "adapters", "anthropic", "x.ts"), exempt: false },
  ])("the adapter-directory exemption for $file.path is $exempt", ({ file, exempt }) => {
    expect(isVendorAdapterFile(file)).toBe(exempt);
  });
});

describe("no network egress under apps/api/src/ai", () => {
  it("uses no network module or primitive", () => {
    const files = readSources(walk(join(REPO_ROOT, "apps", "api", "src", "ai"))).filter(
      (file) => !isVendorAdapterFile(file),
    );
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) =>
      findNetworkUse(file).map((hit) => `${relative(REPO_ROOT, file.path)}: ${hit}`),
    );
    expect(violations).toEqual([]);
  });

  it.each([
    { text: 'import https from "node:https";', hits: 1 },
    { text: 'const r = await fetch("http://x");', hits: 1 },
    { text: 'import net from "net"; new WebSocket("ws://x");', hits: 2 },
    { text: "// never call fetch( here\n/* XMLHttpRequest */ const a = 1;", hits: 0 },
  ])("scanner self-test: $text yields $hits hit(s)", ({ text, hits }) => {
    expect(findNetworkUse({ path: "fixture.ts", text })).toHaveLength(hits);
  });
});
