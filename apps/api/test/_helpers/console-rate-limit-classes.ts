/**
 * RT-805 — the console rate-limit classes of the cookieAuth operations, one
 * YAML file per contract under `test/console-rate-limit/classes/`, mirroring
 * `packages/contracts/openapi/` (`audit.openapi.yaml` → `audit.rate-limit.yaml`).
 * Whether an operation is runtime or contract-only comes from its
 * `x-runtime-status`, so shipping a runtime touches no class file.
 */
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import { load as parseYaml } from "js-yaml";

import { contractRouteKey, yamlFiles, type ContractRoute } from "./openapi-routes";

export const CLASSES_DIR = resolve(__dirname, "..", "console-rate-limit", "classes");

export type RateLimitClassFile = {
  /** Relative to {@link CLASSES_DIR}, with `/` separators. */
  path: string;
  classes: Record<string, string>;
};

export type RatchetInput = {
  cookieOps: ContractRoute[];
  classFiles: RateLimitClassFile[];
  validClasses: ReadonlySet<string>;
  /** The class the runtime resolves for the operation's route, or undefined when it has no route. */
  resolveRuntime(op: ContractRoute): string | undefined;
};

export function classFilePathFor(contractFile: string): string {
  return contractFile.replace(/(\.openapi)?\.ya?ml$/i, ".rate-limit.yaml");
}

export function loadClassFiles(dir: string = CLASSES_DIR): RateLimitClassFile[] {
  return yamlFiles(dir).map((file) => ({
    path: relative(dir, file).split(sep).join("/"),
    classes: (parseYaml(readFileSync(file, "utf8")) ?? {}) as Record<string, string>,
  }));
}

/** Unknown classes, duplicates, and entries that name no cookieAuth operation of their contract. */
function classFileViolations({ cookieOps, classFiles, validClasses }: RatchetInput): string[] {
  const owners = new Set(cookieOps.map((op) => `${classFilePathFor(op.file)}#${op.operation.operationId}`));
  const firstSeen = new Map<string, string>();
  return classFiles.flatMap(({ path, classes }) =>
    Object.entries(classes).flatMap(([operationId, cls]) => {
      const out: string[] = [];
      if (!validClasses.has(cls)) out.push(`unknown class "${cls}": ${operationId} in classes/${path}`);
      const earlier = firstSeen.get(operationId);
      if (earlier) out.push(`duplicate entry: ${operationId} in classes/${earlier} and classes/${path}`);
      else firstSeen.set(operationId, path);
      if (!owners.has(`${path}#${operationId}`)) {
        out.push(`stale entry: ${operationId} in classes/${path} is not a cookieAuth operation of that contract`);
      }
      return out;
    }),
  );
}

function operationViolation(op: ContractRoute, declared: string | undefined, input: RatchetInput): string | undefined {
  const operationId = op.operation.operationId!;
  const classFile = classFilePathFor(op.file);
  if (declared === undefined) return `unclassified cookieAuth operation: ${operationId} (add it to classes/${classFile})`;
  const resolved = input.resolveRuntime(op);
  if (op.operation["x-runtime-status"] === "contract-only") {
    return resolved === undefined
      ? undefined
      : `contract-only but routed: ${operationId} (drop x-runtime-status; its class stays in classes/${classFile})`;
  }
  if (resolved === undefined) return `no controller route: ${operationId}: ${contractRouteKey(op)}`;
  return resolved === declared
    ? undefined
    : `class mismatch: ${operationId} is declared ${declared} but the runtime resolves ${resolved}`;
}

/**
 * The ratchet: every cookieAuth operation (runtime or contract-only) is
 * classified in its own contract's class file; a runtime one resolves to that
 * class; a contract-only one has no route yet; no entry is stale, duplicated
 * or of an unknown class.
 */
export function ratchetViolations(input: RatchetInput): string[] {
  const byFile = new Map(input.classFiles.map((f) => [f.path, f.classes]));
  return [
    ...classFileViolations(input),
    ...input.cookieOps.flatMap((op) => {
      const declared = byFile.get(classFilePathFor(op.file))?.[op.operation.operationId!];
      return operationViolation(op, declared, input) ?? [];
    }),
  ];
}
