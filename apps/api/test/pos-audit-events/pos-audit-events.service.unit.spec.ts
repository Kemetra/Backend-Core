jest.mock("@data-pulse-2/db", () => ({
  runWithTenantContext: jest.fn(async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
    fn({ query: jest.fn() }),
  ),
}));

import "reflect-metadata";
import type { Pool } from "pg";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Logger } from "@data-pulse-2/shared";
import { PosAuditEventsService } from "../../src/pos-audit-events/pos-audit-events.service";
import type { DeviceRepository } from "../../src/pos-operators/device.repository";
import type { AuditEventItemInput, PosAuditEventsSyncInput } from "../../src/pos-audit-events/dto";

const TENANT_ID   = "11111111-0000-4000-8000-000000000001";
const STORE_ID    = "22222222-0000-4000-8000-000000000001";
const DEVICE_TOKEN = "valid-device-token";
const DEVICE_ID = "44444444-0000-4000-8000-000000000001";

function makeEvent(overrides: Partial<AuditEventItemInput> = {}): AuditEventItemInput {
  return {
    event_id:                "aaaaaaaa-0000-4000-8000-000000000001",
    tenant_id:               TENANT_ID,
    branch_id:               STORE_ID,
    originating_terminal_id: DEVICE_ID,
    acting_operator_id:      "user_clerk_test",
    action_category:         "shift.open",
    created_at:              "2026-01-15T10:00:00.000Z",
    payload:                 { shift_id: "55555555-0000-4000-8000-000000000001", opened_at: "2026-01-15T10:00:00.000Z" },
    ...overrides,
  };
}

function makeBody(events: AuditEventItemInput[] = [makeEvent()]): PosAuditEventsSyncInput {
  return {
    device_token_attestation: DEVICE_TOKEN,
    events,
  };
}

const fakeDevice = {
  id:        DEVICE_ID,
  tenantId:  TENANT_ID,
  storeId:   STORE_ID,
  label:     "till",
  tokenHash: "h",
  revokedAt: null,
  createdAt: new Date(),
};

let mockPool: { query: jest.MockedFunction<Pool["query"]> };
let fakeDeviceRepo: { findActiveByAttestation: jest.MockedFunction<DeviceRepository["findActiveByAttestation"]> };
let mockLogger: { warn: jest.MockedFunction<() => void>; info: jest.MockedFunction<() => void> };
let service: PosAuditEventsService;

beforeEach(() => {
  jest.clearAllMocks();

  mockPool      = { query: jest.fn() };
  fakeDeviceRepo = { findActiveByAttestation: jest.fn().mockResolvedValue(fakeDevice) };
  mockLogger    = { warn: jest.fn(), info: jest.fn() };

  service = new PosAuditEventsService(
    mockPool as unknown as Pool,
    fakeDeviceRepo as unknown as DeviceRepository,
    mockLogger as unknown as Logger,
  );

  (runWithTenantContext as jest.Mock).mockImplementation(
    async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
      const fakeClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
      return fn(fakeClient);
    },
  );

  mockPool.query.mockResolvedValue({ rows: [{ id: "actor-user-id" }] });
});

// ===========================================================================
// 1. Device not found → { kind: "device_invalid" }
// ===========================================================================

describe("syncBatch — device resolution", () => {
  it("D1: device not found → { kind: 'device_invalid' }", async () => {
    fakeDeviceRepo.findActiveByAttestation.mockResolvedValue(null);

    const result = await service.syncBatch(makeBody(), "req-id");

    expect(result).toEqual({ kind: "device_invalid" });
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 2-5. Structural validation rejections (schema_violation)
// ===========================================================================

describe("syncBatch — schema_violation rejections", () => {
  it("SV1: invalid action_category → schema_violation", async () => {
    const result = await service.syncBatch(
      makeBody([makeEvent({ action_category: "unknown.category" })]),
      "req-id",
    );

    expect(result).toMatchObject({
      accepted: [],
      rejected: [{ event_id: expect.any(String), category: "schema_violation" }],
    });
  });

  it("SV2: forbidden payload field (pin) → schema_violation", async () => {
    const result = await service.syncBatch(
      makeBody([makeEvent({ payload: { pin: "1234" } })]),
      null,
    );

    expect(result).toMatchObject({
      rejected: [{ category: "schema_violation" }],
    });
  });

  it("SV3: shift.open with non-UUID payload.shift_id → schema_violation", async () => {
    const result = await service.syncBatch(
      makeBody([makeEvent({ payload: { shift_id: "not-a-uuid", opened_at: "2026-01-15T10:00:00.000Z" } })]),
      null,
    );

    expect(result).toMatchObject({
      rejected: [{ category: "schema_violation" }],
    });
  });

  it("SV4: shift.open with missing payload.shift_id → schema_violation", async () => {
    const result = await service.syncBatch(
      makeBody([makeEvent({ payload: { opened_at: "2026-01-15T10:00:00.000Z" } })]),
      null,
    );

    expect(result).toMatchObject({
      rejected: [{ category: "schema_violation" }],
    });
  });
});

// ===========================================================================
// 6-7. Tenant / branch scope mismatch → tenant_mismatch
// ===========================================================================

describe("syncBatch — tenant_mismatch rejections", () => {
  it("TM1: event.tenant_id !== device.tenantId → tenant_mismatch", async () => {
    const result = await service.syncBatch(
      makeBody([makeEvent({ tenant_id: "different-tenant-id" })]),
      null,
    );

    expect(result).toMatchObject({
      rejected: [{ category: "tenant_mismatch" }],
    });
  });

  it("TM2: event.branch_id !== device.storeId → tenant_mismatch", async () => {
    const result = await service.syncBatch(
      makeBody([makeEvent({ branch_id: "different-store-id" })]),
      null,
    );

    expect(result).toMatchObject({
      rejected: [{ category: "tenant_mismatch" }],
    });
  });
});

// ===========================================================================
// 8. Actor not found → invalid_input
// ===========================================================================

describe("syncBatch — actor resolution", () => {
  it("AR0: contradictory client terminal id is rejected before persistence", async () => {
    const result = await service.syncBatch(
      makeBody([
        makeEvent({
          originating_terminal_id: "44444444-0000-4000-8000-000000000099",
        }),
      ]),
      null,
    );

    expect(result).toMatchObject({ rejected: [{ category: "invalid_input" }] });
    expect(runWithTenantContext).not.toHaveBeenCalled();
  });

  it("AR1: actor lookup returns no rows → invalid_input", async () => {
    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
        fn({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
    );

    const result = await service.syncBatch(makeBody(), null);

    expect(result).toMatchObject({
      rejected: [{ category: "invalid_input" }],
    });
  });

  it("AR2: actor lookup binds tenant, store, device, session and event time", async () => {
    let actorSql = "";
    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
        const query = jest.fn(async (sql: string) => {
          if (String(sql).includes("FROM auth_tokens token")) {
            actorSql = String(sql);
            return { rows: [{ id: "user-1" }] };
          }
          return { rows: [{ id: makeEvent().event_id }] };
        });
        return fn({ query });
      },
    );

    const result = await service.syncBatch(makeBody(), null);
    expect(result).toMatchObject({ accepted: [makeEvent().event_id] });
    expect(actorSql).toContain("token.device_id = $4");
    expect(actorSql).toContain("token.store_id = $3");
    expect(actorSql).toContain("token.issued_at <= $6::timestamptz");
    expect(actorSql).toContain("token.revoked_at IS NULL OR token.revoked_at >= $6::timestamptz");
  });
});

// ===========================================================================
// 9-10. Idempotent insert outcomes
// ===========================================================================

describe("syncBatch — accepted / duplicate outcomes", () => {
  it("IO1: accepted event → event_id in accepted array", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: "user-1" }] });

    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
        const fakeClient = {
          query: jest.fn().mockResolvedValue({ rows: [{ id: "aaaaaaaa-0000-4000-8000-000000000001" }] }),
        };
        return fn(fakeClient);
      },
    );

    const evt    = makeEvent();
    const result = await service.syncBatch(makeBody([evt]), "req-id");

    expect(result).toMatchObject({
      accepted:  [evt.event_id],
      duplicates: [],
      rejected:  [],
    });
  });

  it("IO2: duplicate event (ON CONFLICT returns no rows) → event_id in duplicates array", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: "user-1" }] });

    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
        const fakeClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [{ id: "user-1" }] })
            .mockResolvedValueOnce({ rows: [] }),
        };
        return fn(fakeClient);
      },
    );

    const evt    = makeEvent();
    const result = await service.syncBatch(makeBody([evt]), "req-id");

    expect(result).toMatchObject({
      accepted:   [],
      duplicates: [evt.event_id],
      rejected:   [],
    });
  });
});

// ===========================================================================
// 11-12. shift.open side-effect: shifts INSERT
// ===========================================================================

describe("syncBatch — shift.open side-effect", () => {
  it("SH1: shift.open accepted → actor validation + audit_events + shifts", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: "user-1" }] });

    let capturedClient: { query: jest.Mock } | null = null;

    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
        capturedClient = {
          query: jest.fn()
            .mockResolvedValueOnce({ rows: [{ id: "user-1" }] })
            .mockResolvedValueOnce({ rows: [{ id: "aaaaaaaa-0000-4000-8000-000000000001" }] })
            .mockResolvedValueOnce({ rows: [] }),
        };
        return fn(capturedClient);
      },
    );

    await service.syncBatch(makeBody([makeEvent({ action_category: "shift.open" })]), "req-id");

    expect(capturedClient!.query).toHaveBeenCalledTimes(3);
  });

  it("SH2: shift.close accepted → actor validation + audit insert only", async () => {
    mockPool.query.mockResolvedValue({ rows: [{ id: "user-1" }] });

    let capturedClient: { query: jest.Mock } | null = null;

    (runWithTenantContext as jest.Mock).mockImplementation(
      async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
        capturedClient = {
          query: jest.fn().mockResolvedValue({ rows: [{ id: "aaaaaaaa-0000-4000-8000-000000000001" }] }),
        };
        return fn(capturedClient);
      },
    );

    await service.syncBatch(makeBody([makeEvent({ action_category: "shift.close" })]), "req-id");

    expect(capturedClient!.query).toHaveBeenCalledTimes(2);
  });
});

// ===========================================================================
// 13. Unexpected error in processEvent → rejected as invalid_input
// ===========================================================================

describe("syncBatch — unexpected error isolation", () => {
  it("UE1: pool.query throws → event pushed to rejected as invalid_input; other events unaffected", async () => {
    (runWithTenantContext as jest.Mock).mockRejectedValue(new Error("DB connection reset"));

    const result = await service.syncBatch(makeBody([makeEvent()]), "req-id");

    expect(result).toMatchObject({
      rejected: [{ event_id: "aaaaaaaa-0000-4000-8000-000000000001", category: "invalid_input" }],
    });
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 14. Mixed batch: accepted + rejected + duplicates
// ===========================================================================

describe("syncBatch — mixed batch", () => {
  it("MB1: mix of accepted, rejected, and duplicate in one call", async () => {
    const evtAccepted  = makeEvent({ event_id: "aaaaaaaa-0000-4000-8000-000000000001" });
    const evtRejected  = makeEvent({ event_id: "bbbbbbbb-0000-4000-8000-000000000002", action_category: "bad.cat" });
    const evtDuplicate = makeEvent({ event_id: "cccccccc-0000-4000-8000-000000000003" });

    mockPool.query.mockResolvedValue({ rows: [{ id: "user-1" }] });

    // evtRejected short-circuits before runWithTenantContext, so only two
    // invocations occur: first for evtAccepted (accepted), second for evtDuplicate (duplicate).
    (runWithTenantContext as jest.Mock)
      .mockImplementationOnce(
        async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
          const fakeClient = { query: jest.fn().mockResolvedValue({ rows: [{ id: evtAccepted.event_id }] }) };
          return fn(fakeClient);
        },
      )
      .mockImplementationOnce(
        async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
          const fakeClient = {
            query: jest.fn()
              .mockResolvedValueOnce({ rows: [{ id: "user-1" }] })
              .mockResolvedValueOnce({ rows: [] }),
          };
          return fn(fakeClient);
        },
      );

    const result = await service.syncBatch(makeBody([evtAccepted, evtRejected, evtDuplicate]), "req-id");

    expect(result).toMatchObject({
      accepted:   [evtAccepted.event_id],
      duplicates: [evtDuplicate.event_id],
      rejected:   [{ event_id: evtRejected.event_id, category: "schema_violation" }],
    });
  });
});

// ===========================================================================
// 15. All valid non-shift.open action categories are accepted
// ===========================================================================

describe("syncBatch — valid non-shift.open action categories", () => {
  const nonShiftOpenCategories = [
    "shift.close",
    "shift.forced_close",
    "operator.session.takeover",
    "cashier.pin.reset",
    "cashier.pin.unlock",
  ];

  for (const category of nonShiftOpenCategories) {
    it(`NC-${category}: action_category '${category}' accepted without schema_violation`, async () => {
      mockPool.query.mockResolvedValue({ rows: [{ id: "user-1" }] });

      (runWithTenantContext as jest.Mock).mockImplementation(
        async (_pool: unknown, _ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) => {
          const fakeClient = {
            query: jest.fn().mockResolvedValue({ rows: [{ id: "aaaaaaaa-0000-4000-8000-000000000001" }] }),
          };
          return fn(fakeClient);
        },
      );

      const evt    = makeEvent({ action_category: category });
      const result = await service.syncBatch(makeBody([evt]), "req-id");

      expect(result).toMatchObject({
        accepted: [evt.event_id],
        rejected: [],
      });
    });
  }
});
