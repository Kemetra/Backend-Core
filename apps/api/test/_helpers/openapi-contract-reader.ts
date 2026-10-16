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

/** A contract's loader id, e.g. `devices.openapi`. */
export type ContractId = `${string}.openapi`;
/** An OpenAPI path template, e.g. `/api/v1/devices/{deviceId}`. */
export type ApiPath = `/${string}`;
/** A `components.schemas` key (PascalCase by repo convention), e.g. `DeviceSummary`. */
export type SchemaName = Capitalize<string>;

interface LoadedContract {
  readonly id: string;
  readonly document: unknown;
}

/** `value` followed along `keys`, or undefined as soon as a step is not an object. */
function dig(value: unknown, keys: readonly string[]): unknown {
  return keys.reduce<unknown>(
    (current, key) => (current !== null && typeof current === "object" ? (current as JsonObject)[key] : undefined),
    value,
  );
}

function operationIdsOf(contract: LoadedContract): unknown[] {
  const paths = Object.values((dig(contract.document, ["paths"]) ?? {}) as Record<string, JsonObject>);
  return paths.flatMap((item) => Object.values(item).map((o) => dig(o, ["operationId"])));
}

export class ContractReader {
  readonly document: JsonObject;
  /** operationIds declared by every other contract. */
  readonly foreignOperationIds: ReadonlySet<string>;
  private readonly ajv = new Ajv({ strict: false, allErrors: true });

  private constructor(
    private readonly id: ContractId,
    private readonly all: readonly LoadedContract[],
  ) {
    this.document = this.documentOf(id);
    const foreign = all.filter((c) => c.id !== id).flatMap(operationIdsOf);
    this.foreignOperationIds = new Set(foreign.filter((v): v is string => typeof v === "string"));
    addFormats(this.ajv);
    this.ajv.addSchema(this.document, id);
  }

  static read(id: ContractId): ContractReader {
    return new ContractReader(id, loadOpenApiContracts() as readonly LoadedContract[]);
  }

  /** The operation object at `method path`; throws when absent. */
  operation(method: HttpMethod, path: ApiPath): JsonObject {
    return this.at(["paths", path, method]);
  }

  /** The operation's parameters, with `$ref`s resolved. */
  parameters(method: HttpMethod, path: ApiPath): JsonObject[] {
    const declared = (this.operation(method, path)["parameters"] ?? []) as JsonObject[];
    return declared.map((p) =>
      typeof p["$ref"] === "string" ? this.at(["components", "parameters", p["$ref"].replace(PARAMETER_REF, "")]) : p,
    );
  }

  /** `components.schemas[name]`; throws when absent. */
  schema(name: SchemaName): JsonObject {
    return this.at(["components", "schemas", name]);
  }

  /** AJV verdict of `value` against `components.schemas[name]`. */
  accepts(name: SchemaName, value: unknown): boolean {
    const validate = this.ajv.getSchema(`${this.id}#/components/schemas/${name}`);
    if (!validate) throw new Error(`ajv cannot resolve ${name} in ${this.id}`);
    return validate(value) === true;
  }

  /** Another contract's document, by loader id. */
  sibling(id: ContractId): JsonObject {
    return this.documentOf(id);
  }

  private at(keys: readonly string[]): JsonObject {
    const found = dig(this.document, keys);
    if (found === undefined) throw new Error(`${keys.join(".")} not declared in ${this.id}`);
    return found as JsonObject;
  }

  private documentOf(id: ContractId): JsonObject {
    const found = this.all.find((c) => c.id === id);
    if (!found) throw new Error(`${id} not found in packages/contracts/openapi/`);
    return found.document as JsonObject;
  }
}

/** Shorthand for `ContractReader.read`. */
export function readContract(id: ContractId): ContractReader {
  return ContractReader.read(id);
}
