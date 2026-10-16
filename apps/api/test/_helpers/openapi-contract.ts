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

function child(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as JsonObject)[key] : undefined;
}

function operationIdsOf(document: JsonObject): string[] {
  const paths = (child(document, "paths") ?? {}) as Record<string, JsonObject>;
  return Object.values(paths).flatMap((item) =>
    Object.values(item)
      .map((o) => child(o, "operationId"))
      .filter((v): v is string => typeof v === "string"),
  );
}

export function readContract(id: string): ContractReader {
  const all = loadOpenApiContracts();
  const own = all.find((c) => c.id === id);
  if (!own) throw new Error(`${id} not found in packages/contracts/openapi/`);
  const document = own.document as JsonObject;
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(document, id);

  const operation = (method: HttpMethod, path: string): JsonObject => {
    const found = child(child(child(document, "paths"), path), method);
    if (found === undefined) throw new Error(`${method.toUpperCase()} ${path} not declared in ${id}`);
    return found as JsonObject;
  };
  const named = (section: string, name: string): JsonObject => {
    const found = child(child(child(document, "components"), section), name);
    if (found === undefined) throw new Error(`components.${section}.${name} not declared in ${id}`);
    return found as JsonObject;
  };

  return {
    document,
    operation,
    parameters: (method, path) =>
      ((operation(method, path)["parameters"] ?? []) as JsonObject[]).map((p) => {
        const ref = p["$ref"];
        return typeof ref === "string" && ref.startsWith(PARAMETER_REF)
          ? named("parameters", ref.slice(PARAMETER_REF.length))
          : p;
      }),
    schema: (name) => named("schemas", name),
    accepts: (name, value) => {
      const validate = ajv.getSchema(`${id}#/components/schemas/${name}`);
      if (!validate) throw new Error(`ajv cannot resolve ${name} in ${id}`);
      return validate(value) === true;
    },
    foreignOperationIds: new Set(all.filter((c) => c.id !== id).flatMap((c) => operationIdsOf(c.document as JsonObject))),
    sibling: (siblingId) => {
      const found = all.find((c) => c.id === siblingId);
      if (!found) throw new Error(`${siblingId} not found in packages/contracts/openapi/`);
      return found.document as JsonObject;
    },
  };
}
