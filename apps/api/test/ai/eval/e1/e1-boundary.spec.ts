/**
 * RT-648 — the harness introduces no provider SDK, no network primitive and no
 * write operation. Static scans of the eval tree (and, for writes, the AI
 * source), with negative self-tests so each scanner is seen to fail.
 *
 * S3's behavioural evidence is the route log checked in `e1-gates.spec.ts`;
 * this is its static companion.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const denylist = require("../../../../../../tools/ai-vendor-sdk-denylist.json") as {
  packages: string[];
  scopes: string[];
};

const EVAL_DIR = __dirname;
const AI_SRC = join(__dirname, "..", "..", "..", "..", "src", "ai");
const SELF = "e1-boundary.spec.ts";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
const NETWORK_IMPORT = /^(node:)?(http|https|http2|net|tls|dgram|dns|undici|axios|node-fetch)$/;
const NETWORK_GLOBAL = /\b(fetch|XMLHttpRequest|WebSocket)\s*\(/;
const WRITE_OPERATION = /\b(consoleRepairSaleSync|repairSaleSync)\b|\/repair\b/;

function specifiers(text: string): string[] {
  return [...text.matchAll(SPECIFIER)].map((match) => match[1] ?? "");
}

function isVendor(specifier: string): boolean {
  const root = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : (specifier.split("/")[0] ?? "");
  return denylist.packages.includes(root) || denylist.scopes.some((scope) => root.startsWith(scope));
}

function offences(text: string): { vendor: string[]; network: string[] } {
  const imports = specifiers(text);
  return {
    vendor: imports.filter(isVendor),
    network: [...imports.filter((s) => NETWORK_IMPORT.test(s)), ...(NETWORK_GLOBAL.test(text) ? ["global network call"] : [])],
  };
}

const evalFiles = walk(EVAL_DIR).filter((file) => !file.endsWith(SELF));
const rel = (file: string): string => relative(EVAL_DIR, file).split(sep).join("/");

describe("RT-648 harness boundary", () => {
  it("scans the eval tree (not an empty set)", () => {
    expect(evalFiles.length).toBeGreaterThanOrEqual(12);
  });

  it("imports no vendor model SDK and uses no network primitive", () => {
    const found = evalFiles.flatMap((file) => {
      const { vendor, network } = offences(readFileSync(file, "utf8"));
      return [...vendor, ...network].map((hit) => `${rel(file)}: ${hit}`);
    });
    expect(found).toEqual([]);
  });

  it("references no write operation outside the gate checker that names them", () => {
    const sources = [...evalFiles.filter((f) => !f.endsWith("e1-gates.spec.ts") && !f.endsWith("e1.gates.ts")), ...walk(AI_SRC)];
    const found = sources.filter((file) => WRITE_OPERATION.test(readFileSync(file, "utf8"))).map((file) => file);
    expect(found).toEqual([]);
  });

  it("the scanners can fail (negative self-tests)", () => {
    const [vendor] = denylist.packages;
    expect(offences(`import x from "${vendor}";`).vendor).toEqual([vendor]);
    expect(offences(`import { get } from "node:https";`).network).toEqual(["node:https"]);
    expect(offences(`await fetch("http://x");`).network).toEqual(["global network call"]);
    expect(WRITE_OPERATION.test(`await call("consoleRepairSaleSync");`)).toBe(true);
    expect(offences(`import { z } from "zod";`)).toEqual({ vendor: [], network: [] });
  });
});
