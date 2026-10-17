/**
 * RT-387 — the shift variance policy on the RT-17 cash-up (pos-shifts
 * 1.2.0-draft, AD-CASH-001 D-6 / D-7) over HTTP against real Postgres and
 * the production module graph (the RT-17 harness).
 *
 * What this proves:
 *   - open: the optional `frozenPolicy` is recorded verbatim with its
 *     accept-and-flag findings and echoed with `policyFlags`; an open without
 *     it records nothing (old POS) and echoes no `frozenPolicy`; only a
 *     malformed one is a 400; a replay is hash-matched with the policy;
 *   - close: `approvalRequiredByPolicy` / `approvalMissing` derived from the
 *     frozen value (every D-1 branch: none, under / equal / over a limit,
 *     limit 0, a negative variance, a limit in another currency, fallback),
 *     `unknown` for an open without policy (old POS still closes), agreeing
 *     with the 0050 close guard (no 23514);
 *   - the approver verdict: persisted after the commit in
 *     `shift_close_approver_checks`, carried by the 201, read back on a replay;
 *   - every 2xx validates against the contract (`Shift`).
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import { randomUUID } from "node:crypto";

import {
  admin,
  CASHIER,
  closeBody,
  CASHIER_B,
  closePath,
  DEV_A1,
  DEV_A2,
  expectError,
  expectReplay,
  expectSchema,
  MANAGER,
  minutesAgo,
  OPEN_PATH,
  openBody,
  post,
  resetState,
  skipped,
  startHarness,
  stopHarness,
  STORE_A2,
  TENANT_A,
  TENANT_B,
  type FixtureDevice,
} from "./__support__/shift-http-harness";
import { OPEN_SKEW_MS } from "../../src/cash-variance-policy/policy-open-flags";

beforeAll(() => startHarness("RT-387 shift policy"), 240_000);
afterAll(() => stopHarness(), 60_000);
beforeEach(() => resetState());

const limit = (limitAmount: string, currencyCode = "EGP") => ({ mode: "limit", limitAmount, currencyCode });
const NONE = { mode: "none" };

/** A revision row seeded on the admin pool at an exact, millisecond-precise instant. */
interface SeedRevision {
  readonly tenantId?: string;
  readonly storeId?: string;
  readonly kind?: "set" | "clear";
  readonly value?: { mode: string; limitAmount?: string; currencyCode?: string };
  readonly createdAt: Date;
  readonly until?: Date;
  readonly supersedes?: string | null;
  readonly createdBy?: string;
}

async function seedRevision(seed: SeedRevision): Promise<string> {
  const id = randomUUID();
  const value: SeedRevision["value"] | null = seed.kind === "clear" ? null : (seed.value ?? NONE);
  await admin().query(
    `INSERT INTO cash_variance_policy_revisions
       (id, tenant_id, scope, store_id, kind, mode, limit_amount, currency_code, reason, permanent,
        effective_until, supersedes_revision_id, created_by_user_id, created_at, effective_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, 'seed', false, $9, $10, $11, $12, $12)`,
    [
      id,
      seed.tenantId ?? TENANT_A,
      seed.storeId === undefined ? "tenant" : "store",
      seed.storeId ?? null,
      seed.kind ?? "set",
      value?.mode ?? null,
      value?.limitAmount ?? null,
      value?.currencyCode ?? null,
      seed.until ?? null,
      seed.supersedes ?? null,
      seed.createdBy ?? MANAGER.id,
      seed.createdAt,
    ],
  );
  return id;
}

/** A millisecond-precise instant `minutes` before the suite started. */
const T0 = Date.now();
const before = (minutes: number): Date => new Date(T0 - minutes * 60_000);
const iso = (ms: number): string => new Date(ms).toISOString();

async function openWith(frozenPolicy: unknown, overrides: Record<string, unknown> = {}, device: FixtureDevice = DEV_A1) {
  const body = openBody({ ...(frozenPolicy === undefined ? {} : { frozenPolicy }), ...overrides });
  const res = await post({ path: OPEN_PATH, bearer: device.token, body });
  return { res, body, shiftId: body["shiftId"] as string };
}

async function frozenRow(shiftId: string) {
  const r = await admin().query(
    `SELECT frozen_policy_source AS source, frozen_policy_revision_id AS revision_id, frozen_policy_mode AS mode,
            frozen_policy_limit_amount::text AS limit_amount, frozen_policy_currency_code AS currency,
            frozen_policy_flags AS flags
       FROM shifts WHERE shift_id = $1`,
    [shiftId],
  );
  return r.rows[0];
}

let revOld = "";
let revCurrent = "";
/** When revCurrent was published (it superseded revOld): the skew boundaries are measured from it. */
const REV_CURRENT_AT = before(120);
/** STORE_A2: an expiring override S2 (limit 20, stricter than the tenant's 50), then cleared (C2). */
let storeSet = "";
let storeClear = "";
let otherTenantRevision = "";

beforeAll(async () => {
  if (skipped()) return;
  revOld = await seedRevision({ value: limit("100.00"), createdAt: before(180) });
  revCurrent = await seedRevision({ value: limit("50.00"), createdAt: REV_CURRENT_AT, supersedes: revOld });
  storeSet = await seedRevision({ storeId: STORE_A2, value: limit("20.00"), createdAt: before(100), until: before(-1440) });
  storeClear = await seedRevision({ storeId: STORE_A2, kind: "clear", createdAt: before(80), supersedes: storeSet });
  otherTenantRevision = await seedRevision({ tenantId: TENANT_B, value: limit("50.00"), createdAt: before(100), createdBy: CASHIER_B.id });
}, 60_000);

describe("open", () => {
  it("records nothing for an open without frozenPolicy (an old POS) and echoes none", async () => {
    if (skipped()) return;
    const { res, shiftId } = await openWith(undefined);
    expect(res.status).toBe(201);
    expectSchema("Shift", res.body);
    expect(res.body).not.toHaveProperty("frozenPolicy");
    expect(await frozenRow(shiftId)).toEqual({ source: null, revision_id: null, mode: null, limit_amount: null, currency: null, flags: null });
  });

  it("records a tenant policy that was current at openedAt with no flag", async () => {
    if (skipped()) return;
    const frozen = { policySource: "tenant", policyRevisionId: revCurrent, policyValue: limit("50.00") };
    const { res, shiftId } = await openWith(frozen);
    expect(res.status).toBe(201);
    expectSchema("Shift", res.body);
    expect(res.body.frozenPolicy).toEqual({ ...frozen, policyFlags: [] });
    expect(await frozenRow(shiftId)).toEqual({
      source: "tenant",
      revision_id: revCurrent,
      mode: "limit",
      limit_amount: "50.0000",
      currency: "EGP",
      flags: [],
    });
  });

  it("flags an offline open on a revision superseded before openedAt (beyond 120 s)", async () => {
    if (skipped()) return;
    const frozen = { policySource: "tenant", policyRevisionId: revOld, policyValue: limit("100.00") };
    const { res } = await openWith(frozen, { openedAt: minutesAgo(60) });
    expect(res.status).toBe(201);
    expect(res.body.frozenPolicy.policyFlags).toEqual(["policy_revision_superseded"]);
  });

  it("does not flag an open on the older revision while it was still effective", async () => {
    if (skipped()) return;
    const frozen = { policySource: "tenant", policyRevisionId: revOld, policyValue: limit("100.00") };
    const { res } = await openWith(frozen, { openedAt: minutesAgo(150) });
    expect(res.status).toBe(201);
    expect(res.body.frozenPolicy.policyFlags).toEqual([]);
  });

  it("does not flag an open within the 120 s skew of the change", async () => {
    if (skipped()) return;
    const frozen = { policySource: "tenant", policyRevisionId: revOld, policyValue: limit("100.00") };
    const { res } = await openWith(frozen, { openedAt: new Date(Date.now() - 119 * 60_000).toISOString() });
    expect(res.status).toBe(201);
    expect(res.body.frozenPolicy.policyFlags).toEqual([]);
  });

  it("flags a value that differs from the revision's stored value", async () => {
    if (skipped()) return;
    const frozen = { policySource: "tenant", policyRevisionId: revCurrent, policyValue: limit("40.00") };
    const { res } = await openWith(frozen);
    expect(res.body.frozenPolicy.policyFlags).toEqual(["policy_value_mismatch"]);
  });

  it("flags a limit whose currency differs from the shift's (and records it verbatim)", async () => {
    if (skipped()) return;
    const frozen = { policySource: "fallback", policyRevisionId: null, policyValue: limit("0.005", "USD") };
    const { res, shiftId } = await openWith(frozen);
    expect(res.status).toBe(201);
    expect(res.body.frozenPolicy).toEqual({ ...frozen, policyFlags: ["policy_value_mismatch"] });
    expect((await frozenRow(shiftId)).limit_amount).toBe("0.0050");
  });

  it("flags an unknown revision id (never a 400)", async () => {
    if (skipped()) return;
    const frozen = { policySource: "store", policyRevisionId: randomUUID(), policyValue: limit("10.00") };
    const { res } = await openWith(frozen);
    expect(res.status).toBe(201);
    expect(res.body.frozenPolicy.policyFlags).toEqual(["policy_revision_unknown"]);
  });

  it("accepts the never-fetched fallback (limit 0 in the shift's currency) with no flag", async () => {
    if (skipped()) return;
    const frozen = { policySource: "fallback", policyRevisionId: null, policyValue: limit("0.00") };
    const { res } = await openWith(frozen);
    expect(res.status).toBe(201);
    expect(res.body.frozenPolicy.policyFlags).toEqual([]);
  });

  it("flags a system policy frozen while a tenant default was in force (an older cached System default)", async () => {
    if (skipped()) return;
    const { res } = await openWith({ policySource: "system", policyRevisionId: null, policyValue: NONE });
    expect(res.status).toBe(201);
    expect(res.body.frozenPolicy.policyFlags).toEqual(["policy_revision_superseded"]);
  });

  it("does not flag a system policy frozen before the tenant's first default; flags a system limit as a mismatch", async () => {
    if (skipped()) return;
    const { res } = await openWith({ policySource: "system", policyRevisionId: null, policyValue: NONE }, { openedAt: minutesAgo(200) });
    expect(res.body.frozenPolicy.policyFlags).toEqual([]);
    await post({ path: closePath(res.body.shiftId as string), bearer: DEV_A1.token, body: closeBody() }).expect(201);
    const limited = await openWith({ policySource: "system", policyRevisionId: null, policyValue: limit("5.00") }, { openedAt: minutesAgo(200) });
    expect(limited.res.body.frozenPolicy.policyFlags).toEqual(["policy_value_mismatch"]);
  });

  it.each([
    ["a tenant source with a null revision", { policySource: "tenant", policyRevisionId: null, policyValue: NONE }],
    ["a system source with a revision", { policySource: "system", policyRevisionId: randomUUID(), policyValue: NONE }],
    ["a limit without a currency", { policySource: "fallback", policyRevisionId: null, policyValue: { mode: "limit", limitAmount: "0" } }],
    ["a missing member", { policySource: "system", policyValue: NONE }],
    ["an unknown source", { policySource: "cached", policyRevisionId: null, policyValue: NONE }],
  ])("refuses a frozenPolicy with %s with 400 and records nothing", async (_label, frozen) => {
    if (skipped()) return;
    const { res, shiftId } = await openWith(frozen);
    expectError(res, { status: 400, code: "validation_error" });
    expect(await frozenRow(shiftId)).toBeUndefined();
  });

  it("replays the same open (policy included) and refuses the same shiftId without it", async () => {
    if (skipped()) return;
    const frozen = { policySource: "tenant", policyRevisionId: revCurrent, policyValue: limit("50") };
    const { res, body } = await openWith(frozen);
    expect(res.status).toBe(201);
    const replay = await post({ path: OPEN_PATH, bearer: DEV_A1.token, body: { ...body, frozenPolicy: { ...frozen, policyValue: limit("50.00") } } });
    expectReplay(replay);
    expect(replay.body).toEqual(res.body);
    const { frozenPolicy: _dropped, ...legacy } = body;
    expectError(await post({ path: OPEN_PATH, bearer: DEV_A1.token, body: legacy }), { status: 409, code: "shift_payload_conflict" });
  });
});

describe("the accept-and-flag matrix (AD-CASH-001 D-6), one case per cell", () => {
  const tenantPolicy = (id: () => string, value: object = limit("50.00")) => () => ({ policySource: "tenant", policyRevisionId: id(), policyValue: value });
  const storePolicy = (id: () => string, value: object = limit("20.00")) => () => ({ policySource: "store", policyRevisionId: id(), policyValue: value });

  it.each<[string, () => unknown, FixtureDevice, number, string[]]>([
    // tenant / store source: unknown
    ["tenant: an id that is no revision of this tenant", tenantPolicy(() => randomUUID()), DEV_A1, 60, ["policy_revision_unknown"]],
    ["tenant: another tenant's revision", tenantPolicy(() => otherTenantRevision), DEV_A1, 60, ["policy_revision_unknown"]],
    ["store: another store's revision", storePolicy(() => storeSet), DEV_A1, 90, ["policy_revision_unknown"]],
    ["tenant source naming a store revision (scope mismatch)", tenantPolicy(() => storeSet, limit("20.00")), DEV_A2, 90, ["policy_revision_unknown"]],
    ["store: a clear revision", storePolicy(() => storeClear), DEV_A2, 70, ["policy_revision_unknown"]],
    // store source: effective, superseded, value mismatch
    ["store: the override in force at openedAt", storePolicy(() => storeSet), DEV_A2, 90, []],
    ["store: the override after its clear (offline, older cache)", storePolicy(() => storeSet), DEV_A2, 60, ["policy_revision_superseded"]],
    ["store: a value other than the override's", storePolicy(() => storeSet, limit("25.00")), DEV_A2, 90, ["policy_value_mismatch"]],
    // tenant source: superseded and value together; a currency other than the shift's
    ["tenant: superseded and another value", tenantPolicy(() => revOld, limit("99.00")), DEV_A1, 60, ["policy_revision_superseded", "policy_value_mismatch"]],
    ["tenant: the limit in another currency than the shift's", tenantPolicy(() => revCurrent, limit("50.00", "USD")), DEV_A1, 60, ["policy_value_mismatch"]],
    // tenant default under a stricter store override: the tenant revision was not the store's effective one
    ["tenant: the default while a stricter override governed the store", tenantPolicy(() => revCurrent), DEV_A2, 90, ["policy_revision_superseded"]],
    // fallback: never a revision flag
    ["fallback: none", () => ({ policySource: "fallback", policyRevisionId: null, policyValue: NONE }), DEV_A1, 60, []],
  ])("%s", async (_label, frozen, device, minutes, flags) => {
    if (skipped()) return;
    const { res } = await openWith(frozen(), { openedAt: minutesAgo(minutes) }, device);
    expect(res.status).toBe(201);
    expect(res.body.frozenPolicy.policyFlags).toEqual(flags);
  });

  it.each<[string, () => string, number, string[]]>([
    ["old revision, superseded exactly OPEN_SKEW_MS before openedAt", () => revOld, OPEN_SKEW_MS, []],
    ["old revision, superseded OPEN_SKEW_MS + 1 ms before openedAt", () => revOld, OPEN_SKEW_MS + 1, ["policy_revision_superseded"]],
    ["new revision, published exactly OPEN_SKEW_MS after openedAt", () => revCurrent, -OPEN_SKEW_MS, []],
    ["new revision, published OPEN_SKEW_MS + 1 ms after openedAt", () => revCurrent, -(OPEN_SKEW_MS + 1), ["policy_revision_superseded"]],
  ])("skew boundary: %s", async (_label, id, offsetMs, flags) => {
    if (skipped()) return;
    const value = id() === revOld ? limit("100.00") : limit("50.00");
    const frozen = { policySource: "tenant", policyRevisionId: id(), policyValue: value };
    const { res } = await openWith(frozen, { openedAt: iso(REV_CURRENT_AT.getTime() + offsetMs) });
    expect(res.status).toBe(201);
    expect(res.body.frozenPolicy.policyFlags).toEqual(flags);
  });
});

/** Opens with `frozen` (or none) then closes with `close` overrides; returns the 201 close and the stored row. */
async function openAndClose(frozen: unknown, close: Record<string, unknown> = {}) {
  const { res: opened, shiftId } = await openWith(frozen);
  expect(opened.status).toBe(201);
  const body = closeBody(close);
  const res = await post({ path: closePath(shiftId), bearer: DEV_A1.token, body });
  const row = await admin().query(
    `SELECT c.approval_required_by_policy AS required, c.approval_missing AS missing,
            v.status AS verdict, v.reason AS verdict_reason
       FROM shift_closes c LEFT JOIN shift_close_approver_checks v ON v.shift_id = c.shift_id
      WHERE c.shift_id = $1`,
    [shiftId],
  );
  return { res, shiftId, body, stored: row.rows[0] };
}

const tenantPolicy = (value: object) => ({ policySource: "tenant", policyRevisionId: revCurrent, policyValue: value });
const ZERO_VARIANCE = { countedCash: "2755.00", variance: "0.00" };

describe("close derivation (D-1 / D-7)", () => {
  it.each([
    ["no frozen policy (an old POS still closes)", () => undefined, {}, "unknown", "unknown"],
    ["none", () => tenantPolicy(NONE), {}, "no", "no"],
    ["a limit above |variance|", () => tenantPolicy(limit("10.00")), {}, "no", "no"],
    ["a limit equal to |variance|", () => tenantPolicy(limit("5.00")), {}, "no", "no"],
    ["a limit below |variance| with no approver", () => tenantPolicy(limit("4.99")), {}, "yes", "yes"],
    ["limit 0 with a zero variance", () => tenantPolicy(limit("0.00")), ZERO_VARIANCE, "no", "no"],
    ["a limit in another currency, compared as frozen", () => ({ policySource: "fallback", policyRevisionId: null, policyValue: limit("1", "USD") }), {}, "yes", "yes"],
    ["the fallback limit 0", () => ({ policySource: "fallback", policyRevisionId: null, policyValue: limit("0.00") }), {}, "yes", "yes"],
  ])("%s", async (_label, frozen, close, required, missing) => {
    if (skipped()) return;
    const { res, stored } = await openAndClose(frozen(), close);
    expect(res.status).toBe(201);
    expectSchema("Shift", res.body);
    expect(res.body.close).toMatchObject({
      approvalRequiredByPolicy: required,
      approvalMissing: missing,
      approverCheck: { status: "not_applicable", reason: null },
    });
    expect(stored).toEqual({ required, missing, verdict: null, verdict_reason: null });
  });

  it("required and approved by a store manager: yes / no, verified and persisted", async () => {
    if (skipped()) return;
    const { res, stored, shiftId, body } = await openAndClose(tenantPolicy(limit("1.00")), { varianceApprovedByUserId: MANAGER.id });
    expect(res.status).toBe(201);
    expectSchema("Shift", res.body);
    expect(res.body.close).toMatchObject({
      approvalRequiredByPolicy: "yes",
      approvalMissing: "no",
      approverCheck: { status: "verified", reason: null },
    });
    expect(stored).toEqual({ required: "yes", missing: "no", verdict: "verified", verdict_reason: null });
    const replay = await post({ path: closePath(shiftId), bearer: DEV_A1.token, body });
    expectReplay(replay);
    expect(replay.body).toEqual(res.body);
  });

  it("an approver who is the closer is unverified (approver_is_closer), never refused", async () => {
    if (skipped()) return;
    const { res, stored } = await openAndClose(tenantPolicy(limit("1.00")), { varianceApprovedByUserId: CASHIER.id });
    expect(res.status).toBe(201);
    expect(res.body.close.approverCheck).toEqual({ status: "unverified", reason: "approver_is_closer" });
    expect(stored).toMatchObject({ verdict: "unverified", verdict_reason: "approver_is_closer" });
  });

  it("an approver recorded on a shift without policy is still checked; the derived values stay unknown", async () => {
    if (skipped()) return;
    const { res } = await openAndClose(undefined, { varianceApprovedByUserId: MANAGER.id });
    expect(res.status).toBe(201);
    expect(res.body.close).toMatchObject({
      approvalRequiredByPolicy: "unknown",
      approvalMissing: "unknown",
      approverCheck: { status: "verified", reason: null },
    });
  });
});
