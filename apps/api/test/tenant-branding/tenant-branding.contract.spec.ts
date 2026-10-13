/**
 * apps/api/test/tenant-branding/tenant-branding.contract.spec.ts
 *
 * RT-473 S1 (spec 039, planning RT-472): the tenant-branding contract.
 * `[GATED]` contract; the owner approved the spec 039 decisions on 2026-10-13.
 * The runtime ships in RT-473 S2 after its migration and dependency gates.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. No
 * app boot and no HTTP (every operation is contract-only). What this pins:
 *
 *   1. Five operations, all contract-only, colliding with no other contract.
 *   2. POS read: `device` bearer only, no tenant parameter, ETag / 304, and
 *      "no logo" is `200` with `logo: null` (no 404).
 *   3. Console: `cookieAuth` only; tenant from the path; preview stores
 *      nothing; save needs `preview_version` and `expected_revision`;
 *      remove needs `expected_revision`; raw bodies under any Content-Type.
 *   4. The closed 422 rejection codes, the closed warnings, and the 409 / 413
 *      responses stay outside the 422 set.
 *   5. Every projection is strict, and the receipt / screen renditions carry
 *      their pixel sizes.
 */
import "reflect-metadata";

import { createHash } from "node:crypto";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { loadOpenApiContracts } from "../../src/openapi/loader";

const CONTRACT_ID = "tenant-branding.openapi";

const POS_PATH = "/api/pos/v1/tenant/branding";
const LOGO_PATH = "/api/v1/tenants/{tenant_id}/logo";
const PREVIEW_PATH = "/api/v1/tenants/{tenant_id}/logo/preview";

const OPERATIONS: ReadonlyArray<[string, string, string]> = [
  [POS_PATH, "get", "posGetTenantBranding"],
  [LOGO_PATH, "get", "consoleGetTenantLogo"],
  [LOGO_PATH, "put", "consolePutTenantLogo"],
  [LOGO_PATH, "delete", "consoleDeleteTenantLogo"],
  [PREVIEW_PATH, "post", "consolePreviewTenantLogo"],
];

const REJECTION_CODES = [
  "file_type_not_allowed",
  "image_malformed",
  "image_dimensions_too_large",
  "image_too_small",
  "aspect_ratio_out_of_range",
  "image_empty",
  "svg_unsafe_content",
  "svg_unsupported",
];

const WARNINGS = ["low_contrast", "receipt_high_black_coverage", "receipt_thin_strokes"];

interface ParameterObject {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  schema?: Record<string, unknown>;
}

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: ParameterObject[];
  requestBody?: { $ref?: string };
  responses?: Record<string, { $ref?: string; description?: string; content?: unknown }>;
  "x-runtime-status"?: string;
}

type SchemaObject = Record<string, unknown> & {
  required?: string[];
  properties?: Record<string, Record<string, unknown>>;
  additionalProperties?: unknown;
  enum?: unknown[];
};

interface OpenApiDocument {
  openapi?: string;
  info?: { version?: string };
  security?: unknown;
  paths?: Record<string, Record<string, OperationObject | ParameterObject[]>>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    parameters?: Record<string, ParameterObject>;
    requestBodies?: Record<string, { required?: boolean; content?: Record<string, unknown> }>;
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
        const id = (o as OperationObject)?.operationId;
        if (typeof id === "string") otherOperationIds.add(id);
      }
    }
  }
  ajv.addSchema(doc as object, CONTRACT_ID);
});

function op(path: string, method: string): OperationObject {
  const found = doc.paths?.[path]?.[method] as OperationObject | undefined;
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

/** Resolve an operation's parameters (inline or `$ref`), including path-level ones. */
function params(path: string, method: string): ParameterObject[] {
  const pathLevel = (doc.paths?.[path]?.parameters as ParameterObject[] | undefined) ?? [];
  return [...pathLevel, ...(op(path, method).parameters ?? [])].map((p) => {
    if (!p.$ref) return p;
    const resolved = doc.components?.parameters?.[p.$ref.split("/").pop()!];
    if (!resolved) throw new Error(`parameter ${p.$ref} not declared`);
    return resolved;
  });
}

const VERSION = "a".repeat(64);
const PNG = "iVBORw0KGgo=";
const RID = "0192f1e8-7b4c-7a3e-9c1d-2b3f4a5c6d7e";

function screen() {
  return (["boot", "pairing", "sign_in", "lock"] as const).flatMap((slot) =>
    [1, 2].map((scale) => ({
      slot,
      scale,
      width_px: 120 * scale,
      height_px: 40 * scale,
      png_base64: PNG,
    })),
  );
}

function logo() {
  return {
    version: VERSION,
    presentation: { card: false },
    warnings: ["receipt_thin_strokes"],
    screen: screen(),
    receipt: { width_px: 340, height_px: 106, dpi: 180, png_base64: PNG },
    updated_at: "2026-10-13T21:00:00Z",
  };
}

describe("tenant-branding — document and operations", () => {
  it("is an OpenAPI 3.1 document at version 1.0.0-draft", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info?.version).toBe("1.0.0-draft");
  });

  it("declares exactly the five branding operations", () => {
    const declared: string[] = [];
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
      for (const [method, o] of Object.entries(item)) {
        if (method === "parameters") continue;
        declared.push(`${method} ${path} ${(o as OperationObject).operationId}`);
      }
    }
    expect(declared.sort()).toEqual(OPERATIONS.map(([p, m, id]) => `${m} ${p} ${id}`).sort());
  });

  it("marks every operation contract-only until RT-473 S2 ships", () => {
    for (const [path, method] of OPERATIONS) {
      expect(op(path, method)["x-runtime-status"]).toBe("contract-only");
    }
  });

  it("collides with no operationId in any other contract", () => {
    for (const [, , id] of OPERATIONS) expect(otherOperationIds.has(id)).toBe(false);
  });

  it("declares no document-level security (each operation names its own)", () => {
    expect(doc.security).toBeUndefined();
  });
});

describe("tenant-branding — POS read", () => {
  it("is secured by the device bearer only (no JWT format)", () => {
    expect(op(POS_PATH, "get").security).toEqual([{ device: [] }]);
    const device = doc.components?.securitySchemes?.device;
    expect(device).toMatchObject({ type: "http", scheme: "bearer" });
    expect(device?.bearerFormat).toBeUndefined();
  });

  it("takes no tenant, path or query parameter — only If-None-Match", () => {
    const list = params(POS_PATH, "get");
    expect(list.map((p) => `${p.in}:${p.name}`)).toEqual(["header:If-None-Match"]);
    expect(list[0]!.required).toBe(false);
  });

  it("returns 200 / 304 / 400 / 401 / 500 and never 404", () => {
    expect(Object.keys(op(POS_PATH, "get").responses ?? {}).sort()).toEqual(
      ["200", "304", "400", "401", "500"].sort(),
    );
    // A 304 repeats the 200's caching headers (RFC 9110 §15.4.5).
    for (const status of ["200", "304"]) {
      expect(op(POS_PATH, "get").responses?.[status]).toMatchObject({
        headers: { ETag: expect.anything(), "Cache-Control": expect.anything() },
      });
    }
  });

  it("represents no logo as logo: null", () => {
    const valid = validator("TenantBranding");
    expect(valid({ tenant_display_name: "صيدلية النور", revision: 0, logo: null })).toBe(true);
    expect(valid({ tenant_display_name: "صيدلية النور", revision: 0 })).toBe(false);
    expect(valid({ tenant_display_name: "صيدلية النور", logo: null })).toBe(false);
  });
});

describe("tenant-branding — Console surface", () => {
  it("secures every Console operation by cookieAuth only", () => {
    for (const [path, method] of OPERATIONS.filter(([p]) => p !== POS_PATH)) {
      expect(op(path, method).security).toEqual([{ cookieAuth: [] }]);
    }
  });

  it("takes the tenant from the path", () => {
    for (const [path, method] of [
      [LOGO_PATH, "get"],
      [LOGO_PATH, "put"],
      [LOGO_PATH, "delete"],
      [PREVIEW_PATH, "post"],
    ] as const) {
      const tenant = params(path, method).find((p) => p.name === "tenant_id");
      expect(tenant).toMatchObject({ in: "path", required: true });
    }
  });

  it("save requires preview_version and expected_revision", () => {
    const names = params(LOGO_PATH, "put").filter((p) => p.required).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["preview_version", "expected_revision"]));
  });

  it("remove requires expected_revision and no body", () => {
    const names = params(LOGO_PATH, "delete").filter((p) => p.required).map((p) => p.name);
    expect(names).toContain("expected_revision");
    expect(op(LOGO_PATH, "delete").requestBody).toBeUndefined();
  });

  it("the precondition is the integer revision, not the content version (ABA-safe)", () => {
    expect(doc.components!.parameters!.ExpectedRevision!.schema).toEqual({ type: "integer", minimum: 0 });
    expect(schema("TenantBranding").required).toContain("revision");
  });

  it("preview and save take a required raw body under any Content-Type (FR-03)", () => {
    const body = doc.components!.requestBodies!.LogoFile!;
    expect(body.required).toBe(true);
    expect(Object.keys(body.content ?? {})).toEqual(["*/*"]);
    // Raw binary (OAS 3.1): no schema, so the file bytes are sent unchanged.
    expect(body.content!["*/*"]).toEqual({});
    expect(op(LOGO_PATH, "put").requestBody?.$ref).toBe("#/components/requestBodies/LogoFile");
    expect(op(PREVIEW_PATH, "post").requestBody?.$ref).toBe("#/components/requestBodies/LogoFile");
  });

  it("maps the write responses, with 409 and 413 outside the 422 set", () => {
    const keys = (path: string, method: string) => Object.keys(op(path, method).responses ?? {}).sort();
    expect(keys(LOGO_PATH, "put")).toEqual(
      ["200", "400", "401", "403", "404", "409", "413", "422", "500"].sort(),
    );
    expect(keys(PREVIEW_PATH, "post")).toEqual(["200", "400", "401", "403", "404", "413", "422", "500"].sort());
    expect(keys(LOGO_PATH, "delete")).toEqual(["200", "400", "401", "403", "404", "409", "500"].sort());
    expect(keys(LOGO_PATH, "get")).toEqual(["200", "400", "401", "404", "500"].sort());
  });
});

describe("tenant-branding — closed vocabularies", () => {
  it("closes the 422 rejection codes", () => {
    expect(schema("LogoRejectionCode").enum).toEqual(REJECTION_CODES);
    const valid = validator("LogoRejectedError");
    expect(valid({ error: { code: "image_too_small", message: "x", request_id: RID } })).toBe(true);
    expect(valid({ error: { code: "file_too_large", message: "x", request_id: RID } })).toBe(false);
    expect(
      valid({
        error: { code: "svg_unsafe_content", message: "x", request_id: RID, details: { construct: "script" } },
      }),
    ).toBe(true);
    expect(
      valid({
        error: { code: "svg_unsafe_content", message: "x", request_id: RID, details: { excerpt: "<script>" } },
      }),
    ).toBe(false);
  });

  it("requires request_id on both error envelopes", () => {
    expect(validator("LogoRejectedError")({ error: { code: "image_too_small", message: "x" } })).toBe(false);
    expect(validator("Error")({ error: { code: "not_found", message: "x" } })).toBe(false);
  });

  it("accepts the validation-issue array as Error.details, and no object", () => {
    const valid = validator("Error");
    const issues = [{ code: "invalid_type", path: ["tenantId"], message: "Invalid uuid" }];
    expect(valid({ error: { code: "validation_error", message: "x", request_id: RID, details: issues } })).toBe(true);
    expect(valid({ error: { code: "not_found", message: "x", request_id: RID } })).toBe(true);
    expect(
      valid({ error: { code: "validation_error", message: "x", request_id: RID, details: { construct: "script" } } }),
    ).toBe(false);
  });

  it("closes the non-422 error codes, including the filter's generic 401 and 500", () => {
    const codes = (schema("Error").properties!.error as { properties: { code: { enum: string[] } } }).properties.code
      .enum;
    expect(codes).toEqual([
      "validation_error",
      "unauthorized",
      "origin_rejected",
      "not_found",
      "logo_preview_mismatch",
      "logo_changed_concurrently",
      "file_too_large",
      "internal_error",
    ]);
    expect(validator("Error")({ error: { code: "logo_preview_mismtach", message: "x", request_id: RID } })).toBe(
      false,
    );
  });

  it("ties details to the code that carries them", () => {
    const err = validator("Error");
    const issues = [{ code: "invalid_type", path: ["tenantId"], message: "Invalid uuid" }];
    expect(err({ error: { code: "not_found", message: "x", request_id: RID, details: issues } })).toBe(false);
    expect(err({ error: { code: "validation_error", message: "x", request_id: RID } })).toBe(true);
    const rej = validator("LogoRejectedError");
    expect(rej({ error: { code: "svg_unsafe_content", message: "x", request_id: RID } })).toBe(false);
    expect(
      rej({ error: { code: "image_too_small", message: "x", request_id: RID, details: { construct: "script" } } }),
    ).toBe(false);
  });

  it("narrows each error response to its own code", () => {
    const cases: Array<[string, string[]]> = [
      ["ValidationFailure", ["validation_error"]],
      ["DeviceUnauthorized", ["unauthorized"]],
      ["Unauthorized", ["unauthorized"]],
      ["OriginRejected", ["origin_rejected"]],
      ["NotFound", ["not_found"]],
      ["Conflict", ["logo_preview_mismatch", "logo_changed_concurrently"]],
      ["RevisionConflict", ["logo_changed_concurrently"]],
      ["FileTooLarge", ["file_too_large"]],
      ["SystemFailure", ["internal_error"]],
    ];
    const all = (schema("Error").properties!.error as { properties: { code: { enum: string[] } } }).properties.code
      .enum;
    for (const [name, allowed] of cases) {
      const valid = ajv.getSchema(
        `${CONTRACT_ID}#/components/responses/${name}/content/application~1json/schema`,
      )!;
      for (const code of all) {
        expect([name, code, valid({ error: { code, message: "x", request_id: RID } })]).toEqual([
          name,
          code,
          allowed.includes(code),
        ]);
      }
    }
  });

  it("gives the removal only the revision conflict", () => {
    expect(op(LOGO_PATH, "delete").responses?.["409"]?.$ref).toBe("#/components/responses/RevisionConflict");
    expect(op(LOGO_PATH, "put").responses?.["409"]?.$ref).toBe("#/components/responses/Conflict");
  });

  it("names a construct for every FR-07 refusal", () => {
    expect(schema("SvgUnsafeConstruct").enum).toEqual([
      "script",
      "event_handler",
      "external_reference",
      "foreign_object",
      "embedded_content",
      "entity",
      "image_element",
      "css_import",
    ]);
  });

  it("closes the warnings", () => {
    expect(schema("LogoWarning").enum).toEqual(WARNINGS);
  });
});

describe("tenant-branding — projections", () => {
  it("accepts a full logo with 8 screen renditions and a receipt rendition", () => {
    const valid = validator("TenantBranding");
    expect(valid({ tenant_display_name: "Al Nour", revision: 3, logo: logo() })).toBe(true);
  });

  it("requires exactly 8 screen renditions", () => {
    const valid = validator("TenantLogo");
    expect(valid({ ...logo(), screen: screen().slice(0, 7) })).toBe(false);
  });

  it("requires exactly one rendition per (slot, scale) pair", () => {
    const { updated_at: _updatedAt, ...preview } = logo();
    for (const [name, base] of [
      ["TenantLogo", logo()],
      ["LogoPreview", preview],
    ] as const) {
      const valid = validator(name);
      expect(valid(base)).toBe(true);
      // Eight items, one pair duplicated and another missing.
      const dup = screen();
      dup[1] = { ...dup[0]! };
      expect(valid({ ...base, screen: dup })).toBe(false);
      // Eight copies of one pair.
      expect(valid({ ...base, screen: Array.from({ length: 8 }, () => screen()[0]!) })).toBe(false);
    }
  });

  it("caps the receipt rendition at 48 x 15 mm at the 600 dpi ceiling", () => {
    const valid = validator("TenantLogo");
    const at600 = { width_px: 1133, height_px: 354, dpi: 600, png_base64: PNG };
    expect(valid({ ...logo(), receipt: at600 })).toBe(true);
    expect(valid({ ...logo(), receipt: { ...at600, width_px: 1134 } })).toBe(false);
    expect(valid({ ...logo(), receipt: { ...at600, height_px: 355 } })).toBe(false);
  });

  it("forces the card when the logo is low-contrast (FR-11)", () => {
    const { updated_at: _updatedAt, ...preview } = logo();
    for (const [name, base] of [
      ["TenantLogo", logo()],
      ["LogoPreview", preview],
    ] as const) {
      const valid = validator(name);
      const lowContrast = { ...base, warnings: ["low_contrast"] };
      expect(valid({ ...lowContrast, presentation: { card: true } })).toBe(true);
      expect(valid({ ...lowContrast, presentation: { card: false } })).toBe(false);
    }
  });

  it("pins the logo state after a save and after a removal", () => {
    expect(op(LOGO_PATH, "put").responses?.["200"]).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/TenantBrandingSaved" } } },
    });
    expect(op(LOGO_PATH, "delete").responses?.["200"]).toMatchObject({
      content: { "application/json": { schema: { $ref: "#/components/schemas/TenantBrandingRemoved" } } },
    });
    const saved = validator("TenantBrandingSaved");
    const removed = validator("TenantBrandingRemoved");
    const withLogo = { tenant_display_name: "Al Nour", revision: 4, logo: logo() };
    const without = { tenant_display_name: "Al Nour", revision: 5, logo: null };
    expect(saved(withLogo)).toBe(true);
    expect(saved(without)).toBe(false);
    expect(removed(without)).toBe(true);
    expect(removed(withLogo)).toBe(false);
  });

  it("never pairs a stored logo with revision 0 (0 = never written)", () => {
    for (const name of ["TenantBranding", "TenantBrandingSaved"]) {
      const valid = validator(name);
      expect(valid({ tenant_display_name: "Al Nour", revision: 0, logo: logo() })).toBe(false);
      expect(valid({ tenant_display_name: "Al Nour", revision: 1, logo: logo() })).toBe(true);
    }
    expect(validator("TenantBranding")({ tenant_display_name: "Al Nour", revision: 0, logo: null })).toBe(true);
  });

  it("rejects an unknown slot, a scale of 3 and a non-hex version", () => {
    const valid = validator("TenantLogo");
    const bad = screen();
    bad[0] = { ...bad[0]!, slot: "frame" as never };
    expect(valid({ ...logo(), screen: bad })).toBe(false);
    const badScale = screen();
    badScale[0] = { ...badScale[0]!, scale: 3 as never };
    expect(valid({ ...logo(), screen: badScale })).toBe(false);
    expect(valid({ ...logo(), version: "Z".repeat(64) })).toBe(false);
  });

  it("is strict: no extra field on any projection", () => {
    for (const name of [
      "TenantBranding",
      "TenantLogo",
      "LogoPreview",
      "ScreenRendition",
      "ReceiptRendition",
      "Presentation",
      "Error",
      "LogoRejectedError",
    ]) {
      expect(schema(name).additionalProperties).toBe(false);
    }
    expect(validator("TenantLogo")({ ...logo(), master_png: PNG })).toBe(false);
  });

  it("the preview carries the version to echo, and no updated_at", () => {
    const { updated_at: _ignored, ...preview } = logo();
    expect(validator("LogoPreview")(preview)).toBe(true);
    expect(validator("LogoPreview")(logo())).toBe(false);
  });

  it("the receipt rendition carries its dpi", () => {
    expect(schema("ReceiptRendition").required).toEqual(
      expect.arrayContaining(["width_px", "height_px", "dpi", "png_base64"]),
    );
  });
});

/**
 * The ETag recipe (spec 039 FR-18) as executable documentation: the POS
 * recomputes it to validate its cached name record, so both sides must agree
 * byte for byte. These vectors pin the layout UTF8(name) 0x00 ASCII(revision).
 */
function etag(name: string, revision: number): string {
  const input = Buffer.concat([Buffer.from(name, "utf8"), Buffer.from([0]), Buffer.from(String(revision), "ascii")]);
  return `"${createHash("sha256").update(input).digest("hex")}"`;
}

describe("tenant-branding — ETag recipe (FR-18)", () => {
  const NAME = "صيدلية النور";

  it("revision 0 (never written)", () => {
    expect(etag(NAME, 0)).toBe('"3bb27d9a6fa499803a7fc09b5875e62c305fdad24b88cf1f5435b65003de9919"');
  });

  it("revision 3", () => {
    expect(etag(NAME, 3)).toBe('"7f0554e64f2d9f8568dceedc793ad4766963e4590215d24f7893b9d187ada13b"');
  });

  it("the vectors satisfy the ETag header pattern", () => {
    const header = (doc as unknown as { components: { headers: Record<string, { schema: { pattern: string } }> } })
      .components.headers.ETag!.schema.pattern;
    expect(new RegExp(header).test(etag(NAME, 0))).toBe(true);
  });
});
