/**
 * RT-327: the platform POS version policy over HTTP against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool) and the
 * real guards (`PlatformAdminGuard` reads `users.is_platform_admin`). Only
 * cookie authentication is faked: a header names the session.
 *
 *   GET /api/v1/platform/pos-version-policy             platformGetPosVersionPolicy
 *   PUT /api/v1/platform/pos-version-policy/{channel}   platformSetPosVersionPolicy
 *
 * What this proves (RT-327 acceptance):
 *   - platform admins only: a tenant owner or any other signed-in user is 403
 *     `forbidden` (the route exists, so never 404), a bearer or no session is
 *     401, and a platform admin needs no active tenant;
 *   - the change is a compare-and-set: first policy with `expectedRevision`
 *     null, then the revision last read; a stale revision is 409 and writes
 *     nothing; the same values again are a no-op 200 (no audit row);
 *   - versions out of semantic-version order are 422 and write nothing;
 *   - every effective change writes ONE `pos.release_policy.changed` row in
 *     the same transaction: platform-scoped (`tenant_id` NULL), the admin as
 *     actor, `channel` + `old` + `new` only (no email, no body);
 *   - concurrent changes of a channel serialize: one wins, the other is 409;
 *   - the policy table is readable by a tenant context but writable by the
 *     platform-admin context only (RLS).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { DeviceHealthModule } from "../../src/device-health/device-health.module";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import {
  DEV_A1A,
  OWNER_A,
  PLATFORM_ADMIN,
  STAFF_A,
  TENANT_A,
  seedDeviceHealthFixture,
} from "./__support__/device-health-fixture";

const BASE = "/api/v1/platform/pos-version-policy";
const channelPath = (channel: string): string => `${BASE}/${channel}`;
const ACTION = "pos.release_policy.changed";

const h = scopedHttpHarness({
  label: "RT-327 version policy",
  contractId: "pos-device-health.openapi",
  module: DeviceHealthModule,
  seed: seedDeviceHealthFixture,
});

const BODY = {
  latestVersion: "1.5.0",
  recommendedVersion: "1.4.2",
  minSupportedVersion: "1.4.0",
  minSupportedGraceUntil: "2026-12-01T00:00:00.000Z",
  expectedRevision: null as number | null,
};

interface AuditRow {
  actor_user_id: string | null;
  actor_label: string | null;
  tenant_id: string | null;
  store_id: string | null;
  target_type: string | null;
  target_id: string | null;
  metadata: { channel: string; old: Record<string, unknown> | null; new: Record<string, unknown> };
}

/** audit_events is append-only: rows written before the current test are skipped. */
let auditBaseline = 0;

async function audits(admin: Pool): Promise<AuditRow[]> {
  const r = await admin.query<AuditRow>(`SELECT * FROM audit_events WHERE action = $1 ORDER BY occurred_at, id`, [ACTION]);
  return r.rows.slice(auditBaseline);
}

async function markAuditBaseline(admin: Pool): Promise<void> {
  auditBaseline = 0;
  auditBaseline = (await audits(admin)).length;
}

async function storedRevision(admin: Pool, channel: string): Promise<number | null> {
  const r = await admin.query<{ revision: number }>(`SELECT revision FROM pos_version_policy WHERE channel = $1`, [channel]);
  return r.rows[0]?.revision ?? null;
}

beforeEach(async () => {
  if (h.skipped()) return;
  await h.env().admin.query(`DELETE FROM pos_version_policy`);
  await markAuditBaseline(h.env().admin);
});

describe("RT-327 version policy: who may call it", () => {
  it("answers 401 to no session and to a bearer, on both operations", async () => {
    if (h.skipped()) return;
    await h.get(BASE, null).expect(401);
    await h.put(channelPath("stable"), null, BODY).expect(401);
    await h.get(BASE, null).set("authorization", `Bearer ${DEV_A1A.token}`).expect(401);
    const put = await h.put(channelPath("stable"), null, BODY).set("authorization", `Bearer ${DEV_A1A.token}`);
    expect(put.status).toBe(401);
  });

  it.each([
    ["a tenant owner", OWNER_A.session],
    ["a store_staff user", STAFF_A.session],
  ])("answers 403 forbidden to %s, never 404, and writes nothing", async (_who, session) => {
    if (h.skipped()) return;
    const get = await h.get(BASE, session);
    const put = await h.put(channelPath("stable"), session, BODY);
    for (const res of [get, put]) {
      expect(res.status).toBe(403);
      expect((res.body as { error: { code: string } }).error.code).toBe("forbidden");
      h.conforms("Error", res.body);
    }
    expect(await storedRevision(h.env().admin, "stable")).toBeNull();
    expect(await audits(h.env().admin)).toEqual([]);
  });

  it("serves a platform admin with no active tenant", async () => {
    if (h.skipped()) return;
    const res = await h.get(BASE, PLATFORM_ADMIN.session).expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("is not tenant-scoped: no cross-tenant access row is written", async () => {
    if (h.skipped()) return;
    const before = await h.env().admin.query(`SELECT 1 FROM audit_events WHERE action = 'platform.cross_tenant.accessed'`);
    await h.put(channelPath("lab"), PLATFORM_ADMIN.session, BODY).expect(200);
    await h.get(BASE, PLATFORM_ADMIN.session).expect(200);
    const after = await h.env().admin.query(`SELECT 1 FROM audit_events WHERE action = 'platform.cross_tenant.accessed'`);
    expect(after.rowCount).toBe(before.rowCount);
  });
});

describe("RT-327 version policy: the read", () => {
  it("lists all three channels in order, null until a policy is set", async () => {
    if (h.skipped()) return;
    const res = await h.get(BASE, PLATFORM_ADMIN.session).expect(200);
    h.conforms("PosVersionPolicySet", res.body);
    expect(res.body).toEqual({
      items: [
        { channel: "lab", policy: null },
        { channel: "canary", policy: null },
        { channel: "stable", policy: null },
      ],
    });
  });

  it("returns a set policy with its revision and author", async () => {
    if (h.skipped()) return;
    await h.put(channelPath("canary"), PLATFORM_ADMIN.session, BODY).expect(200);
    const res = await h.get(BASE, PLATFORM_ADMIN.session).expect(200);
    h.conforms("PosVersionPolicySet", res.body);
    const items = (res.body as { items: Array<{ channel: string; policy: Record<string, unknown> | null }> }).items;
    expect(items.map((i) => i.channel)).toEqual(["lab", "canary", "stable"]);
    expect(items[0]!.policy).toBeNull();
    expect(items[1]!.policy).toMatchObject({
      latestVersion: "1.5.0",
      recommendedVersion: "1.4.2",
      minSupportedVersion: "1.4.0",
      minSupportedGraceUntil: "2026-12-01T00:00:00.000Z",
      revision: 1,
      updatedByUserId: PLATFORM_ADMIN.id,
    });
    expect(items[2]!.policy).toBeNull();
  });
});

describe("RT-327 version policy: the change", () => {
  it("creates the first policy of a channel at revision 1 and audits it in the same change", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const res = await h.put(channelPath("stable"), PLATFORM_ADMIN.session, BODY).expect(200);
    h.conforms("PosVersionPolicyEntry", res.body);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ channel: "stable", policy: { revision: 1, updatedByUserId: PLATFORM_ADMIN.id } });
    const [row, ...rest] = await audits(admin);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ actor_user_id: PLATFORM_ADMIN.id, tenant_id: null, store_id: null, target_type: "pos_version_policy", target_id: null });
    expect(row!.metadata).toEqual({
      channel: "stable",
      old: null,
      new: {
        latestVersion: "1.5.0",
        recommendedVersion: "1.4.2",
        minSupportedVersion: "1.4.0",
        minSupportedGraceUntil: "2026-12-01T00:00:00.000Z",
        revision: 1,
      },
    });
  });

  it("bumps the revision on an effective change and records the old and new values", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await h.put(channelPath("stable"), PLATFORM_ADMIN.session, BODY).expect(200);
    const changed = { ...BODY, minSupportedVersion: "1.4.1", recommendedVersion: "1.4.3", expectedRevision: 1 };
    const res = await h.put(channelPath("stable"), PLATFORM_ADMIN.session, changed).expect(200);
    expect(res.body).toMatchObject({ policy: { revision: 2, minSupportedVersion: "1.4.1" } });
    const rows = await audits(admin);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.metadata).toMatchObject({
      channel: "stable",
      old: { minSupportedVersion: "1.4.0", recommendedVersion: "1.4.2", revision: 1 },
      new: { minSupportedVersion: "1.4.1", recommendedVersion: "1.4.3", revision: 2 },
    });
    expect(JSON.stringify(rows.map((r) => [r.metadata, r.actor_label]))).not.toMatch(/@|password|cookie|token/i);
  });

  it("treats a body equal to the stored values as a no-op 200, whatever expectedRevision says", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const first = await h.put(channelPath("stable"), PLATFORM_ADMIN.session, BODY).expect(200);
    for (const expectedRevision of [null, 1, 7]) {
      const replay = await h.put(channelPath("stable"), PLATFORM_ADMIN.session, { ...BODY, expectedRevision }).expect(200);
      expect(replay.body).toEqual(first.body);
    }
    expect(await audits(admin)).toHaveLength(1);
    expect(await storedRevision(admin, "stable")).toBe(1);
  });

  it("compares the grace instant as an instant, not as text", async () => {
    if (h.skipped()) return;
    await h.put(channelPath("stable"), PLATFORM_ADMIN.session, BODY).expect(200);
    const sameInstant = { ...BODY, minSupportedGraceUntil: "2026-12-01T02:00:00.000+02:00" };
    await h.put(channelPath("stable"), PLATFORM_ADMIN.session, sameInstant).expect(200);
    expect(await storedRevision(h.env().admin, "stable")).toBe(1);
    expect(await audits(h.env().admin)).toHaveLength(1);
  });

  it("refuses a stale, missing or premature expectedRevision with 409 and writes nothing", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    // No policy yet but a revision is claimed.
    const early = await h.put(channelPath("stable"), PLATFORM_ADMIN.session, { ...BODY, expectedRevision: 1 });
    expect(early.status).toBe(409);
    expect((early.body as { error: { code: string } }).error.code).toBe("policy_revision_conflict");
    h.conforms("Error", early.body);
    await h.put(channelPath("stable"), PLATFORM_ADMIN.session, BODY).expect(200);
    await h.put(channelPath("stable"), PLATFORM_ADMIN.session, { ...BODY, minSupportedVersion: "1.4.1", expectedRevision: 1 }).expect(200);
    const different = { ...BODY, latestVersion: "1.9.0" };
    for (const expectedRevision of [1, null, 9]) {
      const res = await h.put(channelPath("stable"), PLATFORM_ADMIN.session, { ...different, expectedRevision });
      expect({ expectedRevision, status: res.status }).toEqual({ expectedRevision, status: 409 });
    }
    expect(await storedRevision(admin, "stable")).toBe(2);
    expect(await audits(admin)).toHaveLength(2);
  });

  it("refuses versions out of semantic-version order with 422 and writes nothing", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const cases = [
      { ...BODY, minSupportedVersion: "1.5.0", recommendedVersion: "1.4.0" },
      { ...BODY, recommendedVersion: "1.6.0", latestVersion: "1.5.0" },
      { ...BODY, minSupportedVersion: "2.0.0" },
      // A pre-release is lower than its release.
      { ...BODY, minSupportedVersion: "1.4.0", recommendedVersion: "1.4.0-rc.1", latestVersion: "1.4.0" },
    ];
    for (const body of cases) {
      const res = await h.put(channelPath("stable"), PLATFORM_ADMIN.session, body);
      expect({ body, status: res.status }).toEqual({ body, status: 422 });
      expect((res.body as { error: { code: string } }).error.code).toBe("version_order_invalid");
      h.conforms("Error", res.body);
    }
    expect(await storedRevision(admin, "stable")).toBeNull();
    expect(await audits(admin)).toEqual([]);
  });

  it("accepts equal versions and a grace instant already in the past", async () => {
    if (h.skipped()) return;
    const past = { ...BODY, latestVersion: "1.4.0", recommendedVersion: "1.4.0", minSupportedGraceUntil: "2020-01-01T00:00:00.000Z" };
    await h.put(channelPath("stable"), PLATFORM_ADMIN.session, past).expect(200);
  });

  it("refuses a bad channel, a bad body, an unknown or missing key with 400 and writes nothing", async () => {
    if (h.skipped()) return;
    const { latestVersion: _omit, ...missing } = BODY;
    const bad: Array<[string, object]> = [
      ["beta", BODY],
      ["Stable", BODY],
      ["stable", missing],
      ["stable", { ...BODY, note: "why" }],
      ["stable", { ...BODY, latestVersion: "1.5" }],
      ["stable", { ...BODY, minSupportedGraceUntil: "soon" }],
      ["stable", { ...BODY, expectedRevision: 0 }],
      ["stable", []],
    ];
    for (const [channel, body] of bad) {
      const res = await h.put(channelPath(channel), PLATFORM_ADMIN.session, body);
      expect({ channel, body, status: res.status }).toEqual({ channel, body, status: 400 });
      expect((res.body as { error: { code: string } }).error.code).toBe("validation_error");
    }
    expect(await storedRevision(h.env().admin, "stable")).toBeNull();
    expect(await audits(h.env().admin)).toEqual([]);
  });

  it("keeps channels independent", async () => {
    if (h.skipped()) return;
    await h.put(channelPath("lab"), PLATFORM_ADMIN.session, BODY).expect(200);
    await h.put(channelPath("stable"), PLATFORM_ADMIN.session, { ...BODY, minSupportedVersion: "1.3.0" }).expect(200);
    expect(await storedRevision(h.env().admin, "lab")).toBe(1);
    expect(await storedRevision(h.env().admin, "stable")).toBe(1);
    expect(await storedRevision(h.env().admin, "canary")).toBeNull();
  });

  it("serializes concurrent creates of one channel: one wins, the other is 409, one audit row", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    const [a, b] = await Promise.all([
      h.put(channelPath("stable"), PLATFORM_ADMIN.session, BODY),
      h.put(channelPath("stable"), PLATFORM_ADMIN.session, { ...BODY, latestVersion: "1.9.0" }),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
    expect(await storedRevision(admin, "stable")).toBe(1);
    expect(await audits(admin)).toHaveLength(1);
  });

  it("serializes concurrent changes against one revision", async () => {
    if (h.skipped()) return;
    const admin = h.env().admin;
    await h.put(channelPath("stable"), PLATFORM_ADMIN.session, BODY).expect(200);
    const [a, b] = await Promise.all([
      h.put(channelPath("stable"), PLATFORM_ADMIN.session, { ...BODY, minSupportedVersion: "1.4.1", expectedRevision: 1 }),
      h.put(channelPath("stable"), PLATFORM_ADMIN.session, { ...BODY, minSupportedVersion: "1.4.2", expectedRevision: 1 }),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
    expect(await storedRevision(admin, "stable")).toBe(2);
    expect(await audits(admin)).toHaveLength(2);
  });
});

describe("RT-327 pos_version_policy: row level security", () => {
  it("is readable in a tenant context and writable only in the platform-admin context", async () => {
    if (h.skipped()) return;
    await h.put(channelPath("stable"), PLATFORM_ADMIN.session, BODY).expect(200);
    const pool = h.env().app;
    const asTenant = <T>(work: Parameters<typeof runWithTenantContext<T>>[2]) => runWithTenantContext(pool, { tenantId: TENANT_A, isPlatformAdmin: false }, work);
    const seen = await asTenant((client) => client.query(`SELECT channel FROM pos_version_policy`));
    expect(seen.rows).toEqual([{ channel: "stable" }]);
    await expect(
      asTenant((client) =>
        client.query(
          `INSERT INTO pos_version_policy (channel, latest_version, recommended_version, min_supported_version, min_supported_grace_until, revision, updated_by_user_id)
           VALUES ('lab', '1.0.0', '1.0.0', '1.0.0', now(), 1, $1)`,
          [PLATFORM_ADMIN.id],
        ),
      ),
    ).rejects.toThrow();
    const update = await asTenant((client) => client.query(`UPDATE pos_version_policy SET min_supported_version = '0.0.1'`));
    expect(update.rowCount).toBe(0);
    // No DELETE policy for any context: a row is never removed by the application.
    const del = await asTenant((client) => client.query(`DELETE FROM pos_version_policy`));
    expect(del.rowCount).toBe(0);
    expect(await storedRevision(h.env().admin, "stable")).toBe(1);
  });
});
