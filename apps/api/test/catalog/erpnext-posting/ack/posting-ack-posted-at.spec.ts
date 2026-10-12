/**
 * posting-ack-posted-at.spec.ts — Jira RT-425 (RT-289 G2-4, Q6).
 *
 * `erpnext_posting_status.posted_at` is the ERP confirmation time: the server
 * clock when the `posted` ack is applied. It is set once — a duplicate ack is
 * an O-3 echo and never moves it — and only a posted row may carry it (CHECK
 * erpnext_posting_status_posted_at_when_posted, migration 0042).
 *
 * Drives `ErpnextPostingService.ackOutcome` directly. Docker policy: HARD
 * failure unless MIGRATION_TEST_ALLOW_SKIP=1.
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
  seedPostingStatusFixture,
} from "../__support__/seed-posting-status";

let env: PgTestEnv | null = null;
let skip = false;

const TENANT_A = POSTING_STATUS_FIXTURE_IDS.tenantA;
const DOC = { doctype: "Sales Invoice", name: "ACC-SINV-A-0425" };

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPostingStatusFixture(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-ack-posted-at.spec] Docker unavailable: ${String(err)}`);
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

async function row(id: string): Promise<{ status: string; posted_at: Date | null; updated_at: Date }> {
  const r = await env!.admin.query<{ status: string; posted_at: Date | null; updated_at: Date }>(
    `SELECT status, posted_at, updated_at FROM erpnext_posting_status WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
}

describe("RT-425 — erpnext_posting_status.posted_at (ERP confirmation time)", () => {
  it("a pending row has no posted_at", async () => {
    if (skip) return;
    const r = await row(POST_A_PENDING);
    expect(r.status).toBe("pending");
    expect(r.posted_at).toBeNull();
  });

  it("the posted ack sets posted_at to the server time it applied the ack", async () => {
    if (skip) return;
    const rec = await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted",
      documentRef: DOC,
    });
    expect(rec.outcome.outcome).toBe("posted");

    const r = await row(POST_A_PENDING);
    expect(r.status).toBe("posted");
    expect(r.posted_at).not.toBeNull();
    // Same transaction clock as the transition's updated_at / recordedAt.
    expect(r.posted_at!.toISOString()).toBe(rec.outcome.recordedAt);
  });

  it("a duplicate posted ack (fresh key, same document) echoes and never moves posted_at", async () => {
    if (skip) return;
    const first = (await row(POST_A_PENDING)).posted_at!.toISOString();
    const rec = await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted",
      documentRef: DOC,
    });
    expect(rec.replayed).toBe(true);
    expect((await row(POST_A_PENDING)).posted_at!.toISOString()).toBe(first);
  });

  it("the database refuses posted_at on a row that is not posted", async () => {
    if (skip) return;
    await expect(
      env!.admin.query(
        `UPDATE erpnext_posting_status
            SET status = 'pending', document_ref = NULL
          WHERE id = $1`,
        [POST_A_PENDING],
      ),
    ).rejects.toThrow(/erpnext_posting_status_posted_at_when_posted/);
  });
});
