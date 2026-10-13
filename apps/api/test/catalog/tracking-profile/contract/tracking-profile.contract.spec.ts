/**
 * apps/api/test/catalog/tracking-profile/contract/tracking-profile.contract.spec.ts
 *
 * RT-448 (RT-50 Inventory Gate 7, G7-1) — OpenAPI conformance test for
 * `packages/contracts/openapi/catalog/tracking-profile.yaml`.
 *
 * Mirrors `erpnext-warehouse-map.contract.spec.ts`: loads the contract with an
 * explicit `dir` (the loader's scan is non-recursive), asserts both
 * operationIds are present and unique against every shipped operationId, and
 * pins the load-bearing conventions: the human `cookieAuth` scheme, the strict
 * set request (no tenant / product / actor), the closed tracking-mode enum
 * mirroring the database CHECK, the 409 lock, and the strict projection.
 *
 * Structural / load-only (no app boot, no HTTP).
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { TRACKING_MODES } from "@data-pulse-2/db";

import { loadOpenApiContracts } from "../../../../src/openapi/loader";

const NEW_CONTRACT_ID = "tracking-profile";
const PATH = "/api/v1/catalog/products/{productId}/tracking-profile";

const OPERATION_IDS = ["tenantAdminGetTrackingProfile", "tenantAdminSetTrackingProfile"] as const;

function openapiSubDir(sub: string): string {
  return resolve(__dirname, "..", "..", "..", "..", "..", "..", "packages", "contracts", "openapi", sub);
}

interface OperationObject {
  operationId?: string;
  responses?: Record<string, unknown>;
}

interface SchemaObject {
  type?: string | string[];
  enum?: unknown[];
  additionalProperties?: boolean | Record<string, unknown>;
  required?: string[];
  properties?: Record<string, unknown>;
}

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, OperationObject>>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
  security?: Array<Record<string, unknown>>;
}

let doc: OpenApiDocument;
let shippedOperationIds: Set<string>;

function collectOperationIds(docs: OpenApiDocument[], into: Set<string>): void {
  const ops = docs
    .flatMap((d) => Object.values(d.paths ?? {}))
    .flatMap((path) => Object.values(path));
  for (const op of ops) {
    if (typeof op?.operationId === "string") into.add(op.operationId);
  }
}

beforeAll(() => {
  const catalogContracts = loadOpenApiContracts({ dir: openapiSubDir("catalog") });
  const newContract = catalogContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = catalogContracts.map((c) => c.id).join(", ");
    throw new Error(`${NEW_CONTRACT_ID} contract not found; loaded ids: [${ids}]`);
  }
  doc = newContract.document as OpenApiDocument;

  shippedOperationIds = new Set<string>();
  collectOperationIds(
    loadOpenApiContracts().map((c) => c.document as OpenApiDocument),
    shippedOperationIds,
  );
  for (const sub of ["catalog", "pos-sales", "erpnext-connector", "inventory"]) {
    collectOperationIds(
      loadOpenApiContracts({ dir: openapiSubDir(sub) })
        .filter((c) => c.id !== NEW_CONTRACT_ID)
        .map((c) => c.document as OpenApiDocument),
      shippedOperationIds,
    );
  }
});

function schema(name: string): SchemaObject | undefined {
  return doc.components?.schemas?.[name];
}

describe("catalog/tracking-profile.yaml — document", () => {
  it("is OpenAPI 3.1 with a *-draft version", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toEqual(expect.stringMatching(/-draft$/));
  });

  it("maps GET and PUT on the product path to the two operationIds, nothing else", () => {
    const item = doc.paths?.[PATH] ?? {};
    expect(Object.keys(doc.paths ?? {})).toEqual([PATH]);
    expect(item["get"]?.operationId).toBe("tenantAdminGetTrackingProfile");
    expect(item["put"]?.operationId).toBe("tenantAdminSetTrackingProfile");
    expect(Object.keys(item).sort()).toEqual(["get", "put"]);
  });

  it("does NOT collide with any shipped operationId", () => {
    for (const id of OPERATION_IDS) {
      expect(shippedOperationIds.has(id)).toBe(false);
    }
  });
});

describe("catalog/tracking-profile.yaml — auth boundary", () => {
  it("requires the human cookieAuth (dp2_session) scheme at the document level", () => {
    const cookie = doc.components?.securitySchemes?.["cookieAuth"];
    expect(cookie?.["in"]).toBe("cookie");
    expect(cookie?.["name"]).toBe("dp2_session");
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
  });

  it("defines no connector or POS scheme", () => {
    expect(doc.components?.securitySchemes?.["connectorBearer"]).toBeUndefined();
    expect(doc.components?.securitySchemes?.["clerkJwt"]).toBeUndefined();
  });
});

describe("catalog/tracking-profile.yaml — schemas", () => {
  it("TrackingMode is exactly the database's closed set", () => {
    expect(schema("TrackingMode")?.enum).toEqual([...TRACKING_MODES]);
  });

  it("the set request is strict and carries only the two profile fields", () => {
    const s = schema("SetTrackingProfileRequest");
    expect(s?.additionalProperties).toBe(false);
    expect(s?.required?.slice().sort()).toEqual(["expiry_required", "tracking_mode"]);
    expect(Object.keys(s?.properties ?? {}).sort()).toEqual(["expiry_required", "tracking_mode"]);
  });

  it("the projection is strict and reports the lock", () => {
    const p = schema("TrackingProfile");
    expect(p?.additionalProperties).toBe(false);
    expect(p?.required?.slice().sort()).toEqual([
      "expiry_required",
      "product_id",
      "profile_locked",
      "tracking_mode",
    ]);
  });

  it("set declares the lock 409 and the non-disclosing 404", () => {
    const responses = doc.paths?.[PATH]?.["put"]?.responses ?? {};
    for (const code of ["200", "400", "401", "403", "404", "409"]) {
      expect(responses[code]).toBeDefined();
    }
  });

  it("Error is the strict canonical envelope", () => {
    expect(schema("Error")?.additionalProperties).toBe(false);
    expect(schema("Error")?.required).toEqual(["error"]);
  });
});
