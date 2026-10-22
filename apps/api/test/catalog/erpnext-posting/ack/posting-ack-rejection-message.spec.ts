/**
 * RT-410 — the Connector's rejection message is kept on the dead-lettered
 * posting row (AD-POSTING-001 D-1 to D-5; contract `reconciliation.yaml`
 * 1.3.0-draft `PostingBacklogItem.reason`; migration 0071).
 *
 * Proves, against real Postgres with every migration:
 *   - a `permanently_rejected` and a `reconciliation_required` ack store the
 *     sanitised message (`erpnext_posting_status.rejection_message`);
 *   - a re-ack of the same outcome is an O-3 echo and keeps the FIRST message
 *     (G5); an RT-333 superseded-version ack changes nothing;
 *   - Backend-Core-raised dead-letters (retry budget exhausted) and a
 *     reconciliation from a superseded `posted` ack (no reason) store null;
 *   - a reconciliation upgrade of an earlier rejection stores the fresh
 *     message (with the first two cases, one table); a message with nothing
 *     left after sanitising is null and the ack is still accepted;
 *   - the CHECKs refuse a message on a row that is not dead-lettered, and an
 *     empty or over-long one;
 *   - no audit row carries the message (G4).
 *
 * Docker policy mirrors posting-ack.spec: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import {
  ErpnextPostingService,
  POSTING_RETRY_BUDGET,
  type AckOutcomeInput,
} from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import {
  POSTING_STATUS_FIXTURE_IDS,
  POST_A_PENDING,
  seedPostingStatusFixture,
} from "../__support__/seed-posting-status";

let env: PgTestEnv | null = null;
let skip = false;

const TENANT_A = POSTING_STATUS_FIXTURE_IDS.tenantA;
const DOC = { doctype: "Sales Invoice", name: "ACC-SINV-A-0410" };
const MARKER = "rt410-marker-7f3c";
const FIRST = `RepresentationMismatch: representation: rate 12.50 != 12.5 (${MARKER}) dp2_token=abc123`;
const FIRST_STORED = `RepresentationMismatch: representation: rate 12.50 != 12.5 (${MARKER}) dp2_token=[redacted]`;
const SECOND = "NameError: name 'flt' is not defined";

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPostingStatusFixture(env);
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-ack-rejection-message.spec] Docker unavailable: ${String(err)}`);
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

/** Put the row back to pending at frozen version `version`, with no message. */
async function resetPending(version: number | null = 1, retryCount = 0): Promise<void> {
  await env!.admin.query(
    `UPDATE erpnext_posting_status
        SET status = 'pending', document_ref = NULL, posted_at = NULL, rejection_category = NULL,
            reconciliation_document_ref = NULL, rejection_message = NULL, retry_count = $3,
            current_resolution_version = $2
      WHERE id = $1`,
    [POST_A_PENDING, version, retryCount],
  );
}

async function stored(): Promise<{ status: string; category: string | null; message: string | null }> {
  const r = await env!.admin.query<{ status: string; category: string | null; message: string | null }>(
    `SELECT status, rejection_category AS category, rejection_message AS message
       FROM erpnext_posting_status WHERE id = $1`,
    [POST_A_PENDING],
  );
  return r.rows[0]!;
}

const rejected = (message: string, category: "validation" | "other" = "validation"): AckOutcomeInput => ({
  tenantId: TENANT_A,
  workItemRef: POST_A_PENDING,
  outcome: "permanently_rejected",
  reason: { category, message },
});

const reconciliation = (message: string): AckOutcomeInput => ({
  tenantId: TENANT_A,
  workItemRef: POST_A_PENDING,
  outcome: "reconciliation_required",
  documentRef: DOC,
  reason: { category: "validation", message },
});

type StoredRow = Awaited<ReturnType<typeof stored>>;

describe("RT-410 — the message is stored with the dead-letter, sanitised", () => {
  it.each<[string, () => AckOutcomeInput[], StoredRow]>([
    [
      "permanently_rejected stores the sanitised message",
      () => [rejected(FIRST)],
      { status: "permanently_rejected", category: "validation", message: FIRST_STORED },
    ],
    [
      "reconciliation_required stores the sanitised message",
      () => [reconciliation(FIRST)],
      { status: "permanently_rejected", category: "reconciliation_required", message: FIRST_STORED },
    ],
    [
      "a reconciliation upgrade of an earlier rejection stores the fresh message",
      () => [rejected(FIRST), reconciliation(SECOND)],
      { status: "permanently_rejected", category: "reconciliation_required", message: SECOND },
    ],
  ])("%s", async (_label, acks, expected) => {
    if (skip) return;
    await resetPending();
    for (const ack of acks()) await svc().ackOutcome(ack);
    expect(await stored()).toEqual(expected);
  });

  it("a message with nothing left after sanitising is null, and the ack is still recorded", async () => {
    if (skip) return;
    await resetPending();
    const rec = await svc().ackOutcome(rejected("\u0000\u0007\n   ", "other"));
    expect(rec.outcome.outcome).toBe("permanently_rejected");
    expect(await stored()).toEqual({ status: "permanently_rejected", category: "other", message: null });
  });
});

describe("RT-410 — retention (G5)", () => {
  it("a re-ack of the same outcome with another message is an O-3 echo and keeps the first", async () => {
    if (skip) return;
    await resetPending();
    await svc().ackOutcome(rejected(FIRST));
    const again = await svc().ackOutcome(rejected(SECOND));
    expect(again.replayed).toBe(true);
    expect((await stored()).message).toBe(FIRST_STORED);
  });

  it("a repeated reconciliation_required ack keeps the first message", async () => {
    if (skip) return;
    await resetPending();
    await svc().ackOutcome(reconciliation(FIRST));
    const again = await svc().ackOutcome(reconciliation(SECOND));
    expect(again.replayed).toBe(true);
    expect((await stored()).message).toBe(FIRST_STORED);
  });

  it("an RT-333 ack from a superseded resolution version changes nothing", async () => {
    if (skip) return;
    await resetPending(2);
    await svc().ackOutcome(rejected(FIRST));
    const before = await stored();
    const stale = await svc().ackOutcome({ ...rejected(SECOND, "other"), resolutionVersion: 1 });
    expect(stale.replayed).toBe(true);
    expect(await stored()).toEqual(before);
  });

});

describe("RT-410 — dead-letters with no Connector message are null", () => {
  it("the retry budget exhausted by Backend-Core", async () => {
    if (skip) return;
    await resetPending(1, POSTING_RETRY_BUDGET);
    await svc().ackOutcome({ tenantId: TENANT_A, workItemRef: POST_A_PENDING, outcome: "failed_transient" });
    expect(await stored()).toEqual({ status: "permanently_rejected", category: "retry_budget_exhausted", message: null });
  });

  it("a reconciliation recorded from a superseded posted ack (a posted ack carries no reason)", async () => {
    if (skip) return;
    await resetPending(2);
    await svc().ackOutcome({
      tenantId: TENANT_A,
      workItemRef: POST_A_PENDING,
      outcome: "posted",
      documentRef: DOC,
      resolutionVersion: 1,
    });
    expect(await stored()).toEqual({ status: "permanently_rejected", category: "reconciliation_required", message: null });
  });
});

describe("RT-410 — the database CHECKs (migration 0071)", () => {
  /** The SQLSTATE `sql` fails with, or null. */
  async function codeOf(sql: string, params: unknown[]): Promise<string | null> {
    try {
      await env!.admin.query(sql, params);
      return null;
    } catch (err: unknown) {
      return (err as { code?: string }).code ?? String(err);
    }
  }

  it("refuses a message on a row that is not dead-lettered", async () => {
    if (skip) return;
    await resetPending();
    expect(
      await codeOf(`UPDATE erpnext_posting_status SET rejection_message = 'x' WHERE id = $1`, [POST_A_PENDING]),
    ).toBe("23514");
  });

  it.each([
    ["an empty message", ""],
    ["a message over 1000 characters", "x".repeat(1001)],
  ])("refuses %s on a dead-letter", async (_label, message) => {
    if (skip) return;
    await resetPending();
    await svc().ackOutcome(rejected(FIRST));
    expect(
      await codeOf(`UPDATE erpnext_posting_status SET rejection_message = $2 WHERE id = $1`, [POST_A_PENDING, message]),
    ).toBe("23514");
  });
});

describe("RT-410 — the message is never audited (G4)", () => {
  it("no audit_events row carries it", async () => {
    if (skip) return;
    await resetPending();
    await svc().ackOutcome(rejected(FIRST));
    const r = await env!.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE metadata::text LIKE $1`,
      [`%${MARKER}%`],
    );
    expect(r.rows[0]).toEqual({ n: 0 });
  });
});
