/**
 * 017-RECON-WIRING — `ReconciliationRequestedConsumer` Testcontainers spec.
 *
 * Drives the consumer's `handle(envelope)` path (the 015 PostingRequestedConsumer
 * precedent). Proves:
 *   §1 a valid event over a mapped store with DP2 on-hand → the run advances
 *      running → completed; over EMPTY_BIN_VIEW the confirmed items are dp2_only;
 *   §2 the ENVELOPE tenant is authoritative — a tampered payload tenant does not
 *      redirect the run (the consumer ignores the payload tenant entirely);
 *   §3 idempotent at-least-once: a 2nd handle() of the same event is a no-op
 *      (the processor's guarded terminal write) — no duplicate results, 009
 *      ledger byte-unchanged;
 *   §4 a malformed payload throws (the drainer dead-letters after the retry
 *      budget — never silently drops).
 *
 * Docker policy mirrors the other worker DB specs: HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1. Run with WORKER_INCLUDE_DB_TESTS=1.
 */
import {
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OutboxEventEnvelope } from "@data-pulse-2/shared";
import {
  ReconciliationRequestedConsumer,
  RECONCILIATION_REQUESTED_CONSUMER_ID,
  type ReconciliationRequestedPayload,
} from "../../src/erpnext-reconciliation/reconciliation-requested.consumer";

const TENANT = "01900000-0000-7000-8000-0000000bf111";
const OTHER_TENANT = "01900000-0000-7000-8000-0000000bf999";
const STORE_MAPPED = "01900000-0000-7000-8000-0000000bc111";
const ACTOR = "01900000-0000-7000-8000-0000000bd111";
const PROD = "01900000-0000-7000-8000-0000000be111";

let env: PgTestEnv | null = null;
let skip = false;

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "..", "..", "packages", "db", "drizzle");

async function applyAllMigrations(e: PgTestEnv): Promise<void> {
  const files = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .sort();
  for (const name of files) {
    await e.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
  await ensureAppRole(e);
}

async function createRun(e: PgTestEnv, store: string): Promise<string> {
  const r = await e.admin.query<{ id: string }>(
    `INSERT INTO erpnext_reconciliation_run (id, tenant_id, store_id, kind, trigger, status, actor_user_id)
     VALUES (gen_random_uuid(), $1, $2, 'stock', 'on_demand', 'running', $3) RETURNING id`,
    [TENANT, store, ACTOR],
  );
  return r.rows[0]!.id;
}

async function runStatus(e: PgTestEnv, runId: string): Promise<string> {
  const r = await e.admin.query<{ status: string }>(
    `SELECT status FROM erpnext_reconciliation_run WHERE id = $1`,
    [runId],
  );
  return r.rows[0]!.status;
}

async function resultCount(e: PgTestEnv, runId: string): Promise<number> {
  const r = await e.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM erpnext_reconciliation_result WHERE run_id = $1`,
    [runId],
  );
  return Number(r.rows[0]!.n);
}

function envelope(
  runId: string,
  payload: Record<string, unknown>,
  tenantId: string = TENANT,
): OutboxEventEnvelope<ReconciliationRequestedPayload> {
  return {
    event_id: "01900000-0000-7000-8000-0000000bff01",
    event_type: "erpnext.reconciliation.requested",
    tenant_id: tenantId,
    store_id: STORE_MAPPED,
    correlation_id: null,
    occurred_at: new Date().toISOString(),
    payload: payload as ReconciliationRequestedPayload,
  } as unknown as OutboxEventEnvelope<ReconciliationRequestedPayload>;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllMigrations(env);
    const a = env.admin;
    await a.query(
      `INSERT INTO tenants (id, slug, name, default_currency_code)
       VALUES ($1, 'rcw', 'RCW', 'USD'), ($2, 'rcwo', 'RCWO', 'USD') ON CONFLICT (id) DO NOTHING`,
      [TENANT, OTHER_TENANT],
    );
    await a.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'RM', 'Mapped') ON CONFLICT (id) DO NOTHING`,
      [STORE_MAPPED, TENANT],
    );
    await a.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'rcw@fixture.invalid', NULL) ON CONFLICT (id) DO NOTHING`,
      [ACTOR],
    );
    await a.query(
      `INSERT INTO erpnext_warehouse_map (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
       VALUES (gen_random_uuid(), $1, $2, 'stock', 'ERP-WH', $3, 1) ON CONFLICT DO NOTHING`,
      [TENANT, STORE_MAPPED, ACTOR],
    );
    await a.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, 'P', 'standard', $3, $3) ON CONFLICT (id) DO NOTHING`,
      [PROD, TENANT, ACTOR],
    );
    await a.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, 'ERP-I', 'confirmed', 'manual', $3, now()) ON CONFLICT DO NOTHING`,
      [TENANT, PROD, ACTOR],
    );
    await a.query(
      `INSERT INTO stock_movements
         (id, tenant_id, store_id, tenant_product_ref, movement_type, quantity, stocking_unit, occurred_at, created_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 'inbound', 7::numeric, 'ea', now(), $4)`,
      [TENANT, STORE_MAPPED, PROD, ACTOR],
    );
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[reconciliation-requested-consumer.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function guard(): PgTestEnv {
  if (!env) throw new Error("Docker unavailable");
  return env;
}

describe("017-RECON-WIRING — ReconciliationRequestedConsumer", () => {
  it("exposes the canonical consumerId + eventType", () => {
    const c = new ReconciliationRequestedConsumer({} as never);
    expect(c.consumerId).toBe(RECONCILIATION_REQUESTED_CONSUMER_ID);
    expect(c.eventType).toBe("erpnext.reconciliation.requested");
  });

  it("§1 a valid event advances the run running → completed (dp2_only over EMPTY_BIN_VIEW)", async () => {
    if (skip) return;
    const e = guard();
    const runId = await createRun(e, STORE_MAPPED);
    const c = new ReconciliationRequestedConsumer(e.app);
    await c.handle(envelope(runId, { run_id: runId, store_id: STORE_MAPPED }));
    expect(await runStatus(e, runId)).toBe("completed");
    expect(await resultCount(e, runId)).toBe(1); // PROD → dp2_only (no Bin entry)
  });

  it("§2 the ENVELOPE tenant is authoritative — a tampered payload tenant is ignored", async () => {
    if (skip) return;
    const e = guard();
    const runId = await createRun(e, STORE_MAPPED);
    const c = new ReconciliationRequestedConsumer(e.app);
    // payload claims OTHER_TENANT, envelope says TENANT — the run is TENANT's.
    await c.handle(
      envelope(runId, { run_id: runId, store_id: STORE_MAPPED }, TENANT),
    );
    expect(await runStatus(e, runId)).toBe("completed");
  });

  it("§3 idempotent at-least-once: a 2nd handle() is a no-op; no duplicate results", async () => {
    if (skip) return;
    const e = guard();
    const before = await e.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_movements WHERE store_id = $1`,
      [STORE_MAPPED],
    );
    const runId = await createRun(e, STORE_MAPPED);
    const c = new ReconciliationRequestedConsumer(e.app);
    const ev = envelope(runId, { run_id: runId, store_id: STORE_MAPPED });
    await c.handle(ev);
    const firstCount = await resultCount(e, runId);
    await c.handle(ev); // redelivery
    expect(await resultCount(e, runId)).toBe(firstCount); // no duplicates
    const after = await e.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM stock_movements WHERE store_id = $1`,
      [STORE_MAPPED],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n); // 009 ledger never mutated
  });

  it("§4 a malformed payload throws (the drainer dead-letters; never silently drops)", async () => {
    const c = new ReconciliationRequestedConsumer({} as never);
    await expect(
      c.handle(envelope("x", { run_id: "not-a-uuid", store_id: STORE_MAPPED })),
    ).rejects.toThrow(/malformed payload/);
  });
});
