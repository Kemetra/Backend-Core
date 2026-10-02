/**
 * replay.spec.ts — 008 US5 T060.
 *
 * The same captureSale submitted N times with the SAME Idempotency-Key is a
 * deterministic replay: exactly ONE sales row, an identical response on every
 * attempt, and `Idempotent-Replayed: true` on every retry after the first
 * (FR-050/100, SC-003). Reuses the shipped Idempotency-Key interceptor — no new
 * primitive (FR-051).
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  type HarnessHandle,
} from "../capture/__capture-harness";

const h: HarnessHandle = { harness: null, dockerSkipped: false };
const RETRIES = 5;

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));
afterEach(async () => {
  if (h.harness) {
    await h.harness.env.admin.query(
      "DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sales WHERE source_system = 'pos-1'",
    );
  }
});

describe("T060 — captureSale idempotent replay on a repeated Idempotency-Key", () => {
  it("same key x5 → one row, identical response, replay marker on retries", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const body = captureBody({ externalId: "ext-replay" });
    const key = idempKey("replay");

    const responses = [];
    for (let i = 0; i < RETRIES; i += 1) {
      responses.push(
        await h.harness
          .http()
          .post("/api/pos/v1/sales")
          .set("Idempotency-Key", key)
          .send(body),
      );
    }

    for (const res of responses) {
      expect(res.status).toBe(201);
      expect(res.body).toEqual(responses[0]!.body);
    }
    // First is the real write; every retry is an interceptor replay.
    expect(responses[0]!.headers["idempotent-replayed"]).toBeUndefined();
    for (let i = 1; i < RETRIES; i += 1) {
      expect(responses[i]!.headers["idempotent-replayed"]).toBe("true");
    }

    const count = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sales WHERE external_id = 'ext-replay'`,
    );
    expect(count.rows[0]?.n).toBe("1");
  });
});
