/**
 * Structural readers for the OpenAPI contract specs (`*.contract.spec.ts`).
 *
 * The contracts under `packages/contracts/openapi/` are loaded untyped by
 * `loadOpenApiContracts`; these are the minimal shapes a contract spec reads,
 * plus a reader that resolves `#/components/...` references and fails loudly
 * on anything a spec expects but the contract does not declare.
 */
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadOpenApiContracts, type LoadedContract } from "../../src/openapi/loader";

export interface ParameterObject {
  $ref?: string;
  in?: string;
  name?: string;
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

export interface ResponseObject {
  $ref?: string;
  description?: string;
  headers?: Record<string, { $ref?: string; schema?: unknown; description?: string }>;
}

export interface OperationObject {
  operationId?: string;
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: ParameterObject[];
  requestBody?: unknown;
  responses?: Record<string, ResponseObject>;
  "x-runtime-status"?: string;
  "x-runtime-note"?: string;
  "x-audit-action"?: string;
}

export type SchemaObject = Record<string, unknown> & {
  type?: unknown;
  required?: string[];
  properties?: Record<string, Record<string, unknown>>;
  additionalProperties?: unknown;
};

export interface OpenApiDocument {
  openapi?: string;
  info?: { version?: string; description?: string };
  security?: Array<Record<string, unknown>>;
  paths?: Record<string, Record<string, OperationObject>>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    parameters?: Record<string, ParameterObject>;
    responses?: Record<string, ResponseObject>;
    headers?: Record<string, { schema?: unknown; description?: string }>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
}

const SCHEMA_REF = "#/components/schemas/";
const PARAMETER_REF = "#/components/parameters/";

/** An OpenAPI path key, such as `/api/v1/sales/{saleRef}`. */
export type ApiPath = `/${string}`;

/** Reads one contract document; every lookup throws when the contract does not declare it. */
export interface ContractReader {
  readonly doc: OpenApiDocument;
  /** The GET operation at `path`. */
  get(path: ApiPath): OperationObject;
  /** The operation's parameters, `$ref`s resolved. */
  params(path: ApiPath): ParameterObject[];
  param(path: ApiPath, name: string): ParameterObject;
  schema(name: string): SchemaObject;
  /** A component response's description. */
  responseDescription(name: string): string;
  /**
   * The wire shape of a schema value: every local `$ref` inlined and every
   * `description` dropped, so a named enum and an inline one compare equal.
   */
  shape(value: unknown): unknown;
}

function schemaIn(doc: OpenApiDocument, name: string): SchemaObject {
  const found = doc.components?.schemas?.[name];
  if (!found) throw new Error(`schema ${name} not declared`);
  return found;
}

function getIn(doc: OpenApiDocument, path: ApiPath): OperationObject {
  const found = doc.paths?.[path]?.["get"];
  if (!found) throw new Error(`GET ${path} not declared`);
  return found;
}

function resolveParameter(doc: OpenApiDocument, p: ParameterObject): ParameterObject {
  return p.$ref ? doc.components!.parameters![p.$ref.replace(PARAMETER_REF, "")]! : p;
}

function paramsIn(doc: OpenApiDocument, path: ApiPath): ParameterObject[] {
  return (getIn(doc, path).parameters ?? []).map((p) => resolveParameter(doc, p));
}

function paramIn(doc: OpenApiDocument, path: ApiPath, name: string): ParameterObject {
  const found = paramsIn(doc, path).find((p) => p.name === name);
  if (!found) throw new Error(`parameter ${name} not declared on ${path}`);
  return found;
}

function shapeIn(doc: OpenApiDocument, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => shapeIn(doc, v));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const ref = record["$ref"];
  if (typeof ref === "string") return shapeIn(doc, schemaIn(doc, ref.replace(SCHEMA_REF, "")));
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== "description")
      .map(([key, v]) => [key, shapeIn(doc, v)]),
  );
}

export function contractReader(doc: OpenApiDocument): ContractReader {
  return {
    doc,
    get: (path) => getIn(doc, path),
    params: (path) => paramsIn(doc, path),
    param: (path, name) => paramIn(doc, path, name),
    schema: (name) => schemaIn(doc, name),
    responseDescription: (name) => String(doc.components?.responses?.[name]?.description ?? ""),
    shape: (value) => shapeIn(doc, value),
  };
}

/** Every contract, top level and one folder down (the loader's own scan is non-recursive). */
export function allContracts(): LoadedContract[] {
  const root = resolve(__dirname, "..", "..", "..", "..", "packages", "contracts", "openapi");
  const folders = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
  return [...loadOpenApiContracts(), ...folders.flatMap((dir) => loadOpenApiContracts({ dir }))];
}

/** The document of contract `id`, or a loud failure naming where it was looked for. */
export function contractDocument(contracts: readonly LoadedContract[], id: string): OpenApiDocument {
  const found = contracts.find((c) => c.id === id);
  if (!found) throw new Error(`${id} not found under packages/contracts/openapi/`);
  return found.document as OpenApiDocument;
}

/** Every operationId declared by a contract other than `exceptId`. */
export function operationIdsExcept(contracts: readonly LoadedContract[], exceptId: string): Set<string> {
  return new Set(
    contracts
      .filter((c) => c.id !== exceptId)
      .flatMap((c) => Object.values((c.document as OpenApiDocument).paths ?? {}))
      .flatMap((item) => Object.values(item))
      .map((o) => o?.operationId)
      .filter((id): id is string => typeof id === "string"),
  );
}
