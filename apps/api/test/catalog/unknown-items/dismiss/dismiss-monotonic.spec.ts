/**
 * T542 — 005-WAVE1-DISMISS — Monotonic lifecycle spec.
 *
 * Acceptance (slice 005-WAVE1-DISMISS validation contract):
 *   GREEN — FR-004 monotonic lifecycle:
 *     - Attempting to dismiss an already-`dismissed` row returns 409
 *       `already_reconciled`; row state unchanged (resolved_at,
 *       resolved_by, resolution_action all stay as they were on the
 *       first dismiss)
 *     - Attempting to dismiss a `resolved` row returns 409
 *       `already_reconciled`; row state unchanged
 *     - Attempting to dismiss an unknown UUID (cross-tenant probe OR
 *       genuinely non-existent) returns 404 NON-DISCLOSING (same
 *       response shape SI-001/SI-004/FR-013/FR-092 mandates)
 *
 * Why 404 ≠ 409:
 *   - 404 = "RLS filtered the row out — either it belongs to another
 *     tenant or it doesn't exist anywhere". MUST NOT leak existence.
 *   - 409 = "the row IS visible to you (RLS admits it), but the
 *     lifecycle UPDATE rejected because the status isn't `pending`".
 *     This response is informative because the caller has authority
 *     to see the row's current state.
 *
 *   The service's UPDATE-first + conditional-SELECT pattern
 *   distinguishes the two atomically (avoiding the race where a
 *   concurrent dismiss could change the answer between checks).
 *
 * Spec anchors:
 *   - FR-004: `pending → resolved`, `pending → dismissed`, no other
 *     transitions; terminal states are immutable
 *   - SI-001 / SI-004 / FR-013 / FR-092: non-disclosing 404 on
 *     cross-tenant or non-existent probes
 *   - Research §R2: `error.code = "already_reconciled"` for the
 *     409 path
 *   - Slice contract stop rule: "if UPDATE clause omits
 *     WHERE resolution_status='pending' (would violate FR-004
 *     monotonicity)" — this spec is the empirical guard against
 *     that defect
 *
 * Wiring strategy
 * ---------------
 * Service-direct only (no supertest case — the happy-path spec
 * already covers the HTTP boundary). Service-direct exercises the
 * UPDATE-first + conditional SELECT logic where the lifecycle
 * invariant lives.
 *
 * Docker:
 *   Testcontainers Postgres 16 required. Honors
 *   `MIGRATION_TEST_ALLOW_SKIP=1`.
 */
import {
  ConflictException,
  NotFoundException,
} from "@nestjs/common";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { seedCatalogIsolationFixture } from "../../__support__/isolation-harness";
import {
  seedUnknownItemsFixture,
  UNKNOWN_ITEMS_FIXTURE_IDS,
} from "../../__support__/seed-unknown-items";
import { UnknownItemsService } from "../../../../src/catalog/unknown-items/unknown-items.service";

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let service: UnknownItemsService | null = null;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await seedUnknownItemsFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T542 dismiss-monotonic.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  service = new UnknownItemsService(env.app);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

// Reset fixture rows between tests — each `it` sets up its own
// lifecycle state and we don't want bleed.
afterEach(async () => {
  if (dockerSkipped || !env) return;
  await env.admin.query(
    `UPDATE unknown_items
        SET resolution_status = 'pending',
            resolution_action = NULL,
            resolved_at       = NULL,
            resolved_by       = NULL,
            resolved_product_id = NULL
      WHERE id = ANY($1)`,
    [
      [
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode,
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode,
      ],
    ],
  );
});

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn(
      "[T542 dismiss-monotonic.spec] skipping — Docker unavailable",
    );
    return true;
  }
  return false;
}

const ACTOR_USER_ID = "0a000000-0000-7000-8000-0000000005af";

// ---------------------------------------------------------------------------
// T542 — 409 already_reconciled on non-pending rows
// ---------------------------------------------------------------------------

describe("T542 / 005-WAVE1-DISMISS — FR-004 monotonic lifecycle (409 paths)", () => {
  it("re-dismissing a dismissed row → 409 already_reconciled; row state unchanged", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");
    if (!env) throw new Error("env not constructed");

    // Seed the row in `dismissed` terminal state directly via admin
    // pool — bypasses the dismiss endpoint (which we want to test
    // re-entering, not setting up).
    const SEEDED_RESOLVED_BY = "0a000000-0000-7000-8000-0000000005ee";
    await env.admin.query(
      `UPDATE unknown_items
          SET resolution_status = 'dismissed',
              resolution_action = 'dismissed',
              resolved_at       = now(),
              resolved_by       = $2
        WHERE id = $1`,
      [UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode, SEEDED_RESOLVED_BY],
    );

    // Capture the pre-attempt timestamp so we can prove the row
    // wasn't re-stamped by the rejected call.
    const before = await env.admin.query<{
      resolved_at: Date;
      resolved_by: string;
    }>(
      "SELECT resolved_at, resolved_by FROM unknown_items WHERE id = $1",
      [UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode],
    );
    const beforeResolvedAt = before.rows[0]!.resolved_at;
    const beforeResolvedBy = before.rows[0]!.resolved_by;

    // Attempt re-dismiss → should throw ConflictException.
    await expect(
      service.dismissUnknownItem({
        id: UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode,
        tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
        storeScope: { kind: "tenant" },
        actorUserId: ACTOR_USER_ID,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Verify the row state is unchanged — the UPDATE's WHERE clause
    // matched 0 rows (monotonicity guard worked), so neither
    // resolved_at nor resolved_by were re-stamped.
    const after = await env.admin.query<{
      resolved_at: Date;
      resolved_by: string;
      resolution_status: string;
    }>(
      "SELECT resolved_at, resolved_by, resolution_status FROM unknown_items WHERE id = $1",
      [UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode],
    );
    expect(after.rows[0]!.resolution_status).toBe("dismissed");
    expect(after.rows[0]!.resolved_at.getTime()).toBe(
      beforeResolvedAt.getTime(),
    );
    expect(after.rows[0]!.resolved_by).toBe(beforeResolvedBy);
  });

  it("dismissing a resolved row → 409 already_reconciled; row state unchanged", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");
    if (!env) throw new Error("env not constructed");

    // Seed the row as `resolved` (simulating Wave 2's eventual link
    // outcome) — needs a real product_id since the CHK constraint
    // `unknown_items_linked_product_present` requires it for
    // `resolution_action IN ('linked', 'created')`. Use one of the
    // products the 003 isolation fixture seeded for tenant A.
    const tenantAProduct = await env.admin.query<{ id: string }>(
      "SELECT id FROM tenant_products WHERE tenant_id = $1 LIMIT 1",
      [UNKNOWN_ITEMS_FIXTURE_IDS.tenantA],
    );
    const SEEDED_PRODUCT_ID = tenantAProduct.rows[0]?.id;
    if (!SEEDED_PRODUCT_ID) {
      throw new Error(
        "Expected tenant A to have a seeded product from isolation-harness",
      );
    }

    await env.admin.query(
      `UPDATE unknown_items
          SET resolution_status = 'resolved',
              resolution_action = 'linked',
              resolved_at       = now(),
              resolved_by       = $2,
              resolved_product_id = $3
        WHERE id = $1`,
      [
        UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode,
        ACTOR_USER_ID,
        SEEDED_PRODUCT_ID,
      ],
    );

    // Attempt to dismiss the resolved row → should reject as
    // already_reconciled.
    await expect(
      service.dismissUnknownItem({
        id: UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode,
        tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
        storeScope: { kind: "tenant" },
        actorUserId: ACTOR_USER_ID,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Row stays `resolved` with action `linked` — the rejected
    // dismiss MUST NOT silently overwrite the resolution_action.
    const after = await env.admin.query<{
      resolution_status: string;
      resolution_action: string;
      resolved_product_id: string;
    }>(
      `SELECT resolution_status, resolution_action, resolved_product_id
         FROM unknown_items WHERE id = $1`,
      [UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode],
    );
    expect(after.rows[0]!.resolution_status).toBe("resolved");
    expect(after.rows[0]!.resolution_action).toBe("linked");
    expect(after.rows[0]!.resolved_product_id).toBe(SEEDED_PRODUCT_ID);

    // Reset the row to its `pending` state after this test (afterEach
    // covers unknownAYBarcode, but the resolved_product_id needs to
    // clear too — afterEach's NULL on resolved_product_id handles it).
  });
});

// ---------------------------------------------------------------------------
// T542 — 404 non-disclosing on cross-tenant / non-existent
// ---------------------------------------------------------------------------

describe("T542 / 005-WAVE1-DISMISS — SI-001/004 non-disclosing 404", () => {
  it("dismissing a row that exists in ANOTHER tenant → 404 non-disclosing (NOT 409)", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");

    // Tenant A actor attempts to dismiss a row that lives in tenant B's
    // scope. RLS filters it out at both the UPDATE (rowCount=0) and
    // the conditional SELECT (also 0 rows because the row is invisible
    // to tenant A's context). Service classifies as 404.
    await expect(
      service.dismissUnknownItem({
        id: UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXBarcode, // tenant B's row
        tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA, // tenant A's context
        storeScope: { kind: "tenant" },
        actorUserId: ACTOR_USER_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Verify B's row is unchanged (admin pool bypasses RLS) — tenant
    // A's rejected dismiss MUST NOT have touched B's data.
    const bRow = await env!.admin.query<{ resolution_status: string }>(
      "SELECT resolution_status FROM unknown_items WHERE id = $1",
      [UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXBarcode],
    );
    expect(bRow.rows[0]!.resolution_status).toBe("pending");
  });

  it("dismissing a UUID that doesn't exist anywhere → 404 non-disclosing", async () => {
    if (maybeSkip()) return;
    if (!service) throw new Error("service not constructed");

    // Hex-only UUIDv7 literal per the user feedback memory
    // (feedback_uuid_hex_literals — burned twice in prior sessions).
    const NEVER_EXISTED = "0e000000-0000-7000-8000-0000000005df";

    await expect(
      service.dismissUnknownItem({
        id: NEVER_EXISTED,
        tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
        storeScope: { kind: "tenant" },
        actorUserId: ACTOR_USER_ID,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
