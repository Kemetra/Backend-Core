/**
 * sale-sync-ops.unit.spec.ts — 032 §9 Docker-free unit coverage for the
 * server-authoritative sale-sync status vocabulary + the Console read/repair
 * surface branch logic (no Testcontainers).
 *
 * The HTTP/RLS behavior (cross-tenant safe-404, RLS bypass probe, keyset
 * pagination over real Postgres) is proven by the Testcontainers suite (which
 * CANNOT run in this environment — no Docker). This spec exercises the
 * in-process branches those suites can't drive deterministically: the status
 * transition table (T005), the read-model conflict/not-found branches (T016/
 * T017/T020), the controller's guard / rethrow paths, and the F-3 regression
 * assertion that the live POS provenance-conflict 409 is unchanged in shape.
 */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";

// runWithTenantContext is mocked to invoke its callback with a scripted client,
// so the read-model runs entirely in-process with no database.
let clientQuery: jest.Mock;
jest.mock("@data-pulse-2/db", () => ({
  runWithTenantContext: (
    _pool: unknown,
    _ctx: unknown,
    fn: (c: { query: jest.Mock }) => unknown,
  ) => fn({ query: clientQuery }),
}));

import {
  SALE_SYNC_STATUS,
  SALE_SYNC_STATUS_VALUES,
  isAllowedSaleSyncTransition,
  classificationForStatus,
} from "../../../src/catalog/sales/sale-sync-status";
import {
  SaleSyncOpsReadModelService,
  SaleSyncNotFoundError,
  RepairConflictError,
} from "../../../src/catalog/sale-sync-ops/sale-sync-ops.read-model.service";
import { SaleSyncOpsController } from "../../../src/catalog/sale-sync-ops/sale-sync-ops.controller";
// F-3 regression: the POS provenance-conflict 409 lives on the SalesController.
import { SalesController } from "../../../src/catalog/sales/sales.controller";
import {
  SaleNotFoundError,
  TerminalEventProvenanceConflictError,
} from "../../../src/catalog/sales/sales.service";

const TENANT = "0a000000-0000-7000-8000-0000000000a1";
const VALID_REF = "0d000000-0000-7000-8000-0000000000a1";

// Console-session request: tenant-wide (storeId null) is the normal case.
const ctxReq = (over: Record<string, unknown> = {}): never =>
  ({ context: { tenantId: TENANT, storeId: null, userId: "u1" }, ...over }) as never;

// POS-session request: a sale write REQUIRES a resolved store binding, so the
// F-3 regression tests (which drive the POS SalesController) supply one.
const posReq = (): never =>
  ({ context: { tenantId: TENANT, storeId: "s1", userId: "u1" } }) as never;

describe("032 §7 — sale sync-status vocabulary + transitions (T005)", () => {
  it("exposes exactly the four 0026-CHECK values", () => {
    expect(SALE_SYNC_STATUS_VALUES).toEqual([
      "captured",
      "synced",
      "failed-retryable",
      "failed-needs-repair",
    ]);
  });

  it("allows captured → synced / failed-retryable / failed-needs-repair", () => {
    expect(
      isAllowedSaleSyncTransition(SALE_SYNC_STATUS.CAPTURED, SALE_SYNC_STATUS.SYNCED),
    ).toBe(true);
    expect(
      isAllowedSaleSyncTransition(
        SALE_SYNC_STATUS.CAPTURED,
        SALE_SYNC_STATUS.FAILED_NEEDS_REPAIR,
      ),
    ).toBe(true);
  });

  it("treats synced as terminal-success (no outbound transition)", () => {
    expect(
      isAllowedSaleSyncTransition(SALE_SYNC_STATUS.SYNCED, SALE_SYNC_STATUS.CAPTURED),
    ).toBe(false);
    expect(
      isAllowedSaleSyncTransition(
        SALE_SYNC_STATUS.SYNCED,
        SALE_SYNC_STATUS.FAILED_RETRYABLE,
      ),
    ).toBe(false);
  });

  it("repair moves needs-repair → failed-retryable (re-eligible), never straight to synced", () => {
    expect(
      isAllowedSaleSyncTransition(
        SALE_SYNC_STATUS.FAILED_NEEDS_REPAIR,
        SALE_SYNC_STATUS.FAILED_RETRYABLE,
      ),
    ).toBe(true);
    expect(
      isAllowedSaleSyncTransition(
        SALE_SYNC_STATUS.FAILED_NEEDS_REPAIR,
        SALE_SYNC_STATUS.SYNCED,
      ),
    ).toBe(false);
  });

  it("maps the failure states to the §8 dead-letter classification", () => {
    expect(classificationForStatus(SALE_SYNC_STATUS.FAILED_RETRYABLE)).toBe(
      "retryable",
    );
    expect(classificationForStatus(SALE_SYNC_STATUS.FAILED_NEEDS_REPAIR)).toBe(
      "needs-repair",
    );
    expect(classificationForStatus(SALE_SYNC_STATUS.CAPTURED)).toBeNull();
    expect(classificationForStatus(SALE_SYNC_STATUS.SYNCED)).toBeNull();
  });
});

describe("032 §9 — read-model branches (T016/T020)", () => {
  beforeEach(() => {
    clientQuery = jest.fn();
  });

  it("getSaleSyncStatus throws SaleSyncNotFoundError for an absent/out-of-scope sale", async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] }); // sale read → none
    const svc = new SaleSyncOpsReadModelService({} as never);
    await expect(svc.getSaleSyncStatus(TENANT, VALID_REF)).rejects.toBeInstanceOf(
      SaleSyncNotFoundError,
    );
  });

  it("getSaleSyncStatus projects the status + open dead-letter detail", async () => {
    clientQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: VALID_REF,
            store_id: "s1",
            sync_status: "failed-needs-repair",
            source_system: "pos",
            external_id: "x1",
            processed_at: null,
            received_at: new Date("2026-06-11T00:00:00Z"),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            classification: "needs-repair",
            reason_code: "auth_revoked",
            retry_count: 1,
            quarantined_at: new Date("2026-06-12T00:00:00Z"),
            resolved_at: null,
          },
        ],
      });
    const svc = new SaleSyncOpsReadModelService({} as never);
    const body = await svc.getSaleSyncStatus(TENANT, VALID_REF);
    expect(body.syncStatus).toBe("failed-needs-repair");
    expect(body.deadLetter?.classification).toBe("needs-repair");
    expect(body.deadLetter?.reasonCode).toBe("auth_revoked");
  });

  it("audit timeline emits the initial CAPTURE event for a capture-only sale (CodeRabbit #2)", async () => {
    clientQuery
      // 1. sale read → captured, never processed
      .mockResolvedValueOnce({
        rows: [
          {
            id: VALID_REF,
            store_id: "s1",
            sync_status: "captured",
            source_system: "pos",
            external_id: "x1",
            processed_at: null,
            received_at: new Date("2026-06-11T00:00:00Z"),
          },
        ],
      })
      // 2. deadletters → none
      .mockResolvedValueOnce({ rows: [] });
    const svc = new SaleSyncOpsReadModelService({} as never);
    const tl = await svc.getSaleAuditTimeline(TENANT, VALID_REF);
    // Previously empty; now the capture entry is always present.
    expect(tl.entries).toHaveLength(1);
    expect(tl.entries[0]?.event).toBe("sale.captured");
    expect(tl.entries[0]?.at).toBe("2026-06-11T00:00:00.000Z");
  });

  it("audit timeline orders capture → synced → quarantine → resolve", async () => {
    clientQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: VALID_REF,
            store_id: "s1",
            sync_status: "failed-retryable",
            source_system: "pos",
            external_id: "x1",
            processed_at: new Date("2026-06-11T01:00:00Z"),
            received_at: new Date("2026-06-11T00:00:00Z"),
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            classification: "needs-repair",
            quarantined_at: new Date("2026-06-11T02:00:00Z"),
            resolved_at: new Date("2026-06-11T03:00:00Z"),
            correlation_id: null,
          },
        ],
      });
    const svc = new SaleSyncOpsReadModelService({} as never);
    const tl = await svc.getSaleAuditTimeline(TENANT, VALID_REF);
    expect(tl.entries.map((e) => e.event)).toEqual([
      "sale.captured",
      "sync.synced",
      "sync.needs_repair",
      "repair.resolved",
    ]);
  });

  it("repairSaleSync 409s (RepairConflictError) when the sale is not needs-repair", async () => {
    clientQuery.mockResolvedValueOnce({
      rows: [
        {
          id: VALID_REF,
          store_id: "s1",
          sync_status: "synced",
          source_system: "pos",
          external_id: "x1",
          processed_at: new Date(),
          received_at: new Date(),
        },
      ],
    });
    const svc = new SaleSyncOpsReadModelService({} as never);
    await expect(svc.repairSaleSync(TENANT, VALID_REF)).rejects.toBeInstanceOf(
      RepairConflictError,
    );
  });

  it("repairSaleSync resolves the open deadletter + moves status to failed-retryable", async () => {
    clientQuery
      // 1. sale read → needs-repair
      .mockResolvedValueOnce({
        rows: [
          {
            id: VALID_REF,
            store_id: "s1",
            sync_status: "failed-needs-repair",
            source_system: "pos",
            external_id: "x1",
            processed_at: null,
            received_at: new Date("2026-06-11T00:00:00Z"),
          },
        ],
      })
      // 2. resolve deadletter → one row
      .mockResolvedValueOnce({ rows: [{ id: "dl1" }] })
      // 3. update sales status (no return needed)
      .mockResolvedValueOnce({ rows: [] })
      // 4. re-read sale → failed-retryable
      .mockResolvedValueOnce({
        rows: [
          {
            id: VALID_REF,
            store_id: "s1",
            sync_status: "failed-retryable",
            source_system: "pos",
            external_id: "x1",
            processed_at: null,
            received_at: new Date("2026-06-11T00:00:00Z"),
          },
        ],
      })
      // 5. re-read open deadletter → none (resolved)
      .mockResolvedValueOnce({ rows: [] });
    const svc = new SaleSyncOpsReadModelService({} as never);
    const body = await svc.repairSaleSync(TENANT, VALID_REF);
    expect(body.syncStatus).toBe("failed-retryable");
    expect(body.deadLetter).toBeNull();
  });
});

describe("032 §9 — controller guard / rethrow (T016/T020)", () => {
  const makeController = (service: Partial<SaleSyncOpsReadModelService>) =>
    new SaleSyncOpsController(service as SaleSyncOpsReadModelService);

  it("rejects an unauthenticated request (no tenant) with 401", async () => {
    const c = makeController({});
    await expect(
      c.getStatus({ context: { tenantId: null } } as never, VALID_REF),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("maps a malformed saleRef to a 400 validation_error before any DB hit (CodeRabbit #1)", async () => {
    // A syntactically malformed ref is a request-shape error → 400, NOT a
    // safe-404 (the safe-404 is reserved for valid-but-out-of-scope refs, which
    // could otherwise disclose existence). The check runs before any DB hit, so
    // the injected service method is never called.
    const getSaleSyncStatus = jest.fn();
    const c = makeController({ getSaleSyncStatus });
    await expect(c.getStatus(ctxReq(), "not-a-uuid")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      c.getStatus(ctxReq(), "not-a-uuid"),
    ).rejects.toMatchObject({
      response: { code: "validation_error" },
    });
    expect(getSaleSyncStatus).not.toHaveBeenCalled();
  });

  it("applies the malformed-ref 400 on audit-timeline and repair too (all three sites)", async () => {
    const getSaleAuditTimeline = jest.fn();
    const repairSaleSync = jest.fn();
    const c = makeController({ getSaleAuditTimeline, repairSaleSync });
    await expect(
      c.getAuditTimeline(ctxReq(), "bad"),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.repair(ctxReq(), "bad")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(getSaleAuditTimeline).not.toHaveBeenCalled();
    expect(repairSaleSync).not.toHaveBeenCalled();
  });

  it("maps SaleSyncNotFoundError → 404 on status read", async () => {
    const c = makeController({
      getSaleSyncStatus: jest
        .fn()
        .mockRejectedValue(new SaleSyncNotFoundError()),
    });
    await expect(c.getStatus(ctxReq(), VALID_REF)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("maps RepairConflictError → 409 repair_conflict on repair", async () => {
    const c = makeController({
      repairSaleSync: jest.fn().mockRejectedValue(new RepairConflictError()),
    });
    await expect(c.repair(ctxReq(), VALID_REF)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe("F-3 regression — live POS provenance-conflict 409 unchanged", () => {
  it("recordVoid still maps TerminalEventProvenanceConflictError → 409 (not 422)", async () => {
    const service = {
      recordVoid: jest
        .fn()
        .mockRejectedValue(new TerminalEventProvenanceConflictError()),
    };
    const controller = new SalesController(service as never);
    const res = { status: jest.fn(), setHeader: jest.fn() };
    await expect(
      controller.recordVoid(
        posReq(),
        VALID_REF,
        { sourceSystem: "pos", externalId: "v1" } as never,
        res as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("recordVoid still maps SaleNotFoundError → 404 (non-disclosing)", async () => {
    const service = {
      recordVoid: jest.fn().mockRejectedValue(new SaleNotFoundError()),
    };
    const controller = new SalesController(service as never);
    const res = { status: jest.fn(), setHeader: jest.fn() };
    await expect(
      controller.recordVoid(
        posReq(),
        VALID_REF,
        { sourceSystem: "pos", externalId: "v1" } as never,
        res as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
