/**
 * RT-457 (RT-447 F02) — the sale re-drive sweep against real Postgres.
 *
 * Builds the sweep the way WorkerModule does (PgSaleRedriveRepository + the
 * real SaleProcessingProcessor, app role under RLS) and proves it recovers the
 * three stranded states the live pipeline can leave behind:
 *   (a) a sale whose sale-processing job ran out of retries (still
 *       `processed_at IS NULL` long after capture) → processed, and its
 *       `erpnext.posting.requested` intent emitted in the same transaction;
 *   (b) a processed sale whose posting event dead-lettered (no `sale_post`
 *       row) → the event is re-emitted, and the consumer then creates the row;
 *   (c) a void with no `reversal` row → its reversal event is re-emitted.
 * Plus the guards: young items are left to the live pipeline, an event still
 * live in the outbox is not duplicated, a repeat run is a no-op, and each
 * tenant only ever sees its own rows.
 *
 * Docker policy mirrors the other worker DB specs: HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1.
 */
import type { OutboxEventEnvelope } from "@data-pulse-2/shared";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import { PostingRequestedConsumer } from "../../src/erpnext-posting/posting-requested.consumer";
import { SaleProcessingProcessor } from "../../src/sales/sale-processing.processor";
import { SALE_REDRIVE_JOB_NAME, SaleRedriveProcessor } from "../../src/sales/sale-redrive.processor";
import { PgSaleRedriveRepository } from "../../src/sales/sale-redrive.repository";
import { seedUnprocessedSale } from "./__support__/seed";

const TENANT_A = "4e570000-0000-7000-8000-0000000000a1";
const STORE_A = "4e570000-0000-7000-8000-0000000000b1";
const ACTOR_A = "4e570000-0000-7000-8000-0000000000c1";
const TENANT_B = "4e570000-0000-7000-8000-0000000000a2";
const STORE_B = "4e570000-0000-7000-8000-0000000000b2";
const ACTOR_B = "4e570000-0000-7000-8000-0000000000c2";

const MIN_AGE_MS = 15 * 60 * 1000;
const POSTING_EVENT = "erpnext.posting.requested";
const quiet = (): void => undefined;

let env: PgTestEnv | null = null;
let skip = false;
let seq = 0;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[sale-redrive.integration.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function e(): PgTestEnv {
  if (!env) throw new Error("Docker unavailable");
  return env;
}

function sweep(): SaleRedriveProcessor {
  return new SaleRedriveProcessor(
    new PgSaleRedriveRepository(e().app),
    new SaleProcessingProcessor(e().app),
    MIN_AGE_MS,
    quiet,
  );
}

function newSaleId(): string {
  seq += 1;
  return `4e570000-0000-7000-8000-${seq.toString(16).padStart(12, "0")}`;
}

/** A captured sale, `ageMinutes` old; processed `ageMinutes` ago when `processed`. */
async function seedSale(
  opts: { tenant?: "A" | "B"; ageMinutes: number; processed?: boolean },
): Promise<string> {
  const b = opts.tenant === "B";
  const saleId = newSaleId();
  await seedUnprocessedSale(e().admin, {
    tenantId: b ? TENANT_B : TENANT_A,
    storeId: b ? STORE_B : STORE_A,
    saleId,
    actorId: b ? ACTOR_B : ACTOR_A,
    slugSuffix: b ? "rt457-b" : "rt457-a",
    currencyCode: "EGP",
    posTotal: "10.00",
    lineAmounts: ["10.00"],
    sourceSystem: "pos-rt457",
    externalId: `rt457-${saleId}`,
  });
  await e().admin.query(
    `UPDATE sales
        SET created_at = now() - ($2::int * interval '1 minute'),
            processed_at = CASE WHEN $3 THEN now() - ($2::int * interval '1 minute') END,
            sync_status = CASE WHEN $3 THEN 'synced' ELSE sync_status END
      WHERE id = $1`,
    [saleId, opts.ageMinutes, opts.processed === true],
  );
  return saleId;
}

async function saleState(saleId: string): Promise<{ processed: boolean; syncStatus: string }> {
  const r = await e().admin.query<{ processed: boolean; sync_status: string }>(
    `SELECT processed_at IS NOT NULL AS processed, sync_status FROM sales WHERE id = $1`,
    [saleId],
  );
  return { processed: r.rows[0]!.processed, syncStatus: r.rows[0]!.sync_status };
}

interface PostingEventRow {
  event_id: string;
  tenant_id: string;
  store_id: string | null;
  payload: Record<string, unknown>;
  delivery_state: string;
}

async function postingEvents(sourceRefId: string): Promise<PostingEventRow[]> {
  const r = await e().admin.query<PostingEventRow>(
    `SELECT event_id, tenant_id, store_id, payload, delivery_state FROM outbox_events
      WHERE event_type = $1 AND payload->>'source_ref_id' = $2
      ORDER BY occurred_at`,
    [POSTING_EVENT, sourceRefId],
  );
  return r.rows;
}

/** Simulate the drainer giving up on an event (8 attempts exhausted). */
async function deadLetter(eventId: string): Promise<void> {
  await e().admin.query(
    `UPDATE outbox_events SET delivery_state = 'dead_lettered', attempts = 8 WHERE event_id = $1`,
    [eventId],
  );
}

/** Deliver one posting event to the real consumer (what the drainer does). */
async function consume(row: PostingEventRow): Promise<void> {
  const envelope: OutboxEventEnvelope = {
    event_id: row.event_id,
    event_type: POSTING_EVENT,
    tenant_id: row.tenant_id,
    store_id: row.store_id,
    payload: row.payload,
    correlation_id: null,
    attempts: 1,
    occurred_at: new Date(),
  };
  await new PostingRequestedConsumer(e().app).handle(
    envelope as Parameters<PostingRequestedConsumer["handle"]>[0],
  );
}

async function postingRows(sourceRefId: string): Promise<Array<{ kind: string }>> {
  const r = await e().admin.query<{ kind: string }>(
    `SELECT kind FROM erpnext_posting_status WHERE source_ref_id = $1`,
    [sourceRefId],
  );
  return r.rows;
}

/** Run the sweep; the result totals cover every tenant, so tests assert on rows. */
async function runSweep(): Promise<void> {
  await sweep().process(SALE_REDRIVE_JOB_NAME, {});
}

describe("RT-457 (a) — a sale stranded before processing is re-driven", () => {
  it("processes a sale left unprocessed past the minimum age and emits its posting intent", async () => {
    if (skip) return;
    const saleId = await seedSale({ ageMinutes: 60 });

    await runSweep();

    expect(await saleState(saleId)).toEqual({ processed: true, syncStatus: "synced" });
    const events = await postingEvents(saleId);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      sale_id: saleId,
      store_id: STORE_A,
      kind: "sale_post",
      source_ref_id: saleId,
    });

    // The consumer then creates exactly one sale_post row for it.
    await consume(events[0]!);
    expect(await postingRows(saleId)).toEqual([{ kind: "sale_post" }]);
  });

  it("leaves a sale younger than the minimum age to the live pipeline", async () => {
    if (skip) return;
    const saleId = await seedSale({ ageMinutes: 1 });

    await runSweep();

    expect((await saleState(saleId)).processed).toBe(false);
    expect(await postingEvents(saleId)).toHaveLength(0);
  });
});

describe("RT-457 (b) — a processed sale with no sale_post row is re-driven", () => {
  it("re-emits the posting intent once its event dead-lettered, then is a no-op", async () => {
    if (skip) return;
    const saleId = await seedSale({ ageMinutes: 60, processed: true });

    // Its original event is still live: the drainer owns it, nothing is re-emitted.
    await e().admin.query(
      `INSERT INTO outbox_events (event_id, tenant_id, store_id, event_type, payload, delivery_state, attempts)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb, 'failed', 3)`,
      [TENANT_A, STORE_A, POSTING_EVENT, JSON.stringify({
        sale_id: saleId, store_id: STORE_A, kind: "sale_post", source_ref_id: saleId,
      })],
    );
    await runSweep();
    expect(await postingEvents(saleId)).toHaveLength(1);

    // The drainer gives up on it: the sweep re-emits a fresh, pending event.
    await deadLetter((await postingEvents(saleId))[0]!.event_id);
    await runSweep();
    const events = await postingEvents(saleId);
    expect(events.map((row) => row.delivery_state)).toEqual(["dead_lettered", "pending"]);

    // A second tick while the new event is pending re-emits nothing.
    await runSweep();
    expect(await postingEvents(saleId)).toHaveLength(2);

    // Once the consumer has created the row, nothing is re-emitted again.
    await consume(events[1]!);
    await deadLetter(events[1]!.event_id);
    await runSweep();
    expect(await postingEvents(saleId)).toHaveLength(2);
    expect(await postingRows(saleId)).toEqual([{ kind: "sale_post" }]);
  });
});

describe("RT-457 (c) — a void with no reversal row is re-driven", () => {
  it("re-emits the reversal intent for the void", async () => {
    if (skip) return;
    const saleId = await seedSale({ ageMinutes: 90, processed: true });
    await e().admin.query(
      `INSERT INTO erpnext_posting_status
         (tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id, payload_hash, status, rejection_category)
       VALUES ($1, $2, $3, 'sale_post', $3, 'pos-rt457', $4, $5, 'permanently_rejected', 'unmapped_item')`,
      [TENANT_A, STORE_A, saleId, `rt457-${saleId}`, "0".repeat(64)],
    );
    const voidId = newSaleId();
    await e().admin.query(
      `INSERT INTO sale_voids
         (id, sale_id, tenant_id, store_id, business_date, source_system, external_id, payload_hash, created_by, created_at)
       VALUES ($1, $2, $3, $4, current_date, 'pos-rt457', $5, $6, $7, now() - interval '30 minutes')`,
      [voidId, saleId, TENANT_A, STORE_A, `void-${voidId}`, "0".repeat(64), ACTOR_A],
    );

    await runSweep();

    const events = await postingEvents(voidId);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      sale_id: saleId,
      store_id: STORE_A,
      kind: "reversal",
      source_ref_id: voidId,
    });
    await consume(events[0]!);
    expect(await postingRows(voidId)).toEqual([{ kind: "reversal" }]);
  });
});

describe("RT-457 — tenant scope and repeat runs", () => {
  it("re-drives each tenant's own stranded sale under that tenant only", async () => {
    if (skip) return;
    const saleB = await seedSale({ tenant: "B", ageMinutes: 60 });

    await runSweep();
    await runSweep();

    expect((await saleState(saleB)).processed).toBe(true);
    const events = await postingEvents(saleB);
    expect(events).toHaveLength(1);
    expect(events[0]!.tenant_id).toBe(TENANT_B);
    expect(events[0]!.store_id).toBe(STORE_B);
  });
});
