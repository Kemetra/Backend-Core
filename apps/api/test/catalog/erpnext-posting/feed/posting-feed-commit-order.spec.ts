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
import type { Pool } from "pg";
import { servedAcrossConcurrentCommit } from "../../../../../../packages/db/__tests__/_helpers/posting-feed";
import { expectWaitsForPostingFeedLock } from "../../../_helpers/posting-feed-lock";
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
    const transientAck = (workItemRef: string) => (pool: Pool) =>
      new ErpnextPostingService(pool).ackOutcome({
        tenantId: TENANT_A,
        workItemRef,
        outcome: "failed_transient",
      });
    const served = await servedAcrossConcurrentCommit({
      app: env!.app,
      tenantId: TENANT_A,
      pausesAfter: /sequence\s*=\s*DEFAULT/i,
      heldWriter: transientAck(POST_A_PENDING),
      otherWriter: transientAck(POST_A_REVERSAL),
    });
    expect(served.map((row) => row.id)).toEqual(
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
