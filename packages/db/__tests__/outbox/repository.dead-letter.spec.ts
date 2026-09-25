/**
 * T591 [P7][Track C][1C-C1] -- Outbox dead-letter triage queries (DB).
 *
 * Integration test for `listDeadLettered` + `getDeadLettered` from
 * `packages/db/src/outbox/repository.ts`. Pins:
 *
 *   1. Both queries run under `runWithTenantContext({ tenantId: null,
 *      isPlatformAdmin: true })` and see rows from MULTIPLE tenants
 *      (the operator role is platform-scoped).
 *   2. The SELECT NEVER projects `payload`, even when the column
 *      contains a PII canary string.
 *   3. Filter predicates (`event_type`, `tenant_id`) work.
 *   4. Cursor pagination orders by `(occurred_at DESC, event_id DESC)`
 *      and is stable across calls.
 *   5. `getDeadLettered` returns NULL for rows in any state other than
 *      `dead_lettered` (delivered / failed / pending / claimed) -- the
 *      controller maps null to 404 so these are externally
 *      indistinguishable from a missing UUID.
 *   6. `sanitizeLastErrorClass` redacts unsafe column contents (defence
 *      in depth -- the column SHOULD only contain class names, but if a
 *      regression introduces a raw exception string, the API does not
 *      leak it).
 *   7. The runtime app role still sees zero rows without the platform-
 *      admin GUC (RLS proof) -- no `BYPASSRLS` grant required.
 *
 * Docker / Testcontainers: required. Set MIGRATION_TEST_ALLOW_SKIP=1 to
 * soft-skip in local environments without Docker (matches the convention
 * used in `repository.spec.ts` / `retention.spec.ts`).
 */
import {
  APP_ROLE_NAME,
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import {
  getDeadLettered,
  listDeadLettered,
  sanitizeLastErrorClass,
} from "../../src/outbox/repository";
import { runWithTenantContext } from "../../src/middleware/tenant-context";

// ---------------------------------------------------------------------------
// Fixture UUIDs -- prefix "0de" (dead-letter endpoint), distinct from other
// suites. NOTE: UUID literals are restricted to [0-9a-f]; an earlier draft
// used "0dle..." which is rejected by Postgres because 'l' is not hex.
// ---------------------------------------------------------------------------
const TENANT_A = "0dea0000-0000-7000-8000-000000000001";
const TENANT_B = "0deb0000-0000-7000-8000-000000000002";

// Dead-letter rows for tenant A (3 with different occurred_at for cursor tests)
const EVENT_A_DEAD_NEWEST = "0de10000-0000-4000-8000-000000000001";
const EVENT_A_DEAD_MID    = "0de10000-0000-4000-8000-000000000002";
const EVENT_A_DEAD_OLDEST = "0de10000-0000-4000-8000-000000000003";

// Dead-letter row for tenant B (proves cross-tenant visibility)
const EVENT_B_DEAD = "0de20000-0000-4000-8000-000000000001";

// Tenant A: same occurred_at as one of the dead rows but different event_id
// (used for deterministic tie-breaker via event_id DESC).
const EVENT_A_DEAD_TIE = "0de10000-0000-4000-8000-000000000099";

// Non-dead-lettered rows for tenant A — MUST be invisible to the endpoint.
const EVENT_A_PENDING = "0de30000-0000-4000-8000-000000000001";
const EVENT_A_CLAIMED = "0de30000-0000-4000-8000-000000000002";
const EVENT_A_FAILED   = "0de30000-0000-4000-8000-000000000003";
const EVENT_A_DELIVERED = "0de30000-0000-4000-8000-000000000004";

// Dead-letter rows for tenant A with different event_type (for filter test).
const EVENT_A_DEAD_OTHER_TYPE = "0de40000-0000-4000-8000-000000000001";

// Dead-letter row with an UNSAFE last_error value (defence-in-depth probe).
const EVENT_A_DEAD_UNSAFE_ERR = "0de50000-0000-4000-8000-000000000001";

// Platform-scoped dead-letter row (tenant_id NULL since migration 0031).
const EVENT_PLATFORM_DEAD = "0de60000-0000-4000-8000-000000000002";
const NIL_TENANT_ID = "00000000-0000-0000-0000-000000000000";

// PII canary -- if this string ever shows up in a response, the test fails.
const PII_CANARY = "pii-canary@example.test";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);

    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1, 'dle-tenant-a', 'DLE Tenant A'),
         ($2, 'dle-tenant-b', 'DLE Tenant B')`,
      [TENANT_A, TENANT_B],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[outbox/repository.dead-letter.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn(
      "[outbox/repository.dead-letter.spec] skipping (Docker unavailable)",
    );
    return true;
  }
  return false;
}

/**
 * Seed an outbox row directly via the admin pool with controllable
 * timestamps for cursor-ordering tests. Payload always carries the PII
 * canary so the "no payload leak" assertion has something to fail on if
 * the projection accidentally widens.
 */
async function seedEvent(opts: {
  eventId: string;
  tenantId: string | null;
  eventType: string;
  deliveryState:
    | "pending"
    | "claimed"
    | "delivered"
    | "failed"
    | "dead_lettered";
  attempts?: number;
  /**
   * Occurred-at offset in seconds from "now" (negative = older). Tests
   * use small offsets to keep relative ordering deterministic without
   * waiting for real time to pass.
   */
  occurredSecondsAgo: number;
  lastError?: string | null;
}): Promise<void> {
  const {
    eventId,
    tenantId,
    eventType,
    deliveryState,
    attempts = 0,
    occurredSecondsAgo,
    lastError = null,
  } = opts;

  const includeProcessedAt =
    deliveryState === "delivered" || deliveryState === "dead_lettered";

  await env!.admin.query(
    `INSERT INTO outbox_events
       (event_id, tenant_id, event_type, payload,
        delivery_state, attempts, last_error,
        occurred_at, created_at, updated_at, processed_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7,
       now() - make_interval(secs => $8),
       now() - make_interval(secs => $8),
       now() - make_interval(secs => $8),
       CASE WHEN $9::boolean THEN now() - make_interval(secs => $8) ELSE NULL END
     )
     ON CONFLICT (event_id) DO NOTHING`,
    [
      eventId,
      tenantId,
      eventType,
      JSON.stringify({ ref: eventId, actor_label: PII_CANARY }),
      deliveryState,
      attempts,
      lastError,
      occurredSecondsAgo,
      includeProcessedAt,
    ],
  );
}

// ===========================================================================
// Seed
// ===========================================================================

beforeAll(async () => {
  if (dockerSkipped) return;

  // Tenant A: three dead-lettered rows at distinct occurred_at.
  // Lower seconds-ago value = MORE recent (closer to now).
  await seedEvent({
    eventId: EVENT_A_DEAD_NEWEST,
    tenantId: TENANT_A,
    eventType: "audit.event.created",
    deliveryState: "dead_lettered",
    attempts: 8,
    occurredSecondsAgo: 10,
    lastError: "ConsumerTimeout",
  });
  await seedEvent({
    eventId: EVENT_A_DEAD_MID,
    tenantId: TENANT_A,
    eventType: "audit.event.created",
    deliveryState: "dead_lettered",
    attempts: 8,
    occurredSecondsAgo: 60,
    lastError: "DownstreamError",
  });
  await seedEvent({
    eventId: EVENT_A_DEAD_OLDEST,
    tenantId: TENANT_A,
    eventType: "audit.event.created",
    deliveryState: "dead_lettered",
    attempts: 8,
    occurredSecondsAgo: 600,
    lastError: null,
  });

  // Tenant B: one dead-lettered row (cross-tenant visibility under PA GUC).
  await seedEvent({
    eventId: EVENT_B_DEAD,
    tenantId: TENANT_B,
    eventType: "audit.event.created",
    deliveryState: "dead_lettered",
    attempts: 8,
    occurredSecondsAgo: 5,
    lastError: "TenantBOnly",
  });

  // Tenant A: NON-dead-letter rows in every other state.
  await seedEvent({
    eventId: EVENT_A_PENDING,
    tenantId: TENANT_A,
    eventType: "audit.event.created",
    deliveryState: "pending",
    occurredSecondsAgo: 30,
  });
  await seedEvent({
    eventId: EVENT_A_CLAIMED,
    tenantId: TENANT_A,
    eventType: "audit.event.created",
    deliveryState: "claimed",
    attempts: 1,
    occurredSecondsAgo: 30,
  });
  await seedEvent({
    eventId: EVENT_A_FAILED,
    tenantId: TENANT_A,
    eventType: "audit.event.created",
    deliveryState: "failed",
    attempts: 3,
    occurredSecondsAgo: 30,
    lastError: "TransientError",
  });
  await seedEvent({
    eventId: EVENT_A_DELIVERED,
    tenantId: TENANT_A,
    eventType: "audit.event.created",
    deliveryState: "delivered",
    occurredSecondsAgo: 30,
  });

  // Tenant A: dead-letter with a DIFFERENT event_type (filter test).
  await seedEvent({
    eventId: EVENT_A_DEAD_OTHER_TYPE,
    tenantId: TENANT_A,
    eventType: "manual.outbox.test",
    deliveryState: "dead_lettered",
    attempts: 8,
    occurredSecondsAgo: 120,
    lastError: "ManualClass",
  });

  // Tenant A: dead-letter with an UNSAFE last_error value (raw message
  // with whitespace + quotes). The repo's sanitizer MUST replace it
  // with null in the projection.
  await seedEvent({
    eventId: EVENT_A_DEAD_UNSAFE_ERR,
    tenantId: TENANT_A,
    eventType: "audit.event.created",
    deliveryState: "dead_lettered",
    attempts: 8,
    occurredSecondsAgo: 700,
    lastError: `RuntimeError: connection refused at host '${PII_CANARY}'`,
  });

  // Tenant A: dead-letter with the SAME occurred_at as a "tie" row,
  // used to prove the (event_id DESC) tie-breaker.
  //
  // We force exact equality of occurred_at via a deterministic UPDATE
  // after insert (make_interval() seconds-precision is otherwise
  // sub-millisecond noisy).
  await seedEvent({
    eventId: EVENT_A_DEAD_TIE,
    tenantId: TENANT_A,
    eventType: "audit.event.created",
    deliveryState: "dead_lettered",
    attempts: 8,
    occurredSecondsAgo: 60, // same bucket as EVENT_A_DEAD_MID
    lastError: "TieRow",
  });
  await env!.admin.query(
    `UPDATE outbox_events SET occurred_at = (SELECT occurred_at FROM outbox_events WHERE event_id = $1)
       WHERE event_id = $2`,
    [EVENT_A_DEAD_MID, EVENT_A_DEAD_TIE],
  );

  // Platform-scoped row: stored NULL, listed as the nil UUID.
  await seedEvent({
    eventId: EVENT_PLATFORM_DEAD,
    tenantId: null,
    eventType: "audit.event.created",
    deliveryState: "dead_lettered",
    attempts: 8,
    occurredSecondsAgo: 900,
    lastError: "PlatformRow",
  });
}, 60_000);

// ===========================================================================
// Suite 1: sanitizeLastErrorClass unit-level behaviour
// ===========================================================================
describe("sanitizeLastErrorClass (unit)", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["   ", null],
    ["ConsumerTimeout", "ConsumerTimeout"],
    ["pg.QueryError", "pg.QueryError"],
    ["My_Error_42", "My_Error_42"],
  ])(
    "value %p sanitises to %p",
    (input: unknown, expected: string | null) => {
      expect(sanitizeLastErrorClass(input)).toBe(expected);
    },
  );

  it("rejects values containing whitespace (raw error messages)", () => {
    expect(sanitizeLastErrorClass("Runtime Error")).toBeNull();
    expect(sanitizeLastErrorClass("RuntimeError: details")).toBeNull();
  });

  it("rejects values with leading or trailing whitespace (regression: must NOT trim-then-accept)", () => {
    // CodeRabbit review on PR #240: an earlier version of the sanitizer
    // trimmed-then-validated, which silently repaired malformed input.
    // The new contract rejects any whitespace so the absence is loud.
    expect(sanitizeLastErrorClass(" ConsumerTimeout")).toBeNull();
    expect(sanitizeLastErrorClass("ConsumerTimeout ")).toBeNull();
    expect(sanitizeLastErrorClass(" ConsumerTimeout ")).toBeNull();
    expect(sanitizeLastErrorClass("\tConsumerTimeout")).toBeNull();
    expect(sanitizeLastErrorClass("ConsumerTimeout\n")).toBeNull();
  });

  it("rejects values containing quotes or braces", () => {
    expect(sanitizeLastErrorClass('Err"injection"')).toBeNull();
    expect(sanitizeLastErrorClass("Err{payload}")).toBeNull();
    expect(sanitizeLastErrorClass("Err'sql'")).toBeNull();
  });

  it("rejects pathologically long strings", () => {
    const long = "A".repeat(200);
    expect(sanitizeLastErrorClass(long)).toBeNull();
  });

  it("rejects non-string types", () => {
    expect(sanitizeLastErrorClass(42)).toBeNull();
    expect(sanitizeLastErrorClass({ name: "Err" })).toBeNull();
    expect(sanitizeLastErrorClass([])).toBeNull();
  });
});

// ===========================================================================
// Suite 2: listDeadLettered -- happy path (DL-1)
// ===========================================================================
describe("listDeadLettered (DL-1) — cross-tenant visibility under PA GUC", () => {
  it("sees dead-letters from BOTH tenants in a single platform-admin call", async () => {
    if (maybeSkip()) return;
    const rows = await listDeadLettered(env!.app, { limit: 100 });
    const ids = rows.map((r) => r.event_id);
    expect(ids).toContain(EVENT_A_DEAD_NEWEST);
    expect(ids).toContain(EVENT_B_DEAD);
  });

  it("returns ONLY dead_lettered rows (excludes pending/claimed/failed/delivered)", async () => {
    if (maybeSkip()) return;
    const rows = await listDeadLettered(env!.app, { limit: 100 });
    for (const row of rows) {
      expect(row.delivery_state).toBe("dead_lettered");
    }
    const ids = rows.map((r) => r.event_id);
    expect(ids).not.toContain(EVENT_A_PENDING);
    expect(ids).not.toContain(EVENT_A_CLAIMED);
    expect(ids).not.toContain(EVENT_A_FAILED);
    expect(ids).not.toContain(EVENT_A_DELIVERED);
  });
});

// ===========================================================================
// Suite 3: redaction (DL-2)
// ===========================================================================
describe("listDeadLettered (DL-2) — redaction discipline", () => {
  it("response rows never carry a `payload` field, even though the column is populated", async () => {
    if (maybeSkip()) return;
    const rows = await listDeadLettered(env!.app, { limit: 100 });
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("payload");
      // Extra defence: ensure the serialised row does not contain the PII canary.
      expect(JSON.stringify(row)).not.toContain(PII_CANARY);
    }
  });

  it("unsafe last_error column content is suppressed to null", async () => {
    if (maybeSkip()) return;
    const rows = await listDeadLettered(env!.app, { limit: 100 });
    const unsafe = rows.find((r) => r.event_id === EVENT_A_DEAD_UNSAFE_ERR);
    expect(unsafe).toBeDefined();
    expect(unsafe!.last_error_class).toBeNull();
  });

  it("safe last_error column content is exposed as-is", async () => {
    if (maybeSkip()) return;
    const rows = await listDeadLettered(env!.app, { limit: 100 });
    const safe = rows.find((r) => r.event_id === EVENT_A_DEAD_NEWEST);
    expect(safe).toBeDefined();
    expect(safe!.last_error_class).toBe("ConsumerTimeout");
  });

  it("response row keys exactly match the allowlist (defence against widening)", async () => {
    if (maybeSkip()) return;
    const rows = await listDeadLettered(env!.app, { limit: 1 });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;
    expect(new Set(Object.keys(row))).toEqual(
      new Set([
        "event_id",
        "event_type",
        "tenant_id",
        "store_id",
        "delivery_state",
        "attempts",
        "correlation_id",
        "last_error_class",
        "occurred_at",
        // occurred_at_text is the µs-precision projection used for the
        // keyset cursor (see admin.query.schema.ts). It is internal to
        // the repository/service contract; the service's `toDto`
        // mapper drops it before the row reaches the wire.
        "occurred_at_text",
        "created_at",
        "updated_at",
        "processed_at",
      ]),
    );
  });

  it("occurred_at_text projection matches the documented µs-precision shape", async () => {
    if (maybeSkip()) return;
    const rows = await listDeadLettered(env!.app, { limit: 1 });
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;
    // Exact 27-char shape: yyyy-MM-ddTHH:mm:ss.UUUUUUZ
    expect(row.occurred_at_text).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    );
  });
});

// ===========================================================================
// Suite 4: filters (DL-3)
// ===========================================================================
describe("listDeadLettered (DL-3) — filters", () => {
  it("eventType filter narrows results to a single event type", async () => {
    if (maybeSkip()) return;
    const rows = await listDeadLettered(env!.app, {
      eventType: "manual.outbox.test",
      limit: 100,
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) expect(r.event_type).toBe("manual.outbox.test");
    expect(rows.map((r) => r.event_id)).toContain(EVENT_A_DEAD_OTHER_TYPE);
  });

  it("tenantId filter restricts results to one tenant", async () => {
    if (maybeSkip()) return;
    const rows = await listDeadLettered(env!.app, {
      tenantId: TENANT_B,
      limit: 100,
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) expect(r.tenant_id).toBe(TENANT_B);
    expect(rows.map((r) => r.event_id)).toContain(EVENT_B_DEAD);
    expect(rows.map((r) => r.event_id)).not.toContain(EVENT_A_DEAD_NEWEST);
  });

  it("nil-UUID tenantId filter returns platform rows (stored NULL) only", async () => {
    if (maybeSkip()) return;
    const rows = await listDeadLettered(env!.app, {
      tenantId: NIL_TENANT_ID,
      limit: 100,
    });
    expect(rows.map((r) => r.event_id)).toEqual([EVENT_PLATFORM_DEAD]);
    expect(rows[0]!.tenant_id).toBe(NIL_TENANT_ID);
  });

  it("filters compose: eventType + tenantId together", async () => {
    if (maybeSkip()) return;
    const rows = await listDeadLettered(env!.app, {
      tenantId: TENANT_A,
      eventType: "manual.outbox.test",
      limit: 100,
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.event_id).toBe(EVENT_A_DEAD_OTHER_TYPE);
  });

  it("empty filter result returns []", async () => {
    if (maybeSkip()) return;
    const rows = await listDeadLettered(env!.app, {
      eventType: "no.such.event.type",
      limit: 100,
    });
    expect(rows).toEqual([]);
  });
});

// ===========================================================================
// Suite 5: pagination (DL-4)
// ===========================================================================
describe("listDeadLettered (DL-4) — pagination", () => {
  it("orders by occurred_at DESC, event_id DESC", async () => {
    if (maybeSkip()) return;
    const rows = await listDeadLettered(env!.app, {
      tenantId: TENANT_A,
      eventType: "audit.event.created",
      limit: 100,
    });
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!;
      const cur = rows[i]!;
      // CodeRabbit review on PR #240: `Date#getTime()` truncates the
      // timestamp to milliseconds, so two rows that share a ms bucket
      // but differ at the microsecond level compared via `.getTime()`
      // would (incorrectly) be marked as a tie. The repository's
      // ORDER BY occurred_at DESC orders by the underlying µs-precision
      // column, so the test MUST compare at the same precision -- use
      // the µs-text projection from `mapRow()`.
      if (cur.occurred_at_text > prev.occurred_at_text) {
        throw new Error(
          `occurred_at ordering violated at i=${i}: prev=${prev.occurred_at_text} cur=${cur.occurred_at_text}`,
        );
      }
      if (cur.occurred_at_text === prev.occurred_at_text) {
        // Tie at µs precision -- event_id MUST be DESC.
        expect(cur.event_id < prev.event_id).toBe(true);
      }
    }
  });

  it("cursor advances strictly past the cursor row (no re-emission)", async () => {
    if (maybeSkip()) return;
    const page1 = await listDeadLettered(env!.app, {
      tenantId: TENANT_A,
      eventType: "audit.event.created",
      limit: 2,
    });
    expect(page1.length).toBe(2);

    const cursor = {
      occurredAtText: page1[1]!.occurred_at_text,
      eventId: page1[1]!.event_id,
    };
    const page2 = await listDeadLettered(env!.app, {
      tenantId: TENANT_A,
      eventType: "audit.event.created",
      cursor,
      limit: 100,
    });
    const page2Ids = page2.map((r) => r.event_id);
    // No row from page1 reappears.
    for (const r of page1) expect(page2Ids).not.toContain(r.event_id);
  });

  it("limit caps the row count", async () => {
    if (maybeSkip()) return;
    const rows = await listDeadLettered(env!.app, { limit: 1 });
    expect(rows.length).toBe(1);
  });

  it("rejects non-positive limit", async () => {
    if (maybeSkip()) return;
    await expect(
      listDeadLettered(env!.app, { limit: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      listDeadLettered(env!.app, { limit: -1 }),
    ).rejects.toThrow(RangeError);
  });

  it("microsecond-precision cursor paginates two sub-ms rows without gap or duplicate (DL-4 regression)", async () => {
    if (maybeSkip()) return;
    // CodeRabbit review on PR #240: the previous cursor codec carried
    // `Date.toISOString()` (ms-precision), so two dead-letters whose
    // `occurred_at` shared a millisecond bucket but differed in
    // microseconds collided in the keyset predicate. Symptom: page 1
    // returns row A, page 2 (cursor = A) re-emits A OR skips B
    // depending on which side of `<` the comparison landed on.
    //
    // The fix carries `occurred_at_text` end-to-end (µs precision) and
    // compares via `$N::timestamptz` against the verbatim string. This
    // regression test seeds two rows whose `occurred_at` values are
    // exactly 1 microsecond apart, drains them with `limit: 1`, and
    // asserts page 2 contains the OTHER row (no gap, no duplicate).

    const tenantId = "0de60000-0000-7000-8000-000000000001";
    const eventBaseTime = `0deb0000-0000-7000-8000-aaaaaaaaaa`;
    // CodeRabbit review on PR #240: the seed UUIDs are intentionally
    // ANTI-CORRELATED with the timestamp ordering. EVENT_OLDER (anchor.t)
    // gets the LEXICOGRAPHICALLY LARGER UUID (`...aa99`); EVENT_NEWER
    // (anchor.t + 1µs) gets the LEXICOGRAPHICALLY SMALLER UUID
    // (`...aa01`). Under DESC ordering by `(occurred_at, event_id)`:
    //   - CORRECT µs-precision impl: NEWER first (timestamp wins),
    //     so page1 must contain EVENT_NEWER (`...aa01`).
    //   - REGRESSED ms-precision impl: timestamps tie at ms, event_id
    //     DESC kicks in, so page1 would contain EVENT_OLDER (`...aa99`).
    // The assertion at the bottom pins EVENT_NEWER as page1's row,
    // which fails LOUDLY for any ms-truncating regression.
    const EVENT_OLDER = `${eventBaseTime}99`;
    const EVENT_NEWER = `${eventBaseTime}01`;

    // Use a fresh tenant so the rows are isolated from the suite-level
    // fixture data (which mixes tenant A's many dead-letters into the
    // page even with eventType filter).
    await env!.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'dle-sub-ms', 'DLE Sub-Ms') ON CONFLICT DO NOTHING`,
      [tenantId],
    );

    // Pick a deterministic "now-anchor" so we can derive the two
    // timestamps from the database itself (avoids the JS-side ms
    // truncation when we INSERT). Both rows are seeded in a single
    // statement that materialises the two µs-offset timestamps from a
    // single `clock_timestamp()` snapshot.
    await env!.admin.query(
      `
      WITH anchor AS (
        SELECT clock_timestamp() AS t
      )
      INSERT INTO outbox_events
        (event_id, tenant_id, event_type, payload,
         delivery_state, attempts, last_error,
         occurred_at, created_at, updated_at, processed_at)
      SELECT
        $1::uuid,  -- EVENT_OLDER -- anchor.t -- LARGER UUID
        $3::uuid,
        'sub.ms.regression',
        '{}'::jsonb,
        'dead_lettered',
        8,
        'SubMsError',
        anchor.t,
        anchor.t,
        anchor.t,
        anchor.t
      FROM anchor
      UNION ALL
      SELECT
        $2::uuid,  -- EVENT_NEWER -- anchor.t + 1µs -- SMALLER UUID
        $3::uuid,
        'sub.ms.regression',
        '{}'::jsonb,
        'dead_lettered',
        8,
        'SubMsError',
        anchor.t + interval '1 microsecond',
        anchor.t + interval '1 microsecond',
        anchor.t + interval '1 microsecond',
        anchor.t + interval '1 microsecond'
      FROM anchor
      `,
      [EVENT_OLDER, EVENT_NEWER, tenantId],
    );

    // Sanity check: confirm the two rows truly land in the same
    // millisecond bucket but differ at the microsecond level. If a
    // future Postgres / driver / OS change ever broke that assumption,
    // the test below would no longer cover the regression.
    const rawProbe = await env!.admin.query<{
      event_id: string;
      occ: string;
      occ_us: string;
    }>(
      `SELECT event_id::text,
              to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occ,
              to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occ_us
         FROM outbox_events
        WHERE tenant_id = $1::uuid AND event_type = 'sub.ms.regression'
        ORDER BY occurred_at ASC`,
      [tenantId],
    );
    expect(rawProbe.rows).toHaveLength(2);
    // Same ms bucket -- the regression precondition.
    expect(rawProbe.rows[0]!.occ).toBe(rawProbe.rows[1]!.occ);
    // Distinct µs -- the precondition the new cursor must preserve.
    expect(rawProbe.rows[0]!.occ_us).not.toBe(rawProbe.rows[1]!.occ_us);

    // Page 1 (newest first, limit 1).
    const page1 = await listDeadLettered(env!.app, {
      tenantId,
      eventType: "sub.ms.regression",
      limit: 1,
    });
    expect(page1).toHaveLength(1);

    // Page 1 MUST be EVENT_NEWER. If the implementation truncates the
    // timestamp comparison to milliseconds the two rows tie at ms, the
    // `event_id DESC` tie-breaker would pick the lexicographically
    // LARGER UUID (EVENT_OLDER, `...aa99`) instead -- this assertion
    // is the regression trap.
    expect(page1[0]!.event_id).toBe(EVENT_NEWER);

    // Page 2 (cursor = page1's last row's µs text + event_id).
    const cursorRow = page1[0]!;
    const page2 = await listDeadLettered(env!.app, {
      tenantId,
      eventType: "sub.ms.regression",
      cursor: {
        occurredAtText: cursorRow.occurred_at_text,
        eventId: cursorRow.event_id,
      },
      limit: 100,
    });

    // Page 2 must be exactly EVENT_OLDER -- no gap (the row must
    // appear) and no duplicate (it must NOT be EVENT_NEWER again).
    expect(page2).toHaveLength(1);
    expect(page2[0]!.event_id).toBe(EVENT_OLDER);

    // The union of page1 + page2 must be exactly the two seeded rows.
    const seenIds = new Set([cursorRow.event_id, page2[0]!.event_id]);
    expect(seenIds).toEqual(new Set([EVENT_OLDER, EVENT_NEWER]));
  });
});

// ===========================================================================
// Suite 6: getDeadLettered (DL-5)
// ===========================================================================
describe("getDeadLettered (DL-5)", () => {
  it("returns the row for a dead-lettered event", async () => {
    if (maybeSkip()) return;
    const row = await getDeadLettered(env!.app, EVENT_A_DEAD_NEWEST);
    expect(row).not.toBeNull();
    expect(row!.event_id).toBe(EVENT_A_DEAD_NEWEST);
    expect(row!.delivery_state).toBe("dead_lettered");
    expect(row!.last_error_class).toBe("ConsumerTimeout");
  });

  it("returns null for a row that exists but is NOT dead_lettered", async () => {
    if (maybeSkip()) return;
    for (const id of [
      EVENT_A_PENDING,
      EVENT_A_CLAIMED,
      EVENT_A_FAILED,
      EVENT_A_DELIVERED,
    ]) {
      const row = await getDeadLettered(env!.app, id);
      expect(row).toBeNull();
    }
  });

  it("returns null for an event_id that does not exist", async () => {
    if (maybeSkip()) return;
    const row = await getDeadLettered(
      env!.app,
      "00000000-0000-4000-8000-deadbeefdead",
    );
    expect(row).toBeNull();
  });

  it("never returns a payload field", async () => {
    if (maybeSkip()) return;
    const row = await getDeadLettered(env!.app, EVENT_A_DEAD_NEWEST);
    expect(row).not.toBeNull();
    expect(Object.keys(row!)).not.toContain("payload");
    expect(JSON.stringify(row)).not.toContain(PII_CANARY);
  });

  it("redacts unsafe last_error column content", async () => {
    if (maybeSkip()) return;
    const row = await getDeadLettered(env!.app, EVENT_A_DEAD_UNSAFE_ERR);
    expect(row).not.toBeNull();
    expect(row!.last_error_class).toBeNull();
  });
});

// ===========================================================================
// Suite 7: RLS proof (DL-6) -- runtime role sees nothing without PA GUC
// ===========================================================================
describe("RLS posture (DL-6) — no BYPASSRLS, GUC-only escape", () => {
  it("app_role fails closed when no tenant context is set (zero rows OR cast error)", async () => {
    if (maybeSkip()) return;
    // Design note (copied from outbox/rls.spec.ts G-8): Postgres custom
    // GUCs default to an empty string when never set, so the policy's
    // `current_setting('app.current_tenant', true)::uuid` cast either
    // returns NULL (Postgres 15+) -> 0 rows, OR throws "invalid input
    // syntax for type uuid: ''" -> caller error. Both outcomes are
    // fail-closed: tenant isolation holds either way, and tenant data
    // is NEVER returned.
    const client = await env!.app.connect();
    try {
      await client.query("BEGIN");
      // Explicitly suppress platform-admin context so the OR-branch
      // of the policy cannot grant visibility.
      await client.query(`SET LOCAL app.is_platform_admin = 'false'`);

      let count: string | null = null;
      let threwMessage: string | null = null;
      try {
        const r = await client.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM outbox_events WHERE delivery_state = 'dead_lettered'",
        );
        count = r.rows[0]?.count ?? null;
      } catch (err: unknown) {
        threwMessage = err instanceof Error ? err.message : String(err);
      }
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }

      // CodeRabbit review on PR #240: narrow the alternate failure
      // mode so unrelated breakages cannot masquerade as fail-closed.
      // Either:
      //   - the query returned exactly 0 rows (Postgres 15+ behaviour
      //     where the `true` second arg to current_setting returns
      //     NULL on unset and `NULL::uuid` makes the policy fail closed), OR
      //   - the query threw, AND the error is the expected RLS UUID-cast
      //     failure ("invalid input syntax for type uuid"). Anything else
      //     (network errors, syntax errors, etc.) is NOT a valid
      //     fail-closed outcome and the test must fail loudly.
      if (threwMessage === null) {
        expect(count).toBe("0");
      } else {
        expect(threwMessage).toMatch(/invalid input syntax for type uuid/);
      }
    } finally {
      client.release();
    }
  });

  it("app_role sees BOTH tenants' dead-letters when platform-admin GUC is active (cross-tenant visibility)", async () => {
    if (maybeSkip()) return;
    // CodeRabbit review on PR #240: `count >= 2` alone is NOT sufficient
    // to prove cross-tenant visibility, because tenant A has multiple
    // dead-letter rows on its own. Pin the actual tenant IDs returned
    // so the assertion fails loudly if the platform-admin OR-branch
    // ever regresses to single-tenant scope.
    const tenantIds = await runWithTenantContext(
      env!.app,
      { tenantId: null, isPlatformAdmin: true },
      async (client) => {
        const res = await client.query<{ tenant_id: string }>(
          "SELECT DISTINCT tenant_id FROM outbox_events WHERE delivery_state = 'dead_lettered'",
        );
        return res.rows.map((r) => r.tenant_id);
      },
    );
    expect(tenantIds).toEqual(expect.arrayContaining([TENANT_A, TENANT_B]));
  });

  it("app_role does NOT hold BYPASSRLS (probes pg_roles)", async () => {
    if (maybeSkip()) return;
    const res = await env!.admin.query<{ rolbypassrls: boolean }>(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = $1`,
      [APP_ROLE_NAME],
    );
    expect(res.rows[0]!.rolbypassrls).toBe(false);
  });
});
