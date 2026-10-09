/**
 * 017-POLISH — controller guard + error-remap unit spec (Docker-free).
 *
 * Exercises the controller branches the integration specs don't hit directly: the
 * `requireContext`/`requireTenant` unauthorized throw (no session context), and
 * the NotFound/Store error-remap catch arms (a service error → the canonical
 * 404 envelope) + the non-mapped error re-throw. Pure unit — a stub service, no
 * DB, no app boot.
 */
import "reflect-metadata";

import {
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";

import { ErpnextReconciliationController } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.controller";
import {
  RepairNotFoundError,
  RunNotFoundError,
  StoreNotFoundError,
  type ErpnextReconciliationService,
} from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.service";
import type { ErpnextPostingReResolutionService } from "../../../../src/catalog/erpnext-reconciliation/posting-re-resolution.service";
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
const res = () => ({ setHeader: jest.fn(), status: jest.fn() }) as never;

function controllerWith(svc: Partial<ErpnextReconciliationService>): ErpnextReconciliationController {
  return new ErpnextReconciliationController(
    svc as ErpnextReconciliationService,
    {} as ErpnextPostingReResolutionService,
  );
}

describe("017 controller — auth context guards", () => {
  it("listPostingBacklog with no session context → 401", async () => {
    const c = controllerWith({});
    await expect(
      c.listPostingBacklog(noCtxReq, { limit: 100 } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("repairPosting with no session context → 401", async () => {
    const c = controllerWith({});
    await expect(
      c.repairPosting(noCtxReq, REF, {} as never, res()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("triggerRun with no session context → 401", async () => {
    const c = controllerWith({});
    await expect(
      c.triggerRun(noCtxReq, { storeId: REF } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("getRun with no session context → 401", async () => {
    const c = controllerWith({});
    await expect(c.getRun(noCtxReq, REF)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("listResults with no session context → 401", async () => {
    const c = controllerWith({});
    await expect(
      c.listResults(noCtxReq, REF, { limit: 100 } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("repairStock with no session context → 401", async () => {
    const c = controllerWith({});
    await expect(
      c.repairStock(noCtxReq, REF, REF, { repairKind: "re_sync" } as never, res()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("listResults context-only path returns the service result (happy branch)", async () => {
    const c = controllerWith({
      listResults: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    });
    await expect(c.listResults(authedReq, REF, { limit: 100 } as never)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("getRun context path returns the service result (happy branch)", async () => {
    const run = { id: REF, storeId: REF, kind: "stock", trigger: "on_demand", status: "running", startedAt: "x", finishedAt: null, summary: null };
    const c = controllerWith({ getRun: jest.fn().mockResolvedValue(run) });
    await expect(c.getRun(authedReq, REF)).resolves.toBe(run);
  });
});

// Exercise BOTH sides of the optional-query spreads / ternaries (the conditional
// branches the integration specs only hit one side of): cursor present vs null,
// limit set vs default, storeId/class filter present vs absent.
describe("017 controller — optional-query branch coverage", () => {
  it("listPostingBacklog with ALL filters present (cursor/limit/storeId/class)", async () => {
    const spy = jest.fn().mockResolvedValue({ items: [], nextCursor: null });
    const c = controllerWith({ listPostingBacklog: spy });
    await c.listPostingBacklog(authedReq, {
      cursor: "5",
      limit: 25,
      storeId: REF,
      class: "unmapped_item",
    } as never);
    const arg = spy.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg["cursor"]).toBe(5n); // BigInt(cursor) branch
    expect(arg["limit"]).toBe(25); // limit-set branch
    expect(arg["storeId"]).toBe(REF); // storeId-present spread
    expect(arg["rejectionCategory"]).toBe("unmapped_item"); // class-present spread
  });

  it("listPostingBacklog with NO filters (defaults — the other branch side)", async () => {
    const spy = jest.fn().mockResolvedValue({ items: [], nextCursor: null });
    const c = controllerWith({ listPostingBacklog: spy });
    await c.listPostingBacklog(authedReq, {} as never);
    const arg = spy.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg["cursor"]).toBeNull(); // cursor-null branch
    expect(arg["limit"]).toBe(100); // limit-default branch
    expect(arg["storeId"]).toBeUndefined(); // storeId-absent spread
    expect(arg["rejectionCategory"]).toBeUndefined(); // class-absent spread
  });

  it("listResults with class filter present vs absent (both spread sides)", async () => {
    const spy = jest.fn().mockResolvedValue({ items: [], nextCursor: null });
    const c = controllerWith({ listResults: spy });
    await c.listResults(authedReq, REF, { cursor: REF, limit: 10, class: "match" } as never);
    expect((spy.mock.calls[0]![0] as Record<string, unknown>)["mismatchClass"]).toBe("match");
    await c.listResults(authedReq, REF, {} as never);
    const arg2 = spy.mock.calls[1]![0] as Record<string, unknown>;
    expect(arg2["mismatchClass"]).toBeUndefined();
    expect(arg2["cursor"]).toBeNull();
    expect(arg2["limit"]).toBe(100);
  });

  it("repairPosting / triggerRun happy paths return the result (201 branch, no replay)", async () => {
    const setHeader = jest.fn();
    const status = jest.fn();
    const repair = { targetKind: "posting", targetRef: REF, repairKind: "re_post", outcome: "eligible_again", resolvedDocumentRef: null, recordedAt: "x" };
    const run = { id: REF, storeId: REF, kind: "stock", trigger: "on_demand", status: "running", startedAt: "x", finishedAt: null, summary: null };
    const c = controllerWith({
      repairPosting: jest.fn().mockResolvedValue({ replayed: false, repair }),
      triggerRun: jest.fn().mockResolvedValue(run),
    });
    await expect(
      c.repairPosting(authedReq, REF, {} as never, { setHeader, status } as never),
    ).resolves.toBe(repair);
    expect(status).not.toHaveBeenCalled(); // replayed=false → no 200 override
    await expect(c.triggerRun(authedReq, { storeId: REF } as never)).resolves.toBe(run);
  });
});

describe("017 controller — error remap → canonical 404", () => {
  it("repairPosting remaps RepairNotFoundError → NotFoundException(not_found)", async () => {
    const c = controllerWith({
      repairPosting: jest.fn().mockRejectedValue(new RepairNotFoundError()),
    });
    await expect(
      c.repairPosting(authedReq, REF, {} as never, res()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("triggerRun remaps StoreNotFoundError → NotFoundException(not_found)", async () => {
    const c = controllerWith({
      triggerRun: jest.fn().mockRejectedValue(new StoreNotFoundError()),
    });
    await expect(
      c.triggerRun(authedReq, { storeId: REF } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("getRun remaps RunNotFoundError → NotFoundException(not_found)", async () => {
    const c = controllerWith({
      getRun: jest.fn().mockRejectedValue(new RunNotFoundError()),
    });
    await expect(c.getRun(authedReq, REF)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("listResults remaps RunNotFoundError → NotFoundException(not_found)", async () => {
    const c = controllerWith({
      listResults: jest.fn().mockRejectedValue(new RunNotFoundError()),
    });
    await expect(
      c.listResults(authedReq, REF, { limit: 100 } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("repairStock remaps RunNotFoundError → NotFoundException(not_found)", async () => {
    const c = controllerWith({
      repairStock: jest.fn().mockRejectedValue(new RunNotFoundError()),
    });
    await expect(
      c.repairStock(authedReq, REF, REF, { repairKind: "re_sync" } as never, res()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("re-throws a NON-mapped service error unchanged (not swallowed as 404)", async () => {
    const boom = new Error("unexpected");
    const c = controllerWith({
      repairPosting: jest.fn().mockRejectedValue(boom),
    });
    await expect(c.repairPosting(authedReq, REF, {} as never, res())).rejects.toBe(boom);
  });

  it("triggerRun re-throws a NON-StoreNotFound error unchanged", async () => {
    const boom = new Error("boom");
    const c = controllerWith({ triggerRun: jest.fn().mockRejectedValue(boom) });
    await expect(c.triggerRun(authedReq, { storeId: REF } as never)).rejects.toBe(boom);
  });

  it("getRun re-throws a NON-RunNotFound error unchanged", async () => {
    const boom = new Error("boom");
    const c = controllerWith({ getRun: jest.fn().mockRejectedValue(boom) });
    await expect(c.getRun(authedReq, REF)).rejects.toBe(boom);
  });

  it("listResults re-throws a NON-RunNotFound error unchanged", async () => {
    const boom = new Error("boom");
    const c = controllerWith({ listResults: jest.fn().mockRejectedValue(boom) });
    await expect(c.listResults(authedReq, REF, { limit: 100 } as never)).rejects.toBe(boom);
  });

  it("repairStock re-throws a NON-RunNotFound error unchanged", async () => {
    const boom = new Error("boom");
    const c = controllerWith({ repairStock: jest.fn().mockRejectedValue(boom) });
    await expect(
      c.repairStock(authedReq, REF, REF, { repairKind: "re_map" } as never, res()),
    ).rejects.toBe(boom);
  });

  it("repairStock replayed=false → returns 201-path repair (no header)", async () => {
    const setHeader = jest.fn();
    const status = jest.fn();
    const c = controllerWith({
      repairStock: jest.fn().mockResolvedValue({
        replayed: false,
        repair: { targetKind: "stock", targetRef: REF, repairKind: "re_map", outcome: "eligible_again", resolvedDocumentRef: null, recordedAt: "x" },
      }),
    });
    await c.repairStock(authedReq, REF, REF, { repairKind: "re_map" } as never, { setHeader, status } as never);
    expect(setHeader).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
});

describe("017 controller — replayed sets 200 + Idempotent-Replayed header", () => {
  it("repairPosting replayed=true → res.status(200) + header", async () => {
    const setHeader = jest.fn();
    const status = jest.fn();
    const c = controllerWith({
      repairPosting: jest.fn().mockResolvedValue({
        replayed: true,
        repair: {
          targetKind: "posting",
          targetRef: REF,
          repairKind: "re_post",
          outcome: "no_op_echo",
          resolvedDocumentRef: "DOC",
          recordedAt: "2026-06-06T00:00:00.000Z",
        },
      }),
    });
    await c.repairPosting(authedReq, REF, {} as never, { setHeader, status } as never);
    expect(setHeader).toHaveBeenCalledWith("Idempotent-Replayed", "true");
    expect(status).toHaveBeenCalledWith(200);
  });
});
