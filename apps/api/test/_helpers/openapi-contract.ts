/**
 * A reader over one OpenAPI contract of record, for structural contract specs
 * (RT-365). Loads every contract through the production loader, resolves
 * local `#/components/parameters/*` references, compiles component schemas
 * with AJV (formats on, non-strict) and lists the operationIds the OTHER
 * contracts declare, so a spec can assert it collides with none.
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import Ajv from "ajv";
import addFormats from "ajv-formats";

import { loadOpenApiContracts } from "../../src/openapi/loader";

export type JsonObject = Record<string, unknown>;
export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

const PARAMETER_REF = "#/components/parameters/";

export interface ContractReader {
  readonly document: JsonObject;
  /** The operation object at `method path`; throws when absent. */
  operation(method: HttpMethod, path: string): JsonObject;
  /** The operation's parameters, with `$ref`s resolved. */
  parameters(method: HttpMethod, path: string): JsonObject[];
  /** `components.schemas[name]`; throws when absent. */
  schema(name: string): JsonObject;
  /** AJV verdict of `value` against `components.schemas[name]`. */
  accepts(name: string, value: unknown): boolean;
  /** operationIds declared by every other contract. */
  readonly foreignOperationIds: ReadonlySet<string>;
  /** Another contract's document, by loader id. */
  sibling(id: string): JsonObject;
}

interface LoadedContract {
  readonly id: string;
  readonly document: unknown;
}

/** `value[k1][k2]…`, or undefined as soon as a step is not an object. */
function dig(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>(
    (current, key) => (current !== null && typeof current === "object" ? (current as JsonObject)[key] : undefined),
    value,
  );
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} not declared`);
  return value;
}

function documentOf(all: readonly LoadedContract[], id: string): JsonObject {
  const found = all.find((c) => c.id === id);
  if (!found) throw new Error(`${id} not found in packages/contracts/openapi/`);
  return found.document as JsonObject;
}

function operationIdsOf(document: unknown): unknown[] {
  const paths = Object.values((dig(document, "paths") ?? {}) as Record<string, JsonObject>);
  return paths.flatMap((item) => Object.values(item).map((o) => dig(o, "operationId")));
}

function foreignIds(all: readonly LoadedContract[], id: string): ReadonlySet<string> {
  const ids = all.filter((c) => c.id !== id).flatMap((c) => operationIdsOf(c.document));
  return new Set(ids.filter((v): v is string => typeof v === "string"));
}

function compile(document: JsonObject, id: string): (name: string, value: unknown) => boolean {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(document, id);
  return (name, value) => {
    const validate = required(ajv.getSchema(`${id}#/components/schemas/${name}`), `ajv schema ${name} in ${id}`);
    return validate(value) === true;
  };
}

export function readContract(id: string): ContractReader {
  const all = loadOpenApiContracts() as readonly LoadedContract[];
  const document = documentOf(all, id);
  const component = (section: string, name: string): JsonObject =>
    required(dig(document, "components", section, name), `components.${section}.${name} in ${id}`) as JsonObject;
  const operation = (method: HttpMethod, path: string): JsonObject =>
    required(dig(document, "paths", path, method), `${method.toUpperCase()} ${path} in ${id}`) as JsonObject;
  const resolve = (p: JsonObject): JsonObject => {
    const ref = p["$ref"];
    return typeof ref === "string" ? component("parameters", ref.replace(PARAMETER_REF, "")) : p;
  };

  return {
    document,
    operation,
    parameters: (method, path) => ((operation(method, path)["parameters"] ?? []) as JsonObject[]).map(resolve),
    schema: (name) => component("schemas", name),
    accepts: compile(document, id),
    foreignOperationIds: foreignIds(all, id),
    sibling: (siblingId) => documentOf(all, siblingId),
  };
}
