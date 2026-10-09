/**
 * RT-333 — the re-resolve route's controller branches (Docker-free).
 *
 * The no-session 401, the pass-through of the recorded re-resolution, and the
 * error remaps: a missing / out-of-scope work item → the non-disclosing 404, a
 * non-pending or unresolvable intent → 409 `not_re_resolvable`, anything else
 * re-thrown unchanged. Pure unit — stub services, no DB, no app boot.
 */
import "reflect-metadata";

import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";

import { ErpnextReconciliationController } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.controller";
import {
  RepairNotFoundError,
  type ErpnextReconciliationService,
} from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.service";
import {
  ReResolveConflictError,
  type ErpnextPostingReResolutionService,
} from "../../../../src/catalog/erpnext-reconciliation/posting-re-resolution.service";
import type { TenantContextRequest } from "../../../../src/context/types";

const TENANT = "01900000-0000-7000-8000-0000000000a1";
const ACTOR = "01900000-0000-7000-8000-0000000000d1";
const REF = "01900000-0000-7000-8000-0000000000e1";

function reqWith(context: TenantContextRequest["context"]): TenantContextRequest {
  return { context } as TenantContextRequest;
}
const authedReq = reqWith({
  userId: ACTOR,
  tenantId: TENANT,
  storeId: null,
  isPlatformAdmin: false,
  source: "session",
});
const noCtxReq = reqWith(undefined);

function controllerWith(reResolvePosting: jest.Mock): ErpnextReconciliationController {
  return new ErpnextReconciliationController(
    {} as ErpnextReconciliationService,
    { reResolvePosting } as unknown as ErpnextPostingReResolutionService,
  );
}

describe("RT-333 controller — reResolvePosting", () => {
  it("with no session context → 401", async () => {
    const c = controllerWith(jest.fn());
    await expect(c.reResolvePosting(noCtxReq, REF, {})).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("returns the recorded re-resolution with the session tenant + actor", async () => {
    const recorded = {
      workItemRef: REF,
      resolutionVersion: 2,
      previousResolutionVersion: 1,
      recordedAt: "2026-10-09T00:00:00.000Z",
    };
    const svc = jest.fn().mockResolvedValue(recorded);
    await expect(controllerWith(svc).reResolvePosting(authedReq, REF, {})).resolves.toEqual(recorded);
    expect(svc).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, actorUserId: ACTOR, workItemRef: REF }),
    );
  });

  it("remaps RepairNotFoundError → 404 not_found", async () => {
    const c = controllerWith(jest.fn().mockRejectedValue(new RepairNotFoundError()));
    const err = await c.reResolvePosting(authedReq, REF, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toMatchObject({ code: "not_found" });
  });

  it("remaps ReResolveConflictError → 409 not_re_resolvable", async () => {
    const c = controllerWith(jest.fn().mockRejectedValue(new ReResolveConflictError("posted")));
    const err = await c.reResolvePosting(authedReq, REF, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: "not_re_resolvable" });
  });

  it("re-throws a non-mapped error unchanged", async () => {
    const boom = new Error("db down");
    const c = controllerWith(jest.fn().mockRejectedValue(boom));
    await expect(c.reResolvePosting(authedReq, REF, {})).rejects.toBe(boom);
  });
});
