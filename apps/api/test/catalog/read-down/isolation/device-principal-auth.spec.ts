/**
 * device-principal-auth.spec.ts — issue #488, Option B-prime (REAL-GUARD).
 *
 * The other read-down specs stub the route guard and inject `req.context` via
 * the ConfigurableContextGuard — they cover the resolver/projection, NOT auth.
 * THIS spec wires the REAL `PosDeviceAuthGuard` + a REAL `DeviceRepository`
 * against a seeded `devices` row and presents a real `Authorization: Bearer
 * <device-token>` header, so the device-principal auth path itself is proven
 * end-to-end (the gap the preflight flagged: ConfigurableContextGuard bypasses
 * the scope gate).
 *
 * Contract (FR-001 device-principal; FR-002 scope-from-device-row):
 *   - valid active device pairing token  → 200 (snapshot reachable, store
 *     resolved from the device row)
 *   - revoked device token               → 401
 *   - unknown token                      → 401
 *   - non-Bearer / missing Authorization → 401
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1. WSL-only —
 * Testcontainers-backed; skips (does not pass) when Docker is unavailable.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Pool } from "pg";
import request from "supertest";
import { hashToken } from "@data-pulse-2/auth";

import { GlobalExceptionFilter } from "../../../../src/common/exception.filter";
import { PG_POOL } from "../../../../src/auth/auth.module";
import { PosDeviceAuthGuard } from "../../../../src/auth/pos-device-auth.guard";
import { DeviceRepository } from "../../../../src/pos-operators/device.repository";
import { ReadDownController } from "../../../../src/catalog/read-down/read-down.controller";
import { ReadDownService } from "../../../../src/catalog/read-down/read-down.service";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { TENANT_A, STORE_A_X } from "../../__support__/isolation-harness";
import { seedReadDownFixture } from "../__support__/seed-read-down";

// NOTE: hex-only suffixes — "dev01"/"dev02" would contain a non-hex 'v' and
// Postgres rejects them as "invalid input syntax for type uuid".
const DEVICE_ID = "0d000000-0000-7000-8000-00000000de01";
const ACTIVE_TOKEN = "active-device-pairing-token-aaaaaaaaaaaaaaaaa";
const REVOKED_TOKEN = "revoked-device-pairing-token-bbbbbbbbbbbbbbbbb";
const REVOKED_DEVICE_ID = "0d000000-0000-7000-8000-00000000de02";

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;

async function seedDevice(
  pool: Pool,
  id: string,
  rawToken: string,
  revoked: boolean,
): Promise<void> {
  await pool.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      TENANT_A,
      STORE_A_X,
      "test lane",
      hashToken(rawToken),
      revoked ? new Date() : null,
    ],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[device-principal-auth.spec] skipping — Docker unavailable: ${msg}\n`);
      env = null;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  await applyAllUpAndCreateAppRole(env);
  await seedReadDownFixture(env);
  // Devices are written via the admin pool (no tenant GUC at pairing time —
  // the device IS the source of context, mirroring DeviceRepository's note).
  await seedDevice(env.admin, DEVICE_ID, ACTIVE_TOKEN, false);
  await seedDevice(env.admin, REVOKED_DEVICE_ID, REVOKED_TOKEN, true);

  const theEnv = env;
  const moduleRef = await Test.createTestingModule({
    controllers: [ReadDownController],
    providers: [
      // The RESOLVER runs under RLS (env.app) so the snapshot read is real
      // tenant-scoped data.
      { provide: PG_POOL, useFactory: (): Pool => theEnv.app },
      ReadDownService,
      // DeviceRepository runs on the ADMIN pool: `findActiveByAttestation`
      // does a NO-GUC lookup, and `devices` is FORCE ROW LEVEL SECURITY, so the
      // non-superuser app role would see zero rows. This mirrors the proven
      // device-auth integration pattern in
      // pos-operators.controller.spec.ts (PG_POOL ← env.adminUri) — the device
      // is the source of context, so its lookup is not tenant-GUC scoped. In
      // PRODUCTION `PG_POOL` is the privileged app pool that already performs
      // this exact lookup at operator sign-in; the test just makes the
      // privilege explicit.
      {
        provide: DeviceRepository,
        // RT-213: the tenant-status read runs on the RLS-bound app pool.
        useValue: new DeviceRepository(theEnv.admin, theEnv.app),
      },
      PosDeviceAuthGuard,
    ],
  }).compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
}, 180_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

function skip(): boolean {
  if (!env || !app) {
    // eslint-disable-next-line no-console
    console.warn("[device-principal-auth.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

const http = () => request(app!.getHttpServer());

describe("read-down — real device-principal auth (#488 B-prime)", () => {
  it("valid active device pairing token → 200 (store resolved from device row)", async () => {
    if (skip()) return;
    const res = await http()
      .get("/api/pos/v1/catalog/snapshot")
      .set("authorization", `Bearer ${ACTIVE_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("cursor");
    expect(res.body).toHaveProperty("items");
  });

  it("revoked device token → 401", async () => {
    if (skip()) return;
    const res = await http()
      .get("/api/pos/v1/catalog/snapshot")
      .set("authorization", `Bearer ${REVOKED_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("unknown token → 401", async () => {
    if (skip()) return;
    const res = await http()
      .get("/api/pos/v1/catalog/snapshot")
      .set("authorization", `Bearer ${randomUUID()}-not-a-device`);
    expect(res.status).toBe(401);
  });

  it("non-Bearer Authorization → 401", async () => {
    if (skip()) return;
    const res = await http()
      .get("/api/pos/v1/catalog/snapshot")
      .set("authorization", `Basic ${ACTIVE_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("missing Authorization → 401", async () => {
    if (skip()) return;
    const res = await http().get("/api/pos/v1/catalog/snapshot");
    expect(res.status).toBe(401);
  });

  it("delta route is guarded the same way: valid token → not 401", async () => {
    if (skip()) return;
    const res = await http()
      .get("/api/pos/v1/catalog/deltas")
      .query({ since: "x" })
      .set("authorization", `Bearer ${ACTIVE_TOKEN}`);
    // Auth passes (store resolved); the cursor "x" is a content-level concern
    // (non-disclosing 404 for an opaque/foreign cursor) — the point is it is
    // NOT a 401 auth rejection.
    expect(res.status).not.toBe(401);
  });
});

// RT-386 — a cursor whose decoded body is not a JSON object is malformed: after
// real device auth it is the non-disclosing 404 (FR-024), never a 500. The JSON
// text `null` (base64url `bnVsbA`) used to throw a TypeError in both decoders.
describe("read-down — malformed cursor bodies after real device auth (RT-386)", () => {
  const token = (json: string): string => Buffer.from(json, "utf8").toString("base64url");
  const MALFORMED: ReadonlyArray<readonly [string, string]> = [
    ["JSON null (bnVsbA)", token("null")],
    ["a JSON number", token("1")],
    ["a JSON string", token('"x"')],
    ["a JSON array", token("[]")],
  ];

  it.each(MALFORMED)("deltas since=%s → 404", async (_label, since) => {
    if (skip()) return;
    const res = await http()
      .get("/api/pos/v1/catalog/deltas")
      .query({ since })
      .set("authorization", `Bearer ${ACTIVE_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it.each(MALFORMED)("snapshot page_token=%s → 404", async (_label, pageToken) => {
    if (skip()) return;
    const res = await http()
      .get("/api/pos/v1/catalog/snapshot")
      .query({ page_token: pageToken })
      .set("authorization", `Bearer ${ACTIVE_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it("snapshot page_token with a non-string product id → 404", async () => {
    if (skip()) return;
    const pageToken = token(JSON.stringify({ t: TENANT_A, s: STORE_A_X, a: 1 }));
    const res = await http()
      .get("/api/pos/v1/catalog/snapshot")
      .query({ page_token: pageToken })
      .set("authorization", `Bearer ${ACTIVE_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it("control: the snapshot cursor still opens a deltas page (200)", async () => {
    if (skip()) return;
    const snapshot = await http()
      .get("/api/pos/v1/catalog/snapshot")
      .set("authorization", `Bearer ${ACTIVE_TOKEN}`);
    expect(snapshot.status).toBe(200);
    const res = await http()
      .get("/api/pos/v1/catalog/deltas")
      .query({ since: snapshot.body.cursor as string })
      .set("authorization", `Bearer ${ACTIVE_TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("control: a real next_page_token still opens the next snapshot page (200)", async () => {
    if (skip()) return;
    // limit=3 over-fetches 4 rows in product-id order: the two unsellable base
    // products, the sellable product, then an excluded one beyond it, so the
    // page emits the sellable product and issues a next_page_token.
    const first = await http()
      .get("/api/pos/v1/catalog/snapshot")
      .query({ limit: 3 })
      .set("authorization", `Bearer ${ACTIVE_TOKEN}`);
    expect(first.status).toBe(200);
    const pageToken = first.body.next_page_token as string | null;
    expect(typeof pageToken).toBe("string");

    const second = await http()
      .get("/api/pos/v1/catalog/snapshot")
      .query({ limit: 3, page_token: pageToken })
      .set("authorization", `Bearer ${ACTIVE_TOKEN}`);
    expect(second.status).toBe(200);
    expect(second.body.cursor).toBe(first.body.cursor);
  });
});
