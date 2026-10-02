/**
 * password-max-length.unit.spec.ts — RT-153 (RT-145 F1).
 *
 * The canonical password maximum is 1024 Unicode code points. Three
 * boundaries enforce it and must agree on every input:
 *   - runtime: the Zod DTOs (`SignInSchema.password`,
 *     `PasswordResetConfirmSchema.new_password`);
 *   - package: `isWithinPasswordMaxLength` in `@data-pulse-2/auth`, used by
 *     `hashPassword` / `verifyPassword`;
 *   - contract: `maxLength` in `auth.openapi.yaml`, checked with ajv (which,
 *     like JSON Schema, counts code points).
 *
 * Also pins that a reset can never set a password that sign-in rejects.
 * Docker-free.
 */
import Ajv, { type ValidateFunction } from "ajv";
import {
  isWithinPasswordMaxLength,
  MAX_PASSWORD_CODE_POINTS,
} from "@data-pulse-2/auth";

import { PasswordResetConfirmSchema, SignInSchema } from "../../src/auth/dto";
import { loadOpenApiContracts } from "../../src/openapi/loader";

const EMOJI = "\u{1F600}"; // non-BMP: 1 code point, 2 UTF-16 units
const CLEF = "\u{1D11E}"; // non-BMP
const LONE_HIGH_SURROGATE = "\uD800";

/** [label, value, code points] — every case is long enough for both minimums. */
const CASES: ReadonlyArray<readonly [string, string, number]> = [
  ["12 ASCII", "a".repeat(12), 12],
  ["1024 ASCII", "a".repeat(1024), 1024],
  ["1025 ASCII", "a".repeat(1025), 1025],
  ["1024 '€'", "€".repeat(1024), 1024],
  ["1025 '€'", "€".repeat(1025), 1025],
  ["512 emoji (1024 UTF-16 units, the old cap)", EMOJI.repeat(512), 512],
  ["1023 ASCII + 1 emoji (1025 UTF-16 units)", "a".repeat(1023) + EMOJI, 1024],
  ["1024 emoji (2048 UTF-16 units)", EMOJI.repeat(1024), 1024],
  ["1024 emoji + 1 ASCII", EMOJI.repeat(1024) + "a", 1025],
  ["1025 emoji (2050 UTF-16 units)", EMOJI.repeat(1025), 1025],
  ["512 emoji + 512 clef", EMOJI.repeat(512) + CLEF.repeat(512), 1024],
  ["512 emoji + 513 clef", EMOJI.repeat(512) + CLEF.repeat(513), 1025],
  ["1024 lone surrogates", LONE_HIGH_SURROGATE.repeat(1024), 1024],
  ["1025 lone surrogates", LONE_HIGH_SURROGATE.repeat(1025), 1025],
];

const EMAIL = "user@example.com";
const TOKEN = "some-token";

const ajv = new Ajv({ strict: false });
let contractSignInPassword: Record<string, unknown>;
let contractResetNewPassword: Record<string, unknown>;
let validateSignInPassword: ValidateFunction;
let validateResetNewPassword: ValidateFunction;

beforeAll(() => {
  const contract = loadOpenApiContracts().find((c) => c.id === "auth.openapi");
  if (!contract) throw new Error("auth.openapi contract not found");
  const doc = contract.document as {
    paths: Record<string, { post: { requestBody: { content: Record<string, { schema: { properties: Record<string, Record<string, unknown>> } }> } } }>;
    components: { schemas: Record<string, { properties: Record<string, Record<string, unknown>> }> };
  };
  contractSignInPassword = doc.components.schemas["SignInRequest"]!.properties["password"]!;
  contractResetNewPassword =
    doc.paths["/api/v1/auth/password-reset/confirm"]!.post.requestBody.content["application/json"]!.schema.properties["new_password"]!;
  validateSignInPassword = ajv.compile(contractSignInPassword);
  validateResetNewPassword = ajv.compile(contractResetNewPassword);
});

describe("RT-153 contract declares the canonical maximum", () => {
  it("MAX_PASSWORD_CODE_POINTS is 1024", () => {
    expect(MAX_PASSWORD_CODE_POINTS).toBe(1024);
  });

  it("SignInRequest.password has maxLength 1024", () => {
    expect(contractSignInPassword["maxLength"]).toBe(MAX_PASSWORD_CODE_POINTS);
  });

  it("confirmPasswordReset new_password has maxLength 1024", () => {
    expect(contractResetNewPassword["maxLength"]).toBe(MAX_PASSWORD_CODE_POINTS);
  });

  it("existing minimums are unchanged (contract 8 / 12)", () => {
    expect(contractSignInPassword["minLength"]).toBe(8);
    expect(contractResetNewPassword["minLength"]).toBe(12);
  });
});

describe("RT-153 runtime, package and contract agree at the 1024/1025 boundary", () => {
  it.each(CASES)("%s", (_label, value, codePoints) => {
    expect([...value]).toHaveLength(codePoints);
    const expected = codePoints <= MAX_PASSWORD_CODE_POINTS;

    expect(isWithinPasswordMaxLength(value)).toBe(expected);
    expect(SignInSchema.safeParse({ email: EMAIL, password: value }).success).toBe(expected);
    expect(
      PasswordResetConfirmSchema.safeParse({ token: TOKEN, new_password: value }).success,
    ).toBe(expected);
    expect(validateSignInPassword(value)).toBe(expected);
    expect(validateResetNewPassword(value)).toBe(expected);
  });
});

describe("RT-153 DTOs pass the password through unchanged", () => {
  it.each(CASES.filter(([, , n]) => n <= MAX_PASSWORD_CODE_POINTS))("%s", (_label, value) => {
    const signIn = SignInSchema.parse({ email: EMAIL, password: value });
    expect(signIn.password).toBe(value);
    const reset = PasswordResetConfirmSchema.parse({ token: TOKEN, new_password: value });
    expect(reset.new_password).toBe(value);
  });

  it("does not normalize or trim", () => {
    const nfd = " Café ";
    expect(SignInSchema.parse({ email: EMAIL, password: nfd }).password).toBe(nfd);
  });
});

describe("RT-153 over-limit DTO error keeps the too_big shape of the old .max()", () => {
  it.each([
    ["sign-in password", () => SignInSchema.safeParse({ email: EMAIL, password: EMOJI.repeat(1025) }), "password"],
    [
      "reset new_password",
      () => PasswordResetConfirmSchema.safeParse({ token: TOKEN, new_password: EMOJI.repeat(1025) }),
      "new_password",
    ],
  ] as const)("%s", (_label, parse, field) => {
    const result = parse();
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        code: "too_big",
        type: "string",
        maximum: 1024,
        inclusive: true,
        path: [field],
      }),
    ]);
  });
});

describe("RT-153 a reset cannot set a password that sign-in rejects", () => {
  it.each(CASES)("%s", (_label, value) => {
    const resetOk = PasswordResetConfirmSchema.safeParse({ token: TOKEN, new_password: value }).success;
    const signInOk = SignInSchema.safeParse({ email: EMAIL, password: value }).success;
    if (resetOk) expect(signInOk).toBe(true);
  });
});
