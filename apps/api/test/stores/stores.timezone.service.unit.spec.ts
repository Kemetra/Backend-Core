/**
 * Spec 038 / RT-401 — StoresService time zone orchestration, no Postgres.
 *
 * Pins what the service decides: the order of the change checks (no-op →
 * stale expected → unknown zone → open shift), that a refused change
 * writes nothing, the audit row on a committed change, create's zone
 * check, and the preview's derived fields. Locking, RLS and the real
 * `pg_timezone_names` lookup are covered by
 * `stores.timezone.http.integration.spec.ts`.
 */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { TenantContext } from "@data-pulse-2/db";
import type { MembershipRepository } from "../../src/context/membership.repository";
import type { ResolvedContext } from "../../src/context/types";
import type {
  StoreRecord,
  StoresRepository,
  ZoneFacts,
} from "../../src/stores/stores.repository";
import { StoresService } from "../../src/stores/stores.service";

const passthroughTx = async <T>(
  _pool: Pool,
  _ctx: TenantContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> => work({} as PoolClient);

const USER_ID = "0a000000-0000-7000-8000-00000000aa01";
const TENANT_ID = "0a000000-0000-7000-8000-0000000000b2";
const STORE_ID = "0a000000-0000-7000-8000-0000000000c3";
const REQUEST_ID = "0a000000-0000-7000-8000-0000000000e5";
const NOW = new Date("2026-10-12T22:30:00.000Z");

const CTX: ResolvedContext = {
  userId: USER_ID,
  tenantId: TENANT_ID,
  storeId: null,
  isPlatformAdmin: false,
  source: "session",
};

function store(overrides: Partial<StoreRecord> = {}): StoreRecord {
  return {
    id: STORE_ID,
    tenantId: TENANT_ID,
    code: "BR-1",
    name: "Branch",
    timezone: "UTC",
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

const ZONES: Record<string, ZoneFacts> = {
  UTC: { now: NOW, utcOffsetMinutes: 0, businessDate: "2026-10-12" },
  "Africa/Cairo": { now: NOW, utcOffsetMinutes: 180, businessDate: "2026-10-13" },
  "Europe/London": { now: NOW, utcOffsetMinutes: 60, businessDate: "2026-10-12" },
};

class FakeRepo {
  current: StoreRecord | null = store();
  openShifts = 0;
  calls: string[] = [];
  updates: Array<Record<string, unknown>> = [];
  audits: Array<Record<string, unknown>> = [];
  creates: Array<Record<string, unknown>> = [];

  async findById(): Promise<StoreRecord | null> {
    this.calls.push("findById");
    return this.current;
  }
  async findByIdForUpdate(): Promise<StoreRecord | null> {
    this.calls.push("findByIdForUpdate");
    return this.current;
  }
  async describeZone(_c: PoolClient, zone: string): Promise<ZoneFacts | null> {
    this.calls.push(`describeZone:${zone}`);
    return ZONES[zone] ?? null;
  }
  async countOpenShifts(): Promise<number> {
    this.calls.push("countOpenShifts");
    return this.openShifts;
  }
  async update(
    _c: PoolClient,
    _id: string,
    next: Record<string, unknown>,
  ): Promise<StoreRecord | null> {
    this.calls.push("update");
    this.updates.push(next);
    if (!this.current) return null;
    return store({
      ...this.current,
      ...(next["timezone"] !== undefined ? { timezone: next["timezone"] as string } : {}),
      ...(next["name"] !== undefined ? { name: next["name"] as string } : {}),
    });
  }
  async insertTimezoneChangedAudit(
    _c: PoolClient,
    input: Record<string, unknown>,
  ): Promise<void> {
    this.calls.push("audit");
    this.audits.push(input);
  }
  async create(_c: PoolClient, input: Record<string, unknown>): Promise<StoreRecord> {
    this.calls.push("create");
    this.creates.push(input);
    return store({ timezone: (input["timezone"] as string | undefined) ?? "UTC" });
  }
}

function makeService(repo: FakeRepo): StoresService {
  return new StoresService(
    {} as Pool,
    repo as unknown as StoresRepository,
    {} as MembershipRepository,
    passthroughTx,
  );
}

const CAIRO_CHANGE = { timezone: "Africa/Cairo", expectedCurrentTimezone: "UTC" };

describe("StoresService.update — time zone change", () => {
  it("commits the change and writes the audit row in the same transaction", async () => {
    const repo = new FakeRepo();
    const result = await makeService(repo).update(CTX, STORE_ID, {}, CAIRO_CHANGE, {
      requestId: REQUEST_ID,
    });
    expect(result.timezone).toBe("Africa/Cairo");
    expect(repo.calls).toEqual([
      "findByIdForUpdate",
      "describeZone:Africa/Cairo",
      "countOpenShifts",
      "update",
      "audit",
    ]);
    expect(repo.updates[0]).toEqual({
      name: undefined,
      isActive: undefined,
      timezone: "Africa/Cairo",
    });
    expect(repo.audits[0]).toEqual({
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      actorUserId: USER_ID,
      requestId: REQUEST_ID,
      action: "store.timezone.changed",
      from: "UTC",
      to: "Africa/Cairo",
    });
  });

  it("404 when the store is not visible, before any other check", async () => {
    const repo = new FakeRepo();
    repo.current = null;
    await expect(
      makeService(repo).update(CTX, STORE_ID, {}, CAIRO_CHANGE),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.calls).toEqual(["findByIdForUpdate"]);
  });

  it("409 timezone_changed_concurrently on a stale expected zone; nothing written", async () => {
    const repo = new FakeRepo();
    repo.current = store({ timezone: "Europe/London" });
    const err = await makeService(repo)
      .update(CTX, STORE_ID, { name: "New" }, CAIRO_CHANGE)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: "timezone_changed_concurrently",
    });
    expect(repo.updates).toHaveLength(0);
    expect(repo.audits).toHaveLength(0);
  });

  it("400 invalid_timezone for a zone PostgreSQL does not know; nothing written", async () => {
    const repo = new FakeRepo();
    const err = await makeService(repo)
      .update(CTX, STORE_ID, {}, { timezone: "Mars/Olympus_Mons", expectedCurrentTimezone: "UTC" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: "invalid_timezone",
    });
    expect(repo.calls).not.toContain("countOpenShifts");
    expect(repo.updates).toHaveLength(0);
  });

  it("409 store_has_open_shift while a shift is open; nothing written", async () => {
    const repo = new FakeRepo();
    repo.openShifts = 1;
    const err = await makeService(repo)
      .update(CTX, STORE_ID, { name: "New" }, CAIRO_CHANGE)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: "store_has_open_shift",
    });
    expect(repo.updates).toHaveLength(0);
    expect(repo.audits).toHaveLength(0);
  });

  it("a no-op zone with nothing else returns the row untouched, even with an open shift", async () => {
    const repo = new FakeRepo();
    repo.current = store({ timezone: "Africa/Cairo" });
    repo.openShifts = 2;
    const result = await makeService(repo).update(CTX, STORE_ID, {}, {
      timezone: "Africa/Cairo",
      // Stale on purpose: the desired end state already holds.
      expectedCurrentTimezone: "UTC",
    });
    expect(result.timezone).toBe("Africa/Cairo");
    expect(repo.calls).toEqual(["findByIdForUpdate"]);
  });

  it("a no-op zone with a name writes the name only, no audit", async () => {
    const repo = new FakeRepo();
    repo.current = store({ timezone: "Africa/Cairo" });
    const result = await makeService(repo).update(CTX, STORE_ID, { name: "Renamed" }, {
      timezone: "Africa/Cairo",
      expectedCurrentTimezone: "Africa/Cairo",
    });
    expect(result.name).toBe("Renamed");
    expect(repo.updates[0]).toEqual({ name: "Renamed", isActive: undefined, timezone: undefined });
    expect(repo.audits).toHaveLength(0);
  });

  it("without a zone change, keeps the original update path", async () => {
    const repo = new FakeRepo();
    await makeService(repo).update(CTX, STORE_ID, { name: "Renamed" });
    expect(repo.calls).toEqual(["update"]);
  });
});

describe("StoresService.create — time zone", () => {
  it("checks a supplied zone against PostgreSQL and stores it", async () => {
    const repo = new FakeRepo();
    const result = await makeService(repo).create(CTX, {
      code: "BR-2",
      name: "Branch 2",
      timezone: "Africa/Cairo",
    });
    expect(repo.calls).toEqual(["describeZone:Africa/Cairo", "create"]);
    expect(repo.creates[0]).toMatchObject({ timezone: "Africa/Cairo" });
    expect(result.timezone).toBe("Africa/Cairo");
  });

  it("omitted zone: no lookup, column default applies", async () => {
    const repo = new FakeRepo();
    await makeService(repo).create(CTX, { code: "BR-2", name: "Branch 2" });
    expect(repo.calls).toEqual(["create"]);
    expect(repo.creates[0]).toMatchObject({ timezone: undefined });
  });

  it("400 invalid_timezone for an unknown zone; nothing inserted", async () => {
    const repo = new FakeRepo();
    await expect(
      makeService(repo).create(CTX, { code: "BR-2", name: "B", timezone: "Mars/Olympus_Mons" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.creates).toHaveLength(0);
  });
});

describe("StoresService.previewTimezoneChange", () => {
  it("reports both zones, the date shift and no blockers", async () => {
    const repo = new FakeRepo();
    const preview = await makeService(repo).previewTimezoneChange(CTX, STORE_ID, "Africa/Cairo");
    expect(preview).toEqual({
      storeId: STORE_ID,
      currentTimezone: "UTC",
      proposedTimezone: "Africa/Cairo",
      noOp: false,
      now: NOW,
      utcOffsetMinutesCurrent: 0,
      utcOffsetMinutesProposed: 180,
      businessDateCurrent: "2026-10-12",
      businessDateProposed: "2026-10-13",
      businessDateChangesNow: true,
      openShiftCount: 0,
      blockers: [],
      canApply: true,
      caveats: ["offline_shifts_not_visible", "uncaptured_sales_use_new_zone"],
    });
    expect(repo.updates).toHaveLength(0);
    expect(repo.audits).toHaveLength(0);
  });

  it("an open shift is a blocker and can_apply is false", async () => {
    const repo = new FakeRepo();
    repo.openShifts = 2;
    const preview = await makeService(repo).previewTimezoneChange(CTX, STORE_ID, "Europe/London");
    expect(preview.blockers).toEqual([{ code: "store_has_open_shift", count: 2 }]);
    expect(preview.businessDateChangesNow).toBe(false);
    expect(preview.canApply).toBe(false);
  });

  it("the current zone is a no-op and cannot apply", async () => {
    const repo = new FakeRepo();
    const preview = await makeService(repo).previewTimezoneChange(CTX, STORE_ID, "UTC");
    expect(preview.noOp).toBe(true);
    expect(preview.canApply).toBe(false);
  });

  it("404 for an invisible store; 400 for an unknown zone", async () => {
    const repo = new FakeRepo();
    await expect(
      makeService(repo).previewTimezoneChange(CTX, STORE_ID, "Mars/Olympus_Mons"),
    ).rejects.toBeInstanceOf(BadRequestException);
    repo.current = null;
    await expect(
      makeService(repo).previewTimezoneChange(CTX, STORE_ID, "Africa/Cairo"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
