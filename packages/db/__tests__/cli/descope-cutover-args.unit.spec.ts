/**
 * RT-791 — the Descope cutover CLI's argument parsing (no database).
 */
import { descopeIssuerFromEnv, parseDescopeCutoverArgs } from "../../src/cli/descope-cutover";

const U = "0A000000-0000-7000-8000-000000000791";
const ENV = { DESCOPE_PROJECT_ID: "P2cutoverArgs01" } as NodeJS.ProcessEnv;

describe("parseDescopeCutoverArgs", () => {
  it("parses apply with the derived issuer, lower-casing the user id", () => {
    expect(parseDescopeCutoverArgs(["apply", "--user", U, "--descope-subject", "U2abc"], ENV)).toEqual({
      kind: "apply",
      userId: U.toLowerCase(),
      descopeSubject: "U2abc",
      issuer: "https://api.descope.com/P2cutoverArgs01",
      dryRun: false,
    });
  });

  it("parses rollback (no issuer needed) and --dry-run", () => {
    expect(parseDescopeCutoverArgs(["rollback", "--dry-run", "--user", U], {})).toEqual({
      kind: "rollback",
      userId: U.toLowerCase(),
      dryRun: true,
    });
  });

  it.each<[string, string[], NodeJS.ProcessEnv, RegExp]>([
    ["an unknown command", ["flip", "--user", U], ENV, /usage/],
    ["no command", [], ENV, /usage/],
    ["a missing user", ["rollback"], ENV, /--user/],
    ["a malformed user", ["rollback", "--user", "me"], ENV, /--user/],
    ["a missing descope subject", ["apply", "--user", U], ENV, /--descope-subject/],
    ["a flag as descope subject", ["apply", "--user", U, "--descope-subject", "--dry-run"], ENV, /--descope-subject/],
    ["apply without project id or issuer", ["apply", "--user", U, "--descope-subject", "U2abc"], {}, /DESCOPE_PROJECT_ID/],
  ])("refuses %s", (_label, argv, env, message) => {
    expect(() => parseDescopeCutoverArgs(argv, env)).toThrow(message);
  });

  it("never echoes argument values in its errors", () => {
    expect(() => parseDescopeCutoverArgs(["rollback", "--user", "secret-ish"], ENV)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("secret-ish") }),
    );
  });
});

describe("descopeIssuerFromEnv", () => {
  it("prefers DESCOPE_JWT_ISSUER", () => {
    expect(descopeIssuerFromEnv({ ...ENV, DESCOPE_JWT_ISSUER: "P2cutoverArgs01" })).toBe("P2cutoverArgs01");
  });

  it("refuses a malformed project id", () => {
    expect(() => descopeIssuerFromEnv({ DESCOPE_PROJECT_ID: "P2/../x" })).toThrow(/DESCOPE_PROJECT_ID/);
  });
});
