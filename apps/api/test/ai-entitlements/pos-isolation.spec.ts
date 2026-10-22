/**
 * RT-664 — T19 POS isolation (AD-AI-ENT-001 D-1, AI-light rule): POS cashier
 * money, stock, tax and offline paths carry NO entitlement or quota check, so
 * an unreachable entitlement store can never affect a sale.
 *
 * Proved structurally (no database):
 *   - no api source outside `src/ai/**` and `src/ai-entitlements/**` imports
 *     either module, except AppModule registering the Console routes; the
 *     worker (sale processing, inventory, posting) imports neither;
 *   - the module adds no global guard or interceptor;
 *   - its only HTTP routes are the two Console operations, none on the POS
 *     (`/api/pos/...`) surface.
 */
import "reflect-metadata";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";

import { AiEntitlementsController } from "../../src/ai-entitlements/ai-entitlements.controller";
import { AiEntitlementsModule } from "../../src/ai-entitlements/ai-entitlements.module";
import { controllerRoutes } from "../_helpers/openapi-routes";

const API_SRC = resolve(__dirname, "..", "..", "src");
const WORKER_SRC = resolve(__dirname, "..", "..", "..", "worker", "src");

/** A relative import of `…/ai/…` or `…/ai-entitlements/…`, e.g. `./ai/x` or `../ai-entitlements/x`. */
const AI_IMPORT = /from\s+["'](?:\.{1,2}\/)+(?:[\w-]+\/)*(?:ai|ai-entitlements)\/[^"']*["']/;
/** The worker reaching into the api's AI sources. */
const WORKER_AI_IMPORT = /apps\/api\/src\/(?:ai|ai-entitlements)\//;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function importsAi(file: string): boolean {
  return readFileSync(file, "utf8")
    .split("\n")
    .some((line) => AI_IMPORT.test(line));
}

describe("T19 — POS money, stock, tax and offline paths carry no entitlement check", () => {
  it("the import probe recognises an AI import (AppModule has one)", () => {
    expect(importsAi(join(API_SRC, "app.module.ts"))).toBe(true);
  });

  it("no api module outside the AI modules imports them (AppModule only registers the Console routes)", () => {
    const offenders = tsFiles(API_SRC)
      .map((f) => relative(API_SRC, f).replaceAll("\\", "/"))
      .filter((f) => !f.startsWith("ai/") && !f.startsWith("ai-entitlements/") && f !== "app.module.ts")
      .filter((f) => importsAi(join(API_SRC, f)));
    expect(offenders).toEqual([]);
  });

  it("the worker (sale processing, inventory, posting, the outbox) never imports the api AI modules", () => {
    expect(tsFiles(WORKER_SRC).filter((f) => WORKER_AI_IMPORT.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("the module registers no global guard or interceptor", () => {
    const providers = (Reflect.getMetadata("providers", AiEntitlementsModule) as unknown[]) ?? [];
    const globals = providers.filter((p) => {
      const token = typeof p === "object" && p !== null ? (p as { provide?: unknown }).provide : undefined;
      return token === APP_GUARD || token === APP_INTERCEPTOR;
    });
    expect(globals).toEqual([]);
  });

  it("its only routes are the two Console operations, none on the POS surface", () => {
    const routes = controllerRoutes(AiEntitlementsController).map((r) => r.key).sort();
    expect(routes).toEqual([
      "GET /api/v1/tenants/{param}/ai/entitlements",
      "PUT /api/v1/tenants/{param}/ai/entitlements/opt-outs/{param}",
    ]);
    expect(routes.some((r) => r.includes("/api/pos/"))).toBe(false);
  });
});
