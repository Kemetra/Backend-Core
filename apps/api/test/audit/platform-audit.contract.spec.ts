/**
 * apps/api/test/audit/platform-audit.contract.spec.ts
 *
 * RT-431: the platform-scope audit read contract (`listPlatformAuditEvents`,
 * `audit.openapi.yaml` 1.3.0-draft). `[GATED]` contract, contract-only: the
 * runtime ships in a later change.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. What this pins:
 *
 *   1. One new operation, contract-only, with a note; the tenant-scoped
 *      `listAuditEvents` and `AuditEvent` are unchanged (additive version bump).
 *   2. Human `cookieAuth` only; 401 / 403 are stated; no 404.
 *   3. The closed filter set: no `tenant_id`, no `store_id`.
 *   4. The item schema is strict, always `tenant_id: null`, and an email-shaped
 *      `actor_label` must be masked.
 *   5. The RT-414 support-session interaction is stated in the contract.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { loadOpenApiContracts } from "../../src/openapi/loader";

const CONTRACT_ID = "audit.openapi";
const OPERATION_ID = "listPlatformAuditEvents";
const PATH = "/api/v1/platform/audit/events";
const TENANT_PATH = "/api/v1/audit/events";

interface ParameterObject {
  $ref?: string;
  name?: string;
  in?: string;
  schema?: Record<string, unknown>;
}

interface OperationObject {
  operationId?: string;
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: ParameterObject[];
  responses?: Record<string, { $ref?: string; description?: string }>;
  "x-runtime-status"?: string;
  "x-runtime-note"?: string;
}

interface OpenApiDocument {
  info?: { version?: string; description?: string };
  security?: Array<Record<string, unknown>>;
  paths?: Record<string, Record<string, OperationObject>>;
  components?: {
    schemas?: Record<string, Record<string, unknown>>;
    parameters?: Record<string, ParameterObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
}

let doc: OpenApiDocument;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = loadOpenApiContracts();
  const found = contracts.find((c) => c.id === CONTRACT_ID);
  if (!found) throw new Error(`${CONTRACT_ID} not found in packages/contracts/openapi/`);
  doc = found.document as OpenApiDocument;
  otherOperationIds = new Set<string>();
  for (const c of contracts) {
    if (c.id === CONTRACT_ID) continue;
    for (const item of Object.values((c.document as OpenApiDocument).paths ?? {})) {
      for (const o of Object.values(item)) {
        if (typeof o?.operationId === "string") otherOperationIds.add(o.operationId);
      }
    }
  }
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function op(): OperationObject {
  const found = doc.paths?.[PATH]?.get;
  if (!found) throw new Error(`GET ${PATH} not declared`);
  return found;
}

function validator(name: string): ValidateFunction {
  return ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`)!;
}

/** Parameter names of the operation, with `$ref`s resolved. */
function parameterNames(): string[] {
  return (op().parameters ?? []).map((p) => {
    const refName = p.$ref?.split("/").pop();
    return refName ? doc.components!.parameters![refName]!.name! : p.name!;
  });
}

const EVENT_ID = "0192f0a0-0000-7000-8000-000000000001";
const ACTOR_ID = "0192f0a0-0000-7000-8000-000000000002";
const TENANT_FIXTURE = "0192f0a0-0000-7000-8000-000000000009";
const OCCURRED_AT = "2026-10-21T09:00:00.123456Z";

const signinFailed = {
  id: EVENT_ID,
  occurred_at: OCCURRED_AT,
  actor_user_id: null,
  actor_label: "a***@example.com",
  tenant_id: null,
  store_id: null,
  action: "auth.signin.failed",
  kind: "change",
  target_type: null,
  target_id: null,
  request_id: null,
  metadata: {},
};

const crossTenantUnresolvable = {
  ...signinFailed,
  actor_user_id: ACTOR_ID,
  actor_label: "platform_support",
  action: "platform.cross_tenant.accessed",
  request_id: "0192f0a0-0000-7000-8000-000000000003",
  metadata: {
    actor_kind: "platform_admin",
    outcome: "rejected",
    reason: "support_session_required",
    support_session_id: null,
    purpose: null,
    method: "GET",
    route: "/api/v1/tenants/:id/members",
  },
};

function without(row: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));
}

describe("platform audit read: document and operation", () => {
  it("bumps audit.openapi to 1.3.0-draft and keeps its two operations", () => {
    expect(doc.info?.version).toBe("1.3.0-draft");
    const declared = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(item).map(([method, o]) => `${method} ${path} ${o.operationId}`),
    );
    expect(declared.sort()).toEqual([
      `get ${TENANT_PATH} listAuditEvents`,
      `get ${PATH} ${OPERATION_ID}`,
    ]);
  });

  it("collides with no other contract's operationId", () => {
    expect(otherOperationIds.has(OPERATION_ID)).toBe(false);
  });

  it("is contract-only and says where the runtime and the guard rule live", () => {
    const o = op();
    expect(o["x-runtime-status"]).toBe("contract-only");
    expect(o["x-runtime-note"]).toContain("TenantContextGuard");
    expect(o["x-runtime-note"]).toContain("tenant_id IS NULL");
  });

  it("leaves the tenant-scoped list unchanged", () => {
    const tenantOp = doc.paths?.[TENANT_PATH]?.get;
    expect(tenantOp?.["x-runtime-status"]).toBeUndefined();
    expect(tenantOp?.parameters?.map((p) => p.name)).toEqual([
      "action",
      "kind",
      "actor_user_id",
      "store_id",
      "from",
      "to",
      "cursor",
      "limit",
    ]);
    const event = doc.components?.schemas?.AuditEvent as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(event.properties.tenant_id).toEqual({ type: "string", format: "uuid" });
  });
});

describe("platform audit read: auth and refusals", () => {
  it("accepts the human cookie only", () => {
    expect(op().security).toEqual([{ cookieAuth: [] }]);
    expect(doc.components?.securitySchemes?.cookieAuth).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "dp2_session",
    });
  });

  it("declares 200, 400, 401, 403 and 429, and no 404", () => {
    const codes = Object.keys(op().responses ?? {}).sort();
    expect(codes).toEqual(["200", "400", "401", "403", "429"]);
  });

  it("says platform admins only, tenant owners get 403, and 401 is not 'no tenant'", () => {
    const text = op().description ?? "";
    expect(text).toContain("Only a platform admin");
    expect(text).toContain("tenant `owner`");
    expect(text).toContain("gets 403 `forbidden`");
    expect(text).toContain("never means \"no active tenant\"");
  });

  it("states the RT-414 interaction: no support session, no cross-tenant row", () => {
    const text = op().description ?? "";
    expect(text).toContain("MUST NOT require or use a support");
    expect(text).toContain("MUST NOT write a `platform.cross_tenant.accessed` row");
  });
});

describe("platform audit read: filters and paging", () => {
  it("exposes the closed filter set with no tenant or store filter", () => {
    expect(parameterNames()).toEqual([
      "action",
      "kind",
      "actor_user_id",
      "from",
      "to",
      "cursor",
      "limit",
    ]);
  });

  it("keeps the listAuditEvents bounds and defaults", () => {
    const limit = doc.components?.parameters?.PlatformAuditLimit?.schema;
    expect(limit).toMatchObject({ type: "integer", minimum: 1, maximum: 200, default: 50 });
    expect(doc.components?.parameters?.PlatformAuditKind?.schema).toMatchObject({
      enum: ["read", "change"],
    });
  });

  it("requires every list field and rejects extras on the envelope", () => {
    const list = validator("PlatformAuditEventList");
    expect(list({ items: [signinFailed], next_cursor: null })).toBe(true);
    expect(list({ items: [], next_cursor: "opaque" })).toBe(true);
    expect(list({ items: [] })).toBe(false);
    expect(list({ items: [], next_cursor: null, total: 1 })).toBe(false);
  });
});

describe("platform audit read: item projection and disclosure", () => {
  it("accepts a masked sign-in row and an unresolvable-tenant cross-tenant row", () => {
    const item = validator("PlatformAuditEvent");
    expect(item(signinFailed)).toBe(true);
    expect(item({ ...signinFailed, actor_user_id: ACTOR_ID, action: "auth.signin.ok" })).toBe(true);
    expect(item(crossTenantUnresolvable)).toBe(true);
  });

  it("rejects a row that names a tenant", () => {
    const item = validator("PlatformAuditEvent");
    expect(item({ ...signinFailed, tenant_id: TENANT_FIXTURE })).toBe(false);
    expect(item(without(signinFailed, "tenant_id"))).toBe(false);
  });

  it.each([
    ["an unmasked email", "alice@example.com"],
    ["a longer-than-one-character prefix", "al***@example.com"],
    ["a mask with no domain", "a***@"],
    ["a mask with a second @", "a***@x@example.com"],
  ])("rejects %s in actor_label", (_name, label) => {
    expect(validator("PlatformAuditEvent")({ ...signinFailed, actor_label: label })).toBe(false);
  });

  it.each([
    ["a null label", null],
    ["a server label with no @", "platform_support"],
    ["a mask of a one-character domain", "z***@x"],
  ])("accepts %s in actor_label", (_name, label) => {
    expect(validator("PlatformAuditEvent")({ ...signinFailed, actor_label: label })).toBe(true);
  });

  it("rejects an extra property, an unknown kind and a missing field", () => {
    const item = validator("PlatformAuditEvent");
    expect(item({ ...signinFailed, ip: "203.0.113.9" })).toBe(false);
    expect(item({ ...signinFailed, kind: "other" })).toBe(false);
    expect(item(without(signinFailed, "request_id"))).toBe(false);
  });

  it("states the masking rule, the no-IP rule and the untrusted-text rule", () => {
    const text = op().description ?? "";
    expect(text).toContain("The server MUST NOT return it whole");
    expect(text).toContain("MUST be returned as its first character");
    expect(text).toContain("`a***@example.com`");
    expect(text).toContain("no IP address");
    expect(text).toContain("untrusted text");
  });
});
