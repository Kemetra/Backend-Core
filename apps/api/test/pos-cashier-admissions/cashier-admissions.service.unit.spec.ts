/**
 * RT-113 BC2 — CashierAdmissionsService decision table (Docker-free).
 *
 * Drives the service through fakes of its ports and pins the contract's
 * outcome order for `posCreateCashierAdmission`:
 *
 *   (401 is the guard's) → 409 key reuse → 429 takeover rate limit →
 *   403 eligibility → replay → active_elsewhere → admitted
 *
 * and which side effects each outcome may have (only `admitted` writes; a
 * replay writes nothing; only a fresh takeover consults the rate limiter).
 *
 * RT-219: every `admitted` carries the record's `admission_generation`; `end`
 * passes the echoed generation to the store and audits a stale one as a
 * no-op; a replay entry stored before RT-219 gets a generation that never
 * matches.
 */
import type { PoolClient } from "pg";

import {
  CashierAdmissionsService,
  PRE_GENERATION_REPLAY,
  type AdmissionPorts,
  type AdmissionStore,
  type StoredRequest,
} from "../../src/pos-cashier-admissions/cashier-admissions.service";
import type { CashierAdmissionPolicy } from "../../src/pos-cashier-admissions/cashier-admissions.config";
import { requestFingerprint } from "../../src/pos-cashier-admissions/admission-request";
import type { AdmissionRequestInput } from "../../src/pos-cashier-admissions/dto";
import type { Eligibility } from "../../src/pos-cashier-admissions/cashier-eligibility";

const SCOPE = {
  deviceId: "0190f5a2-3b4c-7d8e-9f01-00000000d001",
  tenantId: "0190f5a2-3b4c-7d8e-9f01-00000000a001",
  storeId: "0190f5a2-3b4c-7d8e-9f01-00000000b001",
};
const OTHER_DEVICE = "0190f5a2-3b4c-7d8e-9f01-00000000d002";
const USER = "0190f5a2-3b4c-7d8e-9f01-00000000c001";
const LIVE_ID = "0190f5a2-3b4c-7d8e-9f01-00000000e001";
const NEW_ID = "0190f5a2-3b4c-7d8e-9f01-00000000e002";
const KEY = "pos-pulse:4f6f1c1e-8a52-4c1b-9a0e-6d1f2b3c4d5e";
const NOW = new Date("2026-10-04T08:15:01.000Z");
/** Opaque generations the fake store issues (RT-219). */
const GEN_CREATED = "1791123301000001";
const GEN_RENEWED = "1791123301000002";
const GEN_STORED = "1791119200000000";
const POLICY: CashierAdmissionPolicy = {
  admissionTtlSeconds: 43200,
  offlineGraceSeconds: 86400,
  takeoverLimit: { limit: 10, windowMs: 3_600_000 },
};
const ELIGIBLE: Eligibility = { eligible: true, displayName: "Mona A.", operatorId: "user_2abc" };
const INELIGIBLE: Eligibility = { eligible: false, reason: "role_ineligible" };

const CLIENT = {} as PoolClient;

function onlineBody(extra: Partial<AdmissionRequestInput> = {}): AdmissionRequestInput {
  return { mode: "online", user_id: USER, idempotency_key: KEY, ...extra } as AdmissionRequestInput;
}

function reconcileBody(): AdmissionRequestInput {
  return {
    mode: "reconcile_offline",
    user_id: USER,
    offline_admitted_at: "2026-10-04T08:00:00Z",
    idempotency_key: KEY,
  };
}

const STORED_BODY = {
  kind: "admitted" as const,
  admission_id: LIVE_ID,
  offline_grace_seconds: 86400,
  admission_ttl_seconds: 43200,
  server_time: "2026-10-04T07:00:00.000Z",
  display_name: "Mona A.",
  admission_generation: GEN_STORED,
};

interface World {
  prior: StoredRequest | null;
  priorLiveOnDevice: boolean;
  allowTakeover: boolean;
  eligibility: Eligibility;
  live: { id: string; deviceId: string } | null;
}

function world(overrides: Partial<World> = {}): World {
  return {
    prior: null,
    priorLiveOnDevice: false,
    allowTakeover: true,
    eligibility: ELIGIBLE,
    live: null,
    ...overrides,
  };
}

function build(w: World) {
  const calls: string[] = [];
  const track = <T>(name: string, value: T) =>
    jest.fn(async (..._args: unknown[]) => {
      calls.push(name);
      return value;
    });
  const store = {
    lockRequestKey: track("lockRequestKey", undefined),
    findRequest: track("findRequest", w.prior),
    lockCashier: track("lockCashier", undefined),
    clock: track("clock", NOW),
    expireStale: track("expireStale", [] as Array<{ id: string; deviceId: string }>),
    isLiveOnDevice: track("isLiveOnDevice", w.priorLiveOnDevice),
    findLive: track("findLive", w.live),
    create: track("create", { id: NEW_ID, renewedAt: NOW, generation: GEN_CREATED }),
    renew: track("renew", { id: LIVE_ID, renewedAt: NOW, generation: GEN_RENEWED }),
    end: track("end", undefined),
    saveRequest: track("saveRequest", undefined),
    findOwned: track("findOwned", null),
    endOwned: track("endOwned", "not_live"),
  } as unknown as jest.Mocked<AdmissionStore>;
  const ports: AdmissionPorts = {
    tx: async (_tenantId, work) => work(CLIENT),
    admissions: store,
    eligibility: {
      check: track("eligibility.check", w.eligibility),
      roster: track("eligibility.roster", []),
    },
    takeoverLimit: { allow: track("takeoverLimit.allow", w.allowTakeover) },
    audit: { record: track("audit.record", undefined) },
    logger: { warn: jest.fn() },
    policy: () => POLICY,
  };
  return { service: new CashierAdmissionsService(ports), store, ports, calls };
}

function storedRequest(body: AdmissionRequestInput): StoredRequest {
  return { requestHash: requestFingerprint(body), admissionId: LIVE_ID, responseBody: STORED_BODY };
}

// ===========================================================================
// Outcome order
// ===========================================================================
describe("CashierAdmissionsService.admit — outcome order", () => {
  it("409 wins over everything after auth (key reuse with a different body)", async () => {
    const { service, calls } = build(
      world({
        prior: storedRequest(onlineBody({ takeover: true })),
        allowTakeover: false,
        eligibility: INELIGIBLE,
        live: { id: LIVE_ID, deviceId: OTHER_DEVICE },
      }),
    );
    const out = await service.admit(SCOPE, onlineBody(), "req-1");
    expect(out).toEqual({ kind: "idempotency_conflict" });
    expect(calls).not.toContain("takeoverLimit.allow");
    expect(calls).not.toContain("eligibility.check");
  });

  it("429 precedes eligibility (an over-limit takeover by an ineligible user)", async () => {
    const { service, calls } = build(world({ allowTakeover: false, eligibility: INELIGIBLE }));
    const out = await service.admit(SCOPE, onlineBody({ takeover: true }), "req-1");
    expect(out).toEqual({ kind: "rate_limited" });
    expect(calls).not.toContain("eligibility.check");
    expect(calls).not.toContain("create");
  });

  it("403 precedes active_elsewhere (a revoked user never sees active_elsewhere)", async () => {
    const { service, store, calls } = build(
      world({ eligibility: INELIGIBLE, live: { id: LIVE_ID, deviceId: OTHER_DEVICE } }),
    );
    const out = await service.admit(SCOPE, onlineBody(), "req-1");
    expect(out).toEqual({ kind: "refused" });
    expect(calls).not.toContain("findLive");
    expect(store.create).not.toHaveBeenCalled();
    expect(store.saveRequest).not.toHaveBeenCalled();
  });

  it("a refusal is audited with the category and logged by request_id only", async () => {
    const { service, ports } = build(world({ eligibility: INELIGIBLE }));
    await service.admit(SCOPE, onlineBody(), "req-9");
    expect(ports.audit.record).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({
        action: "pos.cashier_admission.refused",
        actorUserId: null,
        requestId: "req-9",
        metadata: { device_id: SCOPE.deviceId, user_id: USER, category: "role_ineligible" },
      }),
    );
    expect(ports.logger.warn).toHaveBeenCalledWith(
      { request_id: "req-9", refusal: "role_ineligible" },
      expect.any(String),
    );
  });

  it("active_elsewhere when another device holds the live admission (no takeover)", async () => {
    const { service, store, ports } = build(world({ live: { id: LIVE_ID, deviceId: OTHER_DEVICE } }));
    const out = await service.admit(SCOPE, onlineBody(), "req-1");
    expect(out).toEqual({ kind: "active_elsewhere" });
    expect(store.create).not.toHaveBeenCalled();
    expect(store.end).not.toHaveBeenCalled();
    expect(store.saveRequest).not.toHaveBeenCalled();
    expect(ports.audit.record).not.toHaveBeenCalled();
  });

  it("reconcile_offline never takes over: live elsewhere → active_elsewhere", async () => {
    const { service, store, calls } = build(world({ live: { id: LIVE_ID, deviceId: OTHER_DEVICE } }));
    const out = await service.admit(SCOPE, reconcileBody(), "req-1");
    expect(out).toEqual({ kind: "active_elsewhere" });
    expect(store.end).not.toHaveBeenCalled();
    expect(calls).not.toContain("takeoverLimit.allow");
  });
});

// ===========================================================================
// admitted variants
// ===========================================================================
describe("CashierAdmissionsService.admit — admitted", () => {
  const expected = (id: string, generation: string) => ({
    kind: "admitted",
    body: {
      kind: "admitted",
      admission_id: id,
      offline_grace_seconds: 86400,
      admission_ttl_seconds: 43200,
      server_time: NOW.toISOString(),
      display_name: "Mona A.",
      admission_generation: generation,
    },
  });

  it("no live admission → create; the request is recorded for replay", async () => {
    const { service, store, ports } = build(world());
    const out = await service.admit(SCOPE, onlineBody(), "req-1");
    expect(out).toEqual(expected(NEW_ID, GEN_CREATED));
    expect(store.create).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({ userId: USER, mode: "online", takeoverOf: null, ttlSeconds: 43200, at: NOW }),
    );
    expect(store.saveRequest).toHaveBeenCalledWith(
      CLIENT,
      SCOPE,
      expect.objectContaining({ admissionId: NEW_ID, ttlSeconds: 43200, at: NOW }),
    );
    expect(ports.audit.record).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({ action: "pos.cashier_admission.admitted", targetId: NEW_ID }),
    );
  });

  it("live on this device → renew the SAME admission (heartbeat)", async () => {
    const { service, store } = build(world({ live: { id: LIVE_ID, deviceId: SCOPE.deviceId } }));
    const out = await service.admit(SCOPE, onlineBody(), "req-1");
    expect(out).toEqual(expected(LIVE_ID, GEN_RENEWED));
    expect(store.renew).toHaveBeenCalledWith(CLIENT, SCOPE, { admissionId: LIVE_ID, at: NOW }, 43200);
    expect(store.create).not.toHaveBeenCalled();
  });

  it("live elsewhere + takeover → end it ('takeover') and create with takeover_of", async () => {
    const { service, store, ports } = build(world({ live: { id: LIVE_ID, deviceId: OTHER_DEVICE } }));
    const out = await service.admit(SCOPE, onlineBody({ takeover: true }), "req-1");
    expect(out).toEqual(expected(NEW_ID, GEN_CREATED));
    expect(store.end).toHaveBeenCalledWith(CLIENT, SCOPE, { admissionId: LIVE_ID, at: NOW }, "takeover");
    expect(store.create).toHaveBeenCalledWith(CLIENT, expect.objectContaining({ takeoverOf: LIVE_ID }));
    expect(ports.audit.record).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({
        action: "pos.cashier_admission.takeover",
        metadata: expect.objectContaining({ prior_admission_id: LIVE_ID, device_id: SCOPE.deviceId }),
      }),
    );
  });

  it("reconcile with no live admission → create with mode and provenance", async () => {
    const { service, store } = build(world());
    await service.admit(SCOPE, reconcileBody(), "req-1");
    expect(store.create).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({ mode: "reconcile_offline", offlineAdmittedAt: "2026-10-04T08:00:00Z" }),
    );
  });

  it("expired live rows ended by the lazy expiry are audited", async () => {
    const { service, store, ports } = build(world());
    store.expireStale.mockResolvedValueOnce([{ id: LIVE_ID, deviceId: OTHER_DEVICE }]);
    await service.admit(SCOPE, onlineBody(), "req-1");
    expect(ports.audit.record).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({
        action: "pos.cashier_admission.expired",
        targetId: LIVE_ID,
        // The device that held the expired admission, not the requester.
        metadata: { device_id: OTHER_DEVICE, user_id: USER, prior_admission_id: LIVE_ID },
      }),
    );
  });

  it("serialises: both locks, then ONE clock reading, then lazy expiry, before any decision", async () => {
    const { service, calls } = build(world());
    await service.admit(SCOPE, onlineBody(), "req-1");
    const order = [
      "lockRequestKey",
      "lockCashier",
      "clock",
      "findRequest",
      "expireStale",
      "eligibility.check",
      "findLive",
      "create",
    ];
    expect(calls.filter((c) => order.includes(c))).toEqual(order);
  });
});

// ===========================================================================
// replay
// ===========================================================================
describe("CashierAdmissionsService.admit — replay", () => {
  it("same body + admission live on this device + eligible → the stored 200, no writes", async () => {
    const body = onlineBody({ takeover: true });
    const { service, store, ports, calls } = build(
      world({ prior: storedRequest(body), priorLiveOnDevice: true, allowTakeover: false }),
    );
    const out = await service.admit(SCOPE, body, "req-1");
    expect(out).toEqual({ kind: "admitted", body: STORED_BODY });
    expect(calls).not.toContain("takeoverLimit.allow");
    expect(calls).toContain("eligibility.check");
    expect(store.create).not.toHaveBeenCalled();
    expect(store.renew).not.toHaveBeenCalled();
    expect(store.saveRequest).not.toHaveBeenCalled();
    expect(ports.audit.record).not.toHaveBeenCalled();
  });

  it("replay candidate but the user is no longer eligible → 403", async () => {
    const body = onlineBody();
    const { service } = build(world({ prior: storedRequest(body), priorLiveOnDevice: true, eligibility: INELIGIBLE }));
    expect(await service.admit(SCOPE, body, "req-1")).toEqual({ kind: "refused" });
  });

  it("stored admission no longer live → evaluated as new", async () => {
    const body = onlineBody();
    const { service, store } = build(world({ prior: storedRequest(body), priorLiveOnDevice: false }));
    const out = await service.admit(SCOPE, body, "req-1");
    expect(out).toMatchObject({ kind: "admitted", body: { admission_id: NEW_ID } });
    expect(store.create).toHaveBeenCalled();
  });

  it("a takeover that is not a replay consults the limiter", async () => {
    const { service, ports } = build(world());
    await service.admit(SCOPE, onlineBody({ takeover: true }), "req-1");
    expect(ports.takeoverLimit.allow).toHaveBeenCalledWith(SCOPE.deviceId, POLICY.takeoverLimit);
  });

  it("a non-takeover request never consults the limiter", async () => {
    const { service, ports } = build(world({ allowTakeover: false }));
    const out = await service.admit(SCOPE, onlineBody(), "req-1");
    expect(out.kind).toBe("admitted");
    expect(ports.takeoverLimit.allow).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// end and roster
// ===========================================================================
describe("CashierAdmissionsService.end", () => {
  it("own live admission → locked, ended and audited with the user", async () => {
    const { service, store, ports } = build(world());
    store.findOwned.mockResolvedValueOnce({ id: LIVE_ID, userId: USER });
    store.endOwned.mockResolvedValueOnce("ended");
    await service.end(SCOPE, { admissionId: LIVE_ID, generation: null }, "req-1");
    expect(store.lockCashier.mock.invocationCallOrder[0]).toBeLessThan(
      store.endOwned.mock.invocationCallOrder[0]!,
    );
    expect(ports.audit.record).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({
        action: "pos.cashier_admission.ended",
        actorUserId: USER,
        metadata: { device_id: SCOPE.deviceId, user_id: USER, prior_admission_id: LIVE_ID, changed: true },
      }),
    );
  });

  it("unknown or foreign admission → nothing ended; audited without a user", async () => {
    const { service, store, ports } = build(world());
    await service.end(SCOPE, { admissionId: LIVE_ID, generation: null }, "req-1");
    expect(store.endOwned).not.toHaveBeenCalled();
    expect(ports.audit.record).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({
        actorUserId: null,
        metadata: { device_id: SCOPE.deviceId, prior_admission_id: LIVE_ID, changed: false },
      }),
    );
  });
});

describe("CashierAdmissionsService.roster", () => {
  it("returns the eligibility reader's roster for the device scope", async () => {
    const { service, ports } = build(world());
    const entries = [{ user_id: USER, operator_id: "user_2abc", display_name: "Mona A." }];
    (ports.eligibility.roster as jest.Mock).mockResolvedValueOnce(entries);
    expect(await service.roster(SCOPE)).toEqual({ cashiers: entries });
    expect(ports.eligibility.roster).toHaveBeenCalledWith(CLIENT, SCOPE);
  });
});

describe("CashierAdmissionsService — one clock reading per request", () => {
  it("every comparison and write in admit uses the post-lock clock reading", async () => {
    const { service, store } = build(world({ live: { id: LIVE_ID, deviceId: OTHER_DEVICE } }));
    await service.admit(SCOPE, onlineBody({ takeover: true }), "req-1");
    expect(store.clock).toHaveBeenCalledTimes(1);
    expect(store.findRequest).toHaveBeenCalledWith(CLIENT, SCOPE, expect.objectContaining({ at: NOW }));
    expect(store.expireStale).toHaveBeenCalledWith(CLIENT, SCOPE, { userId: USER, at: NOW });
    expect(store.end).toHaveBeenCalledWith(CLIENT, SCOPE, { admissionId: LIVE_ID, at: NOW }, "takeover");
    expect(store.create).toHaveBeenCalledWith(CLIENT, expect.objectContaining({ at: NOW }));
    expect(store.saveRequest).toHaveBeenCalledWith(CLIENT, SCOPE, expect.objectContaining({ at: NOW }));
  });

  it("end reads the clock after the cashier lock and ends at that instant", async () => {
    const { service, store } = build(world());
    store.findOwned.mockResolvedValueOnce({ id: LIVE_ID, userId: USER });
    store.endOwned.mockResolvedValueOnce("ended");
    await service.end(SCOPE, { admissionId: LIVE_ID, generation: null }, "req-1");
    expect(store.lockCashier.mock.invocationCallOrder[0]).toBeLessThan(store.clock.mock.invocationCallOrder[0]!);
    expect(store.endOwned).toHaveBeenCalledWith(CLIENT, SCOPE, { admissionId: LIVE_ID, at: NOW, generation: null });
  });
});

// ===========================================================================
// RT-219: the end generation guard
// ===========================================================================
describe("CashierAdmissionsService.end — generation guard (RT-219)", () => {
  it("passes the echoed generation to the store, under the cashier lock", async () => {
    const { service, store } = build(world());
    store.findOwned.mockResolvedValueOnce({ id: LIVE_ID, userId: USER });
    store.endOwned.mockResolvedValueOnce("ended");
    const out = await service.end(SCOPE, { admissionId: LIVE_ID, generation: GEN_RENEWED }, "req-1");
    expect(out).toEqual({ kind: "ended" });
    expect(store.endOwned).toHaveBeenCalledWith(CLIENT, SCOPE, { admissionId: LIVE_ID, at: NOW, generation: GEN_RENEWED });
    expect(store.lockCashier.mock.invocationCallOrder[0]).toBeLessThan(store.endOwned.mock.invocationCallOrder[0]!);
  });

  it("a stale generation answers the same `ended` and audits a no-op naming the cause", async () => {
    const { service, store, ports } = build(world());
    store.findOwned.mockResolvedValueOnce({ id: LIVE_ID, userId: USER });
    store.endOwned.mockResolvedValueOnce("stale_generation");
    const out = await service.end(SCOPE, { admissionId: LIVE_ID, generation: GEN_CREATED }, "req-7");
    expect(out).toEqual({ kind: "ended" });
    expect(ports.audit.record).toHaveBeenCalledTimes(1);
    expect(ports.audit.record).toHaveBeenCalledWith(CLIENT, {
      scope: SCOPE,
      action: "pos.cashier_admission.ended",
      actorUserId: USER,
      targetId: LIVE_ID,
      requestId: "req-7",
      metadata: {
        device_id: SCOPE.deviceId,
        user_id: USER,
        prior_admission_id: LIVE_ID,
        changed: false,
        stale_generation: true,
      },
    });
  });

  it("an admission that stopped being live before the lock is a plain no-op", async () => {
    const { service, store, ports } = build(world());
    store.findOwned.mockResolvedValueOnce({ id: LIVE_ID, userId: USER });
    store.endOwned.mockResolvedValueOnce("not_live");
    await service.end(SCOPE, { admissionId: LIVE_ID, generation: GEN_RENEWED }, "req-1");
    expect(ports.audit.record).toHaveBeenCalledWith(
      CLIENT,
      expect.objectContaining({
        actorUserId: null,
        metadata: { device_id: SCOPE.deviceId, prior_admission_id: LIVE_ID, changed: false },
      }),
    );
  });
});

describe("CashierAdmissionsService.admit — replay generation (RT-219)", () => {
  it("a replay returns the generation it was issued with, not a newer one", async () => {
    const body = onlineBody();
    const { service, store } = build(world({ prior: storedRequest(body), priorLiveOnDevice: true }));
    const out = await service.admit(SCOPE, body, "req-1");
    expect(out).toEqual({ kind: "admitted", body: STORED_BODY });
    expect(store.renew).not.toHaveBeenCalled();
  });

  it("a replay entry stored before RT-219 gets a generation that never matches", async () => {
    const body = onlineBody();
    const { admission_generation: _dropped, ...legacy } = STORED_BODY;
    const prior = { ...storedRequest(body), responseBody: legacy } as unknown as StoredRequest;
    const { service } = build(world({ prior, priorLiveOnDevice: true }));
    const out = await service.admit(SCOPE, body, "req-1");
    expect(out).toEqual({ kind: "admitted", body: { ...legacy, admission_generation: PRE_GENERATION_REPLAY } });
    expect(PRE_GENERATION_REPLAY).toMatch(/^[\x21-\x7E]{1,64}$/);
  });
});
