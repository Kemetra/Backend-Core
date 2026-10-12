import "reflect-metadata";

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { load as parseYaml } from "js-yaml";

import { AppModule } from "../../src/app.module";

type Operation = {
  operationId?: string;
  "x-runtime-status"?: string;
  "x-runtime-note"?: string;
};

type OpenApiDocument = {
  paths?: Record<string, Record<string, Operation>>;
};

type ExpressLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
};

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

type ContractRoute = { path: string; method: string; operation: Operation };

function yamlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? yamlFiles(path)
      : /\.ya?ml$/i.test(entry.name)
        ? [path]
        : [];
  });
}

function normalizePath(path: string): string {
  const normalized = `/${path}`
    .replace(/\/+/, "/")
    .replace(/:[^/]+/g, "{param}")
    .replace(/\{[^/}]+\}/g, "{param}");
  return normalized.length > 1 ? normalized.replace(/\/$/, "") : normalized;
}

function registeredRoutes(app: INestApplication): Set<string> {
  const express = app.getHttpAdapter().getInstance() as {
    router?: { stack: ExpressLayer[] };
    _router?: { stack: ExpressLayer[] };
  };
  const stack = express.router?.stack ?? express._router?.stack ?? [];
  return new Set(stack.flatMap((layer) =>
    Object.entries(layer.route?.methods ?? {})
      .filter(([, enabled]) => enabled)
      .map(([method]) => `${method.toUpperCase()} ${normalizePath(layer.route!.path)}`),
  ));
}

function contractRoutes(dir: string): ContractRoute[] {
  return yamlFiles(dir).flatMap((file) => {
    const document = parseYaml(readFileSync(file, "utf8")) as OpenApiDocument;
    return Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      HTTP_METHODS.flatMap((method) => {
        const operation = item[method];
        return operation?.operationId ? [{ path, method, operation }] : [];
      }),
    );
  });
}

describe("OpenAPI operations map to registered Nest routes", () => {
  let app: INestApplication;
  const originalEnv = {
    NODE_ENV: process.env["NODE_ENV"],
    DATABASE_URL: process.env["DATABASE_URL"],
    AUTH_LOOKUP_DATABASE_URL: process.env["AUTH_LOOKUP_DATABASE_URL"],
    REDIS_URL: process.env["REDIS_URL"],
  };

  beforeAll(async () => {
    process.env["NODE_ENV"] = "test";
    process.env["DATABASE_URL"] = "postgres://route-check:route-check@127.0.0.1:1/route-check";
    delete process.env["AUTH_LOOKUP_DATABASE_URL"];
    delete process.env["REDIS_URL"];
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("has a real registered method/path for every production operationId", () => {
    const runtimeRoutes = registeredRoutes(app);
    const contractsDir = resolve(__dirname, "..", "..", "..", "..", "packages", "contracts", "openapi");
    const missing: string[] = [];
    const explicitContractOnly: string[] = [];
    const operationIds = new Set<string>();

    for (const { path, method, operation } of contractRoutes(contractsDir)) {
      const operationId = operation.operationId!;
      expect(operationIds.has(operationId)).toBe(false);
      operationIds.add(operationId);
      if (operation["x-runtime-status"] === "contract-only") {
        expect(operation["x-runtime-note"]?.trim().length).toBeGreaterThan(0);
        explicitContractOnly.push(operationId);
        continue;
      }
      expect(operation["x-runtime-status"]).toBeUndefined();
      const route = `${method.toUpperCase()} ${normalizePath(path)}`;
      if (!runtimeRoutes.has(route)) missing.push(`${operationId}: ${route}`);
    }

    expect(explicitContractOnly.sort()).toEqual([
      "acceptInvitation",
      "backfillSaleLinkedMovements",
      "consoleCreatePayerAccount",
      "consoleListPayerAccounts",
      "posRedeemVoucher",
      "posReverseVoucher",
      "posValidateVoucher",
    ]);
    expect(missing).toEqual([]);
  });
});
