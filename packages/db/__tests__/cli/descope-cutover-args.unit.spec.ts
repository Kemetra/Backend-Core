/**
 * RT-791 — the Descope cutover CLI's argument parsing (no database).
 */
import {
  clerkIssuerFromEnv,
  descopeIssuerFromEnv,
  parseDescopeCutoverArgs,
} from "../../src/cli/descope-cutover";

const U = "0A000000-0000-7000-8000-000000000791";
const ENV = { DESCOPE_PROJECT_ID: "P2cutoverArgs01" } as NodeJS.ProcessEnv;

describe("parseDescopeCutoverArgs", () => {
  it("parses apply with the derived issuer, lower-casing the user id", () => {
    expect(parseDescopeCutoverArgs(["apply", "--user", U, "--descope-subject", "U2abc"], ENV)).toEqual({
      kind: "apply",
      userId: U.toLowerCase(),
      descopeSubject: "U2abc",
      issuer: "https://api.descope.com/P2cutoverArgs01",
      clerkIssuer: "https://clerk.dp2.local",
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
    ["a mistyped --dryrun (never a live run)", ["apply", "--user", U, "--descope-subject", "U2abc", "--dryrun"], ENV, /unknown flag/],
    ["a flag of the other command", ["rollback", "--user", U, "--descope-subject", "U2abc"], ENV, /unknown flag/],
    ["a duplicate flag", ["rollback", "--user", U, "--user", U], ENV, /more than once/],
    ["a duplicate --dry-run", ["rollback", "--user", U, "--dry-run", "--dry-run"], ENV, /more than once/],
    ["a stray positional argument", ["rollback", "--user", U, "extra"], ENV, /positional/],
    ["a single-dash flag", ["rollback", "--user", U, "-dry-run"], ENV, /positional/],
  ])("refuses %s", (_label, argv, env, message) => {
    expect(() => parseDescopeCutoverArgs(argv, env)).toThrow(message);
  });

  it("never echoes argument values in its errors", () => {
    expect(() => parseDescopeCutoverArgs(["rollback", "--user", "secret-ish"], ENV)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("secret-ish") }),
    );
  });
});

describe("clerkIssuerFromEnv", () => {
  it("defaults to the 0025 issuer when CLERK_JWT_ISSUER is unset or empty", () => {
    expect(clerkIssuerFromEnv({})).toBe("https://clerk.dp2.local");
    expect(clerkIssuerFromEnv({ CLERK_JWT_ISSUER: "" })).toBe("https://clerk.dp2.local");
  });

  it("uses CLERK_JWT_ISSUER verbatim, as the API adapter does", () => {
    expect(clerkIssuerFromEnv({ CLERK_JWT_ISSUER: "https://clerk.example.com" })).toBe("https://clerk.example.com");
  });

  it.each(["clerk.example.com", "http://clerk.example.com", "https://has space", " https://x"])(
    "refuses a malformed CLERK_JWT_ISSUER %p (exit 3 before any write)",
    (bad) => {
      expect(() => clerkIssuerFromEnv({ CLERK_JWT_ISSUER: bad })).toThrow(/CLERK_JWT_ISSUER/);
      expect(() =>
        parseDescopeCutoverArgs(["apply", "--user", U, "--descope-subject", "U2abc"], { ...ENV, CLERK_JWT_ISSUER: bad }),
      ).toThrow(/CLERK_JWT_ISSUER/);
    },
  );
});

describe("descopeIssuerFromEnv", () => {
  it("prefers DESCOPE_JWT_ISSUER", () => {
    expect(descopeIssuerFromEnv({ ...ENV, DESCOPE_JWT_ISSUER: "P2cutoverArgs01" })).toBe("P2cutoverArgs01");
  });

  it("refuses a malformed project id", () => {
    expect(() => descopeIssuerFromEnv({ DESCOPE_PROJECT_ID: "P2/../x" })).toThrow(/DESCOPE_PROJECT_ID/);
  });
});
