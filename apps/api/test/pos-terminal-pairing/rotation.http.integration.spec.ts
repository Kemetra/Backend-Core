/**
 * RT-369 (RT-287 F6; RT-138 L4 / DL-4) — the device token rotation over HTTP
 * against real Postgres (Testcontainers, every migration, the NOBYPASSRLS
 * `app_test` pool), the real `DeviceRotationModule` and the real
 * `IdempotencyInterceptor` over an in-memory Redis.
 *
 *   POST /api/pos/v1/terminals/rotate  posRotateTerminalToken
 *
 * What this proves (RT-369 acceptance):
 *   - a rotate succeeds: a new token, the same terminal_id, +90 d expiry, the
 *     rotate_after hint, SHA-256 at rest, the old hash kept 10 minutes;
 *   - the old token authenticates device routes inside the 10 minutes and is
 *     refused after them; a retry with it replaces the undelivered token and
 *     never extends the window;
 *   - an expired, unrevoked device may rotate for 7 days, not after;
 *   - revoked and retired devices are 401 (no grace);
 *   - replay is refused (409, no second rotation, no token), per device;
 *   - two concurrent rotates never leave two new tokens valid;
 *   - refusal order (401 before 400) and audit rows without secrets.
 *
 * "Grace allows only rotate": every other route ignores expiry until RT-370
 * turns DEVICE_TOKEN_EXPIRY_ENFORCED on, so only the rotate half is provable
 * here.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import type { Pool } from "pg";
import type request from "supertest";

import { DeviceRepository } from "../../src/pos-operators/device.repository";
import { DeviceRotationModule } from "../../src/pos-terminal-pairing/device-rotation.module";
import { idempotencyProviders } from "../_helpers/idempotency-providers";
import { scopedHttpHarness } from "../_helpers/scoped-http-harness";
import { STORE_A_X, TENANT_A } from "../catalog/__support__/isolation-harness";
import { SES_OWNER_ALL, seedReadStoreScope } from "../catalog/erpnext-reconciliation/__support__/read-store-scope";

const ROTATE = "/api/pos/v1/terminals/rotate";
const id = (n: string): string => `0a000000-0000-7000-8000-00000369${n}`;

const D_MAIN = id("0001");
const D_WINDOW = id("0002");
const D_GRACE = id("0003");
const D_LAPSED = id("0004");
const D_REVOKED = id("0005");
const D_RETIRED = id("0006");
const D_REPLAY = id("0007");
const D_OTHER = id("0008");
const D_RACE = id("0009");
const D_ORDER = id("000a");

const TOKENS: Record<string, string> = Object.fromEntries(
  [D_MAIN, D_WINDOW, D_GRACE, D_LAPSED, D_REVOKED, D_RETIRED, D_REPLAY, D_OTHER, D_RACE, D_ORDER].map((d) => [
    d,
    generateRawToken(),
  ]),
);
const UNKNOWN_TOKEN = generateRawToken();

/** Every secret a response ever carried, to prove no audit row holds one. */
const secrets: string[] = [];
const keys: string[] = [];

async function seed(admin: Pool): Promise<void> {
  const rows: Array<[string, string]> = [
    [D_MAIN, "now() + interval '30 days'"],
    [D_WINDOW, "now() + interval '30 days'"],
    [D_GRACE, "now() - interval '3 days'"],
    [D_LAPSED, "now() - interval '8 days'"],
    [D_REVOKED, "now() + interval '30 days'"],
    [D_RETIRED, "now() + interval '30 days'"],
    [D_REPLAY, "now() + interval '30 days'"],
    [D_OTHER, "now() + interval '30 days'"],
    [D_RACE, "now() + interval '30 days'"],
    [D_ORDER, "now() + interval '30 days'"],
  ];
  for (const [deviceId, expiresSql] of rows) {
    await admin.query(
      `INSERT INTO devices (id, tenant_id, store_id, label, token_hash, expires_at)
       VALUES ($1, $2, $3, 'RT-369 till', $4, ${expiresSql})`,
      [deviceId, TENANT_A, STORE_A_X, hashToken(TOKENS[deviceId]!)],
    );
  }
  await admin.query(`UPDATE devices SET revoked_at = now(), revoke_reason = 'lost' WHERE id = $1`, [D_REVOKED]);
  await admin.query(
    `UPDATE devices SET revoked_at = now(), revoke_reason = 'retired', retired_at = now(), retire_reason = 'EOL'
      WHERE id = $1`,
    [D_RETIRED],
  );
}

const h = scopedHttpHarness({
  label: "RT-369 device rotation",
  contractId: "pos-terminal-pairing.openapi",
  module: DeviceRotationModule,
  seed: async (env) => {
    await seedReadStoreScope(env);
    await seed(env.admin);
  },
  providers: idempotencyProviders(),
});
const skip = (): boolean => h.skipped();

let keySeq = 0;
const nextKey = (): string => {
  const key = `rt369-key-${String((keySeq += 1)).padStart(8, "0")}`;
  keys.push(key);
  return key;
};

function rotate(token: string | null, key: string | null = nextKey()): request.Test {
  let req = h.post(ROTATE, null, {});
  if (token !== null) req = req.set("Authorization", `Bearer ${token}`);
  if (key !== null) req = req.set("Idempotency-Key", key);
  return req;
}

interface Rotated {
  device_token: string;
  terminal_id: string;
  expires_at: string;
  rotate_after: string;
}

async function rotateOk(token: string, key?: string): Promise<Rotated> {
  const res = await rotate(token, key);
  expect(res.status).toBe(200);
  h.conforms("TerminalRotateResponse", res.body);
  const body = res.body as Rotated;
  secrets.push(body.device_token);
  return body;
}

function expectRefusal(res: request.Response, status: number, code: string): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({
    status,
    code,
  });
  h.conforms("RotateError", res.body);
}

interface DeviceRow {
  token_hash: Buffer;
  previous_token_hash: Buffer | null;
  previous_valid_until: Date | null;
  expires_at: Date;
  db_now: Date;
}

async function deviceRow(deviceId: string): Promise<DeviceRow> {
  const r = await h
    .env()
    .admin.query<DeviceRow>(
      `SELECT token_hash, previous_token_hash, previous_valid_until, expires_at, now() AS db_now
         FROM devices WHERE id = $1`,
      [deviceId],
    );
  return r.rows[0]!;
}

async function audits(action: string, deviceId: string): Promise<Array<{ actor_user_id: string | null; metadata: Record<string, unknown> }>> {
  const r = await h
    .env()
    .admin.query(
      `SELECT actor_user_id, metadata FROM audit_events WHERE action = $1 AND target_id = $2 ORDER BY occurred_at, id`,
      [action, deviceId],
    );
  return r.rows as Array<{ actor_user_id: string | null; metadata: Record<string, unknown> }>;
}

/** The real device lookup every device-authenticated route uses. */
const deviceAuth = (): DeviceRepository => new DeviceRepository(h.env().admin, h.env().app);
const authenticates = async (token: string): Promise<string | null> =>
  (await deviceAuth().findActiveByAttestation(token))?.id ?? null;

const DAY = 86_400_000;
const MIN = 60_000;

// ===========================================================================
// 1. A rotate succeeds
// ===========================================================================
describe("posRotateTerminalToken — success", () => {
  it("returns a new token, the same terminal_id, +90 d expiry and the 15-day hint", async () => {
    if (skip()) return;
    const before = await deviceRow(D_MAIN);
    const body = await rotateOk(TOKENS[D_MAIN]!);
    const after = await deviceRow(D_MAIN);

    expect(body.terminal_id).toBe(D_MAIN);
    expect(body.device_token).not.toBe(TOKENS[D_MAIN]);
    expect(Buffer.from(body.device_token, "base64url")).toHaveLength(32);
    const expiresAt = new Date(body.expires_at).getTime();
    expect(Math.abs(expiresAt - (after.db_now.getTime() + 90 * DAY))).toBeLessThan(MIN);
    expect(new Date(body.rotate_after).getTime()).toBe(expiresAt - 15 * DAY);

    // SHA-256 at rest; the presented hash kept as previous for 10 minutes.
    expect(after.token_hash.equals(hashToken(body.device_token))).toBe(true);
    expect(after.previous_token_hash?.equals(before.token_hash)).toBe(true);
    const windowMs = after.previous_valid_until!.getTime() - after.db_now.getTime();
    expect(windowMs).toBeGreaterThan(9 * MIN);
    expect(windowMs).toBeLessThanOrEqual(10 * MIN);
    expect(after.expires_at.getTime()).toBe(expiresAt);
  });

  it("answers the 200 with Cache-Control no-store and Pragma no-cache", async () => {
    if (skip()) return;
    const res = await rotate(TOKENS[D_OTHER]!);
    expect(res.status).toBe(200);
    secrets.push((res.body as Rotated).device_token);
    TOKENS[D_OTHER] = (res.body as Rotated).device_token;
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["pragma"]).toBe("no-cache");
  });

  it("audits pos.device.rotated with the allowlisted metadata and no actor user", async () => {
    if (skip()) return;
    const rows = await audits("pos.device.rotated", D_MAIN);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBeNull();
    expect(Object.keys(rows[0]!.metadata).sort()).toEqual(
      ["credential", "expires_at", "in_grace", "previous_valid_until"].sort(),
    );
    expect(rows[0]!.metadata).toMatchObject({ credential: "current", in_grace: false });
  });
});

// ===========================================================================
// 2. The 10-minute overlap
// ===========================================================================
describe("posRotateTerminalToken — overlap", () => {
  let first: Rotated;
  let windowBefore: Date;

  it("the old and the new token both authenticate device routes inside the window", async () => {
    if (skip()) return;
    first = await rotateOk(TOKENS[D_WINDOW]!);
    expect(await authenticates(TOKENS[D_WINDOW]!)).toBe(D_WINDOW);
    expect(await authenticates(first.device_token)).toBe(D_WINDOW);
    windowBefore = (await deviceRow(D_WINDOW)).previous_valid_until!;
  });

  it("a retry with the old token replaces the undelivered token and never extends the window", async () => {
    if (skip()) return;
    const second = await rotateOk(TOKENS[D_WINDOW]!);
    const row = await deviceRow(D_WINDOW);
    expect(row.previous_token_hash?.equals(hashToken(TOKENS[D_WINDOW]!))).toBe(true);
    expect(row.previous_valid_until?.getTime()).toBe(windowBefore.getTime());
    expect(await authenticates(first.device_token)).toBeNull();
    expect(await authenticates(second.device_token)).toBe(D_WINDOW);
    const rotated = await audits("pos.device.rotated", D_WINDOW);
    expect(rotated.map((r) => r.metadata["credential"])).toEqual(["current", "previous"]);
  });

  it("after the window the old token authenticates nothing and rotate is 401 previous_expired", async () => {
    if (skip()) return;
    await h
      .env()
      .admin.query(`UPDATE devices SET previous_valid_until = now() - interval '1 second' WHERE id = $1`, [D_WINDOW]);
    expect(await authenticates(TOKENS[D_WINDOW]!)).toBeNull();
    expectRefusal(await rotate(TOKENS[D_WINDOW]!), 401, "unauthorized");
    const rejected = await audits("pos.device.rotation_rejected", D_WINDOW);
    expect(rejected.map((r) => r.metadata)).toEqual([{ reason: "previous_expired" }]);
  });
});

// ===========================================================================
// 3. Expiry: the 7-day rotate-only grace
// ===========================================================================
describe("posRotateTerminalToken — grace", () => {
  it("an expired, unrevoked device inside 7 days rotates (in_grace)", async () => {
    if (skip()) return;
    await rotateOk(TOKENS[D_GRACE]!);
    const rows = await audits("pos.device.rotated", D_GRACE);
    expect(rows.map((r) => r.metadata["in_grace"])).toEqual([true]);
  });

  it("past expires_at + 7 days is 401 grace_elapsed and nothing changes", async () => {
    if (skip()) return;
    const before = await deviceRow(D_LAPSED);
    expectRefusal(await rotate(TOKENS[D_LAPSED]!), 401, "unauthorized");
    expect((await deviceRow(D_LAPSED)).token_hash.equals(before.token_hash)).toBe(true);
    const rejected = await audits("pos.device.rotation_rejected", D_LAPSED);
    expect(rejected.map((r) => r.metadata)).toEqual([{ reason: "grace_elapsed" }]);
  });
});

// ===========================================================================
// 4. Revoked and retired: never any grace
// ===========================================================================
describe("posRotateTerminalToken — revoked / retired / unknown", () => {
  it.each([
    ["revoked", D_REVOKED],
    ["retired", D_RETIRED],
  ])("a %s device is 401 and audited with that reason", async (reason, deviceId) => {
    if (skip()) return;
    expectRefusal(await rotate(TOKENS[deviceId]!), 401, "unauthorized");
    const rejected = await audits("pos.device.rotation_rejected", deviceId);
    expect(rejected.map((r) => r.metadata)).toEqual([{ reason }]);
    expect(rejected[0]!.actor_user_id).toBeNull();
  });

  it("a revoked device's previous token authenticates nothing, even inside its window", async () => {
    if (skip()) return;
    const previous = generateRawToken();
    await h
      .env()
      .admin.query(
        `UPDATE devices SET previous_token_hash = $2, previous_valid_until = now() + interval '5 minutes' WHERE id = $1`,
        [D_REVOKED, hashToken(previous)],
      );
    expect(await authenticates(previous)).toBeNull();
    expect(await authenticates(TOKENS[D_REVOKED]!)).toBeNull();
  });

  it("an unknown token, no bearer and a dashboard session are 401 with no audit row", async () => {
    if (skip()) return;
    const before = await h.env().admin.query(`SELECT count(*)::int AS n FROM audit_events`);
    expectRefusal(await rotate(UNKNOWN_TOKEN), 401, "unauthorized");
    expectRefusal(await rotate(null), 401, "unauthorized");
    expectRefusal(await h.post(ROTATE, SES_OWNER_ALL, {}).set("Idempotency-Key", nextKey()), 401, "unauthorized");
    const after = await h.env().admin.query(`SELECT count(*)::int AS n FROM audit_events`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

// ===========================================================================
// 5. Idempotency: non-replayable, scoped per device; refusal order
// ===========================================================================
describe("posRotateTerminalToken — idempotency and refusal order", () => {
  it("a same-key retry is 409 idempotency_key_conflict and does not rotate again", async () => {
    if (skip()) return;
    const key = nextKey();
    const body = await rotateOk(TOKENS[D_REPLAY]!, key);
    const res = await rotate(body.device_token, key);
    expectRefusal(res, 409, "idempotency_key_conflict");
    expect(JSON.stringify(res.body)).not.toContain(body.device_token);
    expect((await deviceRow(D_REPLAY)).token_hash.equals(hashToken(body.device_token))).toBe(true);
    expect(await audits("pos.device.rotated", D_REPLAY)).toHaveLength(1);
  });

  it("the same key from another device is an independent rotation", async () => {
    if (skip()) return;
    const key = nextKey();
    await rotateOk(TOKENS[D_OTHER]!, key);
    const other = await rotate(TOKENS[D_ORDER]!, key);
    expect(other.status).toBe(200);
    secrets.push((other.body as Rotated).device_token);
    TOKENS[D_ORDER] = (other.body as Rotated).device_token;
  });

  it("401 comes before 400: no bearer and no key is 401; a valid bearer without a key is 400", async () => {
    if (skip()) return;
    expectRefusal(await rotate(null, null), 401, "unauthorized");
    expectRefusal(await rotate(TOKENS[D_ORDER]!, null), 400, "idempotency_key_required");
    expectRefusal(await rotate(TOKENS[D_ORDER]!, "short"), 400, "idempotency_key_malformed");
  });
});

// ===========================================================================
// 6. Concurrency: two rotates at once never leave two new tokens valid
// ===========================================================================
describe("posRotateTerminalToken — concurrent rotates", () => {
  it("both answer, but only the later new token and the presented one authenticate", async () => {
    if (skip()) return;
    const [a, b] = await Promise.all([rotate(TOKENS[D_RACE]!), rotate(TOKENS[D_RACE]!)]);
    const ok = [a, b].filter((r) => r.status === 200).map((r) => (r.body as Rotated).device_token);
    secrets.push(...ok);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const live = [];
    for (const token of ok) if ((await authenticates(token)) === D_RACE) live.push(token);
    expect(live).toHaveLength(1);
    expect(await authenticates(TOKENS[D_RACE]!)).toBe(D_RACE);
  });
});

// ===========================================================================
// 7. Audit rows never hold a secret
// ===========================================================================
describe("posRotateTerminalToken — audit hygiene", () => {
  it("no rotation audit row contains a token, a token hash or an Idempotency-Key", async () => {
    if (skip()) return;
    const r = await h
      .env()
      .admin.query<{ metadata: unknown }>(
        `SELECT metadata FROM audit_events WHERE action IN ('pos.device.rotated', 'pos.device.rotation_rejected')`,
      );
    expect(r.rows.length).toBeGreaterThan(5);
    const dump = JSON.stringify(r.rows);
    const allTokens = [...Object.values(TOKENS), ...secrets];
    for (const token of allTokens) {
      const hash = hashToken(token);
      for (const needle of [token, hash.toString("hex"), hash.toString("base64"), hash.toString("base64url")]) {
        expect(dump).not.toContain(needle);
      }
    }
    for (const key of keys) expect(dump).not.toContain(key);
  });
});
