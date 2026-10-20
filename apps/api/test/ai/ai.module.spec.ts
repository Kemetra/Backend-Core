/**
 * RT-655 / RT-664 — AiModule default wiring is inert.
 *
 * With no overrides the gateway must deny everything: the real entitlement
 * port (RT-664) fails closed when its store is unreachable, the budget fails
 * closed, the route allowlist is empty and the provider is disabled. The fake adapter is test-only and never bound by default.
 * AiModule is deliberately NOT imported by AppModule yet: it has no controller
 * and adds no HTTP route.
 */
import "reflect-metadata";

import { Test } from "@nestjs/testing";
import { Pool } from "pg";

import { AiGatewayEntitlementPort } from "../../src/ai-entitlements/gateway-entitlement.port";
import { PG_POOL } from "../../src/auth/auth.module";

import { DisabledModelProvider } from "../../src/ai/adapters/disabled/disabled-model-provider";
import { AiModule } from "../../src/ai/ai.module";
import {
  AI_BUDGET,
  AI_ENTITLEMENT,
  AI_FEATURES,
  AI_MODEL_PROVIDERS,
  AI_ROUTE_ALLOWLIST,
} from "../../src/ai/ai.tokens";
import { readAiGatewayRuntime } from "../../src/ai/gateway/ai-gateway.runtime";
import { AiGateway } from "../../src/ai/gateway/ai-gateway.service";
import { conformanceRequest } from "../_helpers/model-provider-conformance";
import { FEATURE_ID, scope } from "./_support/gateway-harness";

describe("AiModule — default bindings", () => {
  // No database: the entitlement port's store is unreachable, so it must fail closed.
  const unreachable = new Pool({ connectionString: "postgres://nobody:nothing@127.0.0.1:1/none", connectionTimeoutMillis: 300 });
  unreachable.on("error", () => undefined);
  afterAll(() => unreachable.end());

  async function resolve() {
    return Test.createTestingModule({ imports: [AiModule] }).overrideProvider(PG_POOL).useValue(unreachable).compile();
  }

  it("resolves the gateway and binds the safe defaults", async () => {
    const moduleRef = await resolve();
    expect(moduleRef.get(AiGateway)).toBeInstanceOf(AiGateway);
    expect(moduleRef.get(AI_ROUTE_ALLOWLIST)).toEqual([]);
    expect(moduleRef.get(AI_FEATURES)).toEqual([]);
    const providers = moduleRef.get<readonly { providerKey: string }[]>(AI_MODEL_PROVIDERS);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toBeInstanceOf(DisabledModelProvider);
    expect(providers.map((p) => p.providerKey)).not.toContain("fake");
  });

  it("binds the RT-664 entitlement port, which fails closed when its store is unreachable", async () => {
    const moduleRef = await resolve();
    const entitlement = moduleRef.get<{ check(input: unknown): Promise<unknown> }>(AI_ENTITLEMENT);
    expect(entitlement).toBeInstanceOf(AiGatewayEntitlementPort);
    await expect(
      entitlement.check({ tenantId: "0191a000-0000-7000-8000-000000000001", userId: "0191a000-0000-7000-8000-0000000000a1", featureId: "ai.ask", storeIds: [] }),
    ).resolves.toEqual({ allowed: false, reason: "entitlement_unavailable" });
  });

  it("the default budget fails closed", async () => {
    const moduleRef = await resolve();
    const budget = moduleRef.get<{ check(input: unknown): Promise<unknown> }>(AI_BUDGET);
    await expect(
      budget.check({ tenantId: "t", userId: "u", featureId: "f", storeIds: [], routeKey: "r" }),
    ).resolves.toEqual({ allowed: false, reason: "entitlement_unavailable" });
  });

  it("the default gateway denies a fully authorized caller (no feature, no entitlement)", async () => {
    const moduleRef = await resolve();
    const result = await moduleRef.get(AiGateway).run(FEATURE_ID, scope());
    expect(result).toMatchObject({ kind: "fallback", providerRequested: false });
  });

  it("the disabled provider returns unavailable/disabled as a value and never throws", async () => {
    const provider = new DisabledModelProvider();
    await expect(
      provider.generate(conformanceRequest(), new AbortController().signal),
    ).resolves.toEqual({ kind: "unavailable", cause: "disabled" });
  });
});

describe("readAiGatewayRuntime — the kill switch defaults off (AI disabled)", () => {
  const saved = { enabled: process.env["AI_GATEWAY_ENABLED"], node: process.env["NODE_ENV"] };

  afterEach(() => {
    if (saved.enabled === undefined) delete process.env["AI_GATEWAY_ENABLED"];
    else process.env["AI_GATEWAY_ENABLED"] = saved.enabled;
    process.env["NODE_ENV"] = saved.node;
  });

  it("is disabled when AI_GATEWAY_ENABLED is unset or empty", () => {
    delete process.env["AI_GATEWAY_ENABLED"];
    expect(readAiGatewayRuntime().isEnabled()).toBe(false);
    process.env["AI_GATEWAY_ENABLED"] = "";
    expect(readAiGatewayRuntime().isEnabled()).toBe(false);
  });

  it.each(["1", "true", "yes", " TRUE "])("accepts %j as enabled", (value) => {
    process.env["AI_GATEWAY_ENABLED"] = value;
    expect(readAiGatewayRuntime().isEnabled()).toBe(true);
  });

  it.each(["0", "false", "no", "enabled", "on"])("treats %j as disabled", (value) => {
    process.env["AI_GATEWAY_ENABLED"] = value;
    expect(readAiGatewayRuntime().isEnabled()).toBe(false);
  });

  it("reads the flag per call, not once at boot", () => {
    const runtime = readAiGatewayRuntime();
    delete process.env["AI_GATEWAY_ENABLED"];
    expect(runtime.isEnabled()).toBe(false);
    process.env["AI_GATEWAY_ENABLED"] = "true";
    expect(runtime.isEnabled()).toBe(true);
  });

  it("reports production from NODE_ENV", () => {
    process.env["NODE_ENV"] = "production";
    expect(readAiGatewayRuntime().isProduction()).toBe(true);
    process.env["NODE_ENV"] = "test";
    expect(readAiGatewayRuntime().isProduction()).toBe(false);
  });
});
