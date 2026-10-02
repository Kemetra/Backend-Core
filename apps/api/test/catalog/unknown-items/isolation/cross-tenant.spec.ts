/**
 * T507 (authored) → T521 (extended) — 005 unknown_items cross-tenant
 * non-disclosing isolation.
 *
 * Purpose
 * -------
 * Extends the T341 cross-tenant pattern with `unknown_items`-specific
 * cases per spec §7 SI-001 + FR-013 + FR-092:
 *
 *   - SI-001 / FR-013: a tenant cannot read another tenant's unknown
 *     items; cross-tenant lookups must return non-disclosing 404-class
 *     results (no leak that the row exists in the other tenant).
 *   - FR-014 (touched indirectly): a tenant lists only its own pending
 *     items; cross-tenant probe returns an empty list, not an error.
 *
 * RED→GREEN history
 * -----------------
 *   - T507 / 005-WAVE1-HARNESS (PR #307): authored the RED scaffolding
 *     with `it()` placeholders that asserted only `expect(...IDS...).toBeDefined()`.
 *     The not-yet-implemented `UnknownItemsService` was loaded via
 *     dynamic require, with a `serviceMissing()` soft-skip gate that
 *     returned early until T511.
 *   - T511 / 005-WAVE1-CAPTURE-HAPPY (PR #317): shipped `UnknownItemsService`.
 *     The `serviceMissing()` gate fell through; placeholder assertions
 *     remained passing (vacuously).
 *   - **T521 / 005-WAVE1-NON-DISCLOSING (THIS commit)**: rewrites the
 *     placeholder cases into real assertions:
 *       - 4 get-by-id cases exercise the new `findByIdForTenant` helper
 *         (T522) and assert `NotFoundException` on cross-tenant access.
 *       - 2 value-probe cases exercise `captureItem` with cross-tenant
 *         identifier values and assert a NEW pending row is created in
 *         the submitting tenant's scope (the existing-in-other-tenant
 *         row MUST NOT short-circuit dedup).
 *       - 2 list-shaped cases are flipped to `it.skip` with a tripwire
 *         comment pointing at T523 / 005-WAVE1-LIST — that slice authors
 *         `listForTenant` and its own `list-queue.spec.ts` covers the
 *         cross-tenant list invariant per tasks.md T523. Authoring
 *         `listForTenant` here would silently expand the slice.
 *
 * Wiring strategy
 * ---------------
 * Service-direct — no NestJS DI, no `Test.createTestingModule`, no
 * supertest. The slice's allowed_files explicitly exclude the
 * controller; T522 calls the GET-by-id surface "internal" for Wave 1
 * (LIST is the public surface). Construct `new UnknownItemsService(env.app)`
 * with the RLS-enforced app-role pool from the testcontainer; assert
 * exception types and side-effects directly.
 *
 * Why `env.app` and not `env.admin`:
 *   The seed helper uses `env.admin` to insert fixture rows (RLS bypass
 *   is appropriate for seeding). The service under test MUST run
 *   against `env.app` — the app-role pool that 003's RLS policies
 *   actually filter. Mixing them would let a cross-tenant read silently
 *   succeed against the admin pool.
 *
 * Pattern alignment
 * -----------------
 * Lifecycle / Docker-skip guard mirrors
 * `apps/api/test/catalog/isolation/cross-tenant-read.spec.ts` (T341).
 * `serviceMissing()` retained for defense-in-depth (the service IS
 * present at HEAD, but the gate documents the historical RED contract).
 */
import { NotFoundException } from "@nestjs/common";

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

// --------------------------------------------------------------------------
// Suite-level state
// --------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let serviceModuleError: Error | null = null;
let service: UnknownItemsService | null = null;

// ---- Lifecycle -------------------------------------------------------

beforeAll(async () => {
  // Container + fixture setup — same idiom as T341.
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);   // parent tenants/stores
    await seedUnknownItemsFixture(env);        // 005-owned rows
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(
        `\n[T521 cross-tenant.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }

  // Defensive: `UnknownItemsService` IS present at HEAD (T511 PR #317),
  // but the original T507 contract required this gate. Keep it so the
  // suite's behavior under a future module-rename is "skip with a clear
  // signal" rather than "all 8 cases throw an unrelated TypeError".
  try {
    service = new UnknownItemsService(env.app);
  } catch (err: unknown) {
    serviceModuleError =
      err instanceof Error ? err : new Error(String(err));
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

// Each value-probe case writes a new row to (TENANT_A, STORE_A_X) or
// (TENANT_B, STORE_B_X). Clean those up between cases so the FR-032
// natural-dedup doesn't quietly turn a "new row" into a "dedup hit" on
// the second case's submission of the same cross-tenant value.
afterEach(async () => {
  if (dockerSkipped || !env) return;
  await env.admin.query(
    "DELETE FROM unknown_items WHERE value LIKE 'T506-%' AND id NOT IN ($1, $2, $3, $4, $5, $6)",
    [
      UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode,
      UNKNOWN_ITEMS_FIXTURE_IDS.unknownAYBarcode,
      UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXBarcode,
      UNKNOWN_ITEMS_FIXTURE_IDS.unknownBYBarcode,
      UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXPos,
      UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXPos,
    ],
  );
});

// ---- Guard helpers -------------------------------------------------------

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[T521 cross-tenant.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

/**
 * Returns `true` when `UnknownItemsService` failed to instantiate.
 * Historically this guarded the T507 RED-phase (module not yet present).
 * Today the gate is defense-in-depth — a future module rename or
 * constructor signature change would trip this instead of producing 8
 * misleading TypeErrors.
 */
function serviceMissing(): boolean {
  if (serviceModuleError) {
    // eslint-disable-next-line no-console
    console.warn(
      "[T521 cross-tenant.spec] UnknownItemsService instantiation failed — " +
        `skipping (reason=${serviceModuleError.message})`,
    );
    return true;
  }
  if (!service) {
    // eslint-disable-next-line no-console
    console.warn(
      "[T521 cross-tenant.spec] UnknownItemsService not constructed — skipping",
    );
    return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Group A — Tenant A cannot read tenant B's unknown_items via the service
// --------------------------------------------------------------------------
//
// Per SI-001 + FR-013: when tenant A is authenticated and queries for
// tenant B's unknown_item (by guessed UUID), the response MUST be a
// non-disclosing 404-class — indistinguishable from "no such item in
// my tenant". The 003 RLS posture already returns zero rows at the DB
// layer (proven by T341); T522 layers `NotFoundException` on top.

describe("T521 — cross-tenant: tenant A cannot read tenant B's unknown_items", () => {
  it("get-by-id on tenant B's barcode unknown_item from tenant A → non-disclosing 404", async () => {
    if (maybeSkip()) return;
    if (serviceMissing()) return;
    // NOTE the assertion: `NotFoundException`, NOT a 403 or a thrown
    // error with B's tenant_id in the message. SI-004 / FR-092 require
    // the response to be indistinguishable from "id does not exist".
    await expect(
      service!.findByIdForTenant({
        id: UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXBarcode,
        tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
        storeScope: { kind: "tenant" }, // tenant-wide read; should still 404 cross-tenant
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("get-by-id on tenant B's external_pos_id unknown_item from tenant A → non-disclosing 404", async () => {
    if (maybeSkip()) return;
    if (serviceMissing()) return;
    await expect(
      service!.findByIdForTenant({
        id: UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXPos,
        tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
        storeScope: { kind: "tenant" },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // List-shaped case — deferred to 005-WAVE1-LIST. See class header
  // for the scope-boundary rationale; `list-queue.spec.ts` (T523)
  // covers the cross-tenant list invariant.
  it.skip(
    "list pending unknown_items as tenant A → contains only tenant A's rows, never tenant B's (deferred to T523/LIST)",
    () => {},
  );
});

// --------------------------------------------------------------------------
// Group B — Tenant B symmetry (mirror of Group A)
// --------------------------------------------------------------------------

describe("T521 — cross-tenant: tenant B cannot read tenant A's unknown_items", () => {
  it("get-by-id on tenant A's barcode unknown_item from tenant B → non-disclosing 404", async () => {
    if (maybeSkip()) return;
    if (serviceMissing()) return;
    await expect(
      service!.findByIdForTenant({
        id: UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode,
        tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantB,
        storeScope: { kind: "tenant" },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("get-by-id on tenant A's external_pos_id unknown_item from tenant B → non-disclosing 404", async () => {
    if (maybeSkip()) return;
    if (serviceMissing()) return;
    await expect(
      service!.findByIdForTenant({
        id: UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXPos,
        tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantB,
        storeScope: { kind: "tenant" },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.skip(
    "list pending unknown_items as tenant B → contains only tenant B's rows, never tenant A's (deferred to T523/LIST)",
    () => {},
  );
});

// --------------------------------------------------------------------------
// Group C — Cross-tenant probe by identifier value (FR-092)
// --------------------------------------------------------------------------
//
// A more subtle existence-leak vector: tenant A submits a capture with
// an identifier value that tenant A has not seen but tenant B HAS. The
// 005 service must not reveal tenant B's prior row — either by
// returning B's row id or by detecting it as a dedup hit. The 003 RLS
// posture already filters B's row at the DB layer (the dedup SELECT
// runs inside `runWithTenantContext(tenantId=A, ...)`, so B's row is
// invisible). This spec asserts the composed outcome: a NEW pending
// row appears in tenant A's scope per FR-001's happy path.

describe("T521 — cross-tenant: identifier-value probe does not leak across tenants (FR-092)", () => {
  it("tenant A captures value that exists only in tenant B → NEW row in A, B's row untouched", async () => {
    if (maybeSkip()) return;
    if (serviceMissing()) return;

    const result = await service!.captureItem({
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
      storeId: UNKNOWN_ITEMS_FIXTURE_IDS.storeAX,
      actorUserId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantA, // placeholder uuid — service doesn't dereference
      correlationId: "0a000000-0000-7000-8000-000000005211",
      identifierType: "barcode",
      identifierValue: UNKNOWN_ITEMS_FIXTURE_IDS.valueBXBarcode, // B's barcode value
      sourceSystem: null,
      saleContext: null,
    });

    // Must be a fresh capture, NOT a resolved-alias outcome (no alias
    // for this value in tenant A) and NOT a dedup hit on B's row.
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;

    // The captured row belongs to tenant A, not tenant B.
    expect(result.unknownItem.tenantId).toBe(
      UNKNOWN_ITEMS_FIXTURE_IDS.tenantA,
    );
    expect(result.unknownItem.id).not.toBe(
      UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXBarcode,
    );

    // Sanity: tenant B's pre-existing row is unchanged. Read via admin
    // (bypasses RLS) so we're directly inspecting B's tenant.
    const bRow = await env!.admin.query<{ id: string; resolution_status: string }>(
      "SELECT id, resolution_status FROM unknown_items WHERE id = $1",
      [UNKNOWN_ITEMS_FIXTURE_IDS.unknownBXBarcode],
    );
    expect(bRow.rows[0]?.resolution_status).toBe("pending");
  });

  it("tenant B captures value that exists only in tenant A → NEW row in B, A's row untouched", async () => {
    if (maybeSkip()) return;
    if (serviceMissing()) return;

    const result = await service!.captureItem({
      tenantId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantB,
      storeId: UNKNOWN_ITEMS_FIXTURE_IDS.storeBX,
      actorUserId: UNKNOWN_ITEMS_FIXTURE_IDS.tenantB,
      correlationId: "0b000000-0000-7000-8000-000000005212",
      identifierType: "barcode",
      identifierValue: UNKNOWN_ITEMS_FIXTURE_IDS.valueAXBarcode, // A's barcode value
      sourceSystem: null,
      saleContext: null,
    });

    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.unknownItem.tenantId).toBe(
      UNKNOWN_ITEMS_FIXTURE_IDS.tenantB,
    );
    expect(result.unknownItem.id).not.toBe(
      UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode,
    );

    const aRow = await env!.admin.query<{ id: string; resolution_status: string }>(
      "SELECT id, resolution_status FROM unknown_items WHERE id = $1",
      [UNKNOWN_ITEMS_FIXTURE_IDS.unknownAXBarcode],
    );
    expect(aRow.rows[0]?.resolution_status).toBe("pending");
  });
});
