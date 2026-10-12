/**
 * apps/api/test/platform-support-sessions/platform-support-sessions.contract.spec.ts
 *
 * RT-414 (RT-391 P0-a, owner decision D2): the platform support-session
 * contract. `[GATED]` contract: the runtime ships only after the owner
 * approves it, and its decisions 1–5, on RT-414.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP (the operations are contract-only). What this pins:
 *
 *   1. Four operations (open, read current, renew, end), all contract-only,
 *      colliding with no other contract's operationIds.
 *   2. Human `cookieAuth` only; 403 is the non-platform-admin refusal; the
 *      unknown / unavailable tenant is one non-disclosing 404.
 *   3. Purpose is required and closed; ticket_ref is optional, bounded and
 *      cannot hold an email address or whitespace.
 *   4. The session projection is strict and server-owned (expiry, cap).
 *   5. Audit metadata allowlists are strict and carry no PII.
 *   6. `context.openapi.yaml` changes are additive: the 404 is unchanged, a
 *      platform-only 403 and a nullable `support_session` are added.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { loadOpenApiContracts } from "../../src/openapi/loader";

const CONTRACT_ID = "platform-support-sessions.openapi";
const CONTEXT_ID = "context.openapi";

const BASE = "/api/v1/platform/support-sessions";
const CURRENT = `${BASE}/current`;
const RENEW = `${CURRENT}/renew`;
const END = `${CURRENT}/end`;

const OPERATIONS: ReadonlyArray<[string, string, string]> = [
  [BASE, "post", "openSupportSession"],
  [CURRENT, "get", "getCurrentSupportSession"],
  [RENEW, "post", "renewSupportSession"],
  [END, "post", "endSupportSession"],
];

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  requestBody?: unknown;
  responses?: Record<string, { $ref?: string; description?: string }>;
  "x-runtime-status"?: string;
  "x-runtime-note"?: string;
}

type SchemaObject = Record<string, unknown> & {
  required?: string[];
  properties?: Record<string, Record<string, unknown>>;
  additionalProperties?: unknown;
  enum?: unknown[];
};

interface OpenApiDocument {
  openapi?: string;
  info?: { version?: string; description?: string };
  security?: Array<Record<string, unknown>>;
  paths?: Record<string, Record<string, OperationObject>>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    responses?: Record<string, { description?: string }>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
}

let doc: OpenApiDocument;
let contextDoc: OpenApiDocument;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = loadOpenApiContracts();
  const found = contracts.find((c) => c.id === CONTRACT_ID);
  if (!found) throw new Error(`${CONTRACT_ID} not found in packages/contracts/openapi/`);
  doc = found.document as OpenApiDocument;
  contextDoc = contracts.find((c) => c.id === CONTEXT_ID)!.document as OpenApiDocument;
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

function op(path: string, method: string): OperationObject {
  const found = doc.paths?.[path]?.[method];
  if (!found) throw new Error(`${method.toUpperCase()} ${path} not declared`);
  return found;
}

function schema(name: string): SchemaObject {
  const found = doc.components?.schemas?.[name];
  if (!found) throw new Error(`schema ${name} not declared`);
  return found;
}

function validator(name: string): ValidateFunction {
  return ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`)!;
}

const SESSION_ID = "0192f0a0-0000-7000-8000-000000000001";
const TENANT_ID = "0192f0a0-0000-7000-8000-000000000002";

const activeSession = {
  id: SESSION_ID,
  tenant_id: TENANT_ID,
  purpose: "customer_support",
  ticket_ref: "SUP-1042",
  status: "active",
  opened_at: "2026-10-12T09:00:00Z",
  renewed_at: null,
  expires_at: "2026-10-12T10:00:00Z",
  renewal_cap_at: "2026-10-12T17:00:00Z",
  ended_at: null,
  end_reason: null,
};

describe("platform-support-sessions — document and operations", () => {
  it("is an OpenAPI 3.1 document at version 1.0.0-draft", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.0.0-draft");
  });

  it("declares exactly open, read-current, renew and end", () => {
    const declared: string[] = [];
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const [method, o] of Object.entries(item)) declared.push(`${method} ${path} ${o.operationId}`);
    }
    expect(declared.sort()).toEqual(OPERATIONS.map(([p, m, id]) => `${m} ${p} ${id}`).sort());
  });

  it("marks every operation contract-only with a runtime note", () => {
    for (const [path, method] of OPERATIONS) {
      const o = op(path, method);
      expect(o["x-runtime-status"]).toBe("contract-only");
      expect(o["x-runtime-note"]?.trim().length).toBeGreaterThan(0);
    }
  });

  it("collides with no operationId in any other contract", () => {
    for (const [, , id] of OPERATIONS) expect(otherOperationIds.has(id)).toBe(false);
  });

  it("takes a body only on open; renew and end act on the caller's current session", () => {
    expect(op(BASE, "post").requestBody).toBeDefined();
    expect(op(CURRENT, "get").requestBody).toBeUndefined();
    expect(op(RENEW, "post").requestBody).toBeUndefined();
    expect(op(END, "post").requestBody).toBeUndefined();
    expect(Object.keys(doc.paths ?? {}).some((p) => p.includes("{"))).toBe(false);
  });
});

describe("platform-support-sessions — auth and refusals", () => {
  it("accepts only the human cookieAuth session", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["cookieAuth"]);
    for (const [path, method] of OPERATIONS) expect(op(path, method).security).toBeUndefined();
  });

  it("refuses a non-platform-admin with 403 on every operation", () => {
    for (const [path, method] of OPERATIONS) {
      expect(op(path, method).responses?.["403"]?.$ref).toBe(
        "#/components/responses/PlatformAdminRequired",
      );
      expect(op(path, method).responses?.["401"]?.$ref).toBe("#/components/responses/Unauthorized");
    }
  });

  it("answers an unknown and an unavailable tenant with the same 404 on open", () => {
    expect(op(BASE, "post").responses?.["404"]?.$ref).toBe("#/components/responses/TenantNotFound");
    expect(doc.components?.responses?.["TenantNotFound"]?.description).toMatch(/identical/);
  });

  it("declares the cross-cutting refusal codes for tenant-scoped routes", () => {
    const refused = doc.components?.responses?.["SupportSessionRefused"]?.description ?? "";
    expect(refused).toContain("support_session_required");
    expect(refused).toContain("support_session_expired");
    expect(doc.info?.description).toContain("TenantContextGuard");
  });

  it("renews only an active session; an expired one must be opened again (decision 2)", () => {
    const renew = op(RENEW, "post");
    expect(renew.description).toMatch(/expired one is not renewable/);
    expect(renew.responses?.["409"]?.description).toContain("support_session_expired");
    expect(renew.responses?.["409"]?.description).toContain("support_session_renewal_cap_reached");
    expect(renew.requestBody).toBeUndefined();
  });

  it("returns 201 on open and 200 on read, renew and end", () => {
    expect(Object.keys(op(BASE, "post").responses ?? {})).toContain("201");
    for (const [path, method] of OPERATIONS.slice(1)) {
      expect(Object.keys(op(path, method).responses ?? {})).toContain("200");
    }
  });
});

describe("platform-support-sessions — request and projection", () => {
  it("requires tenant_id and a closed purpose; ticket_ref is optional", () => {
    const req = schema("OpenSupportSessionRequest");
    expect(req.additionalProperties).toBe(false);
    expect(req.required).toEqual(["tenant_id", "purpose"]);
    expect(Object.keys(req.properties ?? {}).sort()).toEqual(["purpose", "tenant_id", "ticket_ref"]);
    expect(schema("SupportPurpose").enum).toEqual(["customer_support", "incident", "onboarding"]);
  });

  it("bounds ticket_ref so it cannot hold an email, whitespace or a long note", () => {
    const v = validator("TicketRef");
    for (const ok of ["SUP-1042", "INC#77", "jira:RT-414", "zendesk/123456"]) expect(v(ok)).toBe(true);
    for (const bad of ["", "ops@example.com", "two words", "-leading", "x".repeat(65), "line\nbreak"]) {
      expect(v(bad)).toBe(false);
    }
  });

  it("makes the session projection strict with every key required", () => {
    const s = schema("SupportSession");
    expect(s.additionalProperties).toBe(false);
    expect([...(s.required ?? [])].sort()).toEqual(Object.keys(s.properties ?? {}).sort());
  });

  it("takes no expiry or cap from the client", () => {
    const keys = Object.keys(schema("OpenSupportSessionRequest").properties ?? {});
    expect(keys).not.toContain("expires_at");
    expect(keys).not.toContain("renewal_cap_at");
  });

  it("accepts an active, an expired and an ended session, and a null current", () => {
    const v = validator("SupportSession");
    expect(v(activeSession)).toBe(true);
    expect(v({ ...activeSession, status: "expired", ticket_ref: null })).toBe(true);
    expect(
      v({ ...activeSession, status: "ended", ended_at: "2026-10-12T09:30:00Z", end_reason: "operator" }),
    ).toBe(true);
    expect(validator("CurrentSupportSession")({ support_session: null })).toBe(true);
    expect(validator("CurrentSupportSession")({ support_session: activeSession })).toBe(true);
  });

  it("rejects a session with an unknown purpose, status or extra key", () => {
    const v = validator("SupportSession");
    expect(v({ ...activeSession, purpose: "curiosity" })).toBe(false);
    expect(v({ ...activeSession, status: "paused" })).toBe(false);
    expect(v({ ...activeSession, actor_email: "ops@example.com" })).toBe(false);
  });
});

describe("platform-support-sessions — audit metadata allowlists", () => {
  const FORBIDDEN = /email|token|secret|cookie|password|pin|body|ip/i;

  it("keeps both allowlists strict and free of PII-shaped keys", () => {
    for (const name of ["SupportSessionAuditMetadata", "CrossTenantAccessAuditMetadata"]) {
      const s = schema(name);
      expect(s.additionalProperties).toBe(false);
      for (const key of Object.keys(s.properties ?? {})) expect(key).not.toMatch(FORBIDDEN);
    }
  });

  it("names every RT-135 action and the per-request rule", () => {
    const text = doc.info?.description ?? "";
    for (const action of [
      "platform.support_session.opened",
      "platform.support_session.renewed",
      "platform.support_session.ended",
      "platform.cross_tenant.accessed",
    ]) {
      expect(text).toContain(action);
    }
    expect(text).toMatch(/exactly one row per tenant-scoped/);
  });

  it("accepts admitted and refused access rows and rejects an email in metadata", () => {
    const v = validator("CrossTenantAccessAuditMetadata");
    const admitted = {
      actor_kind: "platform_admin",
      outcome: "succeeded",
      support_session_id: SESSION_ID,
      purpose: "incident",
      method: "GET",
      route: "/api/v1/sales/:saleId",
    };
    expect(v(admitted)).toBe(true);
    expect(
      v({ ...admitted, outcome: "rejected", reason: "support_session_required", support_session_id: null, purpose: null }),
    ).toBe(true);
    expect(v({ ...admitted, actor_kind: "user" })).toBe(false);
    expect(v({ ...admitted, actor_email: "ops@example.com" })).toBe(false);
  });

  it("accepts lifecycle rows", () => {
    const v = validator("SupportSessionAuditMetadata");
    const base = {
      actor_kind: "platform_admin",
      outcome: "succeeded",
      support_session_id: SESSION_ID,
      purpose: "onboarding",
      ticket_ref: null,
    };
    expect(v({ ...base, expires_at: "2026-10-12T10:00:00Z" })).toBe(true);
    expect(v({ ...base, end_reason: "signed_out" })).toBe(true);
    expect(v({ ...base, tenant_name: "Acme" })).toBe(false);
  });
});

describe("context contract — additive RT-414 changes", () => {
  const switchOp = (): OperationObject => contextDoc.paths!["/api/v1/context/tenant"]!["post"]!;

  it("keeps the non-disclosing 404 and adds a platform-only 403", () => {
    const responses = switchOp().responses ?? {};
    expect(responses["404"]?.description).toMatch(/Same response for both/);
    expect(responses["403"]?.description).toContain("support_session_required");
    expect(responses["403"]?.description).toMatch(/Never returned to a user who is not a\s+platform admin/);
  });

  it("adds a nullable support_session summary to ContextResponse", () => {
    const ctx = contextDoc.components!.schemas!["ContextResponse"]!;
    expect(ctx.properties?.["support_session"]).toBeDefined();
    expect(ctx.required).toBeUndefined();
    const summary = contextDoc.components!.schemas!["SupportSessionSummary"]!;
    expect(summary.additionalProperties).toBe(false);
    expect(Object.keys(summary.properties ?? {})).not.toContain("actor_user_id");
  });

  it("keeps the context operations unchanged", () => {
    const ids: string[] = [];
    for (const item of Object.values(contextDoc.paths ?? {})) {
      for (const o of Object.values(item)) if (o.operationId) ids.push(o.operationId);
    }
    expect(ids.sort()).toEqual(["clearActiveStore", "getActiveContext", "switchActiveStore", "switchActiveTenant"]);
  });
});
