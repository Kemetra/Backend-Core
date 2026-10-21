import "reflect-metadata";

import { type INestApplication } from "@nestjs/common";

import { bootDbLessApp, type DbLessApp } from "../_helpers/db-less-app";
import { conformanceViolations } from "../_helpers/openapi-conformance";
import { CONTRACTS_DIR, contractRoutes, normalizePath } from "../_helpers/openapi-routes";

type ExpressLayer = {
  route?: {
    path: string;
    methods: Record<string, boolean>;
  };
};

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

describe("OpenAPI operations map to registered Nest routes", () => {
  let booted: DbLessApp;
  let app: INestApplication;

  beforeAll(async () => {
    booted = await bootDbLessApp("route-check");
    app = booted.app;
  });

  afterAll(async () => {
    await booted.close();
  });

  // RT-805: the contract-only set comes from the `x-runtime-status` markers
  // (with their `x-runtime-note`), not from a hand-kept list here, so adding
  // or lifting an operation touches only its own contract. The rules and
  // their negative cases live in runtime-route-conformance.rules.spec.ts.
  it("has a real registered method/path for every production operationId", () => {
    const contracts = contractRoutes(CONTRACTS_DIR);
    expect(contracts.length).toBeGreaterThanOrEqual(150);
    expect(conformanceViolations(contracts, registeredRoutes(app))).toEqual([]);
  });
});
