/**
 * audit.service.unit.spec.ts
 *
 * Docker-free unit coverage for AuditService (T304-B-api coverage lift).
 *
 * Strategy: hand-written FakeRepo implements AuditRepository. No real DB, no
 * real Drizzle, no Testcontainers, no NestJS DI container. AuditService is
 * constructed directly with a FakeRepo.
 *
 * Responsibilities pinned:
 *   1. Filter forwarding — query params reach the repository with correct
 *      mapping (snake_case → camelCase for actorUserId / storeId).
 *   2. Limit overread — service asks for `limit + 1` rows.
 *   3. Pagination — hasMore detection, `next_cursor` built from last KEPT row.
 *   4. DTO projection — DB camelCase record mapped to snake_case AuditEventDto.
 *   5. Error propagation — repository rejection bubbles to the caller.
 *
 * What this spec does NOT do
 * --------------------------
 *   - Authorize the request — that is the responsibility of AuthGuard +
 *     TenantContextGuard on the controller.
 *   - Test cursor encoding logic — that is covered by audit.query.schema.spec.ts.
 *
 * EXPLICIT EXCLUSION: RLS enforcement is NOT verified by these unit mocks.
 * The fake repo resolves whatever rows are seeded regardless of tenant context —
 * RLS is a DB-layer guarantee tested only with a real Postgres instance.
 */

import { kindOf } from "../../src/audit/audit-action-kinds";
import { AuditService } from "../../src/audit/audit.service";
import type {
  AuditEventRecord,
  AuditRepository,
  ListPageInput,
} from "../../src/audit/audit.repository";
import { decodeCursor, encodeCursor } from "../../src/audit/audit.query.schema";
import type { ListAuditEventsInput } from "../../src/audit/audit.service";

// ---------------------------------------------------------------------------
// Fixed test constants
// ---------------------------------------------------------------------------

const TENANT_ID   = "0a000000-0000-7000-8000-0000000000a1";
const ACTOR_ID    = "0a000000-0000-7000-8000-00000000aa01";
const STORE_ID    = "0a000000-0000-7000-8000-0000000000c1";
const TARGET_ID   = "0a000000-0000-7000-8000-0000000000d1";
const REQUEST_ID  = "0a000000-0000-7000-8000-0000000000e1";
const ROW_ID_1    = "0a000000-0000-7000-8000-000000000101";
const ROW_ID_2    = "0a000000-0000-7000-8000-000000000102";
const ROW_ID_3    = "0a000000-0000-7000-8000-000000000103";

// ---------------------------------------------------------------------------
// FakeRepo
// ---------------------------------------------------------------------------

class FakeRepo implements AuditRepository {
  public lastInput: ListPageInput | null = null;
  public toReturn: AuditEventRecord[] = [];
  public rejectWith: Error | null = null;

  async listPage(input: ListPageInput): Promise<AuditEventRecord[]> {
    this.lastInput = input;
    if (this.rejectWith !== null) {
      throw this.rejectWith;
    }
    return this.toReturn;
  }
}

// ---------------------------------------------------------------------------
// Row builder
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<AuditEventRecord> = {}): AuditEventRecord {
  return {
    id: ROW_ID_1,
    occurredAt: new Date("2026-05-01T12:00:00.000Z"),
    actorUserId: ACTOR_ID,
    actorLabel: null,
    tenantId: TENANT_ID,
    storeId: null,
    action: "auth.signin.ok",
    targetType: null,
    targetId: null,
    requestId: REQUEST_ID,
    metadata: { ip: "1.2.3.4" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Input builder
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<ListAuditEventsInput> = {}): ListAuditEventsInput {
  return {
    tenantId: TENANT_ID,
    isPlatformAdmin: false,
    limit: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let repo: FakeRepo;
let service: AuditService;

beforeEach(() => {
  repo = new FakeRepo();
  service = new AuditService(repo);
});

// ===========================================================================
// AS1 — filter forwarding: mandatory fields
// ===========================================================================

describe("AS1 — AuditService.list: mandatory fields forwarded to repo", () => {
  it("forwards tenantId and isPlatformAdmin verbatim", async () => {
    await service.list(makeInput({ tenantId: TENANT_ID, isPlatformAdmin: true }));

    expect(repo.lastInput!.tenantId).toBe(TENANT_ID);
    expect(repo.lastInput!.isPlatformAdmin).toBe(true);
  });
});

// ===========================================================================
// AS2 — limit overread: service asks for limit + 1 rows
// ===========================================================================

describe("AS2 — AuditService.list: service asks for limit + 1 rows", () => {
  it("forwards limit + 1 to repo for end-of-page detection", async () => {
    await service.list(makeInput({ limit: 25 }));

    expect(repo.lastInput!.limit).toBe(26);
  });

  it("limit 1 → repo receives 2", async () => {
    await service.list(makeInput({ limit: 1 }));

    expect(repo.lastInput!.limit).toBe(2);
  });

  it("limit 200 → repo receives 201", async () => {
    await service.list(makeInput({ limit: 200 }));

    expect(repo.lastInput!.limit).toBe(201);
  });
});

// ===========================================================================
// AS3 — filter forwarding: optional fields (camelCase mapping)
// ===========================================================================

describe("AS3 — AuditService.list: optional filter forwarding", () => {
  it("forwards action, actor_user_id (→ actorUserId), store_id (→ storeId), from, to, cursor", async () => {
    const from = new Date("2026-05-01T00:00:00Z");
    const to   = new Date("2026-05-31T23:59:59Z");
    const cursor = { occurredAt: new Date("2026-05-01T11:00:00Z"), id: ROW_ID_1 };

    await service.list(
      makeInput({
        action: "auth.",
        actor_user_id: ACTOR_ID,
        store_id: STORE_ID,
        from,
        to,
        cursor,
        limit: 25,
      }),
    );

    expect(repo.lastInput!.action).toBe("auth.");
    expect(repo.lastInput!.actorUserId).toBe(ACTOR_ID);
    expect(repo.lastInput!.storeId).toBe(STORE_ID);
    expect(repo.lastInput!.from).toBe(from);
    expect(repo.lastInput!.to).toBe(to);
    expect(repo.lastInput!.cursor).toEqual(cursor);
  });

  it("forwards kind (RT-567)", async () => {
    await service.list(makeInput({ kind: "change" }));
    expect(repo.lastInput!.kind).toBe("change");

    await service.list(makeInput({ kind: undefined }));
    expect(repo.lastInput!.kind).toBeUndefined();
  });

  it("cursor undefined → repo receives cursor: null", async () => {
    await service.list(makeInput({ cursor: undefined }));

    expect(repo.lastInput!.cursor).toBeNull();
  });

  it("actor_user_id undefined → repo receives actorUserId: undefined", async () => {
    await service.list(makeInput({ actor_user_id: undefined }));

    expect(repo.lastInput!.actorUserId).toBeUndefined();
  });

  it("store_id undefined → repo receives storeId: undefined", async () => {
    await service.list(makeInput({ store_id: undefined }));

    expect(repo.lastInput!.storeId).toBeUndefined();
  });
});

// ===========================================================================
// AS4 — pagination: next_cursor is null when fewer rows than limit
// ===========================================================================

describe("AS4 — AuditService.list: next_cursor is null when < limit rows", () => {
  it("next_cursor null when repo returns fewer rows than limit", async () => {
    repo.toReturn = [makeRow({ id: ROW_ID_1 }), makeRow({ id: ROW_ID_2 })];

    const out = await service.list(makeInput({ limit: 5 }));

    expect(out.next_cursor).toBeNull();
    expect(out.items).toHaveLength(2);
  });

  it("next_cursor null when repo returns exactly limit rows (not limit+1)", async () => {
    repo.toReturn = [makeRow({ id: ROW_ID_1 }), makeRow({ id: ROW_ID_2 })];

    const out = await service.list(makeInput({ limit: 2 }));

    expect(out.next_cursor).toBeNull();
    expect(out.items).toHaveLength(2);
  });

  it("next_cursor null when repo returns empty array", async () => {
    repo.toReturn = [];

    const out = await service.list(makeInput({ limit: 50 }));

    expect(out.next_cursor).toBeNull();
    expect(out.items).toHaveLength(0);
  });
});

// ===========================================================================
// AS5 — pagination: next_cursor non-null when repo returns limit + 1 rows
// ===========================================================================

describe("AS5 — AuditService.list: next_cursor encodes the last KEPT row", () => {
  it("emits next_cursor encoding (occurredAt, id) of last kept row when page is full", async () => {
    const lastOccurredAt = new Date("2026-05-01T11:30:00.000Z");
    repo.toReturn = [
      makeRow({ id: ROW_ID_1, occurredAt: new Date("2026-05-01T12:00:00.000Z") }),
      makeRow({ id: ROW_ID_2, occurredAt: new Date("2026-05-01T11:45:00.000Z") }),
      makeRow({ id: ROW_ID_3, occurredAt: lastOccurredAt }),
      // Sentinel "limit+1" row — triggers hasMore detection
      makeRow({ id: "0a000000-0000-7000-8000-000000000999", occurredAt: new Date("2026-05-01T11:00:00.000Z") }),
    ];

    const out = await service.list(makeInput({ limit: 3 }));

    expect(out.items).toHaveLength(3);
    expect(out.next_cursor).not.toBeNull();
    const decoded = decodeCursor(out.next_cursor as string);
    expect(decoded.id).toBe(ROW_ID_3);
    expect(decoded.occurredAt.toISOString()).toBe(lastOccurredAt.toISOString());
  });

  it("single-row page (limit=1) emits cursor encoding that row's (occurredAt, id)", async () => {
    const occurredAt = new Date("2026-05-01T11:30:00.000Z");
    repo.toReturn = [
      makeRow({ id: ROW_ID_1, occurredAt }),
      makeRow({ id: ROW_ID_2, occurredAt: new Date("2026-05-01T11:00:00.000Z") }),
    ];

    const out = await service.list(makeInput({ limit: 1 }));

    expect(out.items).toHaveLength(1);
    const decoded = decodeCursor(out.next_cursor as string);
    expect(decoded.id).toBe(ROW_ID_1);
    expect(decoded.occurredAt.toISOString()).toBe(occurredAt.toISOString());
  });

  it("trimmed items array does NOT include the sentinel (limit+1) row", async () => {
    const sentinelId = "0a000000-0000-7000-8000-000000000999";
    repo.toReturn = [
      makeRow({ id: ROW_ID_1 }),
      makeRow({ id: ROW_ID_2 }),
      makeRow({ id: sentinelId }),
    ];

    const out = await service.list(makeInput({ limit: 2 }));

    expect(out.items).toHaveLength(2);
    const ids = out.items.map((i) => i.id);
    expect(ids).not.toContain(sentinelId);
  });
});

// ===========================================================================
// AS6 — DTO projection (camelCase → snake_case, Date → ISO string)
// ===========================================================================

describe("AS6 — AuditService.list: DTO projection to snake_case", () => {
  it("projects all AuditEventRecord fields to AuditEventDto snake_case shape", async () => {
    const occurredAt = new Date("2026-05-01T12:00:00.000Z");
    repo.toReturn = [
      makeRow({
        id: ROW_ID_1,
        occurredAt,
        actorUserId: ACTOR_ID,
        actorLabel: "alice@example.com",
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        action: "auth.signin.ok",
        targetType: "store",
        targetId: TARGET_ID,
        requestId: REQUEST_ID,
        metadata: { reason: "test" },
      }),
    ];

    const out = await service.list(makeInput({ limit: 50 }));

    expect(out.items[0]).toEqual({
      id: ROW_ID_1,
      occurred_at: occurredAt.toISOString(),
      actor_user_id: ACTOR_ID,
      actor_label: "alice@example.com",
      tenant_id: TENANT_ID,
      store_id: STORE_ID,
      action: "auth.signin.ok",
      kind: "change",
      target_type: "store",
      target_id: TARGET_ID,
      request_id: REQUEST_ID,
      metadata: { reason: "test" },
    });
  });

  it("null nullable fields are preserved as null in DTO", async () => {
    repo.toReturn = [
      makeRow({
        actorUserId: null,
        actorLabel: null,
        storeId: null,
        targetType: null,
        targetId: null,
        requestId: null,
      }),
    ];

    const out = await service.list(makeInput());

    const item = out.items[0]!;
    expect(item.actor_user_id).toBeNull();
    expect(item.actor_label).toBeNull();
    expect(item.store_id).toBeNull();
    expect(item.target_type).toBeNull();
    expect(item.target_id).toBeNull();
    expect(item.request_id).toBeNull();
  });

  it("occurred_at is ISO 8601 string in the DTO", async () => {
    const occurredAt = new Date("2026-05-01T12:00:00.000Z");
    repo.toReturn = [makeRow({ occurredAt })];

    const out = await service.list(makeInput());

    expect(typeof out.items[0]!.occurred_at).toBe("string");
    expect(out.items[0]!.occurred_at).toBe(occurredAt.toISOString());
  });

  it("null metadata from record defaults to {} in DTO", async () => {
    repo.toReturn = [
      makeRow({ metadata: null as unknown as Record<string, unknown> }),
    ];

    const out = await service.list(makeInput());

    expect(out.items[0]!.metadata).toEqual({});
  });
});

// ===========================================================================
// AS7 — error propagation: repository rejection bubbles to caller
// ===========================================================================

describe("AS7 — AuditService.list: repository error propagates", () => {
  it("propagates rejection from repository.listPage to the caller", async () => {
    repo.rejectWith = new Error("DB connection lost");

    await expect(service.list(makeInput())).rejects.toThrow("DB connection lost");
  });
});

// ===========================================================================
// AS8 — cursor round-trip (helper from audit.query.schema used by service)
// ===========================================================================

describe("AS8 — cursor round-trip via encodeCursor / decodeCursor", () => {
  it("a cursor produced by service decodes to the same (occurredAt, id)", async () => {
    const occurredAt = new Date("2026-05-01T11:30:00.000Z");
    const encoded = encodeCursor(occurredAt, ROW_ID_3);
    const decoded = decodeCursor(encoded);
    expect(decoded.occurredAt.toISOString()).toBe(occurredAt.toISOString());
    expect(decoded.id).toBe(ROW_ID_3);
  });
});

// ===========================================================================
// AS9 — response shape: items array always present
// ===========================================================================

describe("AS9 — AuditService.list: response envelope always well-formed", () => {
  it("response has items array and next_cursor field even when empty", async () => {
    repo.toReturn = [];

    const out = await service.list(makeInput());

    expect(Array.isArray(out.items)).toBe(true);
    expect("next_cursor" in out).toBe(true);
  });
});

// ===========================================================================
// AS10 — RT-567: every item carries kind === kindOf(action)
// ===========================================================================

describe("AS10 — AuditService.list: derived kind", () => {
  it("sets kind from the registry: read code → read, change and unregistered codes → change", async () => {
    repo.toReturn = [
      makeRow({ id: ROW_ID_1, action: "shift_closes.listed" }),
      makeRow({ id: ROW_ID_2, action: "sale.voided" }),
      makeRow({ id: ROW_ID_3, action: "zz.unregistered.code" }),
    ];

    const out = await service.list(makeInput({ limit: 50 }));

    expect(out.items.map((i) => [i.action, i.kind])).toEqual([
      ["shift_closes.listed", "read"],
      ["sale.voided", "change"],
      ["zz.unregistered.code", "change"],
    ]);
    for (const item of out.items) {
      expect(item.kind).toBe(kindOf(item.action));
    }
  });
});
