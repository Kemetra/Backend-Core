/**
 * RT-333 — an attempt from a superseded resolution version never changes the row.
 *
 * An operator re-resolution (RT-333) moves a pending intent from version n to
 * n+1 and re-heads it while a connector may still hold the version-n attempt.
 * A `failed_transient` / `permanently_rejected` ack echoing a version other
 * than the row's current one reports on a resolution that no longer applies:
 * it makes NO transition (no dead-letter, no retry increment, no re-head) and
 * is answered with a benign echo — never a 409, which the connector treats as
 * an operator alarm. (A stale `posted` is still recorded for reconciliation,
 * RT-332: an ERP document exists.) An ack without a version is unchanged.
 *
 * Docker policy mirrors posting-ack.spec: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
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
const DOC = { doctype: "Sales Invoice", name: "ACC-SINV-A-0333" };
const REASON = { category: "unmapped_item" as const, message: "item not in ERPNext" };

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPostingStatusFixture(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-ack-superseded.spec] Docker unavailable: ${String(err)}`);
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

async function setRow(status: string, version: number): Promise<void> {
  await env!.admin.query(
    `UPDATE erpnext_posting_status
        SET status = $2, current_resolution_version = $3, rejection_category = NULL,
            reconciliation_document_ref = NULL, retry_count = 0,
            document_ref = CASE WHEN $2 = 'posted' THEN $4 ELSE NULL END
      WHERE id = $1`,
    [POST_A_PENDING, status, version, JSON.stringify(DOC)],
  );
}

interface RowState {
  status: string;
  category: string | null;
  retries: number;
  seq: string;
}

async function row(): Promise<RowState> {
  const r = await env!.admin.query<RowState>(
    `SELECT status, rejection_category AS category, retry_count AS retries,
            sequence::text AS seq
       FROM erpnext_posting_status WHERE id = $1`,
    [POST_A_PENDING],
  );
  return r.rows[0]!;
}

function rejectAck(resolutionVersion?: number) {
  return svc().ackOutcome({
    tenantId: TENANT_A,
    workItemRef: POST_A_PENDING,
    outcome: "permanently_rejected",
    reason: REASON,
    ...(resolutionVersion !== undefined ? { resolutionVersion } : {}),
  });
}

describe("RT-333 — a superseded attempt on a pending row", () => {
  it("a stale permanently_rejected leaves the row pending at its current version", async () => {
    if (skip) return;
    await setRow("pending", 2);
    const before = await row();
    const rec = await rejectAck(1);
    expect(rec.replayed).toBe(true);
    expect(rec.outcome).toMatchObject({ outcome: "failed_transient", dlqueued: false, documentRef: null });
    expect(await row()).toEqual(before);
  });

  it("a stale failed_transient neither spends a retry nor re-heads", async () => {
    if (skip) return;
    await setRow("pending", 2);
    const before = await row();
    await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "failed_transient",
      resolutionVersion: 1,
    });
    expect(await row()).toEqual(before);
  });

  it("a current-version permanently_rejected still dead-letters", async () => {
    if (skip) return;
    await setRow("pending", 2);
    const rec = await rejectAck(2);
    expect(rec.outcome.dlqueued).toBe(true);
    expect((await row()).status).toBe("permanently_rejected");
  });

  it("a permanently_rejected without a version is unchanged (older connector)", async () => {
    if (skip) return;
    await setRow("pending", 2);
    await rejectAck();
    expect((await row()).status).toBe("permanently_rejected");
  });
});

describe("RT-333 — a superseded attempt on a terminal row", () => {
  it("a stale permanently_rejected on a posted row echoes the posted row, no conflict", async () => {
    if (skip) return;
    await setRow("posted", 2);
    const rec = await rejectAck(1);
    expect(rec.replayed).toBe(true);
    expect(rec.outcome).toMatchObject({ outcome: "posted", documentRef: DOC });
    expect((await row()).status).toBe("posted");
  });
});
