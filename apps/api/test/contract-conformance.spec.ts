/**
 * contract-conformance.spec.ts — T300.
 *
 * Strategy: build a minimal Nest app that mounts only the controller under
 * test, with scripted doubles for every injectable dependency. Issue real HTTP
 * requests via Supertest so responses travel through real NestJS
 * serialization + GlobalExceptionFilter. Validate each response body
 * against the schema from `packages/contracts/openapi/*.yaml` using
 * ajv + ajv-formats.
 *
 * Thin slice 1 coverage:
 *   POST /api/v1/auth/signin  200 → SignInResponse
 *   POST /api/v1/auth/signin  401 → Error
 *
 * Thin slice 2 coverage:
 *   GET /api/v1/audit/events  200 → ListAuditEventsResponse
 *   (401/403 intentionally omitted — audit.openapi.yaml defines no schemas
 *   for those responses; bare description lines only.)
 *
 * ajv notes:
 *   - strict: false — OpenAPI schemas contain `nullable`, `example`, etc.
 *     that are not valid JSON Schema keywords; strict mode would throw.
 *   - openapiSchemaToJsonSchema() — the contracts are authored with
 *     OpenAPI 3.0-style `nullable: true` under an `openapi: 3.1.0` header.
 *     ajv sees `type: string` and would reject a null value. The preprocessor
 *     rewrites `{ type: T, nullable: true }` → `{ type: [T, "null"] }` so
 *     the validator correctly accepts null where the contract allows it.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import cookieParser from "cookie-parser";
import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AuthController } from "../src/auth/auth.controller";
import { AuthService } from "../src/auth/auth.service";
import { AuthGuard } from "../src/auth/auth.guard";
import { DashboardAuthGuard } from "../src/auth/dashboard-auth.guard";
import { RateLimiter } from "../src/auth/rate-limit";
import type { SignInResult } from "../src/auth/dto";
import type { RefreshResult } from "../src/auth/auth.service";
import { RolesGuard } from "../src/auth/roles.guard";
import { TenantContextGuard } from "../src/context/tenant-context.guard";
import { AuditController } from "../src/audit/audit.controller";
import { AuditService } from "../src/audit/audit.service";
import type { ListAuditEventsResponse } from "../src/audit/audit.dto";
import type { ListAuditEventsInput } from "../src/audit/audit.service";
import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../src/common/exception.filter";
import { loadOpenApiContracts } from "../src/openapi/loader";
import { InvitationsController } from "../src/memberships/invitations.controller";
import { InvitationsService } from "../src/memberships/invitations.service";
import type { InviteResult } from "../src/memberships/invitations.service";
import type { InvitationRow } from "@data-pulse-2/db/schema";
import { StoresController } from "../src/stores/stores.controller";
import { StoresService } from "../src/stores/stores.service";
import type { StoreRecord } from "../src/stores/stores.repository";
import { TenantsController } from "../src/tenants/tenants.controller";
import { TenantsService } from "../src/tenants/tenants.service";
import type { TenantRecord } from "../src/tenants/tenants.repository";

// ---------------------------------------------------------------------------
// Schema loading + ajv setup
// ---------------------------------------------------------------------------

type JsonSchemaNode = { [key: string]: unknown };

/**
 * Recursively rewrites OpenAPI 3.0-style `{ type: T, nullable: true }` into
 * JSON Schema 2019-09 style `{ type: [T, "null"] }`. This is necessary because
 * the contracts use `nullable: true` for compatibility, but ajv 8 strictly
 * validates against JSON Schema semantics where `nullable` is unknown.
 */
function openapiSchemaToJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(openapiSchemaToJsonSchema);
  }
  if (node === null || typeof node !== "object") {
    return node;
  }

  const obj = node as JsonSchemaNode;
  const result: JsonSchemaNode = {};

  for (const [key, value] of Object.entries(obj)) {
    result[key] = openapiSchemaToJsonSchema(value);
  }

  // Case 1: { type: T, nullable: true } → { type: [T, "null"] }
  if (
    result["nullable"] === true &&
    typeof result["type"] === "string"
  ) {
    result["type"] = [result["type"] as string, "null"];
    delete result["nullable"];
  }

  // Case 2: { $ref: "...", nullable: true } → { anyOf: [{ $ref }, { type: "null" }] }
  // OpenAPI 3.0 places nullable at the same level as $ref; JSON Schema requires anyOf.
  if (result["nullable"] === true && typeof result["$ref"] === "string") {
    const ref = result["$ref"] as string;
    delete result["nullable"];
    delete result["$ref"];
    return { ...result, anyOf: [{ $ref: ref }, { type: "null" }] };
  }

  // Case 3: stray nullable (no type, no $ref) — remove to avoid AJV keyword errors.
  if (result["nullable"] === true) {
    delete result["nullable"];
  }

  return result;
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

/**
 * Loads the contract with the given id from packages/contracts/openapi/ and
 * registers it with ajv as a named schema (`$id` = docId) so that
 * `${docId}#/components/schemas/<Name>` refs resolve. Registration is
 * idempotent — safe to call from every slice's beforeAll regardless of suite
 * ordering. Returns the raw contract document for callers that need to
 * inspect it.
 */
function registerContractSchema(docId: string): object {
  const contracts = loadOpenApiContracts();
  const contract = contracts.find((c) => c.id === docId);
  if (!contract) {
    throw new Error(`${docId} contract not found — check packages/contracts/openapi/`);
  }
  if (!ajv.getSchema(docId)) {
    const processedDoc = openapiSchemaToJsonSchema(contract.document) as object;
    ajv.addSchema({ ...processedDoc, $id: docId });
  }
  return contract.document as object;
}

/** Compiles a validator for `${docId}#/components/schemas/<schemaName>`. */
function compileComponentValidator(docId: string, schemaName: string): ValidateFunction {
  return ajv.compile({ $ref: `${docId}#/components/schemas/${schemaName}` });
}

let validateSignInResponse: ValidateFunction;
let validateError: ValidateFunction;

/** Build ajv validators for the SignInResponse and Error schemas. */
function buildValidators(): void {
  const doc = registerContractSchema("auth.openapi") as {
    components?: { schemas?: Record<string, unknown> };
  };
  const schemas = doc.components?.schemas;
  if (!schemas) {
    throw new Error("auth.openapi contract has no components.schemas");
  }
  if (!schemas["SignInResponse"]) throw new Error("SignInResponse schema not found in auth.openapi");
  if (!schemas["Error"]) throw new Error("Error schema not found in auth.openapi");

  validateSignInResponse = compileComponentValidator("auth.openapi", "SignInResponse");
  validateError = compileComponentValidator("auth.openapi", "Error");
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const FAKE_USER_ID = "0195b100-0000-7000-8000-000000000001";
const FAKE_SESSION_ID = "0195b100-0000-7000-8000-000000000002";

class FakeAuthService {
  public mode: "ok" | "bad-credentials" = "ok";
  public refreshMode: "ok" | "expired" = "ok";
  public confirmPasswordResetThrows = false;
  public confirmEmailVerificationThrows = false;

  async signIn(_email: string, _password: string): Promise<SignInResult> {
    if (this.mode === "bad-credentials") {
      throw new UnauthorizedException("Invalid credentials");
    }
    return {
      sessionId: FAKE_SESSION_ID,
      userId: FAKE_USER_ID,
      absoluteExpiresAt: new Date(Date.now() + 86_400_000),
      user: {
        id: FAKE_USER_ID,
        email: "test@example.com",
        display_name: null,
        is_platform_admin: false,
      },
    };
  }

  async signOut(_sessionId: string): Promise<void> {}

  async refresh(_sessionId: string): Promise<RefreshResult | null> {
    if (this.refreshMode === "expired") return null;
    return {
      sessionId: FAKE_SESSION_ID,
      userId: FAKE_USER_ID,
      absoluteExpiresAt: new Date(Date.now() + 86_400_000),
    };
  }

  async requestPasswordReset(_email: string): Promise<void> {}

  async confirmPasswordReset(_token: string, _newPassword: string): Promise<void> {
    if (this.confirmPasswordResetThrows) {
      throw new BadRequestException("Invalid or expired token");
    }
  }

  async requestEmailVerification(_userId: string): Promise<void> {}

  async confirmEmailVerification(_token: string): Promise<void> {
    if (this.confirmEmailVerificationThrows) {
      throw new BadRequestException("Invalid or expired token");
    }
  }
}

class ScriptedAuthGuard implements CanActivate {
  public mode: "ok" | "reject" = "ok";

  canActivate(ctx: ExecutionContext): boolean {
    if (this.mode === "reject") {
      throw new UnauthorizedException("Unauthorized");
    }
    const req = ctx.switchToHttp().getRequest();
    req.principal = {
      kind: "session",
      sessionId: FAKE_SESSION_ID,
      userId: FAKE_USER_ID,
    };
    return true;
  }
}

/** No-op RateLimiter — always allows. */
class ScriptedRateLimiter {
  async check(): Promise<{ allowed: true; count: 1; remaining: 999; resetMs: 60000 }> {
    return { allowed: true, count: 1, remaining: 999, resetMs: 60_000 };
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let app: INestApplication;
let fakeAuth: FakeAuthService;
let authGuard: ScriptedAuthGuard;

beforeAll(async () => {
  buildValidators();

  fakeAuth = new FakeAuthService();
  authGuard = new ScriptedAuthGuard();
  const rateLimiter = new ScriptedRateLimiter();

  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      { provide: AuthService, useValue: fakeAuth },
      { provide: RateLimiter, useValue: rateLimiter },
    ],
  })
    .overrideGuard(AuthGuard)
    .useValue(authGuard)
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.use(cookieParser());
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(() => {
  fakeAuth.mode = "ok";
  fakeAuth.refreshMode = "ok";
  fakeAuth.confirmPasswordResetThrows = false;
  fakeAuth.confirmEmailVerificationThrows = false;
  authGuard.mode = "ok";
});

function http() {
  return request(app.getHttpServer());
}

function assertNoBody(res: { text: string }): void {
  expect(res.text).toBe("");
}

function assertConformsTo(validate: ValidateFunction, body: unknown): void {
  const valid = validate(body);
  if (!valid) {
    throw new Error(
      `Contract violation:\n${JSON.stringify(validate.errors, null, 2)}\n\nActual body:\n${JSON.stringify(body, null, 2)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Shared scripted guards
//
// Most slices override DashboardAuthGuard / TenantContextGuard / RolesGuard
// with stateless doubles that differ only in the ids they inject. Build them
// via these factories instead of one bespoke class per slice.
// ---------------------------------------------------------------------------

/** Builds a guard that populates request.principal (AuthGuard contract). */
function makePrincipalGuard(sessionId: string, userId: string): CanActivate {
  return {
    canActivate(ctx: ExecutionContext): boolean {
      const req = ctx.switchToHttp().getRequest();
      req.principal = { kind: "session", sessionId, userId };
      return true;
    },
  };
}

/**
 * Builds a guard that populates request.context (TenantContextGuard contract)
 * for a tenant-wide (storeId: null), non-admin session principal. Controllers
 * read context.tenantId etc. and throw a defensive 401 when fields are missing.
 */
function makeTenantContextGuard(userId: string, tenantId: string): CanActivate {
  return {
    canActivate(ctx: ExecutionContext): boolean {
      const req = ctx.switchToHttp().getRequest();
      req.context = {
        userId,
        tenantId,
        storeId: null,
        isPlatformAdmin: false,
        source: "session" as const,
      };
      return true;
    },
  };
}

/** No-op guard — always allows (RolesGuard stand-in). */
const ALLOW_ALL_GUARD: CanActivate = { canActivate: () => true };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/signin — contract conformance (T300)", () => {
  describe("200 SignInResponse", () => {
    it("response body conforms to SignInResponse schema", async () => {
      const res = await http()
        .post("/api/v1/auth/signin")
        .send({ email: "test@example.com", password: "correct-password" })
        .expect(200);

      assertConformsTo(validateSignInResponse, res.body);
    });

    it("200 body has user with nullable display_name accepted as null", async () => {
      const res = await http()
        .post("/api/v1/auth/signin")
        .send({ email: "test@example.com", password: "correct-password" })
        .expect(200);

      // Explicit shape check: display_name=null must not fail the validator
      expect(res.body.user.display_name).toBeNull();
      assertConformsTo(validateSignInResponse, res.body);
    });

    it("200 body has memberships array", async () => {
      const res = await http()
        .post("/api/v1/auth/signin")
        .send({ email: "test@example.com", password: "correct-password" })
        .expect(200);

      expect(Array.isArray(res.body.memberships)).toBe(true);
      assertConformsTo(validateSignInResponse, res.body);
    });

    it("200 body user.id is a valid UUID", async () => {
      const res = await http()
        .post("/api/v1/auth/signin")
        .send({ email: "test@example.com", password: "correct-password" })
        .expect(200);

      expect(typeof res.body.user.id).toBe("string");
      assertConformsTo(validateSignInResponse, res.body);
    });
  });

  describe("401 Error", () => {
    it("response body conforms to Error schema on bad credentials", async () => {
      fakeAuth.mode = "bad-credentials";

      const res = await http()
        .post("/api/v1/auth/signin")
        .send({ email: "test@example.com", password: "wrong-password" })
        .expect(401);

      assertConformsTo(validateError, res.body);
    });

    it("401 error envelope has required code and message fields", async () => {
      fakeAuth.mode = "bad-credentials";

      const res = await http()
        .post("/api/v1/auth/signin")
        .send({ email: "test@example.com", password: "wrong-password" })
        .expect(401);

      expect(res.body).toMatchObject({
        error: {
          code: expect.any(String),
          message: expect.any(String),
        },
      });
      assertConformsTo(validateError, res.body);
    });
  });
});

// =============================================================================
// T300 thin slice 2 — GET /api/v1/audit/events
// =============================================================================
//
// audit.openapi.yaml defines schemas ONLY for the 200 response.
// 401 and 403 are bare description lines with no content/schema —
// conformance validation for those statuses is intentionally omitted.

// ---------------------------------------------------------------------------
// Schema loading — audit validators
// ---------------------------------------------------------------------------

// JSON Pointer path to the inline 200 response schema in audit.openapi.yaml.
// RFC 6901 tilde-encoding: '/' in a path segment → '~1'.
// The full path is:
//   paths./api/v1/audit/events.get.responses.200.content.application/json.schema
const AUDIT_200_REF =
  "audit.openapi#/paths/~1api~1v1~1audit~1events/get/responses/200/content/application~1json/schema";

let validateListAuditEventsResponse: ValidateFunction;

function buildAuditValidators(): void {
  registerContractSchema("audit.openapi");
  // The 200 schema is inline (not a named component), referenced via JSON Pointer.
  // AuditEvent lives in components.schemas and is reached transitively via $ref.
  validateListAuditEventsResponse = ajv.compile({ $ref: AUDIT_200_REF });
}

// ---------------------------------------------------------------------------
// Test doubles — audit slice
// ---------------------------------------------------------------------------

const FAKE_TENANT_ID = "0195b100-0000-7000-8000-000000000010";
const FAKE_AUDIT_USER_ID = "0195b100-0000-7000-8000-000000000001";
const FAKE_AUDIT_SESSION_ID = "0195b100-0000-7000-8000-000000000002";
const FAKE_AUDIT_EVENT_ID = "0195b100-0000-7000-8000-000000000020";

class FakeAuditService {
  public response: ListAuditEventsResponse = { items: [], next_cursor: null };

  async list(_input: ListAuditEventsInput): Promise<ListAuditEventsResponse> {
    return this.response;
  }
}

// ---------------------------------------------------------------------------
// Fixture — audit app
// ---------------------------------------------------------------------------

let auditApp: INestApplication;
let fakeAuditService: FakeAuditService;

beforeAll(async () => {
  buildAuditValidators();

  fakeAuditService = new FakeAuditService();

  const moduleRef = await Test.createTestingModule({
    controllers: [AuditController],
    providers: [
      { provide: AuditService, useValue: fakeAuditService },
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue(makePrincipalGuard(FAKE_AUDIT_SESSION_ID, FAKE_AUDIT_USER_ID))
    .overrideGuard(TenantContextGuard)
    .useValue(makeTenantContextGuard(FAKE_AUDIT_USER_ID, FAKE_TENANT_ID))
    .overrideGuard(RolesGuard)
    .useValue(ALLOW_ALL_GUARD)
    .compile();

  auditApp = moduleRef.createNestApplication({ bufferLogs: true });
  auditApp.use(cookieParser());
  auditApp.useGlobalPipes(new ZodValidationPipe());
  auditApp.useGlobalFilters(new GlobalExceptionFilter());
  await auditApp.init();
});

afterAll(async () => {
  if (auditApp) await auditApp.close();
});

beforeEach(() => {
  fakeAuditService.response = { items: [], next_cursor: null };
});

function auditHttp() {
  return request(auditApp.getHttpServer());
}

// ---------------------------------------------------------------------------
// Tests — GET /api/v1/audit/events
// ---------------------------------------------------------------------------

describe("GET /api/v1/audit/events — contract conformance (T300)", () => {
  describe("200 empty page", () => {
    it("response body conforms to ListAuditEventsResponse schema", async () => {
      const res = await auditHttp()
        .get("/api/v1/audit/events")
        .expect(200);

      assertConformsTo(validateListAuditEventsResponse, res.body);
    });

    it("empty items array and null next_cursor are accepted by the schema", async () => {
      const res = await auditHttp()
        .get("/api/v1/audit/events")
        .expect(200);

      expect(res.body.items).toEqual([]);
      expect(res.body.next_cursor).toBeNull();
      assertConformsTo(validateListAuditEventsResponse, res.body);
    });
  });

  describe("200 one item — all nullable fields as null", () => {
    beforeEach(() => {
      fakeAuditService.response = {
        items: [
          {
            id: FAKE_AUDIT_EVENT_ID,
            occurred_at: new Date("2026-01-15T10:00:00.000Z").toISOString(),
            actor_user_id: null,
            actor_label: null,
            tenant_id: FAKE_TENANT_ID,
            store_id: null,
            action: "auth.signin.ok",
            target_type: null,
            target_id: null,
            request_id: null,
            metadata: {},
          },
        ],
        next_cursor: null,
      };
    });

    it("response body conforms to schema with all nullable AuditEvent fields as null", async () => {
      const res = await auditHttp()
        .get("/api/v1/audit/events")
        .expect(200);

      assertConformsTo(validateListAuditEventsResponse, res.body);
    });

    it("nullable fields actor_user_id, actor_label, store_id, target_type, target_id, request_id are null", async () => {
      const res = await auditHttp()
        .get("/api/v1/audit/events")
        .expect(200);

      const item = res.body.items[0];
      expect(item.actor_user_id).toBeNull();
      expect(item.actor_label).toBeNull();
      expect(item.store_id).toBeNull();
      expect(item.target_type).toBeNull();
      expect(item.target_id).toBeNull();
      expect(item.request_id).toBeNull();
      assertConformsTo(validateListAuditEventsResponse, res.body);
    });
  });

  describe("200 one item — non-null next_cursor", () => {
    beforeEach(() => {
      fakeAuditService.response = {
        items: [
          {
            id: FAKE_AUDIT_EVENT_ID,
            occurred_at: new Date("2026-01-15T10:00:00.000Z").toISOString(),
            actor_user_id: FAKE_AUDIT_USER_ID,
            actor_label: "test@example.com",
            tenant_id: FAKE_TENANT_ID,
            store_id: null,
            action: "auth.signin.ok",
            target_type: "user",
            target_id: FAKE_AUDIT_USER_ID,
            request_id: "0195b100-0000-7000-8000-000000000099",
            metadata: { ip: "127.0.0.1" },
          },
        ],
        next_cursor: "dGVzdC1jdXJzb3I",
      };
    });

    it("response body conforms to schema when next_cursor is a non-null string", async () => {
      const res = await auditHttp()
        .get("/api/v1/audit/events")
        .expect(200);

      assertConformsTo(validateListAuditEventsResponse, res.body);
    });

    it("next_cursor is returned as a string", async () => {
      const res = await auditHttp()
        .get("/api/v1/audit/events")
        .expect(200);

      expect(typeof res.body.next_cursor).toBe("string");
      assertConformsTo(validateListAuditEventsResponse, res.body);
    });
  });
});

// =============================================================================
// T300 thin slice 3 — POST /api/pos/v1/audit-events
// =============================================================================
//
// pos-audit-events.openapi.yaml defines named component schemas for ALL
// response statuses (200, 400, 401). All three are tested here.
//
// The Clerk JWT is optional for this endpoint; the fake ClerkVerifier is
// wired but never called in the happy-path tests (no Authorization header).

import { PosAuditEventsController } from "../src/pos-audit-events/pos-audit-events.controller";
import { PosAuditEventsService } from "../src/pos-audit-events/pos-audit-events.service";
import { CLERK_VERIFIER, type ClerkVerifier } from "../src/pos-operators/clerk-verifier";
import type {
  PosAuditEventsSyncInput,
  PosAuditEventsSyncResponseBody,
} from "../src/pos-audit-events/dto";
import { PosOperatorsController } from "../src/pos-operators/pos-operators.controller";
import { PosOperatorsService } from "../src/pos-operators/pos-operators.service";
import type {
  PosActiveSessionResponseBody,
  PosOperatorSignInResponseBody,
  PosOperatorSignOutResponseBody,
  PosRosterResponseBody,
} from "../src/pos-operators/dto";

// ---------------------------------------------------------------------------
// Schema loading — pos-audit-events validators
// ---------------------------------------------------------------------------

const POS_AUDIT_DOC_ID = "pos-audit-events.openapi";

let validatePosAuditSyncResponse: ValidateFunction;
let validatePosAuditError: ValidateFunction;

function buildPosAuditValidators(): void {
  registerContractSchema(POS_AUDIT_DOC_ID);
  validatePosAuditSyncResponse = compileComponentValidator(POS_AUDIT_DOC_ID, "PosAuditEventsSyncResponse");
  validatePosAuditError = compileComponentValidator(POS_AUDIT_DOC_ID, "Error");
}

// ---------------------------------------------------------------------------
// Test doubles — pos-audit-events slice
// ---------------------------------------------------------------------------

const FAKE_POS_EVENT_ID = "0195b200-0000-7000-8000-000000000001";

class FakePosAuditEventsService {
  public response: PosAuditEventsSyncResponseBody | { kind: "device_invalid" } = {
    accepted: [],
    duplicates: [],
    rejected: [],
  };

  async syncBatch(
    _body: PosAuditEventsSyncInput,
    _requestId: string | null,
  ): Promise<PosAuditEventsSyncResponseBody | { kind: "device_invalid" }> {
    return this.response;
  }
}

/** Fake ClerkVerifier — always succeeds (JWT optional on this endpoint). */
class PosAuditFakeClerkVerifier implements ClerkVerifier {
  async verify(_rawJwt: string): Promise<{ sub: string }> {
    return { sub: "user_fake_clerk_sub" };
  }
}

// ---------------------------------------------------------------------------
// Fixture — pos-audit-events app
// ---------------------------------------------------------------------------

let posAuditApp: INestApplication;
let fakePosAuditService: FakePosAuditEventsService;

beforeAll(async () => {
  buildPosAuditValidators();

  fakePosAuditService = new FakePosAuditEventsService();

  const moduleRef = await Test.createTestingModule({
    controllers: [PosAuditEventsController],
    providers: [
      { provide: PosAuditEventsService, useValue: fakePosAuditService },
      { provide: CLERK_VERIFIER, useValue: new PosAuditFakeClerkVerifier() },
    ],
  }).compile();

  posAuditApp = moduleRef.createNestApplication({ bufferLogs: true });
  posAuditApp.useGlobalPipes(new ZodValidationPipe());
  posAuditApp.useGlobalFilters(new GlobalExceptionFilter());
  await posAuditApp.init();
});

afterAll(async () => {
  if (posAuditApp) await posAuditApp.close();
});

beforeEach(() => {
  fakePosAuditService.response = { accepted: [], duplicates: [], rejected: [] };
});

function posAuditHttp() {
  return request(posAuditApp.getHttpServer());
}

/** Minimal valid request body — device attestation + one well-formed event. */
function makeValidSyncBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    device_token_attestation: "fake-attestation-token",
    events: [
      {
        event_id: FAKE_POS_EVENT_ID,
        tenant_id: "0195b200-0000-7000-8000-000000000010",
        branch_id: "0195b200-0000-7000-8000-000000000020",
        originating_terminal_id: "0195b200-0000-7000-8000-000000000030",
        acting_operator_id: "user_clerk_fake_sub",
        action_category: "shift.open",
        created_at: "2026-01-15T10:00:00.000Z",
        payload: { shift_id: "0195b200-0000-7000-8000-000000000040", opened_at: "2026-01-15T10:00:00.000Z" },
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — POST /api/pos/v1/audit-events
// ---------------------------------------------------------------------------

describe("POST /api/pos/v1/audit-events — contract conformance (T300)", () => {
  describe("200 — accepted response", () => {
    beforeEach(() => {
      fakePosAuditService.response = {
        accepted: [FAKE_POS_EVENT_ID],
        duplicates: [],
        rejected: [],
      };
    });

    it("response body conforms to PosAuditEventsSyncResponse schema", async () => {
      const res = await posAuditHttp()
        .post("/api/pos/v1/audit-events")
        .send(makeValidSyncBody())
        .expect(200);

      assertConformsTo(validatePosAuditSyncResponse, res.body);
    });

    it("accepted contains the submitted event_id; duplicates and rejected are empty arrays", async () => {
      const res = await posAuditHttp()
        .post("/api/pos/v1/audit-events")
        .send(makeValidSyncBody())
        .expect(200);

      expect(res.body.accepted).toEqual([FAKE_POS_EVENT_ID]);
      expect(res.body.duplicates).toEqual([]);
      expect(res.body.rejected).toEqual([]);
      assertConformsTo(validatePosAuditSyncResponse, res.body);
    });
  });

  describe("200 — rejected response (schema_violation)", () => {
    beforeEach(() => {
      fakePosAuditService.response = {
        accepted: [],
        duplicates: [],
        rejected: [{ event_id: FAKE_POS_EVENT_ID, category: "schema_violation" }],
      };
    });

    it("response body conforms to PosAuditEventsSyncResponse schema with non-empty rejected array", async () => {
      const res = await posAuditHttp()
        .post("/api/pos/v1/audit-events")
        .send(makeValidSyncBody())
        .expect(200);

      assertConformsTo(validatePosAuditSyncResponse, res.body);
    });

    it("rejected[0].category is schema_violation (valid enum member)", async () => {
      const res = await posAuditHttp()
        .post("/api/pos/v1/audit-events")
        .send(makeValidSyncBody())
        .expect(200);

      expect(res.body.rejected).toHaveLength(1);
      expect(res.body.rejected[0]).toMatchObject({
        event_id: FAKE_POS_EVENT_ID,
        category: "schema_violation",
      });
      assertConformsTo(validatePosAuditSyncResponse, res.body);
    });
  });

  describe("200 — duplicates response", () => {
    beforeEach(() => {
      fakePosAuditService.response = {
        accepted: [],
        duplicates: [FAKE_POS_EVENT_ID],
        rejected: [],
      };
    });

    it("response body conforms to PosAuditEventsSyncResponse schema with non-empty duplicates array", async () => {
      const res = await posAuditHttp()
        .post("/api/pos/v1/audit-events")
        .send(makeValidSyncBody())
        .expect(200);

      expect(res.body.duplicates).toEqual([FAKE_POS_EVENT_ID]);
      assertConformsTo(validatePosAuditSyncResponse, res.body);
    });
  });

  describe("400 — structural validation error", () => {
    it("response body conforms to Error schema when events array is empty", async () => {
      const res = await posAuditHttp()
        .post("/api/pos/v1/audit-events")
        .send({ device_token_attestation: "fake-attestation-token", events: [] })
        .expect(400);

      assertConformsTo(validatePosAuditError, res.body);
    });

    it("response body conforms to Error schema when device_token_attestation is missing", async () => {
      const res = await posAuditHttp()
        .post("/api/pos/v1/audit-events")
        .send({ events: [makeValidSyncBody().events] })
        .expect(400);

      assertConformsTo(validatePosAuditError, res.body);
    });
  });

  describe("401 — device invalid", () => {
    beforeEach(() => {
      fakePosAuditService.response = { kind: "device_invalid" };
    });

    it("response body conforms to Error schema when device attestation is rejected", async () => {
      const res = await posAuditHttp()
        .post("/api/pos/v1/audit-events")
        .send(makeValidSyncBody())
        .expect(401);

      assertConformsTo(validatePosAuditError, res.body);
    });
  });
});

// =============================================================================
// SLICE 4 — POST /api/pos/v1/operators/sign-out
// =============================================================================
//
// pos-operators.openapi.yaml defines named component schemas for the 200 and
// 401 response statuses. No 400 is defined for this endpoint in the YAML.
//
// PosOperatorsController does NOT use @UseGuards() — it calls extractBearer()
// internally. This means no guard override is needed in the test module.

// ---------------------------------------------------------------------------
// Schema loading — pos-operators validators
// ---------------------------------------------------------------------------

const POS_OPERATORS_DOC_ID = "pos-operators.openapi";

let validatePosSignOutResponse: ValidateFunction;
let validatePosOperatorsError: ValidateFunction;
let validatePosSignInSucceeded: ValidateFunction;
let validatePosTakeoverRequired: ValidateFunction;
let validatePosActiveSessionResponse: ValidateFunction;
let validatePosRosterResponse: ValidateFunction;

function buildPosOperatorsValidators(): void {
  registerContractSchema(POS_OPERATORS_DOC_ID);
  validatePosSignOutResponse = compileComponentValidator(POS_OPERATORS_DOC_ID, "PosOperatorSignOutResponse");
  validatePosOperatorsError = compileComponentValidator(POS_OPERATORS_DOC_ID, "Error");
  validatePosSignInSucceeded = compileComponentValidator(POS_OPERATORS_DOC_ID, "PosOperatorSignInSucceeded");
  validatePosTakeoverRequired = compileComponentValidator(POS_OPERATORS_DOC_ID, "PosOperatorTakeoverRequired");
  validatePosActiveSessionResponse = compileComponentValidator(POS_OPERATORS_DOC_ID, "PosActiveSessionResponse");
  validatePosRosterResponse = compileComponentValidator(POS_OPERATORS_DOC_ID, "PosRosterResponse");
}

/**
 * Shared 401 assertion for the pos-operators surface: the envelope must
 * carry error.code + error.message and conform to the contract Error schema.
 */
function expectPosOperatorsUnauthorizedEnvelope(body: unknown): void {
  expect(body).toMatchObject({
    error: {
      code: expect.any(String),
      message: expect.any(String),
    },
  });
  assertConformsTo(validatePosOperatorsError, body);
}

// ---------------------------------------------------------------------------
// Fake service
// ---------------------------------------------------------------------------

class FakePosOperatorsService {
  public signOutResult: PosOperatorSignOutResponseBody | { kind: "refused" } = {
    kind: "signed_out",
  };

  public signInResult: PosOperatorSignInResponseBody | { kind: "refused" } = {
    kind: "refused",
  };

  public activeSessionResult: PosActiveSessionResponseBody | { kind: "refused" } = {
    kind: "refused",
  };

  public takeoverConfirmResult: PosOperatorSignInResponseBody | { kind: "refused" } = {
    kind: "refused",
  };

  public rosterResult: PosRosterResponseBody | { kind: "refused" } = {
    kind: "refused",
  };

  async signIn(
    _rawJwt: string,
    _body: unknown,
    _requestId: string,
  ): Promise<PosOperatorSignInResponseBody | { kind: "refused" }> {
    return this.signInResult;
  }

  async signOut(
    _rawJwt: string,
    _body: unknown,
    _requestId: string,
  ): Promise<PosOperatorSignOutResponseBody | { kind: "refused" }> {
    return this.signOutResult;
  }

  async activeSession(
    _rawJwt: string,
    _query: unknown,
    _requestId: string,
  ): Promise<PosActiveSessionResponseBody | { kind: "refused" }> {
    return this.activeSessionResult;
  }

  async takeoverConfirm(
    _rawJwt: string,
    _body: unknown,
    _requestId: string,
  ): Promise<PosOperatorSignInResponseBody | { kind: "refused" }> {
    return this.takeoverConfirmResult;
  }

  async roster(
    _rawJwt: string,
    _query: unknown,
    _requestId: string,
  ): Promise<PosRosterResponseBody | { kind: "refused" }> {
    return this.rosterResult;
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FAKE_POS_OPERATORS_SESSION_ID = "0195b300-0000-7000-8000-000000000001";

let posOperatorsApp: INestApplication;
let fakePosOperatorsService: FakePosOperatorsService;

beforeAll(async () => {
  buildPosOperatorsValidators();
  fakePosOperatorsService = new FakePosOperatorsService();

  const moduleRef = await Test.createTestingModule({
    controllers: [PosOperatorsController],
    providers: [
      { provide: PosOperatorsService, useValue: fakePosOperatorsService },
    ],
  }).compile();

  posOperatorsApp = moduleRef.createNestApplication({ bufferLogs: true });
  posOperatorsApp.useGlobalPipes(new ZodValidationPipe());
  posOperatorsApp.useGlobalFilters(new GlobalExceptionFilter());
  await posOperatorsApp.init();
});

afterAll(async () => {
  if (posOperatorsApp) await posOperatorsApp.close();
});

beforeEach(() => {
  fakePosOperatorsService.signOutResult = { kind: "signed_out" };
  fakePosOperatorsService.signInResult = { kind: "refused" };
  fakePosOperatorsService.activeSessionResult = { kind: "refused" };
  fakePosOperatorsService.takeoverConfirmResult = { kind: "refused" };
  fakePosOperatorsService.rosterResult = { kind: "refused" };
});

function posOperatorsHttp() {
  return request(posOperatorsApp.getHttpServer());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/pos/v1/operators/sign-out — contract conformance (T300)", () => {
  describe("200 — signed_out", () => {
    it("response body conforms to PosOperatorSignOutResponse schema", async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/sign-out")
        .set("Authorization", "Bearer fake-jwt-token")
        .send({ session_id: FAKE_POS_OPERATORS_SESSION_ID })
        .expect(200);

      assertConformsTo(validatePosSignOutResponse, res.body);
    });

    it('body.kind is exactly "signed_out"', async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/sign-out")
        .set("Authorization", "Bearer fake-jwt-token")
        .send({ session_id: FAKE_POS_OPERATORS_SESSION_ID })
        .expect(200);

      expect(res.body.kind).toBe("signed_out");
      assertConformsTo(validatePosSignOutResponse, res.body);
    });
  });

  describe("401 — missing Bearer token", () => {
    it("response body conforms to Error schema when Authorization header is absent", async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/sign-out")
        .send({ session_id: FAKE_POS_OPERATORS_SESSION_ID })
        .expect(401);

      assertConformsTo(validatePosOperatorsError, res.body);
    });

    it("401 error envelope has required error.code and error.message fields", async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/sign-out")
        .send({ session_id: FAKE_POS_OPERATORS_SESSION_ID })
        .expect(401);

      expectPosOperatorsUnauthorizedEnvelope(res.body);
    });
  });

  describe("401 — service refuses", () => {
    beforeEach(() => {
      fakePosOperatorsService.signOutResult = { kind: "refused" };
    });

    it("response body conforms to Error schema when service returns refused", async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/sign-out")
        .set("Authorization", "Bearer fake-jwt-token")
        .send({ session_id: FAKE_POS_OPERATORS_SESSION_ID })
        .expect(401);

      assertConformsTo(validatePosOperatorsError, res.body);
    });
  });
});

// =============================================================================
// SLICE 5 — POST /api/pos/v1/operators/sign-in
// =============================================================================
//
// pos-operators.openapi.yaml defines two named 200 variant schemas:
//   - PosOperatorSignInSucceeded  (kind: signed_in)
//   - PosOperatorTakeoverRequired (kind: takeover_required)
// and a 401 using the shared Error schema.
//
// Each variant is validated directly against its named component schema —
// not against the full oneOf union — consistent with the slice 4 pattern.
//
// The same posOperatorsApp fixture from slice 4 is reused: PosOperatorsController
// handles both sign-in and sign-out, so no new Nest app is needed.

const FAKE_POS_SIGN_IN_SESSION_ID = "0195b400-0000-7000-8000-000000000001";
const FAKE_POS_SIGN_IN_TENANT_ID = "0195b400-0000-7000-8000-000000000010";
const FAKE_POS_SIGN_IN_BRANCH_ID = "0195b400-0000-7000-8000-000000000020";

function makeSignInBody(): Record<string, unknown> {
  return {
    kind: "manager_admin",
    device_token_attestation: "fake-attestation",
  };
}

function makeSignedInResult(): PosOperatorSignInResponseBody {
  return {
    kind: "signed_in",
    operator: {
      id: "user_fake_clerk_sub",
      // 033: provider-neutral users.id (§16), required on PosOperatorSummary.
      // Distinct from `id` (= clerk_user_id, the v1 bridge).
      user_id: "0195b400-0000-7000-8000-000000000099",
      display_name: "Test Operator",
      role: "manager",
      tenant_id: FAKE_POS_SIGN_IN_TENANT_ID,
      branch_id: FAKE_POS_SIGN_IN_BRANCH_ID,
    },
    operator_session: {
      id: FAKE_POS_SIGN_IN_SESSION_ID,
      issued_at: new Date("2026-01-15T10:00:00.000Z").toISOString(),
      // 031 D1: a fresh issue returns the client-presentable envelope.
      envelope: "fake-operator-authorization-envelope-raw-token",
    },
  };
}

describe("POST /api/pos/v1/operators/sign-in — contract conformance (T300)", () => {
  describe("200 — signed_in", () => {
    beforeEach(() => {
      fakePosOperatorsService.signInResult = makeSignedInResult();
    });

    it("response body conforms to PosOperatorSignInSucceeded schema", async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/sign-in")
        .set("Authorization", "Bearer fake-jwt-token")
        .send(makeSignInBody())
        .expect(200);

      assertConformsTo(validatePosSignInSucceeded, res.body);
    });

    it('body.kind is exactly "signed_in"', async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/sign-in")
        .set("Authorization", "Bearer fake-jwt-token")
        .send(makeSignInBody())
        .expect(200);

      expect(res.body.kind).toBe("signed_in");
      assertConformsTo(validatePosSignInSucceeded, res.body);
    });

    it("operator and operator_session fields are present and schema-valid", async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/sign-in")
        .set("Authorization", "Bearer fake-jwt-token")
        .send(makeSignInBody())
        .expect(200);

      expect(res.body.operator).toBeDefined();
      expect(typeof res.body.operator.id).toBe("string");
      expect(res.body.operator_session).toBeDefined();
      expect(typeof res.body.operator_session.id).toBe("string");
      assertConformsTo(validatePosSignInSucceeded, res.body);
    });
  });

  describe("200 — takeover_required", () => {
    beforeEach(() => {
      fakePosOperatorsService.signInResult = { kind: "takeover_required" };
    });

    it("response body conforms to PosOperatorTakeoverRequired schema", async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/sign-in")
        .set("Authorization", "Bearer fake-jwt-token")
        .send(makeSignInBody())
        .expect(200);

      assertConformsTo(validatePosTakeoverRequired, res.body);
    });

    it('body.kind is exactly "takeover_required"', async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/sign-in")
        .set("Authorization", "Bearer fake-jwt-token")
        .send(makeSignInBody())
        .expect(200);

      expect(res.body.kind).toBe("takeover_required");
      assertConformsTo(validatePosTakeoverRequired, res.body);
    });
  });

  describe("401 — missing Bearer token", () => {
    it("response body conforms to Error schema when Authorization header is absent", async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/sign-in")
        .send(makeSignInBody())
        .expect(401);

      assertConformsTo(validatePosOperatorsError, res.body);
    });

    it("401 error envelope has required error.code and error.message fields", async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/sign-in")
        .send(makeSignInBody())
        .expect(401);

      expectPosOperatorsUnauthorizedEnvelope(res.body);
    });
  });

  describe("401 — service refuses", () => {
    it("response body conforms to Error schema when service returns refused", async () => {
      // signInResult is reset to { kind: "refused" } by the outer beforeEach
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/sign-in")
        .set("Authorization", "Bearer fake-jwt-token")
        .send(makeSignInBody())
        .expect(401);

      assertConformsTo(validatePosOperatorsError, res.body);
    });
  });
});

// =============================================================================
// SLICE 6 — GET /api/pos/v1/operators/active-session
// =============================================================================
//
// pos-operators.openapi.yaml defines one 200 schema (PosActiveSessionResponse)
// with two enum values for `kind` (none / active), and a 401 using the shared
// Error schema. No 400 response body is defined in the contract.
//
// The same posOperatorsApp fixture is reused. FakePosOperatorsService gains
// activeSessionResult + activeSession() — same pattern as signInResult.
//
// NestJS resolves @Query() parameter pipes before the method body executes,
// so missing-Bearer 401 tests must include both required query params
// (?branch_id=...&operator_id=...) to avoid hitting the Zod query validation 400 first.

const FAKE_ACTIVE_SESSION_BRANCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FAKE_ACTIVE_SESSION_OPERATOR_ID = "user_fake_clerk_sub";
const FAKE_ACTIVE_SESSION_QUERY = `branch_id=${FAKE_ACTIVE_SESSION_BRANCH_ID}&operator_id=${FAKE_ACTIVE_SESSION_OPERATOR_ID}`;

describe("GET /api/pos/v1/operators/active-session — contract conformance (T300)", () => {
  describe("200 — kind: none", () => {
    beforeEach(() => {
      fakePosOperatorsService.activeSessionResult = { kind: "none" };
    });

    it("response body conforms to PosActiveSessionResponse schema", async () => {
      const res = await posOperatorsHttp()
        .get(`/api/pos/v1/operators/active-session?${FAKE_ACTIVE_SESSION_QUERY}`)
        .set("Authorization", "Bearer fake-jwt-token")
        .expect(200);

      assertConformsTo(validatePosActiveSessionResponse, res.body);
    });

    it('body.kind is exactly "none"', async () => {
      const res = await posOperatorsHttp()
        .get(`/api/pos/v1/operators/active-session?${FAKE_ACTIVE_SESSION_QUERY}`)
        .set("Authorization", "Bearer fake-jwt-token")
        .expect(200);

      expect(res.body.kind).toBe("none");
      assertConformsTo(validatePosActiveSessionResponse, res.body);
    });
  });

  describe("200 — kind: active", () => {
    beforeEach(() => {
      fakePosOperatorsService.activeSessionResult = { kind: "active" };
    });

    it("response body conforms to PosActiveSessionResponse schema", async () => {
      const res = await posOperatorsHttp()
        .get(`/api/pos/v1/operators/active-session?${FAKE_ACTIVE_SESSION_QUERY}`)
        .set("Authorization", "Bearer fake-jwt-token")
        .expect(200);

      assertConformsTo(validatePosActiveSessionResponse, res.body);
    });

    it('body.kind is exactly "active"', async () => {
      const res = await posOperatorsHttp()
        .get(`/api/pos/v1/operators/active-session?${FAKE_ACTIVE_SESSION_QUERY}`)
        .set("Authorization", "Bearer fake-jwt-token")
        .expect(200);

      expect(res.body.kind).toBe("active");
      assertConformsTo(validatePosActiveSessionResponse, res.body);
    });
  });

  describe("401 — missing Bearer token", () => {
    it("response body conforms to Error schema when Authorization header is absent", async () => {
      const res = await posOperatorsHttp()
        .get(`/api/pos/v1/operators/active-session?${FAKE_ACTIVE_SESSION_QUERY}`)
        .expect(401);

      assertConformsTo(validatePosOperatorsError, res.body);
    });

    it("401 error envelope has required error.code and error.message fields", async () => {
      const res = await posOperatorsHttp()
        .get(`/api/pos/v1/operators/active-session?${FAKE_ACTIVE_SESSION_QUERY}`)
        .expect(401);

      expectPosOperatorsUnauthorizedEnvelope(res.body);
    });
  });

  describe("401 — service refuses", () => {
    it("response body conforms to Error schema when service returns refused", async () => {
      // activeSessionResult is reset to { kind: "refused" } by the outer beforeEach
      const res = await posOperatorsHttp()
        .get(`/api/pos/v1/operators/active-session?${FAKE_ACTIVE_SESSION_QUERY}`)
        .set("Authorization", "Bearer fake-jwt-token")
        .expect(401);

      assertConformsTo(validatePosOperatorsError, res.body);
    });
  });
});

// =============================================================================
// SLICE 7 — POST /api/pos/v1/operators/takeover/confirm
// =============================================================================
//
// pos-operators.openapi.yaml defines only 200 and 401 for this endpoint.
// 200 uses PosOperatorSignInSucceeded (same schema as sign-in success).
// 401 uses the shared Error schema.
// No 400 body schema is defined in the contract — 400 tests are omitted.
//
// The same posOperatorsApp fixture is reused: PosOperatorsController handles
// all five POS operator routes including takeover/confirm.

const FAKE_TAKEOVER_EVENT_ID = "0195b500-0000-7000-8000-000000000001";

function makeConfirmBody(): Record<string, unknown> {
  return {
    event_id: FAKE_TAKEOVER_EVENT_ID,
    operator_id: "user_fake_clerk_sub",
    device_token_attestation: "fake-attestation",
  };
}

describe("POST /api/pos/v1/operators/takeover/confirm — contract conformance (T300)", () => {
  describe("200 — signed_in", () => {
    beforeEach(() => {
      fakePosOperatorsService.takeoverConfirmResult = makeSignedInResult();
    });

    it("response body conforms to PosOperatorSignInSucceeded schema", async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/takeover/confirm")
        .set("Authorization", "Bearer fake-jwt-token")
        .send(makeConfirmBody())
        .expect(200);

      assertConformsTo(validatePosSignInSucceeded, res.body);
    });

    it('body.kind is "signed_in" and operator/operator_session are present', async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/takeover/confirm")
        .set("Authorization", "Bearer fake-jwt-token")
        .send(makeConfirmBody())
        .expect(200);

      expect(res.body.kind).toBe("signed_in");
      expect(res.body.operator).toBeDefined();
      expect(typeof res.body.operator.id).toBe("string");
      expect(res.body.operator_session).toBeDefined();
      expect(typeof res.body.operator_session.id).toBe("string");
      assertConformsTo(validatePosSignInSucceeded, res.body);
    });
  });

  describe("401 — missing Bearer token", () => {
    it("response body conforms to Error schema when Authorization header is absent", async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/takeover/confirm")
        .send(makeConfirmBody())
        .expect(401);

      assertConformsTo(validatePosOperatorsError, res.body);
    });

    it("401 error envelope has required error.code and error.message fields", async () => {
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/takeover/confirm")
        .send(makeConfirmBody())
        .expect(401);

      expectPosOperatorsUnauthorizedEnvelope(res.body);
    });
  });

  describe("401 — service refuses", () => {
    it("response body conforms to Error schema when service returns refused", async () => {
      // takeoverConfirmResult is reset to { kind: "refused" } by the outer beforeEach
      const res = await posOperatorsHttp()
        .post("/api/pos/v1/operators/takeover/confirm")
        .set("Authorization", "Bearer fake-jwt-token")
        .send(makeConfirmBody())
        .expect(401);

      assertConformsTo(validatePosOperatorsError, res.body);
    });
  });
});

// =============================================================================
// SLICE 8 — GET /api/pos/v1/operators/roster
// =============================================================================
//
// pos-operators.openapi.yaml defines only 200 and 401 for this endpoint.
// 200 uses PosRosterResponse: { cashiers: PosRosterCashierEntry[] }.
// 401 uses the shared Error schema.
// No 400 body schema is defined in the contract — 400 tests are omitted.
//
// branch_id is an optional query param but is included in all requests,
// including missing-Bearer tests, to avoid triggering Zod 400 before auth.
//
// The same posOperatorsApp fixture is reused.

const FAKE_ROSTER_BRANCH_ID = "0195b600-0000-7000-8000-000000000010";

describe("GET /api/pos/v1/operators/roster — contract conformance (T300)", () => {
  describe("200 — empty roster", () => {
    beforeEach(() => {
      fakePosOperatorsService.rosterResult = { cashiers: [] };
    });

    it("response body conforms to PosRosterResponse schema", async () => {
      const res = await posOperatorsHttp()
        .get(`/api/pos/v1/operators/roster?branch_id=${FAKE_ROSTER_BRANCH_ID}`)
        .set("Authorization", "Bearer fake-jwt-token")
        .expect(200);

      assertConformsTo(validatePosRosterResponse, res.body);
    });

    it("cashiers is an empty array", async () => {
      const res = await posOperatorsHttp()
        .get(`/api/pos/v1/operators/roster?branch_id=${FAKE_ROSTER_BRANCH_ID}`)
        .set("Authorization", "Bearer fake-jwt-token")
        .expect(200);

      expect(res.body.cashiers).toEqual([]);
      assertConformsTo(validatePosRosterResponse, res.body);
    });
  });

  describe("200 — one cashier", () => {
    beforeEach(() => {
      fakePosOperatorsService.rosterResult = {
        cashiers: [
          {
            id: "user_fake_clerk_sub",
            // 034: provider-neutral users.id (§16), required on
            // PosRosterCashierEntry. Distinct from id (= clerk_user_id).
            user_id: "0195b400-0000-7000-8000-0000000a0099",
            display_name: "Test Cashier",
            role: "cashier",
          },
        ],
      };
    });

    it("response body conforms to PosRosterResponse schema", async () => {
      const res = await posOperatorsHttp()
        .get(`/api/pos/v1/operators/roster?branch_id=${FAKE_ROSTER_BRANCH_ID}`)
        .set("Authorization", "Bearer fake-jwt-token")
        .expect(200);

      assertConformsTo(validatePosRosterResponse, res.body);
    });

    it("cashier entry has id, display_name, and role cashier", async () => {
      const res = await posOperatorsHttp()
        .get(`/api/pos/v1/operators/roster?branch_id=${FAKE_ROSTER_BRANCH_ID}`)
        .set("Authorization", "Bearer fake-jwt-token")
        .expect(200);

      expect(res.body.cashiers).toHaveLength(1);
      const cashier = res.body.cashiers[0];
      expect(typeof cashier.id).toBe("string");
      expect(typeof cashier.display_name).toBe("string");
      expect(cashier.role).toBe("cashier");
      assertConformsTo(validatePosRosterResponse, res.body);
    });
  });

  describe("401 — missing Bearer token", () => {
    it("response body conforms to Error schema when Authorization header is absent", async () => {
      const res = await posOperatorsHttp()
        .get(`/api/pos/v1/operators/roster?branch_id=${FAKE_ROSTER_BRANCH_ID}`)
        .expect(401);

      assertConformsTo(validatePosOperatorsError, res.body);
    });

    it("401 error envelope has required error.code and error.message fields", async () => {
      const res = await posOperatorsHttp()
        .get(`/api/pos/v1/operators/roster?branch_id=${FAKE_ROSTER_BRANCH_ID}`)
        .expect(401);

      expectPosOperatorsUnauthorizedEnvelope(res.body);
    });
  });

  describe("401 — service refuses", () => {
    it("response body conforms to Error schema when service returns refused", async () => {
      // rosterResult is reset to { kind: "refused" } by the outer beforeEach
      const res = await posOperatorsHttp()
        .get(`/api/pos/v1/operators/roster?branch_id=${FAKE_ROSTER_BRANCH_ID}`)
        .set("Authorization", "Bearer fake-jwt-token")
        .expect(401);

      assertConformsTo(validatePosOperatorsError, res.body);
    });
  });
});

// =============================================================================
// SLICE 9 — GET /api/v1/context/me
// =============================================================================
//
// context.openapi.yaml defines one 200 schema (ContextResponse, named
// component). 401 is a bare description line with no content/schema —
// conformance tests for that status are intentionally omitted.
// AuthGuard only — no TenantContextGuard or RolesGuard for this endpoint.

import { ContextController } from "../src/context/context.controller";
import { ContextService, type ContextResponseBody } from "../src/context/context.service";

// ---------------------------------------------------------------------------
// Schema loading — context validators
// ---------------------------------------------------------------------------

const CONTEXT_DOC_ID = "context.openapi";

let validateContextResponse: ValidateFunction;

function buildContextValidators(): void {
  registerContractSchema(CONTEXT_DOC_ID);
  validateContextResponse = compileComponentValidator(CONTEXT_DOC_ID, "ContextResponse");
}

// ---------------------------------------------------------------------------
// Test doubles — context slice
// ---------------------------------------------------------------------------

const FAKE_CONTEXT_USER_ID = "0195c100-0000-7000-8000-000000000001";
const FAKE_CONTEXT_SESSION_ID = "0195c100-0000-7000-8000-000000000002";
const FAKE_CONTEXT_TENANT_ID = "0195c100-0000-7000-8000-000000000010";
const FAKE_CONTEXT_STORE_ID = "0195c100-0000-7000-8000-000000000020";

const EMPTY_CONTEXT_RESPONSE: ContextResponseBody = {
  user: {
    id: FAKE_CONTEXT_USER_ID,
    email: "test@example.com",
    display_name: null,
    is_platform_admin: false,
  },
  active_tenant: null,
  active_store: null,
  active_role_code: null,
  memberships: [],
};

const ACTIVE_CONTEXT_RESPONSE: ContextResponseBody = {
  user: {
    id: FAKE_CONTEXT_USER_ID,
    email: "test@example.com",
    display_name: "Test User",
    is_platform_admin: false,
  },
  active_tenant: {
    id: FAKE_CONTEXT_TENANT_ID,
    slug: "acme",
    name: "Acme Corp",
  },
  active_store: {
    id: FAKE_CONTEXT_STORE_ID,
    code: "S01",
    name: "Main Store",
  },
  active_role_code: "tenant_admin",
  memberships: [
    {
      tenant_id: FAKE_CONTEXT_TENANT_ID,
      tenant_name: "Acme Corp",
      role_code: "tenant_admin",
      store_access_kind: "all",
      accessible_store_ids: [FAKE_CONTEXT_STORE_ID],
    },
  ],
};

const SWITCHED_TENANT_RESPONSE: ContextResponseBody = {
  user: {
    id: FAKE_CONTEXT_USER_ID,
    email: "test@example.com",
    display_name: "Test User",
    is_platform_admin: false,
  },
  active_tenant: {
    id: FAKE_CONTEXT_TENANT_ID,
    slug: "acme",
    name: "Acme Corp",
  },
  active_store: null,
  active_role_code: "tenant_admin",
  memberships: [
    {
      tenant_id: FAKE_CONTEXT_TENANT_ID,
      tenant_name: "Acme Corp",
      role_code: "tenant_admin",
      store_access_kind: "all",
      accessible_store_ids: [FAKE_CONTEXT_STORE_ID],
    },
  ],
};

const SWITCHED_STORE_RESPONSE: ContextResponseBody = {
  user: {
    id: FAKE_CONTEXT_USER_ID,
    email: "test@example.com",
    display_name: "Test User",
    is_platform_admin: false,
  },
  active_tenant: {
    id: FAKE_CONTEXT_TENANT_ID,
    slug: "acme",
    name: "Acme Corp",
  },
  active_store: {
    id: FAKE_CONTEXT_STORE_ID,
    code: "S01",
    name: "Main Store",
  },
  active_role_code: "tenant_admin",
  memberships: [
    {
      tenant_id: FAKE_CONTEXT_TENANT_ID,
      tenant_name: "Acme Corp",
      role_code: "tenant_admin",
      store_access_kind: "all",
      accessible_store_ids: [FAKE_CONTEXT_STORE_ID],
    },
  ],
};

class FakeContextService {
  public response: ContextResponseBody = EMPTY_CONTEXT_RESPONSE;
  public switchTenantResponse: ContextResponseBody = EMPTY_CONTEXT_RESPONSE;
  public switchStoreResponse: ContextResponseBody = EMPTY_CONTEXT_RESPONSE;
  public clearStoreResponse: ContextResponseBody = EMPTY_CONTEXT_RESPONSE;

  async getActiveContext(_principal: unknown): Promise<ContextResponseBody> {
    return this.response;
  }

  async switchTenant(_principal: unknown, _tenantId: string): Promise<ContextResponseBody> {
    return this.switchTenantResponse;
  }

  async switchStore(_principal: unknown, _storeId: string): Promise<ContextResponseBody> {
    return this.switchStoreResponse;
  }

  async clearStore(_principal: unknown): Promise<ContextResponseBody> {
    return this.clearStoreResponse;
  }
}

// ---------------------------------------------------------------------------
// Fixture — context app
// ---------------------------------------------------------------------------

let contextApp: INestApplication;
let fakeContextService: FakeContextService;

beforeAll(async () => {
  buildContextValidators();

  fakeContextService = new FakeContextService();

  const moduleRef = await Test.createTestingModule({
    controllers: [ContextController],
    providers: [
      { provide: ContextService, useValue: fakeContextService },
    ],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue(makePrincipalGuard(FAKE_CONTEXT_SESSION_ID, FAKE_CONTEXT_USER_ID))
    .compile();

  contextApp = moduleRef.createNestApplication({ bufferLogs: true });
  contextApp.use(cookieParser());
  contextApp.useGlobalPipes(new ZodValidationPipe());
  contextApp.useGlobalFilters(new GlobalExceptionFilter());
  await contextApp.init();
});

afterAll(async () => {
  if (contextApp) await contextApp.close();
});

beforeEach(() => {
  fakeContextService.response = EMPTY_CONTEXT_RESPONSE;
  fakeContextService.switchTenantResponse = EMPTY_CONTEXT_RESPONSE;
  fakeContextService.switchStoreResponse = EMPTY_CONTEXT_RESPONSE;
  fakeContextService.clearStoreResponse = EMPTY_CONTEXT_RESPONSE;
});

function contextHttp() {
  return request(contextApp.getHttpServer());
}

// ---------------------------------------------------------------------------
// Tests — GET /api/v1/context/me
// ---------------------------------------------------------------------------

describe("GET /api/v1/context/me — contract conformance (T300)", () => {
  describe("200 empty / no active context", () => {
    it("response body conforms to ContextResponse schema", async () => {
      const res = await contextHttp()
        .get("/api/v1/context/me")
        .expect(200);

      assertConformsTo(validateContextResponse, res.body);
    });

    it("active_tenant, active_store, active_role_code are null and memberships is an empty array", async () => {
      const res = await contextHttp()
        .get("/api/v1/context/me")
        .expect(200);

      expect(res.body.active_tenant).toBeNull();
      expect(res.body.active_store).toBeNull();
      expect(res.body.active_role_code).toBeNull();
      expect(Array.isArray(res.body.memberships)).toBe(true);
      expect(res.body.memberships).toHaveLength(0);
      assertConformsTo(validateContextResponse, res.body);
    });
  });

  describe("200 active tenant/store context", () => {
    beforeEach(() => {
      fakeContextService.response = ACTIVE_CONTEXT_RESPONSE;
    });

    it("response body conforms to ContextResponse schema when active_tenant and active_store are set", async () => {
      const res = await contextHttp()
        .get("/api/v1/context/me")
        .expect(200);

      assertConformsTo(validateContextResponse, res.body);
    });

    it("non-null active_tenant, active_store, active_role_code and memberships with accessible_store_ids", async () => {
      const res = await contextHttp()
        .get("/api/v1/context/me")
        .expect(200);

      expect(res.body.active_tenant).not.toBeNull();
      expect(typeof res.body.active_tenant.id).toBe("string");
      expect(res.body.active_store).not.toBeNull();
      expect(typeof res.body.active_store.id).toBe("string");
      expect(typeof res.body.active_role_code).toBe("string");
      expect(Array.isArray(res.body.memberships)).toBe(true);
      expect(res.body.memberships).toHaveLength(1);
      expect(Array.isArray(res.body.memberships[0].accessible_store_ids)).toBe(true);
      assertConformsTo(validateContextResponse, res.body);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/v1/context/tenant
// ---------------------------------------------------------------------------

describe("POST /api/v1/context/tenant — contract conformance (T300)", () => {
  beforeEach(() => {
    fakeContextService.switchTenantResponse = SWITCHED_TENANT_RESPONSE;
  });

  it("200 — response body conforms to ContextResponse schema after tenant switch", async () => {
    const res = await contextHttp()
      .post("/api/v1/context/tenant")
      .send({ tenant_id: FAKE_CONTEXT_TENANT_ID })
      .expect(200);

    assertConformsTo(validateContextResponse, res.body);
  });

  it("200 — active_tenant is present and active_store is null after tenant switch", async () => {
    const res = await contextHttp()
      .post("/api/v1/context/tenant")
      .send({ tenant_id: FAKE_CONTEXT_TENANT_ID })
      .expect(200);

    expect(res.body.active_tenant).not.toBeNull();
    expect(typeof res.body.active_tenant.id).toBe("string");
    expect(res.body.active_store).toBeNull();
    assertConformsTo(validateContextResponse, res.body);
  });

  it("200 — memberships and active_role_code remain schema-valid in switched context", async () => {
    const res = await contextHttp()
      .post("/api/v1/context/tenant")
      .send({ tenant_id: FAKE_CONTEXT_TENANT_ID })
      .expect(200);

    expect(Array.isArray(res.body.memberships)).toBe(true);
    expect(res.body.memberships).toHaveLength(1);
    expect(Array.isArray(res.body.memberships[0].accessible_store_ids)).toBe(true);
    expect(typeof res.body.active_role_code).toBe("string");
    assertConformsTo(validateContextResponse, res.body);
  });
});

// ---------------------------------------------------------------------------
// Tests — POST /api/v1/context/store
// ---------------------------------------------------------------------------

describe("POST /api/v1/context/store — contract conformance (T300)", () => {
  beforeEach(() => {
    fakeContextService.switchStoreResponse = SWITCHED_STORE_RESPONSE;
  });

  it("200 — response body conforms to ContextResponse schema", async () => {
    const res = await contextHttp()
      .post("/api/v1/context/store")
      .send({ store_id: FAKE_CONTEXT_STORE_ID })
      .expect(200);

    assertConformsTo(validateContextResponse, res.body);
  });

  it("200 — active_store is non-null and id matches requested store_id", async () => {
    const res = await contextHttp()
      .post("/api/v1/context/store")
      .send({ store_id: FAKE_CONTEXT_STORE_ID })
      .expect(200);

    expect(res.body.active_store).not.toBeNull();
    expect(res.body.active_store.id).toBe(FAKE_CONTEXT_STORE_ID);
    assertConformsTo(validateContextResponse, res.body);
  });
});

// ---------------------------------------------------------------------------
// Tests — DELETE /api/v1/context/store
// ---------------------------------------------------------------------------

describe("DELETE /api/v1/context/store — contract conformance (T300)", () => {
  beforeEach(() => {
    fakeContextService.clearStoreResponse = SWITCHED_TENANT_RESPONSE;
  });

  it("200 — response body conforms to ContextResponse schema", async () => {
    const res = await contextHttp()
      .delete("/api/v1/context/store")
      .expect(200);

    assertConformsTo(validateContextResponse, res.body);
  });

  it("200 — active_store is null after clear", async () => {
    const res = await contextHttp()
      .delete("/api/v1/context/store")
      .expect(200);

    expect(res.body.active_store).toBeNull();
    assertConformsTo(validateContextResponse, res.body);
  });
});

// ---------------------------------------------------------------------------
// Slice T300 — auth remaining endpoints contract conformance
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/signout", () => {
  it("204 — success has no body", async () => {
    const res = await http().post("/api/v1/auth/signout").expect(204);
    assertNoBody(res);
  });

  it("401 — guard rejection conforms to Error schema", async () => {
    authGuard.mode = "reject";
    const res = await http().post("/api/v1/auth/signout").expect(401);
    assertConformsTo(validateError, res.body);
  });
});

describe("POST /api/v1/auth/refresh", () => {
  it("204 — success has no body", async () => {
    const res = await http().post("/api/v1/auth/refresh").expect(204);
    assertNoBody(res);
  });

  it("401 — expired session conforms to Error schema", async () => {
    fakeAuth.refreshMode = "expired";
    const res = await http().post("/api/v1/auth/refresh").expect(401);
    assertConformsTo(validateError, res.body);
  });
});

describe("POST /api/v1/auth/password-reset/request", () => {
  it("202 — success has no body", async () => {
    const res = await http()
      .post("/api/v1/auth/password-reset/request")
      .send({ email: "user@example.com" })
      .expect(202);
    assertNoBody(res);
  });
});

describe("POST /api/v1/auth/password-reset/confirm", () => {
  it("204 — success has no body", async () => {
    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: "tok", new_password: "supersecret123" })
      .expect(204);
    assertNoBody(res);
  });

  it("400 — invalid token conforms to Error schema", async () => {
    fakeAuth.confirmPasswordResetThrows = true;
    const res = await http()
      .post("/api/v1/auth/password-reset/confirm")
      .send({ token: "bad", new_password: "supersecret123" })
      .expect(400);
    assertConformsTo(validateError, res.body);
  });
});

describe("POST /api/v1/auth/email/verify/request", () => {
  it("202 — success has no body", async () => {
    const res = await http()
      .post("/api/v1/auth/email/verify/request")
      .expect(202);
    assertNoBody(res);
  });

  it("401 — guard rejection conforms to Error schema", async () => {
    authGuard.mode = "reject";
    const res = await http()
      .post("/api/v1/auth/email/verify/request")
      .expect(401);
    assertConformsTo(validateError, res.body);
  });
});

describe("POST /api/v1/auth/email/verify/confirm", () => {
  it("204 — success has no body", async () => {
    const res = await http()
      .post("/api/v1/auth/email/verify/confirm")
      .send({ token: "tok" })
      .expect(204);
    assertNoBody(res);
  });

  it("400 — invalid token conforms to Error schema", async () => {
    fakeAuth.confirmEmailVerificationThrows = true;
    const res = await http()
      .post("/api/v1/auth/email/verify/confirm")
      .send({ token: "bad" })
      .expect(400);
    assertConformsTo(validateError, res.body);
  });
});

// =============================================================================
// T304-B slice 10 — POST /api/v1/memberships/invite
// =============================================================================
//
// memberships.openapi.yaml defines Invitation schema (201 response).
// Validates that role_code (string) is present and role_id is absent.

// ---------------------------------------------------------------------------
// Schema loading — memberships validators
// ---------------------------------------------------------------------------

const MEMBERSHIPS_DOC_ID = "memberships.openapi";
let validateInvitation: ValidateFunction;

function buildMembershipsValidators(): void {
  registerContractSchema(MEMBERSHIPS_DOC_ID);
  validateInvitation = compileComponentValidator(MEMBERSHIPS_DOC_ID, "Invitation");
}

// ---------------------------------------------------------------------------
// Test doubles — memberships invite slice
// ---------------------------------------------------------------------------

const MEMBERSHIPS_INVITATION_ID = "0195d100-0000-7000-8000-000000000001";
const MEMBERSHIPS_TENANT_ID     = "0195d100-0000-7000-8000-000000000010";
const MEMBERSHIPS_USER_ID       = "0195d100-0000-7000-8000-000000000020";

class FakeMembershipsInvitationsService {
  async invite(_ctx: unknown, _dto: unknown): Promise<InviteResult> {
    const row: InvitationRow = {
      id: MEMBERSHIPS_INVITATION_ID,
      tenantId: MEMBERSHIPS_TENANT_ID,
      email: "invitee@example.com",
      roleId: "ignored-role-uuid",
      storeAccessKind: "all",
      invitedStoreIds: [],
      invitedByUserId: MEMBERSHIPS_USER_ID,
      tokenHash: Buffer.alloc(0),
      status: "pending",
      expiresAt: new Date("2026-05-24T00:00:00.000Z"),
      acceptedByUserId: null,
      acceptedAt: null,
      createdAt: new Date("2026-05-17T00:00:00.000Z"),
      updatedAt: new Date("2026-05-17T00:00:00.000Z"),
      deletedAt: null,
    };
    return { row, roleCode: "tenant_admin" };
  }
}

// ---------------------------------------------------------------------------
// Fixture — memberships invite app
// ---------------------------------------------------------------------------

let membershipsApp: INestApplication;

beforeAll(async () => {
  buildMembershipsValidators();

  const moduleRef = await Test.createTestingModule({
    controllers: [InvitationsController],
    providers: [
      { provide: InvitationsService, useValue: new FakeMembershipsInvitationsService() },
    ],
  })
    .overrideGuard(DashboardAuthGuard).useValue(makePrincipalGuard("memberships-session-1", MEMBERSHIPS_USER_ID))
    .overrideGuard(TenantContextGuard).useValue(makeTenantContextGuard(MEMBERSHIPS_USER_ID, MEMBERSHIPS_TENANT_ID))
    .overrideGuard(RolesGuard).useValue(ALLOW_ALL_GUARD)
    .compile();

  membershipsApp = moduleRef.createNestApplication({ bufferLogs: true });
  membershipsApp.useGlobalPipes(new ZodValidationPipe());
  membershipsApp.useGlobalFilters(new GlobalExceptionFilter());
  await membershipsApp.init();
});

afterAll(async () => {
  if (membershipsApp) await membershipsApp.close();
});

function membershipsHttp() {
  return request(membershipsApp.getHttpServer());
}

const VALID_INVITE_BODY = {
  email: "invitee@example.com",
  role_code: "tenant_admin",
  store_access_kind: "all",
};

// ---------------------------------------------------------------------------
// Tests — POST /api/v1/memberships/invite
// ---------------------------------------------------------------------------

describe("POST /api/v1/memberships/invite — contract conformance (T304-B slice 10)", () => {
  describe("201 Invitation — role_code present, role_id absent", () => {
    it("response body conforms to Invitation schema", async () => {
      const res = await membershipsHttp()
        .post("/api/v1/memberships/invite")
        .send(VALID_INVITE_BODY)
        .expect(201);

      assertConformsTo(validateInvitation, res.body);
    });

    it("response contains role_code as a string", async () => {
      const res = await membershipsHttp()
        .post("/api/v1/memberships/invite")
        .send(VALID_INVITE_BODY)
        .expect(201);

      expect(typeof res.body.role_code).toBe("string");
      assertConformsTo(validateInvitation, res.body);
    });

    it("response does NOT expose role_id", async () => {
      const res = await membershipsHttp()
        .post("/api/v1/memberships/invite")
        .send(VALID_INVITE_BODY)
        .expect(201);

      expect(Object.keys(res.body)).not.toContain("role_id");
      assertConformsTo(validateInvitation, res.body);
    });
  });
});

// =============================================================================
// Slice 11 — stores (T300)
// =============================================================================
//
// Covers:
//   GET /api/v1/stores          200 → Store[]
//   GET /api/v1/stores/:store_id 200 → Store
//
// Wire-shape goal: confirm StoresController.toBody() serialises Date fields
// to ISO strings before AJV evaluates format: date-time.
// =============================================================================

const STORES_DOC_ID = "stores.openapi";

let validateStoreArray: ValidateFunction;
let validateStore: ValidateFunction;

function buildStoresValidators(): void {
  registerContractSchema(STORES_DOC_ID);
  validateStore = compileComponentValidator(STORES_DOC_ID, "Store");
  validateStoreArray = ajv.compile({
    type: "array",
    items: { $ref: `${STORES_DOC_ID}#/components/schemas/Store` },
  });
}

// ---------------------------------------------------------------------------
// Test doubles — stores slice
// ---------------------------------------------------------------------------

const STORES_TENANT_ID = "11111111-1111-7111-8111-111111111111";
const STORES_STORE_ID  = "22222222-2222-7222-8222-222222222222";
const STORES_USER_ID   = "33333333-3333-7333-8333-333333333333";

/** Fixture using Date objects — toBody() must convert them to ISO strings. */
const STORE_RECORD: StoreRecord = {
  id: STORES_STORE_ID,
  tenantId: STORES_TENANT_ID,
  code: "S001",
  name: "Test Store",
  isActive: true,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-06-01T00:00:00.000Z"),
  deletedAt: null,
};

class FakeStoresService {
  async list(_ctx: unknown): Promise<StoreRecord[]> {
    return [STORE_RECORD];
  }

  async read(_ctx: unknown, _storeId: string): Promise<StoreRecord> {
    return STORE_RECORD;
  }
}

// ---------------------------------------------------------------------------
// Fixture — stores app
// ---------------------------------------------------------------------------

let storesApp: INestApplication;

beforeAll(async () => {
  buildStoresValidators();

  const moduleRef = await Test.createTestingModule({
    controllers: [StoresController],
    providers: [
      { provide: StoresService, useValue: new FakeStoresService() },
    ],
  })
    .overrideGuard(DashboardAuthGuard).useValue(makePrincipalGuard("stores-session-1", STORES_USER_ID))
    .overrideGuard(TenantContextGuard).useValue(makeTenantContextGuard(STORES_USER_ID, STORES_TENANT_ID))
    .overrideGuard(RolesGuard).useValue(ALLOW_ALL_GUARD)
    .compile();

  storesApp = moduleRef.createNestApplication({ bufferLogs: true });
  storesApp.useGlobalPipes(new ZodValidationPipe());
  storesApp.useGlobalFilters(new GlobalExceptionFilter());
  await storesApp.init();
});

afterAll(async () => {
  if (storesApp) await storesApp.close();
});

function storesHttp() {
  return request(storesApp.getHttpServer());
}

// ---------------------------------------------------------------------------
// Tests — stores slice (T300 slice 11)
// ---------------------------------------------------------------------------

describe("Slice 11 — stores (T300)", () => {
  describe("GET /api/v1/stores → 200 Store[]", () => {
    it("response body conforms to Store[] schema", async () => {
      const res = await storesHttp()
        .get("/api/v1/stores")
        .expect(200);

      assertConformsTo(validateStoreArray, res.body);
    });

    it("date fields are ISO strings, not Date objects", async () => {
      const res = await storesHttp()
        .get("/api/v1/stores")
        .expect(200);

      const store = res.body[0];
      expect(store.created_at).toBe("2024-01-01T00:00:00.000Z");
      expect(store.updated_at).toBe("2024-06-01T00:00:00.000Z");
      expect(store.deleted_at).toBeNull();
      assertConformsTo(validateStoreArray, res.body);
    });
  });

  describe("GET /api/v1/stores/:store_id → 200 Store", () => {
    it("response body conforms to Store schema", async () => {
      const res = await storesHttp()
        .get(`/api/v1/stores/${STORES_STORE_ID}`)
        .expect(200);

      assertConformsTo(validateStore, res.body);
    });

    it("date fields are ISO strings, not Date objects", async () => {
      const res = await storesHttp()
        .get(`/api/v1/stores/${STORES_STORE_ID}`)
        .expect(200);

      expect(res.body.created_at).toBe("2024-01-01T00:00:00.000Z");
      expect(res.body.updated_at).toBe("2024-06-01T00:00:00.000Z");
      expect(res.body.deleted_at).toBeNull();
      assertConformsTo(validateStore, res.body);
    });
  });
});

// =============================================================================
// Slice 12 — tenants (T300)
// =============================================================================
//
// Covers:
//   GET /api/v1/tenants               200 → TenantSummary[]
//   GET /api/v1/tenants/:tenant_id    200 → Tenant
//
// Wire-shape goal:
//   - TenantSummary: id/slug/name only — no date fields.
//   - Tenant (allOf TenantSummary): confirm toFullBody() serialises Date
//     fields to ISO strings before AJV evaluates format: date-time.
//
// Guard note: TenantsController uses only AuthGuard (class-wide). It reads
// request.principal, NOT request.context. No TenantContextGuard override
// is needed. RolesGuard must still be overridden because NestJS resolves
// all guard constructors at module-init time (per-method guards are still
// instantiated); without the override the module fails to boot due to
// RolesGuard's MembershipRepository/PG_POOL dependencies.
// =============================================================================

const TENANTS_DOC_ID    = "tenants.openapi";
const TENANTS_TENANT_ID = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const TENANTS_USER_ID   = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";

let validateTenantSummaryArray: ValidateFunction;
let validateTenant: ValidateFunction;

function buildTenantsValidators(): void {
  registerContractSchema(TENANTS_DOC_ID);
  validateTenant = compileComponentValidator(TENANTS_DOC_ID, "Tenant");
  validateTenantSummaryArray = ajv.compile({
    type: "array",
    items: { $ref: `${TENANTS_DOC_ID}#/components/schemas/TenantSummary` },
  });
}

// ---------------------------------------------------------------------------
// Test doubles — tenants slice
// ---------------------------------------------------------------------------

/** Fixture with real Date objects — toFullBody() must convert to ISO strings. */
const TENANT_RECORD: TenantRecord = {
  id: TENANTS_TENANT_ID,
  slug: "acme-corp",
  name: "Acme Corp",
  status: "active",
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-06-01T00:00:00.000Z"),
  deletedAt: null,
};

class FakeTenantsService {
  async list(_principal: unknown): Promise<TenantRecord[]> {
    return [TENANT_RECORD];
  }

  async read(_principal: unknown, _tenantId: string): Promise<TenantRecord> {
    return TENANT_RECORD;
  }
}

// ---------------------------------------------------------------------------
// Fixture — tenants app
// ---------------------------------------------------------------------------

let tenantsApp: INestApplication;

beforeAll(async () => {
  buildTenantsValidators();

  const moduleRef = await Test.createTestingModule({
    controllers: [TenantsController],
    providers: [
      { provide: TenantsService, useValue: new FakeTenantsService() },
    ],
  })
    .overrideGuard(DashboardAuthGuard).useValue(makePrincipalGuard("tenants-session-1", TENANTS_USER_ID))
    .overrideGuard(RolesGuard).useValue(ALLOW_ALL_GUARD)
    .compile();

  tenantsApp = moduleRef.createNestApplication({ bufferLogs: true });
  tenantsApp.useGlobalPipes(new ZodValidationPipe());
  tenantsApp.useGlobalFilters(new GlobalExceptionFilter());
  await tenantsApp.init();
});

afterAll(async () => {
  if (tenantsApp) await tenantsApp.close();
});

function tenantsHttp() {
  return request(tenantsApp.getHttpServer());
}

// ---------------------------------------------------------------------------
// Tests — tenants slice (T300 slice 12)
// ---------------------------------------------------------------------------

describe("Slice 12 — tenants (T300)", () => {
  describe("GET /api/v1/tenants → 200 TenantSummary[]", () => {
    it("response body conforms to TenantSummary[] schema", async () => {
      const res = await tenantsHttp()
        .get("/api/v1/tenants")
        .expect(200);

      assertConformsTo(validateTenantSummaryArray, res.body);
    });

    it("summary fields are id/slug/name only; no date fields", async () => {
      const res = await tenantsHttp()
        .get("/api/v1/tenants")
        .expect(200);

      const summary = res.body[0];
      expect(summary.id).toBe(TENANTS_TENANT_ID);
      expect(summary.slug).toBe("acme-corp");
      expect(summary.name).toBe("Acme Corp");
      expect(summary).not.toHaveProperty("created_at");
      expect(summary).not.toHaveProperty("updated_at");
      expect(summary).not.toHaveProperty("deleted_at");
      assertConformsTo(validateTenantSummaryArray, res.body);
    });
  });

  describe("GET /api/v1/tenants/:tenant_id → 200 Tenant", () => {
    it("response body conforms to Tenant schema", async () => {
      const res = await tenantsHttp()
        .get(`/api/v1/tenants/${TENANTS_TENANT_ID}`)
        .expect(200);

      assertConformsTo(validateTenant, res.body);
    });

    it("date fields are ISO strings, not Date objects", async () => {
      const res = await tenantsHttp()
        .get(`/api/v1/tenants/${TENANTS_TENANT_ID}`)
        .expect(200);

      expect(res.body.created_at).toBe("2024-01-01T00:00:00.000Z");
      expect(res.body.updated_at).toBe("2024-06-01T00:00:00.000Z");
      expect(res.body.deleted_at).toBeNull();
      assertConformsTo(validateTenant, res.body);
    });
  });
});

// =============================================================================
// Slice 13 — PATCH /api/v1/memberships/:membership_id (T300)
// =============================================================================
//
// memberships.openapi.yaml defines the Membership schema (200 response for
// PATCH /api/v1/memberships/{membership_id}).
//
// Wire-shape goal:
//   - revoked_at: null       when service detail has revokedAt: null
//   - revoked_at: ISO string when service detail has revokedAt: Date
//
// The memberships.openapi document is already registered with AJV by
// buildMembershipsValidators() in Slice 10. No re-registration is needed.
//
// Guard note: MembershipsController uses AuthGuard + TenantContextGuard
// (class-level) and RolesGuard (method-level). All three must be overridden
// so the module boots without real PG_POOL / Redis dependencies.
// =============================================================================

import { MembershipsController } from "../src/memberships/memberships.controller";
import { MembershipsService } from "../src/memberships/memberships.service";
import type { MembershipDetail } from "../src/context/membership.repository";

// ---------------------------------------------------------------------------
// Schema loading — memberships PATCH validator
// ---------------------------------------------------------------------------

// memberships.openapi is already added to ajv in Slice 10's buildMembershipsValidators().
// Compile the Membership schema validator here — called inside the beforeAll below.
let validateMembership: ValidateFunction;

function buildMembershipUpdateValidator(): void {
  // In the normal full-suite run Slice 10 already registered the document;
  // registerContractSchema is idempotent so test isolation still works.
  registerContractSchema(MEMBERSHIPS_DOC_ID);
  validateMembership = compileComponentValidator(MEMBERSHIPS_DOC_ID, "Membership");
}

// ---------------------------------------------------------------------------
// Test doubles — memberships PATCH slice
// ---------------------------------------------------------------------------

const PATCH_MEMBERSHIP_ID = "cc000000-cc00-7000-8000-000000000001";
const PATCH_TENANT_ID     = "cc000000-cc00-7000-8000-000000000010";
const PATCH_USER_ID       = "cc000000-cc00-7000-8000-000000000020";

const BASE_MEMBERSHIP_DETAIL: MembershipDetail = {
  membershipId: PATCH_MEMBERSHIP_ID,
  user: { id: PATCH_USER_ID, email: "member@example.com", displayName: "Member One" },
  roleCode: "tenant_admin",
  storeAccessKind: "all",
  accessibleStoreIds: [],
  revokedAt: null,
};

class FakeMembershipsUpdateService {
  public detail: MembershipDetail = { ...BASE_MEMBERSHIP_DETAIL };

  async update(_ctx: unknown, _membershipId: string, _dto: unknown): Promise<MembershipDetail> {
    return this.detail;
  }

  async revoke(_ctx: unknown, _membershipId: string): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Fixture — memberships PATCH app
// ---------------------------------------------------------------------------

let membershipsUpdateApp: INestApplication;
let fakeMembershipsUpdateService: FakeMembershipsUpdateService;

beforeAll(async () => {
  buildMembershipUpdateValidator();

  fakeMembershipsUpdateService = new FakeMembershipsUpdateService();

  const moduleRef = await Test.createTestingModule({
    controllers: [MembershipsController],
    providers: [
      { provide: MembershipsService, useValue: fakeMembershipsUpdateService },
    ],
  })
    .overrideGuard(DashboardAuthGuard).useValue(makePrincipalGuard("patch-memberships-session-1", PATCH_USER_ID))
    .overrideGuard(TenantContextGuard).useValue(makeTenantContextGuard(PATCH_USER_ID, PATCH_TENANT_ID))
    .overrideGuard(RolesGuard).useValue(ALLOW_ALL_GUARD)
    .compile();

  membershipsUpdateApp = moduleRef.createNestApplication({ bufferLogs: true });
  membershipsUpdateApp.useGlobalPipes(new ZodValidationPipe());
  membershipsUpdateApp.useGlobalFilters(new GlobalExceptionFilter());
  await membershipsUpdateApp.init();
});

afterAll(async () => {
  if (membershipsUpdateApp) await membershipsUpdateApp.close();
});

beforeEach(() => {
  fakeMembershipsUpdateService.detail = { ...BASE_MEMBERSHIP_DETAIL };
});

function membershipsUpdateHttp() {
  return request(membershipsUpdateApp.getHttpServer());
}

// ---------------------------------------------------------------------------
// Tests — PATCH /api/v1/memberships/:membership_id (T300 slice 13)
// ---------------------------------------------------------------------------

describe("Slice 13 — PATCH /api/v1/memberships/:membership_id (T300)", () => {
  describe("200 Membership — revoked_at: null", () => {
    it("response body conforms to Membership schema when revokedAt is null", async () => {
      fakeMembershipsUpdateService.detail = { ...BASE_MEMBERSHIP_DETAIL, revokedAt: null };

      const res = await membershipsUpdateHttp()
        .patch(`/api/v1/memberships/${PATCH_MEMBERSHIP_ID}`)
        .send({ role_code: "tenant_admin" })
        .expect(200);

      assertConformsTo(validateMembership, res.body);
    });

    it("revoked_at is null in the wire response when revokedAt is null", async () => {
      fakeMembershipsUpdateService.detail = { ...BASE_MEMBERSHIP_DETAIL, revokedAt: null };

      const res = await membershipsUpdateHttp()
        .patch(`/api/v1/memberships/${PATCH_MEMBERSHIP_ID}`)
        .send({ role_code: "tenant_admin" })
        .expect(200);

      expect(res.body.revoked_at).toBeNull();
      assertConformsTo(validateMembership, res.body);
    });
  });

  describe("200 Membership — revoked_at: ISO string", () => {
    it("response body conforms to Membership schema when revokedAt is a Date", async () => {
      fakeMembershipsUpdateService.detail = {
        ...BASE_MEMBERSHIP_DETAIL,
        revokedAt: new Date("2024-07-01T00:00:00.000Z"),
      };

      const res = await membershipsUpdateHttp()
        .patch(`/api/v1/memberships/${PATCH_MEMBERSHIP_ID}`)
        .send({ role_code: "tenant_admin" })
        .expect(200);

      assertConformsTo(validateMembership, res.body);
    });

    it("revoked_at is an ISO string in the wire response when revokedAt is a Date", async () => {
      fakeMembershipsUpdateService.detail = {
        ...BASE_MEMBERSHIP_DETAIL,
        revokedAt: new Date("2024-07-01T00:00:00.000Z"),
      };

      const res = await membershipsUpdateHttp()
        .patch(`/api/v1/memberships/${PATCH_MEMBERSHIP_ID}`)
        .send({ role_code: "tenant_admin" })
        .expect(200);

      expect(res.body.revoked_at).toBe("2024-07-01T00:00:00.000Z");
      assertConformsTo(validateMembership, res.body);
    });
  });
});
