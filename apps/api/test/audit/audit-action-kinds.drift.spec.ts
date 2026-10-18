/**
 * RT-567 §4.3 / RT-687 — drift guard for the action-kind registry.
 *
 * Sweeps every `@Auditable` handler of the real AppModule and checks the
 * registry (`src/audit/audit-action-kinds.ts`) against it:
 *   1. every code on a `GET` route is registered as `read`;
 *   2. no code on a non-`GET` route is registered as `read`;
 *   3. the read set is closed: every `read` code is a live `GET`
 *      `@Auditable` code or is on the reviewed `RETIRED_READ_CODES` (D-3).
 * Rule 3 keeps direct-emit change codes (service-level `action: …`) out of
 * the read set without a hand-kept list of them.
 *
 * Docker-free: the app boots against an unreachable DB, like the RT-129
 * route-auth sweep.
 */
import "reflect-metadata";

import { RequestMethod, type Type } from "@nestjs/common";
import { METHOD_METADATA } from "@nestjs/common/constants";

import {
  READ_ACTION_CODES,
  RETIRED_READ_CODES,
  kindOf,
} from "../../src/audit/audit-action-kinds";
import { AUDITABLE_KEY } from "../../src/audit/auditable.decorator";
import { appControllers, bootDbLessApp, type DbLessApp } from "../_helpers/db-less-app";

interface AuditableRoute {
  readonly id: string;
  readonly isGet: boolean;
  readonly action: string;
}

/** The `@Auditable` handlers of `controller`, with whether each is a `GET`. */
function auditableRoutes(controller: Type<unknown>): AuditableRoute[] {
  const proto = controller.prototype as Record<string, object>;
  const routes: AuditableRoute[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    const action = name === "constructor" ? undefined : Reflect.getMetadata(AUDITABLE_KEY, proto[name]!);
    const verb = action === undefined ? undefined : Reflect.getMetadata(METHOD_METADATA, proto[name]!);
    if (typeof action === "string" && verb !== undefined) {
      routes.push({ id: `${controller.name}.${name}`, isGet: verb === RequestMethod.GET, action });
    }
  }
  return routes;
}

/** Registry problems for `routes`; empty when the registry is in sync. */
export function driftProblems(
  routes: readonly AuditableRoute[],
  readCodes: readonly string[],
  retiredReadCodes: readonly string[],
): string[] {
  const reads = new Set(readCodes);
  const liveGetCodes = new Set(routes.filter((r) => r.isGet).map((r) => r.action));
  const unregisteredGets = routes
    .filter((r) => r.isGet && !reads.has(r.action))
    .map((r) => `GET ${r.id} code "${r.action}" is not registered as read`);
  const nonGetReads = routes
    .filter((r) => !r.isGet && reads.has(r.action))
    .map((r) => `non-GET ${r.id} code "${r.action}" is registered as read`);
  const strayReads = readCodes
    .filter((code) => !liveGetCodes.has(code) && !retiredReadCodes.includes(code))
    .map((code) => `read code "${code}" is neither a live GET @Auditable code nor retired`);
  return [...unregisteredGets, ...nonGetReads, ...strayReads];
}

describe("audit action-kind registry drift guard (RT-567 §4.3)", () => {
  let booted: DbLessApp;
  let routes: AuditableRoute[] = [];

  beforeAll(async () => {
    // The sweep reads decorator metadata only.
    booted = await bootDbLessApp("drift-check");
    routes = appControllers(booted.app).flatMap(auditableRoutes);
  });

  afterAll(async () => {
    await booted.close();
  });

  it("finds the @Auditable routes (the sweep is not vacuous)", () => {
    const getCodes = routes.filter((r) => r.isGet).map((r) => r.action);
    expect(getCodes.length).toBeGreaterThanOrEqual(30);
    expect(getCodes).toContain("pos_sales.detail_read");
    expect(routes.some((r) => !r.isGet)).toBe(true);
  });

  it("the registry is in sync with the live @Auditable routes", () => {
    expect(driftProblems(routes, READ_ACTION_CODES, RETIRED_READ_CODES)).toEqual([]);
  });

  it("registers the RT-689 POS readSale code as read", () => {
    expect(kindOf("pos_sales.detail_read")).toBe("read");
  });

  it("the read set has no duplicates and retired codes are not live", () => {
    expect(new Set(READ_ACTION_CODES).size).toBe(READ_ACTION_CODES.length);
    const liveGetCodes = new Set(routes.filter((r) => r.isGet).map((r) => r.action));
    expect(RETIRED_READ_CODES.filter((c) => liveGetCodes.has(c))).toEqual([]);
  });
});

describe("driftProblems detects drift", () => {
  const routes: AuditableRoute[] = [
    { id: "A.list", isGet: true, action: "a.listed" },
    { id: "A.create", isGet: false, action: "a.created" },
  ];

  it("passes when in sync", () => {
    expect(driftProblems(routes, ["a.listed"], [])).toEqual([]);
  });

  it("fails when a GET @Auditable code is unregistered", () => {
    expect(driftProblems(routes, [], [])).toEqual([
      'GET A.list code "a.listed" is not registered as read',
    ]);
  });

  it("fails when a non-GET code is registered as read", () => {
    expect(driftProblems(routes, ["a.listed", "a.created"], [])).toEqual([
      'non-GET A.create code "a.created" is registered as read',
      'read code "a.created" is neither a live GET @Auditable code nor retired',
    ]);
  });

  it("fails when the read set holds a code with no live GET route that is not retired", () => {
    expect(driftProblems(routes, ["a.listed", "auth.signin.ok"], [])).toEqual([
      'read code "auth.signin.ok" is neither a live GET @Auditable code nor retired',
    ]);
  });

  it("accepts a retired read code (D-3)", () => {
    expect(driftProblems(routes, ["a.listed", "old.listed"], ["old.listed"])).toEqual([]);
  });
});
