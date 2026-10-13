/**
 * OpenAPI contract loader.
 *
 * At startup, walks `packages/contracts/openapi/`, parses every `*.yaml`
 * file, and returns the parsed documents keyed by filename stem (e.g.,
 * `auth.openapi.yaml` → `auth.openapi`). Fails loudly on any parse error
 * because the contracts are the source of truth for every API surface
 * (Constitution IV).
 *
 * The contracts are returned as `unknown` here — the future contract-
 * conformance test (T300, Phase 10) is what enforces shape. This loader is
 * intentionally schema-agnostic.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";

import { compareCodeUnits } from "../common/compare-code-units";

export interface LoadedContract {
  /** Filename stem, e.g. "auth.openapi". */
  id: string;
  /** Absolute path on disk. */
  path: string;
  /** Parsed YAML document (untyped — the OpenAPI shape is enforced by tests). */
  document: unknown;
}

export interface LoadOpenApiOptions {
  /**
   * Override the contracts directory. Defaults to
   * `packages/contracts/openapi` resolved relative to the workspace root.
   */
  dir?: string;
}

/**
 * Resolve the default contracts directory. The repo layout puts
 * `packages/contracts/openapi/` at a known location relative to this file:
 *
 *   apps/api/dist/openapi/loader.js  →  ../../../packages/contracts/openapi
 *   apps/api/src/openapi/loader.ts   →  ../../../packages/contracts/openapi
 */
function defaultContractsDir(): string {
  return resolve(__dirname, "..", "..", "..", "..", "packages", "contracts", "openapi");
}

export function loadOpenApiContracts(
  opts: LoadOpenApiOptions = {},
): LoadedContract[] {
  const dir = opts.dir ?? defaultContractsDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `loadOpenApiContracts: cannot read directory ${dir}: ${message}`,
    );
  }
  const yamls = entries.filter(
    (name) => name.endsWith(".yaml") || name.endsWith(".yml"),
  );
  if (yamls.length === 0) {
    throw new Error(`loadOpenApiContracts: no YAML files found in ${dir}`);
  }
  yamls.sort(compareCodeUnits);
  return yamls.map((name) => {
    const path = join(dir, name);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `loadOpenApiContracts: cannot read ${path}: ${message}`,
      );
    }
    let document: unknown;
    try {
      document = parseYaml(raw);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `loadOpenApiContracts: invalid YAML in ${path}: ${message}`,
      );
    }
    if (document === null || document === undefined) {
      throw new Error(
        `loadOpenApiContracts: ${path} parsed to ${String(document)} — empty or whitespace-only YAML`,
      );
    }
    const id = name.replace(/\.(ya?ml)$/i, "");
    return { id, path, document };
  });
}
