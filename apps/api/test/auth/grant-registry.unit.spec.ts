/**
 * RT-812 — the boot-checked grant lists are assembled from one fragment per
 * feature (`src/auth/grants/<slug>.grants.ts`). These tests pin how fragments
 * merge and that a malformed or conflicting fragment refuses boot instead of
 * silently narrowing what the boot check verifies.
 */
import { buildGrantRegistry } from "../../src/auth/grant-registry";
import { ALL_TABLE_PRIVILEGES } from "../../src/auth/grant-fragment";

const fragment = (name: string, grants: unknown) => ({ name, exports: { GRANTS: grants } });
const empty = { deployScripts: [], domainRequired: [], lookupForbidden: [], lookupAllowed: [] };

describe("buildGrantRegistry", () => {
  it("concatenates the fragments in load order and indexes scripts and allowed tables", () => {
    const registry = buildGrantRegistry([
      fragment("baseline", {
        ...empty,
        deployScripts: ["a-domain-grants.sql"],
        domainRequired: [["a", "SELECT"]],
        lookupForbidden: [["a", ALL_TABLE_PRIVILEGES]],
      }),
      fragment("refunds", {
        deployScripts: ["refunds-domain-grants.sql"],
        domainRequired: [["refunds", "SELECT"], ["refunds", "INSERT"]],
        lookupForbidden: [["refunds", ALL_TABLE_PRIVILEGES]],
        lookupAllowed: [{ table: "refund_codes", reason: "static reference codes, no tenant data" }],
      }),
    ]);
    expect(registry.domainRequired).toEqual([["a", "SELECT"], ["refunds", "SELECT"], ["refunds", "INSERT"]]);
    expect(registry.lookupForbidden.map(([t]) => t)).toEqual(["a", "refunds"]);
    expect(registry.deployScripts).toEqual({
      "a-domain-grants.sql": "baseline",
      "refunds-domain-grants.sql": "refunds",
    });
    expect(registry.lookupAllowed).toEqual({ refund_codes: "static reference codes, no tenant data" });
    expect(registry.fragments.map((f) => f.name)).toEqual(["baseline", "refunds"]);
    expect(Object.isFrozen(registry.domainRequired)).toBe(true);
  });

  it.each([
    ["a domain grant", { ...empty, domainRequired: [["a", "SELECT"]] }, /domain grant SELECT ON a.*baseline and other/],
    ["a forbidden table", { ...empty, lookupForbidden: [["a", ALL_TABLE_PRIVILEGES]] }, /forbidden table a.*baseline and other/],
    ["a deploy script", { ...empty, deployScripts: ["a-domain-grants.sql"] }, /a-domain-grants\.sql.*baseline and other/],
    ["an allowed table", { ...empty, lookupAllowed: [{ table: "a", reason: "static" }] }, /allowed table a.*baseline and other/],
  ])("refuses %s declared by two fragments", (_label, grants, message) => {
    expect(() => buildGrantRegistry([fragment("baseline", grants), fragment("other", grants)])).toThrow(message);
  });

  it("refuses a table both forbidden and allowed for the lookup role", () => {
    expect(() =>
      buildGrantRegistry([
        fragment("baseline", { ...empty, lookupForbidden: [["a", ALL_TABLE_PRIVILEGES]] }),
        fragment("other", { ...empty, lookupAllowed: [{ table: "a", reason: "static" }] }),
      ]),
    ).toThrow(/a is both forbidden and allowed/);
  });

  it.each([
    ["no GRANTS export", { name: "x", exports: {} }],
    ["a missing list", fragment("x", { deployScripts: [], domainRequired: [], lookupForbidden: [] })],
    ["a non-pair domain grant", fragment("x", { ...empty, domainRequired: [["a"]] })],
    ["an unknown privilege", fragment("x", { ...empty, domainRequired: [["a", "SELEKT"]] })],
    ["a non-identifier table", fragment("x", { ...empty, domainRequired: [["a; DROP", "SELECT"]] })],
    ["a forbidden entry with an unknown privilege", fragment("x", { ...empty, lookupForbidden: [["a", "SELECT, OWN"]] })],
    ["a script outside the routine naming", fragment("x", { ...empty, deployScripts: ["../a.sql"] })],
    ["an allowed table with no reason", fragment("x", { ...empty, lookupAllowed: [{ table: "a", reason: " " }] })],
    ["a domain grant naming two privileges", fragment("x", { ...empty, domainRequired: [["a", "SELECT, INSERT"]] })],
  ])("refuses a fragment with %s", (_label, bad) => {
    expect(() => buildGrantRegistry([fragment("baseline", empty), bad])).toThrow(/grants fragment x/);
  });
});
