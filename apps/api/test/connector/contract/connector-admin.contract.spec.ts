/**
 * apps/api/test/connector/contract/connector-admin.contract.spec.ts
 *
 * Slice 018-CONTRACT (T021) — OpenAPI conformance test for
 * `packages/contracts/openapi/connector/connector-admin.yaml`.
 *
 * Mirrors `apps/api/test/catalog/erpnext-warehouse-map/contract/erpnext-warehouse-map.contract.spec.ts`:
 *   - loads the new contract via the production `loadOpenApiContracts` helper
 *     with an explicit `dir` (the helper's scan is non-recursive, so the nested
 *     `connector/` directory is loaded explicitly);
 *   - asserts the SIX 018 operationIds are present + UNIQUE against every
 *     shipped operationId;
 *   - pins the slice's load-bearing conventions:
 *       · the HUMAN dashboard `cookieAuth` scheme — NOT the 012 `connectorBearer`
 *         machine scheme and NOT the POS `clerkJwt` device scheme. (The
 *         SESSION-ONLY / no-`dashboard_api`-bearer enforcement FR-005c is a
 *         runtime guard concern asserted in the US1/US4 specs, not expressible
 *         in the OpenAPI security block; the contract description records it.)
 *       · strict request DTOs (§XII): register carries ONLY display_name +
 *         erpnext_site_ref + environment (no tenant_id/actor/id/disabled);
 *       · the closed Error set incl. `409 conflict` /
 *         `idempotency_key_conflict` + non-disclosing `404`;
 *       · the raw secret appears ONLY in `IssuedCredential` (issue/rotate
 *         response), NEVER in the `ConnectorInstance` / `CredentialStatus`
 *         status projections (§IV / FR-007/021).
 *
 * Structural / load-only (no app boot, no HTTP).
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../src/openapi/loader";

const NEW_CONTRACT_ID = "connector-admin";

const OPERATION_IDS = [
  "tenantAdminRegisterConnectorInstance",
  "tenantAdminListConnectorInstances",
  "tenantAdminIssueConnectorCredential",
  "tenantAdminRotateConnectorCredential",
  "tenantAdminRevokeConnectorCredential",
  "tenantAdminDisableConnectorInstance",
] as const;

function openapiSubDir(sub: string): string {
  return resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "packages",
    "contracts",
    "openapi",
    sub,
  );
}

interface OperationObject {
  operationId?: string;
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{ $ref?: string }>;
  requestBody?: {
    content?: Record<string, { schema?: { $ref?: string } }>;
  };
  responses?: Record<string, unknown>;
}

type PathItem = Record<string, OperationObject>;

interface SchemaObject {
  type?: string | string[];
  additionalProperties?: boolean | Record<string, unknown>;
  required?: string[];
  properties?: Record<string, unknown>;
}

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
  security?: Array<Record<string, unknown>>;
}

let doc: OpenApiDocument;
let shippedOperationIds: Set<string>;

function collectOperationIds(docs: OpenApiDocument[], into: Set<string>): void {
  for (const d of docs) {
    if (!d.paths) continue;
    for (const path of Object.values(d.paths)) {
      for (const op of Object.values(path)) {
        if (op && typeof op.operationId === "string") into.add(op.operationId);
      }
    }
  }
}

beforeAll(() => {
  const connectorContracts = loadOpenApiContracts({ dir: openapiSubDir("connector") });
  const newContract = connectorContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = connectorContracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${openapiSubDir("connector")}; loaded ids: [${ids}]`,
    );
  }
  doc = newContract.document as OpenApiDocument;

  // SHIPPED operationIds the new ops must not collide with: top-level +
  // nested catalog/ + pos-sales/ + erpnext-connector/ + erpnext-reconciliation/.
  shippedOperationIds = new Set<string>();
  collectOperationIds(
    loadOpenApiContracts().map((c) => c.document as OpenApiDocument),
    shippedOperationIds,
  );
  for (const sub of ["catalog", "pos-sales", "erpnext-connector", "erpnext-reconciliation"]) {
    collectOperationIds(
      loadOpenApiContracts({ dir: openapiSubDir(sub) })
        .filter((c) => c.id !== NEW_CONTRACT_ID)
        .map((c) => c.document as OpenApiDocument),
      shippedOperationIds,
    );
  }
});

function operations(): Array<{ path: string; method: string; op: OperationObject }> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      out.push({ path, method, op });
    }
  }
  return out;
}

function findOp(operationId: string): OperationObject | undefined {
  return operations().find((o) => o.op.operationId === operationId)?.op;
}

function schema(name: string): SchemaObject | undefined {
  return doc.components?.schemas?.[name];
}

// ===========================================================================
// 1. Loadability + document-level conventions
// ===========================================================================
describe("connector/connector-admin.yaml — loadability", () => {
  it("is parseable by the production OpenAPI loader", () => {
    expect(doc).toBeDefined();
    expect(typeof doc).toBe("object");
  });

  it("declares OpenAPI 3.1 of record", () => {
    expect(doc.openapi).toBe("3.1.0");
  });

  it("declares an info block with title and a *-draft version", () => {
    expect(doc.info?.title).toEqual(expect.any(String));
    expect(doc.info?.version).toEqual(expect.stringMatching(/-draft$/));
  });
});

// ===========================================================================
// 2. Operations present + globally unique
// ===========================================================================
describe("connector/connector-admin.yaml — operations", () => {
  it("declares all six 018 operationIds", () => {
    for (const id of OPERATION_IDS) {
      expect(findOp(id)).toBeDefined();
    }
  });

  it("does NOT collide with or rename any shipped operationId", () => {
    for (const id of OPERATION_IDS) {
      expect(shippedOperationIds.has(id)).toBe(false);
    }
  });
});

// ===========================================================================
// 3. Auth — HUMAN dashboard cookieAuth (NOT connectorBearer / clerkJwt)
// ===========================================================================
describe("connector/connector-admin.yaml — auth boundary", () => {
  it("defines the cookieAuth (httpOnly dp2_session) scheme", () => {
    const cookie = doc.components?.securitySchemes?.["cookieAuth"];
    expect(cookie).toBeDefined();
    expect(cookie?.["type"]).toBe("apiKey");
    expect(cookie?.["in"]).toBe("cookie");
    expect(cookie?.["name"]).toBe("dp2_session");
  });

  it("requires cookieAuth at the document level", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
  });

  it("does NOT define connectorBearer (012 machine) or clerkJwt (POS device)", () => {
    expect(doc.components?.securitySchemes?.["connectorBearer"]).toBeUndefined();
    expect(doc.components?.securitySchemes?.["clerkJwt"]).toBeUndefined();
  });
});

// ===========================================================================
// 4. Strict request DTOs (§XII) + Idempotency-Key on rotate/revoke
// ===========================================================================
describe("connector/connector-admin.yaml — request DTOs", () => {
  it("register request is strict and carries ONLY the registerable fields (no mass-assignment)", () => {
    const s = schema("RegisterConnectorInstanceRequest");
    expect(s?.additionalProperties).toBe(false);
    expect(s?.required?.sort()).toEqual(["display_name", "environment", "erpnext_site_ref"]);
    for (const forbidden of ["tenant_id", "id", "created_by", "disabled_at", "disabled_by"]) {
      expect(s?.properties?.[forbidden]).toBeUndefined();
    }
  });

  it("issue request is strict and exposes only the bounded expiry override", () => {
    const s = schema("IssueCredentialRequest");
    expect(s?.additionalProperties).toBe(false);
    expect(s?.properties?.["expires_in_days"]).toBeDefined();
    for (const forbidden of ["tenant_id", "secret", "token_hash", "scope"]) {
      expect(s?.properties?.[forbidden]).toBeUndefined();
    }
  });

  it("rotate + revoke require an Idempotency-Key parameter", () => {
    for (const id of [
      "tenantAdminRotateConnectorCredential",
      "tenantAdminRevokeConnectorCredential",
    ]) {
      const refs = (findOp(id)?.parameters ?? []).map((p) => p.$ref ?? "");
      expect(refs.some((r) => r.endsWith("/IdempotencyKey"))).toBe(true);
    }
  });
});

// ===========================================================================
// 5. Closed error set + non-disclosing 404 + conflict codes
// ===========================================================================
describe("connector/connector-admin.yaml — error envelope", () => {
  it("register declares the (env, site_ref) conflict (409)", () => {
    const responses = findOp("tenantAdminRegisterConnectorInstance")?.responses ?? {};
    expect(responses["409"]).toBeDefined();
  });

  it("issue declares 409 conflict for an already-active credential (RT-62)", () => {
    const responses = findOp("tenantAdminIssueConnectorCredential")?.responses ?? {};
    expect(responses["409"]).toBeDefined();
  });

  it("rotate + revoke declare 404 + the idempotency conflict (409)", () => {
    for (const id of [
      "tenantAdminRotateConnectorCredential",
      "tenantAdminRevokeConnectorCredential",
    ]) {
      const responses = findOp(id)?.responses ?? {};
      expect(responses["404"]).toBeDefined();
      expect(responses["409"]).toBeDefined();
    }
  });

  it("Error is the strict canonical envelope { error: { code, message, request_id? } }", () => {
    const err = schema("Error");
    expect(err?.additionalProperties).toBe(false);
    expect(err?.required).toEqual(["error"]);
  });
});

// ===========================================================================
// 6. Secret discipline — raw secret ONLY in IssuedCredential, never in status
//    projections (§IV / FR-007/021)
// ===========================================================================
describe("connector/connector-admin.yaml — secret discipline", () => {
  it("IssuedCredential (issue/rotate response) carries the one-time raw secret", () => {
    const s = schema("IssuedCredential");
    expect(s?.additionalProperties).toBe(false);
    expect(s?.properties?.["secret"]).toBeDefined();
  });

  // RT-82 K3: the rotate secret is never stored for replay, so a same-key
  // retry is a 409, never a replayed 201 carrying the secret.
  it("documents rotate as non-replayable: a same-key retry is 409, never the secret (RT-82 K3)", () => {
    const rotate = findOp("tenantAdminRotateConnectorCredential");
    expect(rotate?.description).toMatch(/Non-replayable/);
    const conflict = (rotate?.responses ?? {})["409"] as { description?: string } | undefined;
    expect(conflict?.description).toMatch(/idempotency_key_conflict/);
    expect(conflict?.description).toMatch(/never replayed/);
  });

  it("ConnectorInstance projection carries NO secret / hash (status only)", () => {
    const props = schema("ConnectorInstance")?.properties ?? {};
    for (const forbidden of ["secret", "token_hash", "token", "raw_secret", "credential_secret"]) {
      expect(props[forbidden]).toBeUndefined();
    }
  });

  it("CredentialStatus projection carries NO secret / hash (status only)", () => {
    const props = schema("CredentialStatus")?.properties ?? {};
    for (const forbidden of ["secret", "token_hash", "token", "raw_secret"]) {
      expect(props[forbidden]).toBeUndefined();
    }
  });

  it("the only schema with a `secret` property is IssuedCredential", () => {
    const withSecret = Object.entries(doc.components?.schemas ?? {})
      .filter(([, s]) => (s.properties ?? {})["secret"] !== undefined)
      .map(([name]) => name);
    expect(withSecret).toEqual(["IssuedCredential"]);
  });
});
