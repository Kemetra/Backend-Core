/**
 * RT-366 (RT-287 F3) — the device lifecycle impact preview over HTTP against
 * real Postgres (Testcontainers, every migration, the NOBYPASSRLS `app_test`
 * pool) and the real module graph, on the RT-365 device fixture.
 *
 *   GET  /api/v1/devices/{deviceId}/impact  consoleGetDeviceImpact
 *   POST /api/v1/devices/{deviceId}/revoke  consoleRevokeDevice (the 409 `error.details`)
 *
 * What this proves (RT-366 acceptance):
 *   - the verdict of every action on every fixture state (active, open legacy /
 *     cash-up shift, revoked, custody exception, retired), with the open shift,
 *     the server-received cash facts, the cascade counts and the links;
 *   - parity: on the same state, the revoke's outcome is the one the preview's
 *     verdict maps to (contract "Impact preview"), for every refusing reason ×
 *     role, and for one revoke of each succeeding verdict class; the preview's
 *     cascade counts equal the revoke's audit counts; a 409 carries the
 *     preview of the refused state;
 *   - snapshot, not reservation: a shift that opens after an `allowed` preview
 *     makes the revoke 409, and the 409's details show that shift, including
 *     when the revoke waited on that open's lifecycle lock;
 *   - same scope and 404 as the reads; 400 for a malformed action / reason;
 *   - read-only and secret-free: no write, no cascade, no note or token.
 *
 * Replace / move / retire have no mutation yet (RT-367 / RT-368): their
 * verdicts are pinned here and their parity is proved when those mutations
 * call the same evaluator.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import type request from "supertest";

import { runWithTenantContext } from "@data-pulse-2/db";

import { DevicesModule } from "../../src/devices/devices.module";
import { ShiftCashUpRepository } from "../../src/pos-shifts/shift-cash-up.repository";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { STORE_A_X, TENANT_A } from "../catalog/__support__/isolation-harness";
import { SES_ADMIN_SPEC, SES_OWNER_ALL } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  CASHIER_A,
  cashFactsDigest,
  D_B,
  D_EXC,
  D_LATE_Y,
  D_NEW,
  D_OLD,
  D_RETIRED,
  D_SOON,
  NO_DEVICE,
  R_BLOCK,
  R_PLAIN,
  R_RACE,
  R_REC,
  R_REC_ADMIN,
  R_REVERSE,
  R_SEC,
  SES_MANAGER,
  SES_MANAGER_ACTIVE,
  SES_STAFF,
  seedDeviceFixture,
  SHIFT_BLOCK,
  SHIFT_EXC,
  SHIFT_REC,
  SHIFT_SEC,
} from "./__support__/device-fixture";
import { contractRevokeOutcome, type RevokeBodyView, type RevokeOutcome } from "./__support__/impact-outcome";

const impactPath = (deviceId: string): string => `/api/v1/devices/${deviceId}/impact`;
const revokePath = (deviceId: string): string => `/api/v1/devices/${deviceId}/revoke`;

const RECOVERY_REQUIRES = ["owner_or_tenant_admin", "note", "acknowledge_custody_exception"];
const NOTE = "Till will not boot; drawer cash in the back-office safe";
const NON_SECURITY = ["replaced", "moved", "retired", "admin_error", "other"] as const;

let cashBaseline = "";

const h = scopedHttpHarness({
  label: "RT-366 device impact",
  contractId: "devices.openapi",
  module: DevicesModule,
  seed: async (env) => {
    await seedDeviceFixture(env);
    cashBaseline = await cashFactsDigest(env.admin);
  },
});
const skip = (): boolean => h.skipped();

type Preview = Record<string, unknown> & { verdict: string; blockCode: string | null; cascade: Cascade | null };
type Cascade = { operatorSessionCount: number; pendingPairingCodeCount: number };

async function preview(session: string, deviceId: string, action: string, reason?: string): Promise<Preview> {
  const res = await h.get(impactPath(deviceId), session, { action, ...(reason !== undefined ? { reason } : {}) });
  expect(res.status).toBe(200);
  h.conforms("DeviceImpactPreview", res.body);
  return res.body as Preview;
}

const post = (deviceId: string, session: string, body: object): request.Test => h.post(revokePath(deviceId), session, body);

/** The contract's outcome for `p` (the shared verdict → revoke outcome table). */
const expectedRevoke = (p: Preview, body: RevokeBodyView): RevokeOutcome =>
  contractRevokeOutcome({ verdict: p.verdict, blockCode: p.blockCode, requires: p["requires"] as string[] }, body);

function outcomeOf(res: request.Response): RevokeOutcome {
  const body = res.body as { outcome?: string; error?: { code?: string } };
  return [res.status, res.status === 200 ? String(body.outcome) : String(body.error?.code)];
}

/** The preview fields that describe the state (everything but the evaluation time). */
const stateOf = (p: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(p).filter(([k]) => k !== "evaluatedAt"));

async function revokeAuditCounts(deviceId: string): Promise<Cascade[]> {
  const r = await h.env().admin.query<{ metadata: Record<string, number> }>(
    `SELECT metadata FROM audit_events WHERE action = 'pos.device.revoked' AND target_id = $1`,
    [deviceId],
  );
  return r.rows.map((row) => ({
    operatorSessionCount: row.metadata["revoked_session_count"]!,
    pendingPairingCodeCount: row.metadata["cancelled_pairing_code_count"]!,
  }));
}

// ===========================================================================
// 1. Verdicts and facts (read-only)
// ===========================================================================
describe("consoleGetDeviceImpact — verdicts and facts", () => {
  it("previews an allowed revoke of an active device with its cascade", async () => {
    if (skip()) return;
    expect(await preview(SES_OWNER_ALL, R_PLAIN, "revoke", "admin_error")).toMatchObject({
      deviceId: R_PLAIN,
      action: "revoke",
      revokeReason: "admin_error",
      trustState: "active",
      verdict: "allowed",
      blockCode: null,
      requires: [],
      openShift: null,
      custodyExceptionShiftId: null,
      // The live operator token (not the expired one); the terminal and the replacement code.
      cascade: { operatorSessionCount: 1, pendingPairingCodeCount: 2 },
    });
  });

  it("blocks a non-security revoke over an open legacy shift, whose cash facts are unknown", async () => {
    if (skip()) return;
    expect(await preview(SES_MANAGER, R_BLOCK, "revoke", "moved")).toMatchObject({
      verdict: "blocked",
      blockCode: "unresolved_cash_session",
      openShift: {
        shiftId: SHIFT_BLOCK,
        source: "legacy",
        openedAt: "2026-10-15T08:00:00.000Z",
        openingCashierUserId: CASHIER_A,
        cashFacts: null,
      },
      cascade: { operatorSessionCount: 0, pendingPairingCodeCount: 0 },
    });
  });

  it("counts a cash-up shift's server-received facts: the open and its movement", async () => {
    if (skip()) return;
    const p = await preview(SES_MANAGER, R_SEC, "revoke", "stolen");
    expect(p).toMatchObject({
      verdict: "allowed_with_custody_exception",
      requires: [],
      openShift: { shiftId: SHIFT_SEC, source: "cash_up", cashFacts: { view: "server_received", receivedCount: 2 } },
      cascade: { operatorSessionCount: 1, pendingPairingCodeCount: 0 },
    });
    const received = await h.env().admin.query<{ at: Date }>(
      `SELECT max(received_at) AS at FROM (
         SELECT received_at FROM shifts WHERE shift_id = $1
         UNION ALL SELECT received_at FROM shift_cash_movements WHERE shift_id = $1) f`,
      [SHIFT_SEC],
    );
    expect((p["openShift"] as { cashFacts: { lastReceivedAt: string } }).cashFacts.lastReceivedAt).toBe(
      received.rows[0]!.at.toISOString(),
    );
  });

  it("reports the recovery revoke's requirements, allowed for owner / tenant_admin, forbidden for a manager", async () => {
    if (skip()) return;
    for (const session of [SES_OWNER_ALL, SES_ADMIN_SPEC]) {
      expect(await preview(session, R_REC, "revoke", "hardware_failure")).toMatchObject({
        verdict: "allowed_with_custody_exception",
        requires: RECOVERY_REQUIRES,
        openShift: { shiftId: SHIFT_REC },
      });
    }
    expect(await preview(SES_MANAGER, R_REC, "revoke", "hardware_failure")).toMatchObject({
      verdict: "forbidden_recovery",
      requires: RECOVERY_REQUIRES,
    });
  });

  it("judges each action on a device whose open shift is the custody exception", async () => {
    if (skip()) return;
    const verdicts = async (action: string, reason?: string) => {
      const p = await preview(SES_OWNER_ALL, D_EXC, action, reason);
      expect(p).toMatchObject({ trustState: "revoked", custodyExceptionShiftId: SHIFT_EXC, cascade: null });
      return [p.verdict, p.blockCode];
    };
    expect(await verdicts("revoke", "lost")).toEqual(["no_change", null]);
    expect(await verdicts("replace")).toEqual(["allowed", null]);
    expect(await verdicts("move")).toEqual(["allowed", null]);
    expect(await verdicts("retire")).toEqual(["blocked", "unresolved_custody_exception"]);
  });

  it("judges each action on a retired, a revoked, an active and an active-with-shift device", async () => {
    if (skip()) return;
    const cases: ReadonlyArray<readonly [string, string, string, string | null]> = [
      [D_RETIRED, "revoke", "no_change", null],
      [D_RETIRED, "replace", "blocked", "device_retired"],
      [D_RETIRED, "move", "blocked", "device_retired"],
      [D_RETIRED, "retire", "no_change", null],
      [D_OLD, "replace", "allowed", null],
      [D_OLD, "retire", "allowed", null],
      [D_SOON, "replace", "allowed", null],
      [D_SOON, "move", "allowed", null],
      [D_SOON, "retire", "allowed", null],
      [R_REC_ADMIN, "replace", "blocked", "unresolved_cash_session"],
      [R_REC_ADMIN, "move", "blocked", "unresolved_cash_session"],
      [R_REC_ADMIN, "retire", "blocked", "unresolved_cash_session"],
    ];
    for (const [deviceId, action, verdict, blockCode] of cases) {
      const p = await preview(SES_OWNER_ALL, deviceId, action, action === "revoke" ? "admin_error" : undefined);
      expect([deviceId, action, p.verdict, p.blockCode]).toEqual([deviceId, action, verdict, blockCode]);
    }
  });

  it("records each implied action's reason, and shows the replace links", async () => {
    if (skip()) return;
    expect(await preview(SES_OWNER_ALL, D_SOON, "move")).toMatchObject({
      revokeReason: "moved",
      replacesDeviceId: D_RETIRED,
      // D_SOON's live operator token and the pending replacement code for it.
      cascade: { operatorSessionCount: 1, pendingPairingCodeCount: 1 },
    });
    expect(await preview(SES_OWNER_ALL, D_OLD, "replace")).toMatchObject({ revokeReason: "replaced", replacedByDeviceId: D_NEW });
    expect(await preview(SES_OWNER_ALL, D_OLD, "retire")).toMatchObject({ revokeReason: "retired", cascade: null });
  });

  it("never returns a note, a token or a code", async () => {
    if (skip()) return;
    const body = JSON.stringify(await preview(SES_OWNER_ALL, D_EXC, "retire"));
    expect(body).not.toMatch(/drawer cash|safe|token|hash|code_|tenant/i);
  });
});

// ===========================================================================
// 2. Scope and validation
// ===========================================================================
describe("consoleGetDeviceImpact — scope and validation", () => {
  it("refuses another tenant's, an out-of-scope, an absent device and a disallowed role as the same 404", async () => {
    if (skip()) return;
    const q = { action: "retire" };
    for (const [deviceId, session] of [
      [D_B, SES_OWNER_ALL],
      [D_LATE_Y, SES_ADMIN_SPEC],
      [D_SOON, SES_MANAGER_ACTIVE],
      [NO_DEVICE, SES_OWNER_ALL],
      [D_SOON, SES_STAFF],
    ] as const) {
      const res = await h.get(impactPath(deviceId), session, q);
      expect([deviceId, res.status, (res.body as { error: { code: string } }).error.code]).toEqual([deviceId, 404, "not_found"]);
      h.conforms("Error", res.body);
    }
    expect((await h.get(impactPath(D_SOON), null, q)).status).toBe(401);
  });

  it.each([
    ["a revoke without a reason", R_PLAIN, { action: "revoke" }],
    ["a reason with another action", R_PLAIN, { action: "replace", reason: "replaced" }],
    ["an unknown action", R_PLAIN, { action: "suspend" }],
    ["an unknown reason", R_PLAIN, { action: "revoke", reason: "broken" }],
    ["no action", R_PLAIN, {}],
    ["a smuggled key", R_PLAIN, { action: "retire", tenant_id: TENANT_A }],
    ["a malformed id", "not-a-uuid", { action: "retire" }],
  ])("answers 400 validation_error for %s", async (_label, deviceId, query) => {
    if (skip()) return;
    const res = await h.get(impactPath(deviceId), SES_OWNER_ALL, query as Record<string, string>);
    expect([res.status, (res.body as { error: { code: string } }).error.code]).toEqual([400, "validation_error"]);
  });
});

// ===========================================================================
// 3. Parity with the revoke
// ===========================================================================

interface RefusalCase {
  readonly deviceId: string;
  readonly session: string;
  readonly body: { readonly reason: string } & RevokeBodyView;
}

/** The bodies tried for a reason: a recovery revoke missing each requirement, else the reason alone. */
const refusalBodies = (reason: string): RefusalCase["body"][] =>
  reason === "hardware_failure"
    ? [{ reason }, { reason, note: NOTE }, { reason, acknowledgeCustodyException: true }]
    : [{ reason, ...(reason === "other" ? { note: "x" } : {}) }];

/** Every refusing reason × role × body on a legacy-shift and a cash-up-shift device: none revokes. */
const REFUSAL_CASES: readonly RefusalCase[] = [R_BLOCK, R_REC_ADMIN].flatMap((deviceId) =>
  [...NON_SECURITY, "hardware_failure"].flatMap((reason) =>
    [SES_OWNER_ALL, SES_ADMIN_SPEC, SES_MANAGER].flatMap((session) =>
      refusalBodies(reason).map((body) => ({ deviceId, session, body })),
    ),
  ),
);

/** Preview, then revoke: the outcome is the preview's, and a 409 carries the same preview. */
async function expectRevokeAsPreviewed({ deviceId, session, body }: RefusalCase): Promise<void> {
  const p = await preview(session, deviceId, "revoke", body.reason);
  const res = await post(deviceId, session, body);
  expect([deviceId, session, body, outcomeOf(res)]).toEqual([deviceId, session, body, expectedRevoke(p, body)]);
  if (res.status !== 409) return;
  h.conforms("DeviceImpactConflict", res.body);
  expect(stateOf((res.body as { error: { details: Record<string, unknown> } }).error.details)).toEqual(stateOf(p));
}
describe("preview / revoke parity", () => {
  it("previews never write: no revoke, no cascade, no cash fact", async () => {
    if (skip()) return;
    const r = await h.env().admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action = 'pos.device.revoked'`,
    );
    expect(r.rows[0]!.n).toBe(0);
    const pending = await h.env().admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM pairing_codes WHERE status = 'pending'`);
    expect(pending.rows[0]!.n).toBe(3);
    expect(await cashFactsDigest(h.env().admin)).toBe(cashBaseline);
  });

  it("every refusing reason × role revokes as its preview says, and the 409 carries that preview", async () => {
    if (skip()) return;
    for (const refusal of REFUSAL_CASES) await expectRevokeAsPreviewed(refusal);
    const untouched = await h.env().admin.query(`SELECT revoked_at FROM devices WHERE id = ANY($1::uuid[])`, [[R_BLOCK, R_REC_ADMIN]]);
    expect(untouched.rows.map((row) => row.revoked_at)).toEqual([null, null]);
  });

  it.each([
    ["allowed", R_PLAIN, SES_MANAGER, { reason: "admin_error", note: "Paired to the wrong store" }],
    ["allowed_with_custody_exception (security)", R_SEC, SES_MANAGER, { reason: "stolen" }],
    ["allowed_with_custody_exception (recovery)", R_REC, SES_OWNER_ALL, { reason: "hardware_failure", note: NOTE, acknowledgeCustodyException: true }],
  ] as const)("a %s preview revokes, and its cascade equals the audit counts", async (_label, deviceId, session, body) => {
    if (skip()) return;
    const p = await preview(session, deviceId, "revoke", body.reason);
    const res = await post(deviceId, session, body);
    expect(outcomeOf(res)).toEqual(expectedRevoke(p, body));
    expect(await revokeAuditCounts(deviceId)).toEqual([p.cascade]);
    expect((res.body as { device: { custodyExceptionShiftId: string | null } }).device.custodyExceptionShiftId).toBe(
      p.verdict === "allowed" ? null : (p["openShift"] as { shiftId: string }).shiftId,
    );
  });

  it.each([
    ["revoked", R_PLAIN, 1],
    ["revoked with a custody exception", D_EXC, 0],
    ["retired", D_RETIRED, 0],
  ] as const)("a no_change preview of a %s device revokes as already_revoked, writing nothing", async (state, deviceId, audits) => {
    if (skip()) return;
    const p = await preview(SES_OWNER_ALL, deviceId, "revoke", "lost");
    expect(p).toMatchObject({ verdict: "no_change", trustState: state === "retired" ? "retired" : "revoked", cascade: null });
    expect(outcomeOf(await post(deviceId, SES_OWNER_ALL, { reason: "lost" }))).toEqual(expectedRevoke(p, {}));
    expect(await revokeAuditCounts(deviceId)).toHaveLength(audits);
  });

  it("the revokes changed no cash fact", async () => {
    if (skip()) return;
    expect(await cashFactsDigest(h.env().admin)).toBe(cashBaseline);
  });
});

// ===========================================================================
// 4. The preview is a snapshot, not a reservation
// ===========================================================================
describe("a shift that opens after the preview", () => {
  it("turns an allowed preview into a 409 whose details show the new shift", async () => {
    if (skip()) return;
    const before = await preview(SES_OWNER_ALL, R_RACE, "revoke", "admin_error");
    expect(before).toMatchObject({ verdict: "allowed", openShift: null });

    const shiftId = "0a000000-0000-7000-8000-0000036603e1";
    const scope = { tenantId: TENANT_A, storeId: STORE_A_X, deviceId: R_RACE };
    const repo = new ShiftCashUpRepository();
    await runWithTenantContext(h.env().app, { tenantId: TENANT_A, isPlatformAdmin: false }, async (c) => {
      expect(await repo.lockOpenableDevice(c, scope)).toBe(true);
      const opened = await repo.insertShift(c, scope, {
        shiftId,
        openedAt: "2026-10-16T14:00:00Z",
        openingUserId: CASHIER_A,
        currencyCode: "EGP",
        openingFloat: "100.00",
        recordedByUserId: CASHIER_A,
        payloadHash: Buffer.alloc(32, 6),
      });
      expect(opened.kind).toBe("inserted");
    });

    const res = await post(R_RACE, SES_OWNER_ALL, { reason: "admin_error" });
    expect(outcomeOf(res)).toEqual([409, "unresolved_cash_session"]);
    h.conforms("DeviceImpactConflict", res.body);
    const details = (res.body as { error: { details: Preview } }).error.details;
    expect(details).toMatchObject({
      verdict: "blocked",
      blockCode: "unresolved_cash_session",
      openShift: { shiftId, source: "cash_up", cashFacts: { receivedCount: 1 } },
    });
    expect(stateOf(await preview(SES_OWNER_ALL, R_RACE, "revoke", "admin_error"))).toEqual(stateOf(details));
  });

  it("a revoke that waited on a shift open's lifecycle lock answers 409 with that shift in its details", async () => {
    if (skip()) return;
    expect(await preview(SES_OWNER_ALL, R_REVERSE, "revoke", "admin_error")).toMatchObject({ verdict: "allowed" });
    const shiftId = "0a000000-0000-7000-8000-0000036603e2";
    const scope = { tenantId: TENANT_A, storeId: STORE_A_X, deviceId: R_REVERSE };
    const repo = new ShiftCashUpRepository();
    const opener = await h.env().admin.connect();
    let response: request.Response | null = null;
    try {
      // The open holds the lifecycle lock; the revoke starts and must wait for it.
      await opener.query("BEGIN");
      expect(await repo.lockOpenableDevice(opener, scope)).toBe(true);
      const revoking = post(R_REVERSE, SES_OWNER_ALL, { reason: "admin_error" }).then((res) => {
        response = res;
        return res;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(response).toBeNull();
      const opened = await repo.insertShift(opener, scope, {
        shiftId,
        openedAt: "2026-10-16T15:00:00Z",
        openingUserId: CASHIER_A,
        currencyCode: "EGP",
        openingFloat: "100.00",
        recordedByUserId: CASHIER_A,
        payloadHash: Buffer.alloc(32, 5),
      });
      expect(opened.kind).toBe("inserted");
      await opener.query("COMMIT");
      const res = await revoking;
      expect(outcomeOf(res)).toEqual([409, "unresolved_cash_session"]);
      h.conforms("DeviceImpactConflict", res.body);
      expect((res.body as { error: { details: Preview } }).error.details).toMatchObject({
        verdict: "blocked",
        openShift: { shiftId },
      });
    } finally {
      opener.release();
    }
  });
});
