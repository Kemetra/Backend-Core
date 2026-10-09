/**
 * RT-325 — ErpnextPostingService.pullPostings orders by the NUMERIC sequence.
 *
 * Regression guard for a feed that sorted `sequence::text` lexicographically
 * ("10" < "9"): a page that crossed a digit boundary returned the higher
 * sequence first and advanced the cursor past the lower one, so a `pending` row
 * was never offered again (reproduced on the rt9 lab, RT-316 round 4).
 *
 * Seeds the 015 posting-status fixture, then re-heads its two tenant-A pending
 * rows to sequences 9 and 10 the way repair does (`sequence = DEFAULT`). The
 * assertions are on the returned cursor — what the connector persists.
 *
 * Docker policy mirrors posting-feed.spec: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
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
    const a = env.admin;
    // Next DEFAULT = 9: the reversal row takes 9, the sale_post row takes 10.
    await a.query(
      `SELECT setval(pg_get_serial_sequence('erpnext_posting_status', 'sequence'), 8)`,
    );
    await a.query(
      `UPDATE erpnext_posting_status SET sequence = DEFAULT WHERE id = $1`,
      [POST_A_REVERSAL],
    );
    await a.query(
      `UPDATE erpnext_posting_status SET sequence = DEFAULT WHERE id = $1`,
      [POST_A_PENDING],
    );
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-feed-ordering.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function svc(): ErpnextPostingService {
  if (!env) throw new Error("Docker unavailable");
  return new ErpnextPostingService(env.app);
}

describe("ErpnextPostingService.pullPostings — RT-325 numeric sequence order", () => {
  it("a one-row page starts at the lowest pending sequence (9 before 10)", async () => {
    if (skip) return;
    const page = await svc().pullPostings({ tenantId: TENANT_A, since: null, limit: 1 });
    expect(page.cursor).toBe("9");
  });

  it("paging on from 9 reaches 10 — no pending row is skipped", async () => {
    if (skip) return;
    const page = await svc().pullPostings({ tenantId: TENANT_A, since: 9n, limit: 1 });
    expect(page.cursor).toBe("10");
  });

  it("a full page advances the cursor to the highest sequence it scanned", async () => {
    if (skip) return;
    const page = await svc().pullPostings({ tenantId: TENANT_A, since: null, limit: 100 });
    expect(page.cursor).toBe("10");
  });
});
