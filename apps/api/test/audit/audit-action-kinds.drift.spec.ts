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

import type { INestApplication, Type } from "@nestjs/common";
import { METHOD_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { NestFactory, ModulesContainer } from "@nestjs/core";

import { AppModule } from "../../src/app.module";
import {
  READ_ACTION_CODES,
  RETIRED_READ_CODES,
  kindOf,
} from "../../src/audit/audit-action-kinds";
import { AUDITABLE_KEY } from "../../src/audit/auditable.decorator";

interface AuditableRoute {
  readonly id: string;
  readonly isGet: boolean;
  readonly action: string;
}

function auditableRoutes(controller: Type<unknown>): AuditableRoute[] {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== "constructor" && typeof proto[name] === "function")
    .flatMap((name) => {
      const handler = proto[name] as object;
      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      const action = Reflect.getMetadata(AUDITABLE_KEY, handler) as string | undefined;
      if (verb === undefined || action === undefined) return [];
      return [{ id: `${controller.name}.${name}`, isGet: verb === RequestMethod.GET, action }];
    });
}

/** Registry problems for `routes`; empty when the registry is in sync. */
export function driftProblems(
  routes: readonly AuditableRoute[],
  readCodes: readonly string[],
  retiredReadCodes: readonly string[],
): string[] {
  const reads = new Set(readCodes);
  const liveGetCodes = new Set(routes.filter((r) => r.isGet).map((r) => r.action));
  const problems: string[] = [];
  for (const r of routes) {
    if (r.isGet && !reads.has(r.action)) {
      problems.push(`GET ${r.id} code "${r.action}" is not registered as read`);
    }
    if (!r.isGet && reads.has(r.action)) {
      problems.push(`non-GET ${r.id} code "${r.action}" is registered as read`);
    }
  }
  for (const code of readCodes) {
    if (!liveGetCodes.has(code) && !retiredReadCodes.includes(code)) {
      problems.push(`read code "${code}" is neither a live GET @Auditable code nor retired`);
    }
  }
  return problems;
}

describe("audit action-kind registry drift guard (RT-567 §4.3)", () => {
  let app: INestApplication;
  let routes: AuditableRoute[] = [];
  const originalEnv = {
    NODE_ENV: process.env["NODE_ENV"],
    DATABASE_URL: process.env["DATABASE_URL"],
    AUTH_LOOKUP_DATABASE_URL: process.env["AUTH_LOOKUP_DATABASE_URL"],
    REDIS_URL: process.env["REDIS_URL"],
  };

  beforeAll(async () => {
    process.env["NODE_ENV"] = "test";
    // Unreachable on purpose: the sweep reads decorator metadata only.
    process.env["DATABASE_URL"] = "postgres://drift-check:drift-check@127.0.0.1:1/drift-check";
    delete process.env["AUTH_LOOKUP_DATABASE_URL"];
    delete process.env["REDIS_URL"];
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();

    routes = [...app.get(ModulesContainer).values()].flatMap((mod) =>
      [...mod.controllers.values()].flatMap((wrapper) =>
        auditableRoutes(wrapper.metatype as Type<unknown>),
      ),
    );
  });

  afterAll(async () => {
    await app.close();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
