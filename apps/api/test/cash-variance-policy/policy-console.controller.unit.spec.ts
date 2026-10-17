/**
 * RT-387 (Opus review M2): a publish that loses the scope's chain race in the
 * database (`ConcurrentPolicyChangeError`, the 0050 chain index / guard
 * backstop behind the advisory lock) is the contract's 409
 * `cash_variance_policy_changed_concurrently`, never a 500.
 */
import "reflect-metadata";

import { HttpException } from "@nestjs/common";

import { CashVariancePolicyConsoleController } from "../../src/cash-variance-policy/policy-console.controller";
import { ConcurrentPolicyChangeError } from "../../src/cash-variance-policy/policy.repository";
import type { CashVariancePolicyService } from "../../src/cash-variance-policy/policy.service";
import type { TenantContextRequest } from "../../src/context/types";

const TENANT = "0a000000-0000-7000-8000-000003870a01";
const STORE = "0a000000-0000-7000-8000-000003870a02";
const USER = "0a000000-0000-7000-8000-000003870a03";

const request = {
  context: { tenantId: TENANT, userId: USER, storeId: null },
  requestId: "0a000000-0000-7000-8000-000003870a04",
} as unknown as TenantContextRequest;

function controllerFailingWith(err: Error): CashVariancePolicyConsoleController {
  const service = {
    tenantPublish: jest.fn(() => Promise.reject(err)),
    storePublish: jest.fn(() => Promise.reject(err)),
  } as unknown as CashVariancePolicyService;
  return new CashVariancePolicyConsoleController(service);
}

async function refusal(work: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const err = await work.then(
    () => {
      throw new Error("expected a refusal");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpException);
  const http = err as HttpException;
  return { status: http.getStatus(), body: http.getResponse() };
}

describe("a lost chain race on publish", () => {
  const conflict = { status: 409, body: { code: "cash_variance_policy_changed_concurrently", message: expect.any(String) } };

  it("is 409 on the tenant publish", async () => {
    const controller = controllerFailingWith(new ConcurrentPolicyChangeError());
    const body = { expectedRevisionId: null, policyValue: { mode: "none" as const }, reason: "r" };
    expect(await refusal(controller.tenantPublish(request, TENANT, body))).toEqual(conflict);
  });

  it("is 409 on the store publish", async () => {
    const controller = controllerFailingWith(new ConcurrentPolicyChangeError());
    const body = { expectedRevisionId: null, kind: "clear" as const, reason: "r" };
    expect(await refusal(controller.storePublish(request, STORE, body))).toEqual(conflict);
  });

  it("leaves any other error to the 500 path", async () => {
    const boom = new Error("boom");
    const controller = controllerFailingWith(boom);
    const body = { expectedRevisionId: null, kind: "clear" as const, reason: "r" };
    await expect(controller.storePublish(request, STORE, body)).rejects.toBe(boom);
  });
});
