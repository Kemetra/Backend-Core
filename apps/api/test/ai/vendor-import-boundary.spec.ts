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

function walk(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => entry !== "node_modules" && entry !== "dist")
    .flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return full.endsWith(".ts") && !full.endsWith(".d.ts") ? [full] : [];
    });
}

function srcDirsIn(group: string): string[] {
  const groupDir = join(REPO_ROOT, group);
  return readdirSync(groupDir)
    .map((name) => join(groupDir, name, "src"))
    .filter((src) => existsSync(src) && statSync(src).isDirectory());
}

const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s+["']([^"']+)["']/g, // import / import type / export ... from
  /\bimport\s+["']([^"']+)["']/g, // side-effect import
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import()
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require()
];

function importedSpecifiers(source: string): string[] {
  return SPECIFIER_PATTERNS.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1] as string),
  );
}

function isVendorSpecifier(specifier: string): boolean {
  const bare = specifier.replace(/^node:/, "");
  const exact = denylist.packages.some((pkg) => bare === pkg || bare.startsWith(`${pkg}/`));
  return exact || denylist.scopes.some((scope) => bare.startsWith(scope));
}

/** True when `file` lives under apps/<app>/src/ai/adapters/<vendor>/... */
function isVendorAdapterFile(file: string): boolean {
  const posixPath = relative(REPO_ROOT, file).split(sep).join("/");
  const vendor = VENDOR_ADAPTER_PATH.exec(posixPath)?.[1];
  return vendor !== undefined && !NON_VENDOR_ADAPTER_DIRS.has(vendor);
}

function violationsInFile(file: string): string[] {
  if (isVendorAdapterFile(file)) return [];
  return importedSpecifiers(readFileSync(file, "utf8"))
    .filter(isVendorSpecifier)
    .map((specifier) => `${relative(REPO_ROOT, file)} imports ${specifier}`);
}

function findVendorImportViolations(): string[] {
  return ["apps", "packages"]
    .flatMap(srcDirsIn)
    .flatMap((root) => walk(root))
    .flatMap(violationsInFile);
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

/** Removes `//` and block comments so prose that mentions a primitive is not a hit. */
function stripComments(source: string): string {
  let out = "";
  let rest = source;
  for (;;) {
    const open = rest.indexOf("/*");
    if (open === -1) break;
    const close = rest.indexOf("*/", open + 2);
    out += rest.slice(0, open);
    rest = close === -1 ? "" : rest.slice(close + 2);
  }
  return (out + rest).replace(/\/\/.*$/gm, "");
}

function findNetworkUse(source: string): string[] {
  const modules = importedSpecifiers(source)
    .map((spec) => spec.replace(/^node:/, ""))
    .filter((spec) => NETWORK_MODULES.has(spec));
  const code = stripComments(source);
  const tokens = NETWORK_TOKENS.filter((token) => token.test(code)).map((token) => token.source);
  return [...modules, ...tokens];
}

describe("vendor SDK import boundary", () => {
  it("no vendor model SDK is imported anywhere outside apps/*/src/ai/adapters/<vendor>/**", () => {
    expect(findVendorImportViolations()).toEqual([]);
  });

  it("scanner self-test: catches static, type, side-effect, re-export, dynamic and require imports", () => {
    const fixture = [
      'import Anthropic from "@anthropic-ai/sdk";',
      'import type { Foo } from "openai/resources";',
      'import "@langchain/core";',
      'export * from "litellm";',
      'const a = await import("@ai-sdk/openai");',
      'const b = require("@aws-sdk/client-bedrock-runtime");',
      'import { ok } from "./fine";',
      'import { z } from "zod";',
    ].join("\n");
    expect(importedSpecifiers(fixture).filter(isVendorSpecifier).sort()).toEqual(
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

  it.each([
    [["apps", "api", "src", "ai", "adapters", "anthropic", "client.ts"], true],
    [["apps", "api", "src", "ai", "adapters", "fake", "x.ts"], false],
    [["apps", "api", "src", "ai", "adapters", "recorded", "x.ts"], false],
    [["apps", "api", "src", "ai", "adapters", "disabled", "x.ts"], false],
    [["apps", "api", "src", "ai", "adapters", "anthropic.ts"], false],
    [["apps", "api", "src", "ai", "gateway", "x.ts"], false],
    [["apps", "api", "src", "other", "adapters", "anthropic", "x.ts"], false],
  ])("the adapter-directory exemption (%j) is %s", (segments, exempt) => {
    expect(isVendorAdapterFile(join(REPO_ROOT, ...segments))).toBe(exempt);
  });
});

describe("no network egress under apps/api/src/ai", () => {
  it("uses no network module or primitive", () => {
    const files = walk(join(REPO_ROOT, "apps", "api", "src", "ai")).filter(
      (file) => !isVendorAdapterFile(file),
    );
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) =>
      findNetworkUse(readFileSync(file, "utf8")).map((hit) => `${relative(REPO_ROOT, file)}: ${hit}`),
    );
    expect(violations).toEqual([]);
  });

  it.each([
    ['import https from "node:https";', 1],
    ['const r = await fetch("http://x");', 1],
    ['import net from "net"; new WebSocket("ws://x");', 2],
    ["// never call fetch( here\n/* XMLHttpRequest */ const a = 1;", 0],
  ])("scanner self-test: %j yields %s hit(s)", (source, hits) => {
    expect(findNetworkUse(source)).toHaveLength(hits);
  });
});
