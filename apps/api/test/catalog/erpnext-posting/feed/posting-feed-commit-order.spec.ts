/**
 * RT-456 (RT-447 F01) — the posting feed stays complete when sequence-drawing
 * transactions commit out of order.
 *
 * `sequence` is an identity drawn when the row is written, and the connector
 * persists the cursor of the last row served. A transient ack re-heads its row
 * (`sequence = DEFAULT`); if that transaction commits after a later sequence
 * was already served, the row is never offered again. This spec holds one
 * re-head open, lets a second re-head run, pulls the feed, then releases the
 * first and pulls again from the persisted cursor: every pending row must have
 * been served.
 *
 * Docker policy mirrors posting-feed.spec: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { expectWaitsForPostingFeedLock, pausingPool } from "../../../_helpers/posting-feed-lock";
import { ErpnextPostingService } from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import {
  POSTING_STATUS_FIXTURE_IDS,
  POST_A_PENDING,
  POST_A_REVERSAL,
  seedPostingStatusFixture,
} from "../__support__/seed-posting-status";

let env: PgTestEnv | null = null;
let skip = false;

const TENANT_A = POSTING_STATUS_FIXTURE_IDS.tenantA;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPostingStatusFixture(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-feed-commit-order.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

/** The connector's pull: the exact pullPostings predicate/order, as the app role under RLS. */
async function pullFeed(since: string | null): Promise<{ refs: string[]; cursor: string | null }> {
  const client = await env!.app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [TENANT_A]);
    const r = await client.query<{ id: string; sequence: string }>(
      `SELECT id, sequence::text AS sequence
         FROM erpnext_posting_status
        WHERE status = 'pending'
          AND ($1::bigint IS NULL OR sequence > $1::bigint)
        ORDER BY erpnext_posting_status.sequence`,
      [since],
    );
    await client.query("COMMIT");
    const last = r.rows[r.rows.length - 1];
    // An empty page echoes `since` (erpnext-posting.controller.ts).
    return { refs: r.rows.map((row) => row.id), cursor: last ? last.sequence : since };
  } finally {
    client.release();
  }
}

async function resetPending(): Promise<void> {
  await env!.admin.query(
    `UPDATE erpnext_posting_status
        SET status = 'pending', retry_count = 0, document_ref = NULL, rejection_category = NULL
      WHERE id = ANY($1::uuid[])`,
    [[POST_A_PENDING, POST_A_REVERSAL]],
  );
}

describe("RT-456 — posting feed completeness under concurrent commit", () => {
  it("a transient re-head that commits after a later sequence was served is still offered", async () => {
    if (skip) return;
    await resetPending();
    const start = (await pullFeed(null)).cursor;

    // Ack 1 re-heads its row (draws a new sequence) and is held open.
    const held = pausingPool(env!.app, /sequence\s*=\s*DEFAULT/i);
    const ack1 = new ErpnextPostingService(held.pool).ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "failed_transient",
    });
    await held.paused;

    // Ack 2 re-heads the other row concurrently.
    const ack2 = new ErpnextPostingService(env!.app).ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_REVERSAL,
      outcome: "failed_transient",
    });
    await Promise.race([ack2, new Promise((resolve) => setTimeout(resolve, 1_000))]);

    // The connector pulls now and persists the returned cursor ...
    const first = await pullFeed(start);
    held.release();
    await Promise.all([ack1, ack2]);
    // ... then pulls again from it.
    const second = await pullFeed(first.cursor);

    expect([...first.refs, ...second.refs]).toEqual(
      expect.arrayContaining([POST_A_PENDING, POST_A_REVERSAL]),
    );
  }, 30_000);

  it("an ack waits for the tenant posting-feed lock", async () => {
    if (skip) return;
    await resetPending();
    await expectWaitsForPostingFeedLock(env!.admin, TENANT_A, () =>
      new ErpnextPostingService(env!.app).ackOutcome({
        tenantId: TENANT_A,
        workItemRef: POST_A_PENDING,
        outcome: "failed_transient",
      }),
    );
  });
});
