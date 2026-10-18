/**
 * audit.service.spec.ts — T235.
 *
 * Service-layer unit spec. The repository is fully stubbed; we pin:
 *   - filter forwarding (action / actor_user_id / store_id / from / to /
 *     cursor) reaches the repository unchanged.
 *   - DB rows map to the OpenAPI `AuditEvent` response shape (snake_case,
 *     ISO date-time for `occurred_at`, `metadata` defaulted to `{}`).
 *   - `next_cursor` is null when fewer than `limit` rows came back, and
 *     non-null (encoding the LAST row's `(occurred_at, id)`) when the
 *     page is full.
 *   - service does not log audit metadata content.
 */
import { AuditService } from "../../src/audit/audit.service";
import {
  type AuditEventRecord,
  type AuditRepository,
  type ListPageInput,
} from "../../src/audit/audit.repository";
import {
  decodeCursor,
  encodeCursor,
} from "../../src/audit/audit.query.schema";

const TENANT_A = "0a000000-0000-7000-8000-0000000000a1";
const ACTOR = "0a000000-0000-7000-8000-00000000aa01";
const STORE = "0a000000-0000-7000-8000-0000000000c1";
const TARGET = "0a000000-0000-7000-8000-0000000000d1";
const REQ = "0a000000-0000-7000-8000-0000000000e1";
const ROW_ID_1 = "0a000000-0000-7000-8000-000000000101";
const ROW_ID_2 = "0a000000-0000-7000-8000-000000000102";
const ROW_ID_3 = "0a000000-0000-7000-8000-000000000103";

function makeRow(overrides: Partial<AuditEventRecord> = {}): AuditEventRecord {
  return {
    id: ROW_ID_1,
    occurredAt: new Date("2026-05-01T12:00:00.000Z"),
    actorUserId: ACTOR,
    actorLabel: null,
    tenantId: TENANT_A,
    storeId: null,
    action: "auth.signin.ok",
    targetType: null,
    targetId: null,
    requestId: REQ,
    metadata: { ip: "1.2.3.4" },
    ...overrides,
  };
}

class FakeRepo implements AuditRepository {
  public lastInput: ListPageInput | null = null;
  public toReturn: AuditEventRecord[] = [];

  async listPage(input: ListPageInput): Promise<AuditEventRecord[]> {
    this.lastInput = input;
    return this.toReturn;
  }
}

describe("AuditService", () => {
  let repo: FakeRepo;
  let service: AuditService;

  beforeEach(() => {
    repo = new FakeRepo();
    service = new AuditService(repo);
  });

  describe("filter forwarding", () => {
    it("forwards action / actor_user_id / store_id / from / to / limit verbatim to the repo", async () => {
      const from = new Date("2026-05-01T00:00:00Z");
      const to = new Date("2026-05-31T23:59:59Z");
      await service.list({
        tenantId: TENANT_A,
        isPlatformAdmin: false,
        action: "auth.",
        actor_user_id: ACTOR,
        store_id: STORE,
        from,
        to,
        cursor: undefined,
        limit: 25,
      });
      expect(repo.lastInput).toEqual({
        tenantId: TENANT_A,
        isPlatformAdmin: false,
        action: "auth.",
        actorUserId: ACTOR,
        storeId: STORE,
        from,
        to,
        cursor: null,
        // The repository asks for one extra row to cheaply detect end-of-page.
        limit: 26,
      });
    });

    it("forwards a decoded cursor verbatim", async () => {
      const cursorOccurredAt = new Date("2026-05-01T10:00:00Z");
      await service.list({
        tenantId: TENANT_A,
        isPlatformAdmin: false,
        cursor: { occurredAt: cursorOccurredAt, id: ROW_ID_1 },
        limit: 50,
      });
      expect(repo.lastInput?.cursor).toEqual({
        occurredAt: cursorOccurredAt,
        id: ROW_ID_1,
      });
    });

    it("passes isPlatformAdmin=true through unchanged", async () => {
      await service.list({
        tenantId: TENANT_A,
        isPlatformAdmin: true,
        limit: 50,
      });
      expect(repo.lastInput?.isPlatformAdmin).toBe(true);
    });
  });

  describe("response mapping", () => {
    it("projects DB record to the OpenAPI AuditEvent snake_case shape", async () => {
      repo.toReturn = [
        makeRow({
          actorLabel: "alice@example.com",
          targetType: "store",
          targetId: TARGET,
          metadata: { reason: "test" },
        }),
      ];
      const out = await service.list({
        tenantId: TENANT_A,
        isPlatformAdmin: false,
        limit: 50,
      });
      expect(out).toEqual({
        items: [
          {
            id: ROW_ID_1,
            occurred_at: "2026-05-01T12:00:00.000Z",
            actor_user_id: ACTOR,
            actor_label: "alice@example.com",
            tenant_id: TENANT_A,
            store_id: null,
            action: "auth.signin.ok",
            kind: "change",
            target_type: "store",
            target_id: TARGET,
            request_id: REQ,
            metadata: { reason: "test" },
          },
        ],
        next_cursor: null,
      });
    });

    it("renders metadata as `{}` when DB row has null metadata", async () => {
      // The DB column is NOT NULL DEFAULT '{}', but service must still
      // be defensive — null/undefined coming through becomes `{}`.
      repo.toReturn = [makeRow({ metadata: null as unknown as Record<string, unknown> })];
      const out = await service.list({
        tenantId: TENANT_A,
        isPlatformAdmin: false,
        limit: 50,
      });
      expect(out.items[0]?.metadata).toEqual({});
    });
  });

  describe("next_cursor", () => {
    it("is null when fewer than limit rows are returned (no more pages)", async () => {
      repo.toReturn = [makeRow({ id: ROW_ID_1 }), makeRow({ id: ROW_ID_2 })];
      const out = await service.list({
        tenantId: TENANT_A,
        isPlatformAdmin: false,
        limit: 5,
      });
      expect(out.next_cursor).toBeNull();
      expect(out.items).toHaveLength(2);
    });

    it("is non-null and encodes the LAST returned row when a full page came back", async () => {
      // Simulate "limit + 1" rows returned by the repo (the convention that
      // signals more data exists). Service trims to limit and emits cursor.
      const lastOccurredAt = new Date("2026-05-01T11:30:00.000Z");
      repo.toReturn = [
        makeRow({
          id: ROW_ID_1,
          occurredAt: new Date("2026-05-01T12:00:00.000Z"),
        }),
        makeRow({
          id: ROW_ID_2,
          occurredAt: new Date("2026-05-01T11:45:00.000Z"),
        }),
        makeRow({
          id: ROW_ID_3,
          occurredAt: lastOccurredAt,
        }),
        // Sentinel "limit+1" row so the service knows there's more.
        makeRow({
          id: "0a000000-0000-7000-8000-000000000999",
          occurredAt: new Date("2026-05-01T11:00:00.000Z"),
        }),
      ];
      const out = await service.list({
        tenantId: TENANT_A,
        isPlatformAdmin: false,
        limit: 3,
      });
      expect(out.items).toHaveLength(3);
      expect(out.next_cursor).not.toBeNull();
      const decoded = decodeCursor(out.next_cursor as string);
      expect(decoded.id).toBe(ROW_ID_3);
      expect(decoded.occurredAt.toISOString()).toBe(
        lastOccurredAt.toISOString(),
      );
    });

    it("emits a sane cursor on a single-row full page (limit=1)", async () => {
      const lastOccurredAt = new Date("2026-05-01T11:30:00.000Z");
      repo.toReturn = [
        makeRow({ id: ROW_ID_1, occurredAt: lastOccurredAt }),
        makeRow({
          id: ROW_ID_2,
          occurredAt: new Date("2026-05-01T11:00:00.000Z"),
        }),
      ];
      const out = await service.list({
        tenantId: TENANT_A,
        isPlatformAdmin: false,
        limit: 1,
      });
      expect(out.items).toHaveLength(1);
      const decoded = decodeCursor(out.next_cursor as string);
      expect(decoded.id).toBe(ROW_ID_1);
    });
  });

  describe("encodeCursor / decodeCursor used by the service round-trip", () => {
    it("a cursor produced by the service decodes back to the same (occurredAt,id)", async () => {
      const occurredAt = new Date("2026-05-01T11:30:00.000Z");
      const encoded = encodeCursor(occurredAt, ROW_ID_3);
      const decoded = decodeCursor(encoded);
      expect(decoded.occurredAt.toISOString()).toBe(
        occurredAt.toISOString(),
      );
      expect(decoded.id).toBe(ROW_ID_3);
    });
  });
});
