/**
 * RT-155 — per-resource replay keys (RT-82 K1), the transitional legacy-key
 * probe (K2) and non-replayable secret responses (K3).
 *
 * Docker-free: FakeRedis plus an in-memory Postgres mirror with the real
 * claim / complete / find semantics, so both replay sources are exercised.
 * The real routes (sales, inventory, connector rotate/revoke) are covered by
 * the db-integration specs that sit next to their harnesses.
 */
import "reflect-metadata";
import {
  Controller,
  HttpCode,
  Param,
  Post,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";

import {
  IdempotencyKeyStore,
  IdempotencyMirrorConflict,
  type IdempotencyEntry,
  type StoredResult,
} from "@data-pulse-2/shared";

import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import type { ResolvedContext } from "../../src/context/types";
import {
  IDEMPOTENCY_KEY_STORE,
  IdempotencyInterceptor,
  bodyFingerprint,
} from "../../src/idempotency/idempotency.interceptor";
import { Idempotent } from "../../src/idempotency/idempotent.decorator";
import { InProgressMarker } from "../../src/idempotency/in-progress-marker";
import {
  isNonReplayableMarker,
  nonReplayableMarker,
} from "../../src/idempotency/non-replayable";
import { composeStoreKey, paramsSegment } from "../../src/idempotency/store-key";
import * as apiMetrics from "../../src/observability/metrics/api.metrics";

const TENANT = "0a000000-0000-7000-8000-000000155a01";
const USER = "0a000000-0000-7000-8000-000000155b01";
const KEY = "rt155-key-000000000000000000000001";
const BASE = "/api/test/rt155";
const ACT_TEMPLATE = `${BASE}/things/:ref/act`;
const ROTATE_TEMPLATE = `${BASE}/instances/:id/rotate`;
const SECRET_PREFIX = "synthetic-rt155-secret";

class FakeRedis {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.map.set(key, value);
    return "OK";
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
  values(): string[] {
    return [...this.map.values()];
  }
  clear(): void {
    this.map.clear();
  }
}

interface MirrorRow {
  fingerprint: Buffer;
  result: StoredResult;
  expiresAt: Date;
}

/** In-memory stand-in for PgIdempotencyMirror (claim → complete → find). */
class MemoryMirror {
  readonly rows = new Map<string, MirrorRow>();
  private id(r: { tenantId: string; storeId: string | null; clientId: string; key: string }): string {
    return `${r.tenantId}|${r.storeId ?? "null"}|${r.clientId}|${r.key}`;
  }
  async claim(r: {
    tenantId: string;
    storeId: string | null;
    clientId: string;
    key: string;
    fingerprint: Buffer;
    expiresAt: Date;
  }): Promise<void> {
    const existing = this.rows.get(this.id(r));
    if (existing && existing.expiresAt > new Date()) throw new IdempotencyMirrorConflict();
    this.rows.set(this.id(r), {
      fingerprint: r.fingerprint,
      result: { status: 0, body: { __dp2IdempotencyClaim: true } },
      expiresAt: r.expiresAt,
    });
  }
  async release(r: { tenantId: string; storeId: string | null; clientId: string; key: string }): Promise<void> {
    if (this.rows.get(this.id(r))?.result.status === 0) this.rows.delete(this.id(r));
  }
  async insert(r: {
    tenantId: string;
    storeId: string | null;
    clientId: string;
    key: string;
    fingerprint: Buffer;
    result: StoredResult;
    expiresAt: Date;
  }): Promise<void> {
    this.rows.set(this.id(r), { fingerprint: r.fingerprint, result: r.result, expiresAt: r.expiresAt });
  }
  async find(r: { tenantId: string; storeId: string | null; clientId: string; key: string }): Promise<IdempotencyEntry | null> {
    return this.rows.get(this.id(r)) ?? null;
  }
  serialized(): string {
    return JSON.stringify([...this.rows.values()].map((row) => row.result));
  }
}

const CALLS = new Map<string, number>();
function bump(name: string): number {
  const n = (CALLS.get(name) ?? 0) + 1;
  CALLS.set(name, n);
  return n;
}

@Controller(BASE)
class Rt155Controller {
  @Post("things/:ref/act")
  @HttpCode(202)
  @Idempotent("required")
  act(@Param("ref") ref: string): { ref: string; run: number } {
    return { ref, run: bump(`act:${ref}`) };
  }

  @Post("plain")
  @Idempotent("required")
  plain(): { run: number } {
    return { run: bump("plain") };
  }

  @Post("instances/:id/rotate")
  @Idempotent("required", { replay: "forbid", replayMarkerFields: ["credential_id"] })
  rotate(@Param("id") id: string): { credential_id: string; instance_id: string; secret: string } {
    const run = bump(`rotate:${id}`);
    return { credential_id: `cred-${id}-${run}`, instance_id: id, secret: `${SECRET_PREFIX}-${id}-${run}` };
  }

  @Post("instances/:id/reset")
  @Idempotent("required", { replay: "forbid" })
  reset(@Param("id") id: string): { secret: string } {
    return { secret: `${SECRET_PREFIX}-reset-${id}-${bump(`reset:${id}`)}` };
  }
}

class ContextGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ context?: ResolvedContext; principal?: object }>();
    req.context = { userId: USER, tenantId: TENANT, storeId: null, isPlatformAdmin: false, source: "session" };
    req.principal = { userId: USER };
    return true;
  }
}

class FakeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {}
}

async function buildApp(store: unknown): Promise<INestApplication> {
  const interceptor = new IdempotencyInterceptor(
    new Reflector(),
    store as IdempotencyKeyStore,
    new FakeMarker() as unknown as InProgressMarker,
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [Rt155Controller],
    providers: [
      { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
      { provide: APP_INTERCEPTOR, useValue: interceptor },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalGuards(new ContextGuard());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
  return app;
}

const EXPIRES = (): Date => new Date(Date.now() + 72 * 60 * 60 * 1000);

describe("RT-155 K1 — store-key composition", () => {
  it("pins the key of a route without params as byte-identical to the pre-RT-155 format", () => {
    const expected = `POST:/api/v1/memberships/invite:${USER}:${KEY}`;
    expect(composeStoreKey("POST", "/api/v1/memberships/invite", USER, KEY)).toBe(expected);
    expect(composeStoreKey("POST", "/api/v1/memberships/invite", USER, KEY, {})).toBe(expected);
    expect(composeStoreKey("POST", "/api/v1/memberships/invite", USER, KEY, undefined)).toBe(expected);
  });

  it("appends the canonical, sorted params on a param route", () => {
    expect(composeStoreKey("POST", "/s/:b/:a", USER, KEY, { b: "2", a: "1" })).toBe(
      `POST:/s/:b/:a:{"a":"1","b":"2"}:${USER}:${KEY}`,
    );
    expect(paramsSegment({ id: undefined })).toBe("");
  });
});

describe("RT-155 — interceptor over a FakeRedis + in-memory pg mirror", () => {
  let app: INestApplication;
  let redis: FakeRedis;
  let mirror: MemoryMirror;
  let store: IdempotencyKeyStore;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    redis = new FakeRedis();
    mirror = new MemoryMirror();
    store = new IdempotencyKeyStore({
      redis,
      pgWriter: mirror,
      pgReader: mirror,
      defaultTtlMs: 72 * 60 * 60 * 1000,
    });
    app = await buildApp(store);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    CALLS.clear();
    redis.clear();
    mirror.rows.clear();
  });

  it("AC5: a route without params stores under the unchanged key string", async () => {
    await http().post(`${BASE}/plain`).set("Idempotency-Key", KEY).send({}).expect(201);
    expect(redis.keys()).toEqual([
      `idempotency:${TENANT}:null:${USER}:POST:${BASE}/plain:${USER}:${KEY}`,
    ]);
  });

  it("AC1: the same key + body on a different resource runs that resource's handler", async () => {
    const a = await http().post(`${BASE}/things/A/act`).set("Idempotency-Key", KEY).send({ n: 1 }).expect(202);
    const b = await http().post(`${BASE}/things/B/act`).set("Idempotency-Key", KEY).send({ n: 1 }).expect(202);
    expect(a.body).toEqual({ ref: "A", run: 1 });
    expect(b.body).toEqual({ ref: "B", run: 1 });
    expect(b.headers["idempotent-replayed"]).toBeUndefined();
    expect(CALLS.get("act:A")).toBe(1);
    expect(CALLS.get("act:B")).toBe(1);
  });

  it("AC4 + AC8: same-resource replay keeps the stored status, and metric labels stay the template", async () => {
    const replaySpy = jest.spyOn(apiMetrics, "recordIdempotencyReplay");
    await http().post(`${BASE}/things/A/act`).set("Idempotency-Key", KEY).send({ n: 1 }).expect(202);
    const again = await http().post(`${BASE}/things/A/act`).set("Idempotency-Key", KEY).send({ n: 1 }).expect(202);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.body).toEqual({ ref: "A", run: 1 });
    expect(CALLS.get("act:A")).toBe(1);
    expect(replaySpy).toHaveBeenCalledWith({ route: `POST:${ACT_TEMPLATE}` });
    for (const [labels] of replaySpy.mock.calls) {
      expect(labels.route).not.toContain("/things/A/");
    }
  });

  describe("K2 — legacy template-only key probe", () => {
    const legacyKey = composeStoreKey("POST", ACT_TEMPLATE, USER, KEY);

    it("AC7: a completed legacy row (same body) → 409, neither replayed nor executed", async () => {
      const conflictSpy = jest.spyOn(apiMetrics, "recordIdempotencyConflict");
      await store.save(TENANT, null, USER, legacyKey, bodyFingerprint({ n: 1 }), { status: 202, body: { ref: "A", run: 9 } }, EXPIRES());
      const res = await http().post(`${BASE}/things/B/act`).set("Idempotency-Key", KEY).send({ n: 1 }).expect(409);
      expect(res.body.error.code).toBe("idempotency_key_conflict");
      expect(res.headers["idempotent-replayed"]).toBeUndefined();
      expect(CALLS.get("act:B")).toBeUndefined();
      expect(conflictSpy).toHaveBeenCalledWith({ route: `POST:${ACT_TEMPLATE}` });
    });

    it("a legacy row with a different body → 409 as well", async () => {
      await store.save(TENANT, null, USER, legacyKey, bodyFingerprint({ other: true }), { status: 202, body: {} }, EXPIRES());
      const res = await http().post(`${BASE}/things/A/act`).set("Idempotency-Key", KEY).send({ n: 1 }).expect(409);
      expect(res.body.error.code).toBe("idempotency_key_conflict");
      expect(CALLS.get("act:A")).toBeUndefined();
    });

    it("a legacy in-flight claim → 409 (never executed alongside it)", async () => {
      await mirror.claim({ tenantId: TENANT, storeId: null, clientId: USER, key: legacyKey, fingerprint: bodyFingerprint({ n: 1 }), expiresAt: EXPIRES() });
      await http().post(`${BASE}/things/A/act`).set("Idempotency-Key", KEY).send({ n: 1 }).expect(409);
      expect(CALLS.get("act:A")).toBeUndefined();
    });

    it("a legacy rotate row holding a secret is never replayed", async () => {
      const legacyRotate = composeStoreKey("POST", ROTATE_TEMPLATE, USER, KEY);
      const legacySecret = `${SECRET_PREFIX}-legacy`;
      await store.save(TENANT, null, USER, legacyRotate, bodyFingerprint({}), { status: 201, body: { secret: legacySecret } }, EXPIRES());
      const res = await http().post(`${BASE}/instances/A/rotate`).set("Idempotency-Key", KEY).send({}).expect(409);
      expect(JSON.stringify(res.body).includes(legacySecret)).toBe(false);
      expect(CALLS.get("rotate:A")).toBeUndefined();
    });
  });

  describe("K3 — replay: forbid", () => {
    it("AC6: stores only the status + allowlisted marker, never the secret (Redis and pg)", async () => {
      const first = await http().post(`${BASE}/instances/A/rotate`).set("Idempotency-Key", KEY).send({}).expect(201);
      const secret = first.body.secret as string;
      expect(secret.startsWith(SECRET_PREFIX)).toBe(true);

      expect(redis.values().some((v) => v.includes(secret))).toBe(false);
      expect(mirror.serialized().includes(secret)).toBe(false);
      const stored = JSON.parse(redis.values()[0]!) as { status: number; body: unknown };
      expect(stored.status).toBe(201);
      expect(stored.body).toEqual({ __dp2NonReplayable: true, credential_id: "cred-A-1" });
    });

    it("AC6: a same-key retry → 409 without the secret, and the handler does not run again", async () => {
      const first = await http().post(`${BASE}/instances/A/rotate`).set("Idempotency-Key", KEY).send({}).expect(201);
      const retry = await http().post(`${BASE}/instances/A/rotate`).set("Idempotency-Key", KEY).send({}).expect(409);
      expect(retry.body.error.code).toBe("idempotency_key_conflict");
      expect(retry.headers["idempotent-replayed"]).toBeUndefined();
      expect(JSON.stringify(retry.body).includes(first.body.secret as string)).toBe(false);
      expect(CALLS.get("rotate:A")).toBe(1);
    });

    it("the Postgres copy is non-replayable too (Redis lost)", async () => {
      await http().post(`${BASE}/instances/A/rotate`).set("Idempotency-Key", KEY).send({}).expect(201);
      redis.clear();
      await http().post(`${BASE}/instances/A/rotate`).set("Idempotency-Key", KEY).send({}).expect(409);
      expect(CALLS.get("rotate:A")).toBe(1);
    });

    it("AC2: the same key on another instance rotates it and returns its own fresh secret", async () => {
      const a = await http().post(`${BASE}/instances/A/rotate`).set("Idempotency-Key", KEY).send({}).expect(201);
      const b = await http().post(`${BASE}/instances/B/rotate`).set("Idempotency-Key", KEY).send({}).expect(201);
      expect(b.body.instance_id).toBe("B");
      expect(b.body.credential_id).toBe("cred-B-1");
      expect(b.body.secret).not.toBe(a.body.secret);
      expect(CALLS.get("rotate:B")).toBe(1);
    });

    it("without replayMarkerFields the marker carries only the flag", async () => {
      await http().post(`${BASE}/instances/A/reset`).set("Idempotency-Key", KEY).send({}).expect(201);
      const stored = JSON.parse(redis.values()[0]!) as { body: unknown };
      expect(stored.body).toEqual({ __dp2NonReplayable: true });
    });

    it("a stored marker is never replayed, even on a route without the option", async () => {
      const newKey = composeStoreKey("POST", ACT_TEMPLATE, USER, KEY, { ref: "A" });
      await store.save(TENANT, null, USER, newKey, bodyFingerprint({ n: 1 }), { status: 202, body: nonReplayableMarker({}) }, EXPIRES());
      await http().post(`${BASE}/things/A/act`).set("Idempotency-Key", KEY).send({ n: 1 }).expect(409);
      expect(CALLS.get("act:A")).toBeUndefined();
    });
  });
});

describe("RT-155 — lost-claim path (claim race resolved by a completed row)", () => {
  const fp = bodyFingerprint({});

  /** First lookup of the new key misses; after the lost claim it hits `body`. */
  function racingStore(body: unknown, newKey: string): unknown {
    let newKeyLookups = 0;
    return {
      async findOrCreate(_t: string, _s: string | null, _c: string, key: string) {
        if (key !== newKey) return { hit: false, entry: null };
        newKeyLookups += 1;
        if (newKeyLookups === 1) return { hit: false, entry: null };
        return { hit: true, entry: { fingerprint: fp, result: { status: 201, body }, expiresAt: EXPIRES() } };
      },
      async claim() {
        return "conflict" as const;
      },
      async releaseClaim() {},
      async save() {},
    };
  }

  beforeEach(() => CALLS.clear());

  it("a forbid route answers 409 instead of replaying", async () => {
    const key = composeStoreKey("POST", ROTATE_TEMPLATE, USER, KEY, { id: "A" });
    const app = await buildApp(racingStore({ credential_id: "cred-A-1" }, key));
    try {
      const res = await request(app.getHttpServer()).post(`${BASE}/instances/A/rotate`).set("Idempotency-Key", KEY).send({}).expect(409);
      expect(res.body.error.code).toBe("idempotency_key_conflict");
      expect(CALLS.get("rotate:A")).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("a stored marker answers 409 on any route", async () => {
    const key = composeStoreKey("POST", ACT_TEMPLATE, USER, KEY, { ref: "A" });
    const app = await buildApp(racingStore(nonReplayableMarker({}), key));
    try {
      await request(app.getHttpServer()).post(`${BASE}/things/A/act`).set("Idempotency-Key", KEY).send({}).expect(409);
    } finally {
      await app.close();
    }
  });

  it("an ordinary stored response still replays", async () => {
    const key = composeStoreKey("POST", ACT_TEMPLATE, USER, KEY, { ref: "A" });
    const app = await buildApp(racingStore({ ref: "A", run: 1 }, key));
    try {
      const res = await request(app.getHttpServer()).post(`${BASE}/things/A/act`).set("Idempotency-Key", KEY).send({}).expect(201);
      expect(res.headers["idempotent-replayed"]).toBe("true");
      expect(CALLS.get("act:A")).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe("RT-155 — nonReplayableMarker", () => {
  it("keeps only allowlisted top-level scalars and never mutates the body", () => {
    const body = { credential_id: "c1", secret: "s", nested: { secret: "s" }, n: 1, ok: true, none: null };
    const marker = nonReplayableMarker(body, ["credential_id", "nested", "n", "ok", "none", "missing", "__dp2NonReplayable"]);
    expect(marker).toEqual({ __dp2NonReplayable: true, credential_id: "c1", n: 1, ok: true, none: null });
    expect(body.secret).toBe("s");
  });

  it("handles a non-object body", () => {
    expect(nonReplayableMarker("raw", ["x"])).toEqual({ __dp2NonReplayable: true });
    expect(nonReplayableMarker(null)).toEqual({ __dp2NonReplayable: true });
  });

  it("recognises only a flagged object", () => {
    expect(isNonReplayableMarker({ __dp2NonReplayable: true })).toBe(true);
    expect(isNonReplayableMarker({ __dp2NonReplayable: "true" })).toBe(false);
    expect(isNonReplayableMarker(null)).toBe(false);
    expect(isNonReplayableMarker("x")).toBe(false);
  });
});
