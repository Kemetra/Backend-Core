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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const denylist = require("../../../../tools/ai-vendor-sdk-denylist.json") as {
  packages: string[];
  scopes: string[];
};

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const NON_VENDOR_ADAPTER_DIRS = new Set(["fake", "recorded", "disabled"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ["apps", "packages"]) {
    const groupDir = join(REPO_ROOT, group);
    for (const name of readdirSync(groupDir)) {
      const src = join(groupDir, name, "src");
      try {
        if (statSync(src).isDirectory()) roots.push(src);
      } catch {
        // package without a src directory
      }
    }
  }
  return roots;
}

const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s+["']([^"']+)["']/g, // import / import type / export ... from
  /\bimport\s+["']([^"']+)["']/g, // side-effect import
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import()
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require()
];

function importedSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.push(match[1] as string);
  }
  return found;
}

function isVendorSpecifier(specifier: string): boolean {
  const bare = specifier.replace(/^node:/, "");
  if (denylist.packages.some((pkg) => bare === pkg || bare.startsWith(`${pkg}/`))) return true;
  return denylist.scopes.some((scope) => bare.startsWith(scope));
}

/** True when `file` lives under apps/<app>/src/ai/adapters/<vendor>/... */
function isVendorAdapterFile(file: string): boolean {
  const parts = relative(REPO_ROOT, file).split(sep);
  const at = parts.indexOf("adapters");
  if (at < 3 || parts[at - 1] !== "ai" || parts[at - 2] !== "src") return false;
  const vendor = parts[at + 1];
  return vendor !== undefined && parts.length > at + 2 && !NON_VENDOR_ADAPTER_DIRS.has(vendor);
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

function findNetworkUse(source: string): string[] {
  const hits = importedSpecifiers(source)
    .map((spec) => spec.replace(/^node:/, ""))
    .filter((spec) => NETWORK_MODULES.has(spec));
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const token of NETWORK_TOKENS) if (token.test(stripped)) hits.push(token.source);
  return hits;
}

describe("vendor SDK import boundary", () => {
  it("no vendor model SDK is imported anywhere outside apps/*/src/ai/adapters/<vendor>/**", () => {
    const violations: string[] = [];
    for (const root of sourceRoots()) {
      for (const file of walk(root)) {
        if (isVendorAdapterFile(file)) continue;
        for (const specifier of importedSpecifiers(readFileSync(file, "utf8"))) {
          if (isVendorSpecifier(specifier)) {
            violations.push(`${relative(REPO_ROOT, file)} imports ${specifier}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
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

  it("the adapter-directory exemption only covers real vendor dirs under apps/<app>/src/ai", () => {
    const base = ["apps", "api", "src", "ai", "adapters"];
    expect(isVendorAdapterFile(join(REPO_ROOT, ...base, "anthropic", "client.ts"))).toBe(true);
    expect(isVendorAdapterFile(join(REPO_ROOT, ...base, "fake", "x.ts"))).toBe(false);
    expect(isVendorAdapterFile(join(REPO_ROOT, ...base, "recorded", "x.ts"))).toBe(false);
    expect(isVendorAdapterFile(join(REPO_ROOT, ...base, "disabled", "x.ts"))).toBe(false);
    expect(isVendorAdapterFile(join(REPO_ROOT, ...base, "anthropic.ts"))).toBe(false);
    expect(isVendorAdapterFile(join(REPO_ROOT, "apps", "api", "src", "ai", "gateway", "x.ts"))).toBe(false);
    expect(
      isVendorAdapterFile(join(REPO_ROOT, "apps", "api", "src", "other", "adapters", "anthropic", "x.ts")),
    ).toBe(false);
  });
});

describe("no network egress under apps/api/src/ai", () => {
  it("uses no network module or primitive", () => {
    const aiRoot = join(REPO_ROOT, "apps", "api", "src", "ai");
    const files = walk(aiRoot).filter((file) => !isVendorAdapterFile(file));
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      for (const hit of findNetworkUse(readFileSync(file, "utf8"))) {
        violations.push(`${relative(REPO_ROOT, file)}: ${hit}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("scanner self-test: catches network modules and primitives, ignores comments", () => {
    expect(findNetworkUse('import https from "node:https";')).toEqual(["https"]);
    expect(findNetworkUse('const r = await fetch("http://x");')).toHaveLength(1);
    expect(findNetworkUse('import net from "net"; new WebSocket("ws://x");')).toHaveLength(2);
    expect(findNetworkUse("// never call fetch( here\n/* XMLHttpRequest */ const a = 1;")).toEqual([]);
  });
});
