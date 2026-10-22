/**
 * RT-664 — the AI entitlement `check` (layers 1, 4, 6, 7) and the Option A
 * reserve / commit / release (AD-AI-ENT-001 D-3, D-8) against real Postgres
 * (Testcontainers, every migration incl. 0055) on the NOBYPASSRLS `app_test`
 * pool holding ONLY the RT-664 domain grants on the 0055 tables.
 *
 * RT-644 §5: T1 out-of-plan, T2 over quota, T3 concurrent at the limit, T4
 * upgrade, T5 downgrade, T6 expired trial, T7 cross-tenant (RLS), T10 outage
 * release, T13 idempotent replay, T14 store unreachable, T15 suspended
 * tenant, T17 stuck reservation (sweeper), D-4 mixed store scope, D-8 refused
 * output not charged, and the v1 one-counter-per-request constraint.
 *
 * Every decision body validates against the internal `AiEntitlementDecision`
 * schema of `ai-entitlements.openapi.yaml`.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { listExpiredAiReservations, runWithTenantContext, settleAiReservation } from "@data-pulse-2/db";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { Pool } from "pg";

import { AiEntitlementChecker, type CheckOutcome } from "../../src/ai-entitlements/entitlement-checker";
import { AiEntitlementGrants } from "../../src/ai-entitlements/entitlement-grants";
import { MembershipRepository } from "../../src/context/membership.repository";
import { loadOpenApiContracts } from "../../src/openapi/loader";
import type { PgTestEnv } from "../_helpers/postgres-container";
import {
  ASK_LIMIT,
  BRIEFING_LIMIT,
  counter,
  ctxFor,
  F_ASK,
  F_BRIEFING,
  F_DOCTOR,
  F_NO_METER,
  F_TWO_METERS,
  key,
  ledgerKinds,
  newTenant,
  PLATFORM_ADMIN,
  startAiDb,
  stopAiDb,
  type AiTenant,
} from "./__support__/ai-fixture";

let env: PgTestEnv | null = null;
let checker: AiEntitlementChecker;
let grants: AiEntitlementGrants;

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const contract = loadOpenApiContracts().find((c) => c.id === "ai-entitlements.openapi");
ajv.addSchema(contract!.document as object, "ai");
const validateDecision = ajv.getSchema("ai#/components/schemas/AiEntitlementDecision")!;

function conforms(outcome: CheckOutcome): CheckOutcome {
  if (!validateDecision(outcome.decision)) throw new Error(JSON.stringify(validateDecision.errors));
  return outcome;
}

beforeAll(async () => {
  env = await startAiDb("RT-664 check");
  if (env === null) return;
  checker = new AiEntitlementChecker(env.app, { reservationTtlSeconds: 900 });
  grants = new AiEntitlementGrants(env.app, new MembershipRepository(env.app));
}, 240_000);

afterAll(async () => {
  await stopAiDb(env);
}, 60_000);

const skip = (): boolean => env === null;
const admin = (): Pool => env!.admin;
const actor = { actorUserId: PLATFORM_ADMIN, requestId: null };

async function grant(t: AiTenant, input: Partial<Parameters<AiEntitlementGrants["publishRevision"]>[2]> = {}): Promise<number> {
  const head = await admin().query<{ v: number | null }>(
    `SELECT max(entitlement_version) AS v FROM tenant_ai_entitlements WHERE tenant_id = $1`,
    [t.tenantId],
  );
  const r = await grants.publishRevision(actor, t.tenantId, {
    expectedVersion: head.rows[0]?.v ?? 0,
    state: "active",
    planCode: "ai_assist",
    catalogVersion: 1,
    reason: "RT-664 test grant",
    ...input,
  });
  return r.entitlementVersion;
}

function check(t: AiTenant, input: { featureId?: string; stores?: string[]; units?: number; key?: string } = {}, ctx = ctxFor(t)) {
  return checker
    .check(ctx, {
      featureId: input.featureId ?? F_ASK,
      targetStores: input.stores ?? [],
      unitsEstimate: input.units ?? 1,
      idempotencyKey: input.key ?? key(),
    })
    .then(conforms);
}

function reservationOf(outcome: CheckOutcome): string {
  if (outcome.decision.decision !== "allow") throw new Error(`expected allow, got ${JSON.stringify(outcome.decision)}`);
  return outcome.decision.reservationId;
}

async function useUp(t: AiTenant, n: number, featureId = F_ASK, stores: string[] = []): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const reservationId = reservationOf(await check(t, { featureId, stores }));
    await checker.settle({ tenantId: t.tenantId, reservationId, outcome: "ok" });
  }
}

describe("layer 6 — entitlement", () => {
  it("T1: a feature outside the plan is not_entitled and reserves nothing", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    const v = await grant(t);
    const r = await check(t, { featureId: F_DOCTOR });
    expect(r.decision).toMatchObject({ decision: "deny", reasonCode: "not_entitled", entitlementVersion: v, optOutVersion: 0 });
    expect(await ledgerKinds(admin(), t.tenantId)).toEqual([]);
  });

  it("a tenant with no revision is not_entitled at version 0 (default deny)", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    expect((await check(t)).decision).toMatchObject({ decision: "deny", reasonCode: "not_entitled", entitlementVersion: 0 });
  });

  it("T6: an expired trial is trial_expired; grace is grace_read_only", async () => {
    if (skip()) return;
    const trial = await newTenant(admin());
    await grant(trial, {
      state: "trial",
      effectiveFrom: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      effectiveUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    expect((await check(trial)).decision).toMatchObject({ decision: "deny", reasonCode: "trial_expired" });
    const grace = await newTenant(admin());
    await grant(grace, { state: "grace" });
    expect((await check(grace)).decision).toMatchObject({ decision: "deny", reasonCode: "grace_read_only" });
    expect(await ledgerKinds(admin(), grace.tenantId)).toEqual([]);
  });

  it("T4: an upgrade allows the next request under v+1; earlier rows keep v", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    const v1 = await grant(t);
    const first = await check(t);
    expect(first.decision).toMatchObject({ decision: "allow", entitlementVersion: v1 });
    expect((await check(t, { featureId: F_DOCTOR })).decision).toMatchObject({ reasonCode: "not_entitled" });
    const v2 = await grant(t, { planCode: "ai_ops" });
    expect((await check(t, { featureId: F_DOCTOR })).decision).toMatchObject({ decision: "allow", entitlementVersion: v2 });
    const versions = await admin().query<{ entitlement_version: number }>(
      `SELECT entitlement_version FROM ai_usage_ledger WHERE tenant_id = $1 ORDER BY created_at`,
      [t.tenantId],
    );
    expect(versions.rows.map((r) => r.entitlement_version)).toEqual([v1, v2]);
  });

  it("T5: a downgrade below `used` leaves remaining 0 (never negative); an in-flight request commits under v", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    const v1 = await grant(t);
    await useUp(t, 3);
    const inFlight = reservationOf(await check(t));
    await grant(t, { overrides: [{ featureId: F_ASK, action: "enable", meter: "ask_requests", meterLimitDelta: -4, reason: "downgrade" }] });
    const denied = await check(t);
    expect(denied.decision).toMatchObject({
      decision: "deny",
      reasonCode: "quota_exhausted",
      meter: { limit: 1, used: 3, reserved: 1, remaining: 0 },
    });
    expect(await checker.settle({ tenantId: t.tenantId, reservationId: inFlight, outcome: "ok" })).toEqual({ kind: "committed", applied: true });
    const committed = await admin().query<{ entitlement_version: number }>(
      `SELECT entitlement_version FROM ai_usage_ledger WHERE reservation_id = $1 AND entry_kind = 'committed'`,
      [inFlight],
    );
    expect(committed.rows[0]?.entitlement_version).toBe(v1);
  });

  it("a revision effective only in the future does not apply yet", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grant(t, { effectiveFrom: new Date(Date.now() + 86_400_000).toISOString() });
    expect((await check(t)).decision).toMatchObject({ reasonCode: "not_entitled", entitlementVersion: 0 });
  });
});

describe("layer 1, layer 4 and fail-closed", () => {
  it("T15: a suspended tenant is tenant_inactive before any entitlement read (null versions)", async () => {
    if (skip()) return;
    const t = await newTenant(admin(), "suspended");
    expect((await check(t)).decision).toMatchObject({ decision: "deny", reasonCode: "tenant_inactive", entitlementVersion: null, optOutVersion: null });
  });

  it("D-4: any target store outside the principal's scope refuses the whole request (never narrowed)", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grant(t);
    const scoped = ctxFor(t, { storeAccess: { kind: "specific", storeIds: [t.storeA] } });
    const r = await check(t, { featureId: F_BRIEFING, stores: [t.storeA, t.storeB] }, scoped);
    expect(r.decision).toMatchObject({ decision: "deny", reasonCode: "not_authorized", entitlementVersion: null });
    expect((await check(t, { featureId: F_BRIEFING, stores: [] }, scoped)).decision).toMatchObject({ reasonCode: "not_authorized" });
    expect((await check(t, { featureId: F_BRIEFING, stores: [t.storeA] }, scoped)).decision).toMatchObject({ decision: "allow" });
  });

  it("a platform admin, a token principal or a store of another tenant is not_authorized", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    const other = await newTenant(admin());
    await grant(t);
    expect((await check(t, {}, ctxFor(t, { isPlatformAdmin: true }))).decision).toMatchObject({ reasonCode: "not_authorized" });
    expect((await check(t, {}, ctxFor(t, { source: "token" }))).decision).toMatchObject({ reasonCode: "not_authorized" });
    const r = await check(t, { featureId: F_BRIEFING, stores: [other.storeA] });
    expect(r.decision).toMatchObject({ reasonCode: "not_authorized" });
    expect(await counter(admin(), other.tenantId, "briefings", other.storeA)).toBeNull();
  });

  it("T14: an unreachable store is entitlement_unavailable, never a throw", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    const dead = new Pool({ connectionString: "postgres://nobody:nothing@127.0.0.1:1/none", connectionTimeoutMillis: 500 });
    dead.on("error", () => undefined);
    try {
      const r = await new AiEntitlementChecker(dead, { reservationTtlSeconds: 900 }).check(ctxFor(t), {
        featureId: F_ASK,
        targetStores: [],
        unitsEstimate: 1,
        idempotencyKey: key(),
      });
      expect(conforms(r).decision).toMatchObject({ decision: "deny", reasonCode: "entitlement_unavailable" });
    } finally {
      await dead.end();
    }
  });

  it("v1: a feature with no meter or two meters, or a store meter without exactly one store, fails closed", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grant(t);
    for (const r of [
      await check(t, { featureId: F_NO_METER }),
      await check(t, { featureId: F_TWO_METERS }),
      await check(t, { featureId: F_BRIEFING, stores: [] }),
      await check(t, { featureId: F_BRIEFING, stores: [t.storeA, t.storeB] }),
    ]) {
      expect(r.decision).toMatchObject({ decision: "deny", reasonCode: "entitlement_unavailable" });
    }
    expect(await ledgerKinds(admin(), t.tenantId)).toEqual([]);
  });
});

describe("layer 7 — reserve / commit / release", () => {
  it("T2: at the limit the next request is quota_exhausted with the next UTC reset", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grant(t);
    await useUp(t, ASK_LIMIT);
    const r = await check(t);
    const now = new Date();
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
    expect(r.decision).toMatchObject({
      decision: "deny",
      reasonCode: "quota_exhausted",
      meter: { meter: "ask_requests", window: "month", limit: ASK_LIMIT, used: ASK_LIMIT, reserved: 0, remaining: 0 },
    });
    expect(new Date((r.decision as { meter: { resetsAt: string } }).meter.resetsAt).toISOString()).toBe(nextMonth);
  });

  it("D-9: the UTC window and its reset do not depend on the session TimeZone", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grant(t);
    const uri = new URL(env!.adminUri);
    const ny = new Pool({
      host: uri.hostname,
      port: Number(uri.port),
      database: env!.database,
      user: "app_test",
      password: "app_test",
      options: "-c TimeZone=America/New_York",
    });
    try {
      const r = conforms(
        await new AiEntitlementChecker(ny, { reservationTtlSeconds: 900 }).check(ctxFor(t), {
          featureId: F_ASK,
          targetStores: [],
          unitsEstimate: 1,
          idempotencyKey: key(),
        }),
      );
      const now = new Date();
      const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
      expect(r.decision.decision).toBe("allow");
      expect(new Date((r.decision as { meter: { resetsAt: string } }).meter.resetsAt).toISOString()).toBe(nextMonth);
    } finally {
      await ny.end();
    }
  });

  it("T3: 20 parallel requests at L-1 used: exactly one is allowed and used + reserved = L", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grant(t);
    await useUp(t, ASK_LIMIT - 1);
    const results = await Promise.all(Array.from({ length: 20 }, () => check(t)));
    const allowed = results.filter((r) => r.decision.decision === "allow");
    expect(allowed).toHaveLength(1);
    expect(results.filter((r) => r.decision.decision === "deny" && r.decision.reasonCode === "quota_exhausted")).toHaveLength(19);
    expect(await counter(admin(), t.tenantId, "ask_requests")).toEqual({ used: ASK_LIMIT - 1, reserved: 1 });
  });

  it("a store meter is charged to the store served; a tenant meter once per request", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grant(t);
    await useUp(t, BRIEFING_LIMIT, F_BRIEFING, [t.storeA]);
    expect((await check(t, { featureId: F_BRIEFING, stores: [t.storeA] })).decision).toMatchObject({ reasonCode: "quota_exhausted" });
    expect((await check(t, { featureId: F_BRIEFING, stores: [t.storeB] })).decision).toMatchObject({ decision: "allow" });
    expect(await counter(admin(), t.tenantId, "briefings", t.storeA)).toEqual({ used: BRIEFING_LIMIT, reserved: 0 });
  });

  it("commit charges once; a second settle and a late settle after release change nothing", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grant(t);
    const id = reservationOf(await check(t));
    expect(await counter(admin(), t.tenantId, "ask_requests")).toEqual({ used: 0, reserved: 1 });
    expect(await checker.settle({ tenantId: t.tenantId, reservationId: id, outcome: "ok" })).toEqual({ kind: "committed", applied: true });
    expect(await checker.settle({ tenantId: t.tenantId, reservationId: id, outcome: "ok" })).toEqual({ kind: "committed", applied: false });
    expect(await counter(admin(), t.tenantId, "ask_requests")).toEqual({ used: 1, reserved: 0 });
    const released = reservationOf(await check(t));
    await checker.settle({ tenantId: t.tenantId, reservationId: released, outcome: "not_attempted" });
    expect(await checker.settle({ tenantId: t.tenantId, reservationId: released, outcome: "ok" })).toEqual({ kind: "released", applied: false });
    expect(await counter(admin(), t.tenantId, "ask_requests")).toEqual({ used: 1, reserved: 0 });
  });

  it.each(["provider_unavailable", "output_invalid", "provider_refused", "output_truncated", "input_rejected"])(
    "T10 / D-8: outcome %s releases the reservation and leaves the meter unchanged",
    async (outcome) => {
      if (skip()) return;
      const t = await newTenant(admin());
      await grant(t);
      const id = reservationOf(await check(t));
      expect(await checker.settle({ tenantId: t.tenantId, reservationId: id, outcome })).toEqual({ kind: "released", applied: true });
      expect(await counter(admin(), t.tenantId, "ask_requests")).toEqual({ used: 0, reserved: 0 });
      const row = await admin().query(`SELECT outcome FROM ai_usage_ledger WHERE reservation_id = $1 AND entry_kind = 'released'`, [id]);
      expect(row.rows[0]).toEqual({ outcome });
    },
  );

  it("records the run metadata and reported tokens on the terminal row (AI-09)", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grant(t);
    const id = reservationOf(await check(t));
    await checker.settle({
      tenantId: t.tenantId,
      reservationId: id,
      outcome: "ok",
      telemetry: { routeKey: "r@v1", providerKey: "fake", modelId: "m-1", evidenceRefIds: ["sale:1"], inputTokens: 10, outputTokens: 3, tokenCountSource: "reported" },
    });
    const r = await admin().query(
      `SELECT route_key, provider_key, model_id, evidence_ref_ids, input_tokens::int, output_tokens::int, token_count_source
         FROM ai_usage_ledger WHERE reservation_id = $1 AND entry_kind = 'committed'`,
      [id],
    );
    expect(r.rows[0]).toEqual({
      route_key: "r@v1",
      provider_key: "fake",
      model_id: "m-1",
      evidence_ref_ids: ["sale:1"],
      input_tokens: 10,
      output_tokens: 3,
      token_count_source: "reported",
    });
  });

  it("T13: a replay of the same key is the same reservation, reserved once; another body is refused", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grant(t);
    const k = key();
    const first = await check(t, { key: k });
    const replay = await check(t, { key: k });
    expect(reservationOf(replay)).toBe(reservationOf(first));
    expect(replay.replay).toEqual({ open: true });
    expect(await counter(admin(), t.tenantId, "ask_requests")).toEqual({ used: 0, reserved: 1 });
    expect((await check(t, { key: k, units: 2 })).decision).toMatchObject({ decision: "deny", reasonCode: "entitlement_unavailable" });
    await checker.settle({ tenantId: t.tenantId, reservationId: reservationOf(first), outcome: "ok" });
    const afterCommit = await check(t, { key: k });
    expect(afterCommit.replay).toEqual({ open: false });
    expect(await counter(admin(), t.tenantId, "ask_requests")).toEqual({ used: 1, reserved: 0 });
  });

  it("the same key from another user of the tenant is refused, never the first user's reservation", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grant(t);
    const k = key();
    reservationOf(await check(t, { key: k }));
    const other = ctxFor(t, { userId: "0a000000-0000-7000-8000-0000066400b9" });
    expect((await check(t, { key: k }, other)).decision).toMatchObject({ decision: "deny", reasonCode: "entitlement_unavailable" });
    expect(await counter(admin(), t.tenantId, "ask_requests")).toEqual({ used: 0, reserved: 1 });
  });

  it("parallel replays of one key reserve once", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grant(t);
    const k = key();
    const results = await Promise.all(Array.from({ length: 8 }, () => check(t, { key: k })));
    expect(new Set(results.map(reservationOf)).size).toBe(1);
    expect(await counter(admin(), t.tenantId, "ask_requests")).toEqual({ used: 0, reserved: 1 });
  });
});

describe("T17 — the TTL sweeper", () => {
  it("releases a stuck reservation as reservation_expired; a later commit is not charged", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    await grant(t);
    const shortTtl = new AiEntitlementChecker(env!.app, { reservationTtlSeconds: 1 });
    const id = reservationOf(conforms(await shortTtl.check(ctxFor(t), { featureId: F_ASK, targetStores: [], unitsEstimate: 1, idempotencyKey: key() })));
    const open = reservationOf(await check(t));
    await new Promise((r) => setTimeout(r, 1_200));
    await runWithTenantContext(env!.app, { tenantId: t.tenantId, isPlatformAdmin: false }, async (client) => {
      const expired = await listExpiredAiReservations(client, { tenantId: t.tenantId, lookbackSeconds: 3600, limit: 10 });
      expect(expired).toEqual([id]);
      for (const reservationId of expired) {
        await settleAiReservation(client, { tenantId: t.tenantId, reservationId, outcome: "reservation_expired", entryId: randomUUID() });
      }
    });
    expect(await checker.settle({ tenantId: t.tenantId, reservationId: id, outcome: "ok" })).toEqual({ kind: "released", applied: false });
    expect(await counter(admin(), t.tenantId, "ask_requests")).toEqual({ used: 0, reserved: 1 });
    expect(open).not.toBe(id);
  });
});

describe("T7 — cross-tenant isolation (RLS)", () => {
  it("tenant A's context reads none of tenant B's ledger, counters or revisions, and cannot settle B's reservation", async () => {
    if (skip()) return;
    const a = await newTenant(admin());
    const b = await newTenant(admin());
    await grant(a);
    await grant(b);
    const bReservation = reservationOf(await check(b));
    const seen = await runWithTenantContext(env!.app, { tenantId: a.tenantId, isPlatformAdmin: false }, async (client) => {
      const q = async (table: string) =>
        (await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [b.tenantId])).rows[0].n as number;
      return { ledger: await q("ai_usage_ledger"), counters: await q("ai_usage_counters"), revisions: await q("tenant_ai_entitlements") };
    });
    expect(seen).toEqual({ ledger: 0, counters: 0, revisions: 0 });
    expect(await checker.settle({ tenantId: a.tenantId, reservationId: bReservation, outcome: "ok" })).toBeNull();
    expect(await counter(admin(), b.tenantId, "ask_requests")).toEqual({ used: 0, reserved: 1 });
  });

  it("a locking read of the ledger is refused under these grants, so terminal writes serialise on advisory locks", async () => {
    if (skip()) return;
    const t = await newTenant(admin());
    const lockRead = runWithTenantContext(env!.app, { tenantId: t.tenantId, isPlatformAdmin: false }, (client) =>
      client.query(`SELECT id FROM ai_usage_ledger WHERE tenant_id = $1 FOR UPDATE`, [t.tenantId]),
    );
    await expect(lockRead).rejects.toMatchObject({ code: "42501" });
  });

  it("the runtime role holds no UPDATE, DELETE or TRUNCATE on the ledger and no catalog write", async () => {
    if (skip()) return;
    const r = await admin().query<{ priv: string; granted: boolean }>(
      `SELECT t.tbl || ':' || t.priv AS priv, has_table_privilege('app_test', t.tbl, t.priv) AS granted
         FROM (VALUES ('ai_usage_ledger', 'UPDATE'), ('ai_usage_ledger', 'DELETE'), ('ai_usage_ledger', 'TRUNCATE'),
                      ('ai_plan_catalog', 'INSERT'), ('ai_plan_catalog_features', 'INSERT'), ('ai_usage_counters', 'DELETE'),
                      ('tenant_ai_entitlements', 'UPDATE')) AS t(tbl, priv)`,
    );
    expect(r.rows.filter((row) => row.granted)).toEqual([]);
  });
});
