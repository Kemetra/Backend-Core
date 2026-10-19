/**
 * apps/api/test/ai-entitlements/ai-entitlements.contract.spec.ts
 *
 * RT-662 (RT-644 ENT-BC1): the AI entitlement read, the closed reason-code
 * set and the server-internal `check` decision, as fixed by AD-AI-ENT-001.
 * `[GATED]` contract, owner-approved 2026-10-19.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP. What this pins:
 *
 *   1. One contract-only GET at `/api/v1/tenants/{tenant_id}/ai/entitlements`.
 *   2. Read scope: `cookieAuth` only; 404 (never 403); guards before
 *      validation, so a refused caller learns nothing about the plan.
 *   3. The two role views (D-6): full for owner / tenant_admin, minimal for
 *      store_manager, nothing commercial anywhere.
 *   4. The closed reason-code set (§4.4 + D-5) and the tenant-facing subset.
 *   5. The internal `check` input and decision: tenant and principal never
 *      come from the input; allow needs a reservation, deny needs a reason.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import {
  allContracts,
  contractDocument,
  contractReader,
  operationIdsExcept,
  type ContractReader,
  type OpenApiDocument,
  type OperationObject,
} from "../_helpers/openapi-contract";

const CONTRACT_ID = "ai-entitlements.openapi";
const PATH = "/api/v1/tenants/{tenant_id}/ai/entitlements";
const OPERATION_ID = "consoleGetTenantAiEntitlements";
const OPT_OUT_PATH = "/api/v1/tenants/{tenant_id}/ai/entitlements/opt-outs/{feature_id}";
const OPT_OUT_OPERATION_ID = "consolePutTenantAiFeatureOptOut";

type SchemaName =
  | "TenantAiEntitlements"
  | "AiFeatureOptOutRequest"
  | "AiFeatureAvailability"
  | "AiEntitlementCheckInput"
  | "AiEntitlementDecision";

let doc: OpenApiDocument;
let api: ContractReader;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  doc = contractDocument(contracts, CONTRACT_ID);
  api = contractReader(doc);
  otherOperationIds = operationIdsExcept(contracts, CONTRACT_ID);
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function validator(name: SchemaName): ValidateFunction {
  const v = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${name}`);
  return v;
}

type ParamRef = { $ref: string };

function optOut(): OperationObject {
  const found = doc.paths?.[OPT_OUT_PATH]?.["put"];
  if (!found) throw new Error(`PUT ${OPT_OUT_PATH} not declared`);
  return found;
}

function refs(list: unknown): string[] {
  return (list as ParamRef[]).map((p) => p.$ref);
}

const STORE_REF = "0190f5a2-3b4c-7d8e-9f01-000000000002";
const RESERVATION_ID = "0190f5a2-3b4c-7d8e-9f01-000000000099";
const NOW = "2026-10-19T10:00:00Z";
const KEY = "rt662-idempotency-key-0001";

const FULL = {
  view: "full",
  entitlementVersion: 3,
  optOutRevision: 7,
  state: "active",
  effectiveFrom: "2026-10-01T00:00:00Z",
  effectiveUntil: null,
  evaluatedAt: NOW,
  features: [
    {
      featureId: "ai.ask",
      availability: "unavailable",
      unavailableReason: "feature_disabled_tenant",
      entitled: true,
      optOut: { optedOut: true, changedAt: NOW },
      meters: [],
    },
    {
      featureId: "ai.briefing.daily",
      availability: "available",
      unavailableReason: null,
      entitled: true,
      optOut: { optedOut: false, changedAt: null },
      meters: [
        {
          meter: "briefings_per_store_day",
          unit: "request",
          window: "day",
          storeRef: STORE_REF,
          limit: 5,
          used: 2,
          reserved: 1,
          remaining: 2,
          resetsAt: "2026-10-20T00:00:00Z",
        },
      ],
    },
  ],
} as const;

const MINIMAL = {
  view: "minimal",
  evaluatedAt: NOW,
  features: [
    { featureId: "ai.ask", availability: "unavailable" },
    { featureId: "ai.briefing.daily", availability: "available" },
  ],
} as const;

const CHECK_INPUT = {
  featureId: "ai.briefing.daily",
  targetStores: [STORE_REF],
  unitsEstimate: 1,
  idempotencyKey: KEY,
} as const;

const ALLOW = {
  decision: "allow",
  entitlementVersion: 3,
  optOutRevision: 7,
  reservationId: RESERVATION_ID,
  evaluatedAt: NOW,
} as const;

const DENY = {
  decision: "deny",
  reasonCode: "entitlement_unavailable",
  entitlementVersion: null,
  optOutRevision: null,
  evaluatedAt: NOW,
} as const;

const OPT_OUT_BODY = {
  expectedOptOutRevision: 7,
  optedOut: true,
  reason: "Not using AI answers in this tenant yet",
} as const;

const REASON_CODES = [
  "not_authorized",
  "tenant_inactive",
  "feature_disabled_system",
  "policy_denied",
  "not_entitled",
  "trial_expired",
  "grace_read_only",
  "feature_disabled_tenant",
  "quota_exhausted",
  "spend_cap_reached",
  "free_credit_exhausted",
  "entitlement_unavailable",
  "provider_unavailable",
];

describe("ai-entitlements — document and operation", () => {
  it("is an OpenAPI 3.1 document at version 1.0.0-draft", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.0.0-draft");
  });

  it("declares exactly two operations: the read GET with no body and the opt-out PUT", () => {
    expect(Object.keys(doc.paths ?? {})).toEqual([PATH, OPT_OUT_PATH]);
    const methods = (path: string) => Object.keys(doc.paths![path]!).filter((k) => k !== "parameters");
    expect(methods(PATH)).toEqual(["get"]);
    expect(methods(OPT_OUT_PATH)).toEqual(["put"]);
    expect(api.get(PATH).operationId).toBe(OPERATION_ID);
    expect(api.get(PATH).requestBody).toBeUndefined();
    expect(optOut().operationId).toBe(OPT_OUT_OPERATION_ID);
  });

  it("is contract-only until the RT-664 runtime ships", () => {
    for (const op of [api.get(PATH), optOut()]) {
      expect(op["x-runtime-status"]).toBe("contract-only");
      expect(op["x-runtime-note"]).toMatch(/RT-664/);
    }
  });

  it("collides with no operationId in any other contract", () => {
    expect(otherOperationIds.has(OPERATION_ID)).toBe(false);
    expect(otherOperationIds.has(OPT_OUT_OPERATION_ID)).toBe(false);
  });

  it("states no price, currency, plan name, cost, token or grace duration in any tenant view", () => {
    const shape = JSON.stringify(api.shape(api.schema("TenantAiEntitlements")));
    for (const word of ["price", "currency", "planCode", "plan_code", "cost", "token", "credit", "spendCap", "graceDays", "graceLength"]) {
      expect(shape).not.toContain(word);
    }
  });
});

describe("ai-entitlements — auth and read scope", () => {
  it("accepts only the human cookieAuth session", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
    expect(api.get(PATH).security).toEqual([{ cookieAuth: [] }]);
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(["cookieAuth"]);
  });

  it("answers 200 / 400 / 401 / 404 / 429 / 500 / 503: the refusal is 404, never 403", () => {
    expect(Object.keys(api.get(PATH).responses ?? {}).sort()).toEqual(["200", "400", "401", "404", "429", "500", "503"]);
    expect(api.get(PATH).responses!["404"]).toEqual({ $ref: "#/components/responses/NotFound" });
  });

  it("takes the tenant only as the path id that must equal the session's tenant, and no query", () => {
    const pathParams = doc.paths![PATH]!["parameters"] as unknown as Array<{ $ref: string }>;
    expect(pathParams).toEqual([{ $ref: "#/components/parameters/TenantId" }]);
    expect(api.params(PATH)).toEqual([]);
    expect(doc.components!.parameters!["TenantId"]!.description).toMatch(/Must be the session's tenant/);
  });

  it("refuses store_staff, another tenant and an absent tenant with the same non-disclosing 404", () => {
    const description = api.responseDescription("NotFound");
    expect(description).toMatch(/store_staff/);
    expect(description).toMatch(/not the session's tenant/);
    expect(description).toMatch(/never carries plan information/);
  });

  it("runs the guards before validation and before any entitlement read (layer 3 before layer 6)", () => {
    const description = doc.info?.description ?? "";
    expect(description).toMatch(/guards run before request\s+validation and before any\s+entitlement read/);
    expect(description).toMatch(/layer 3 before layer 6/);
  });

  it("fails closed with 503 entitlement_unavailable, never a guessed view", () => {
    expect(api.get(PATH).responses!["503"]).toEqual({ $ref: "#/components/responses/EntitlementUnavailable" });
    expect(api.responseDescription("EntitlementUnavailable")).toMatch(/entitlement_unavailable/);
  });

  it("marks the 200 Cache-Control: no-store and declares the console 429 headers", () => {
    expect(api.get(PATH).responses!["200"]!.headers?.["Cache-Control"]).toEqual({
      $ref: "#/components/headers/CacheControlNoStore",
    });
    const headers = doc.components!.responses!["TooManyRequests"]!.headers ?? {};
    expect(Object.keys(headers).sort()).toEqual(["Cache-Control", "Retry-After", "X-Request-Id"]);
  });
});

describe("ai-entitlements — role views (D-6)", () => {
  it("accepts a valid full view and a valid minimal view", () => {
    const v = validator("TenantAiEntitlements");
    expect(v(FULL)).toBe(true);
    expect(v(MINIMAL)).toBe(true);
  });

  it("gives the minimal view no reason, meter, opt-out or plan state", () => {
    const v = validator("TenantAiEntitlements");
    expect(v({ ...MINIMAL, state: "active" })).toBe(false);
    expect(v({ ...MINIMAL, entitlementVersion: 3 })).toBe(false);
    expect(v({ ...MINIMAL, features: [{ ...MINIMAL.features[0], unavailableReason: "not_entitled" }] })).toBe(false);
    expect(v({ ...MINIMAL, features: [{ ...MINIMAL.features[0], meters: [] }] })).toBe(false);
    expect(v({ ...MINIMAL, features: [{ ...MINIMAL.features[0], optOut: { optedOut: true, changedAt: NOW } }] })).toBe(false);
    expect(Object.keys(api.schema("AiFeatureAvailability").properties!).sort()).toEqual(["availability", "featureId"]);
  });

  it("never states spend-cap, free-credit or system reasons to a tenant", () => {
    expect(api.schema("AiTenantFacingReasonCode")["enum"]).toEqual([
      "not_entitled",
      "trial_expired",
      "grace_read_only",
      "feature_disabled_tenant",
    ]);
    const v = validator("TenantAiEntitlements");
    for (const reason of ["spend_cap_reached", "free_credit_exhausted", "feature_disabled_system", "not_authorized"]) {
      expect(v({ ...FULL, features: [{ ...FULL.features[0], unavailableReason: reason }] })).toBe(false);
    }
  });

  it("counts requests only, in UTC day or month windows (D-3, D-9)", () => {
    const meter = api.schema("AiRequestMeter");
    expect(meter.properties!["unit"]).toMatchObject({ const: "request" });
    expect(api.schema("AiMeterWindow")["enum"]).toEqual(["day", "month"]);
    const v = validator("TenantAiEntitlements");
    const bad = { ...FULL.features[1].meters[0], remaining: -1 };
    expect(v({ ...FULL, features: [{ ...FULL.features[1], meters: [bad] }] })).toBe(false);
  });

  it("allows only the RT-644 §4.3 lifecycle states and a nullable effectiveUntil", () => {
    expect(api.schema("AiEntitlementState")["enum"]).toEqual(["none", "trial", "active", "grace", "expired", "cancelled"]);
    expect(api.schema("TenantAiEntitlementsFull").properties!["effectiveUntil"]).toMatchObject({ type: ["string", "null"] });
  });

  it("rejects an unknown view and a feature id outside the ai.* namespace", () => {
    const v = validator("TenantAiEntitlements");
    expect(v({ ...MINIMAL, view: "staff" })).toBe(false);
    expect(validator("AiFeatureAvailability")({ featureId: "catalog.doctor", availability: "available" })).toBe(false);
    expect(validator("AiFeatureAvailability")({ featureId: "ai.catalog.doctor", availability: "maybe" })).toBe(false);
  });
});

describe("ai-entitlements — reason codes (§4.4 + D-5)", () => {
  it("is exactly the closed set of AD-AI-ENT-001, feature_disabled_tenant included", () => {
    expect(api.schema("AiEntitlementReasonCode")["enum"]).toEqual(REASON_CODES);
  });
});

describe("ai-entitlements — internal check contract (§4.2)", () => {
  it("is server-internal: marked x-internal and referenced by no operation", () => {
    for (const name of ["AiEntitlementCheckInput", "AiEntitlementDecision", "AiEntitlementAllow", "AiEntitlementDeny"]) {
      expect(api.schema(name)["x-internal"]).toBe(true);
    }
    const operations = JSON.stringify(doc.paths);
    expect(operations).not.toMatch(/AiEntitlementCheckInput|AiEntitlementDecision/);
  });

  it("takes feature, target stores, units and idempotency key, and never a tenant or principal", () => {
    const input = api.schema("AiEntitlementCheckInput");
    expect(Object.keys(input.properties!).sort()).toEqual(["featureId", "idempotencyKey", "targetStores", "unitsEstimate"]);
    const v = validator("AiEntitlementCheckInput");
    expect(v(CHECK_INPUT)).toBe(true);
    expect(v({ ...CHECK_INPUT, tenantId: STORE_REF })).toBe(false);
    expect(v({ ...CHECK_INPUT, userId: STORE_REF })).toBe(false);
    expect(v({ ...CHECK_INPUT, unitsEstimate: 0 })).toBe(false);
    expect(v({ ...CHECK_INPUT, idempotencyKey: "short" })).toBe(false);
    expect(v({ ...CHECK_INPUT, targetStores: [STORE_REF, STORE_REF] })).toBe(false);
  });

  it("allows only with a reservation and no reason", () => {
    const v = validator("AiEntitlementDecision");
    expect(v(ALLOW)).toBe(true);
    const { reservationId: _omit, ...noReservation } = ALLOW;
    expect(v(noReservation)).toBe(false);
    expect(v({ ...ALLOW, reasonCode: "not_entitled" })).toBe(false);
  });

  it("denies only with a closed-set reason and no reservation, failing closed with a null version", () => {
    const v = validator("AiEntitlementDecision");
    expect(v(DENY)).toBe(true);
    const { reasonCode: _omit, ...noReason } = DENY;
    expect(v(noReason)).toBe(false);
    expect(v({ ...DENY, reasonCode: "maybe_later" })).toBe(false);
    expect(v({ ...DENY, reservationId: RESERVATION_ID })).toBe(false);
    expect(api.schema("AiEntitlementDeny").description).toMatch(/entitlement_unavailable/);
  });

  it("never denies with provider_unavailable, an execution outcome, and states the meter on quota_exhausted", () => {
    const v = validator("AiEntitlementDecision");
    expect(api.schema("AiCheckDenyReasonCode")["enum"]).toEqual(REASON_CODES.filter((c) => c !== "provider_unavailable"));
    expect(v({ ...DENY, reasonCode: "provider_unavailable" })).toBe(false);
    expect(v({ ...DENY, reasonCode: "quota_exhausted", entitlementVersion: 3, optOutRevision: 7 })).toBe(false);
    const meter = { meter: "ask_per_month", window: "month", limit: 10, used: 10, reserved: 0, remaining: 0, resetsAt: "2026-11-01T00:00:00Z" };
    expect(v({ ...DENY, reasonCode: "quota_exhausted", entitlementVersion: 3, optOutRevision: 7, meter })).toBe(true);
  });
});

describe("ai-entitlements — owner opt-out write (D-5)", () => {
  it("is owner only, cookieAuth, idempotent and audited", () => {
    const op = optOut();
    expect(op.security).toEqual([{ cookieAuth: [] }]);
    expect((op as Record<string, unknown>)["x-idempotency"]).toBe("required");
    expect(op["x-audit-action"]).toBe("ai_entitlement.opt_out_changed");
    expect(String(doc.components!.securitySchemes!["cookieAuth"]!["description"])).toMatch(/@Roles\("owner"\)`\s+on the opt-out write/);
    expect(api.responseDescription("NotFound")).toMatch(/every role but `owner`\s+on the opt-out write/);
  });

  it("takes the tenant and feature from the path and requires the Idempotency-Key header", () => {
    expect(refs(doc.paths![OPT_OUT_PATH]!["parameters"])).toEqual([
      "#/components/parameters/TenantId",
      "#/components/parameters/FeatureIdPath",
    ]);
    expect(refs(optOut().parameters)).toEqual(["#/components/parameters/IdempotencyKey"]);
    expect(doc.components!.parameters!["IdempotencyKey"]).toMatchObject({ in: "header", required: true });
  });

  it("answers 403 only for origin_rejected, 409 for a stale opt-out revision, 422 not_entitled for an opt-in beyond the plan", () => {
    expect(Object.keys(optOut().responses ?? {}).sort()).toEqual(
      ["200", "400", "401", "403", "404", "409", "422", "425", "429", "500", "503"],
    );
    expect(optOut().responses!["403"]).toEqual({ $ref: "#/components/responses/OriginRejected" });
    expect(api.responseDescription("OptOutConflict")).toMatch(/ai_opt_out_changed_concurrently/);
    expect(api.responseDescription("OptInExceedsPlan")).toMatch(/422 `not_entitled`/);
    expect(REASON_CODES).toContain("not_entitled");
  });

  it("guards the write with its own optOutRevision, never entitlementVersion", () => {
    const body = api.schema("AiFeatureOptOutRequest");
    expect(Object.keys(body.properties!).sort()).toEqual(["expectedOptOutRevision", "optedOut", "reason"]);
    expect(JSON.stringify(body)).not.toMatch(/entitlementVersion/);
    expect(api.schema("TenantAiEntitlementsFull").required).toEqual(
      expect.arrayContaining(["entitlementVersion", "optOutRevision"]),
    );
  });

  it("can only subtract: no tenant, feature, limit, plan, state or grant in the body; reason required", () => {
    const v = validator("AiFeatureOptOutRequest");
    expect(v(OPT_OUT_BODY)).toBe(true);
    expect(v({ ...OPT_OUT_BODY, optedOut: false })).toBe(true);
    for (const extra of [{ tenantId: STORE_REF }, { featureId: "ai.ask" }, { limit: 10 }, { state: "active" }, { grant: true }]) {
      expect(v({ ...OPT_OUT_BODY, ...extra })).toBe(false);
    }
    const { reason: _omit, ...noReason } = OPT_OUT_BODY;
    expect(v(noReason)).toBe(false);
    expect(v({ ...OPT_OUT_BODY, reason: "" })).toBe(false);
    expect(v({ ...OPT_OUT_BODY, expectedOptOutRevision: -1 })).toBe(false);
  });

  it("answers 200 with the updated full view, no-store, with the replay header", () => {
    const ok = optOut().responses!["200"] as unknown as {
      headers: Record<string, { $ref: string }>;
      content: { "application/json": { schema: { $ref: string } } };
    };
    expect(ok.content["application/json"].schema.$ref).toBe("#/components/schemas/TenantAiEntitlementsFull");
    expect(Object.keys(ok.headers).sort()).toEqual(["Cache-Control", "Idempotent-Replayed"]);
  });
});

describe("ai-entitlements — provenance of both sources", () => {
  it("records entitlementVersion and optOutRevision on every decision", () => {
    expect(api.schema("AiEntitlementAllow").required).toEqual(
      expect.arrayContaining(["entitlementVersion", "optOutRevision"]),
    );
    expect(api.schema("AiEntitlementDeny").required).toEqual(
      expect.arrayContaining(["entitlementVersion", "optOutRevision"]),
    );
    const v = validator("AiEntitlementDecision");
    const { optOutRevision: _omit, ...noOptOut } = ALLOW;
    expect(v(noOptOut)).toBe(false);
    expect(v({ ...DENY, reasonCode: "feature_disabled_tenant", entitlementVersion: 3, optOutRevision: 7 })).toBe(true);
  });
});
