/**
 * RT-572 — `consoleUpdatePayerAccount` over HTTP against real Postgres
 * (Testcontainers, every migration, the NOBYPASSRLS `app_test` pool) and the
 * real module graph. Contract: `settlement.yaml` 2.1.0.
 *
 *   PATCH /api/v1/settlement/payer-accounts/{payerRef}
 *
 * What this proves:
 *   - repair: a missing `externalRef` is set, a link replaced, `displayName`
 *     and `status` changed; `version` bumps by one per effective update;
 *   - the order of refusals: RBAC 403 -> validation 400 -> not found / out of
 *     store scope 404 -> tenant-wide scope 403 -> version 409 -> no-op;
 *   - a `status` / `externalRef` field on a tenant-wide payer needs
 *     tenant-wide store scope (403 `payer_scope_insufficient`), by presence;
 *   - idempotent replay, key reuse with another body, concurrent callers;
 *   - the audit row is written in the update's transaction (a failing audit
 *     insert rolls the update back), is tenant-level for a tenant-wide payer,
 *     and is absent on a no-op and on every refusal;
 *   - a posting that froze the payer's link keeps it (RT-332);
 *   - tenant isolation and the store scope as non-disclosing 404s.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import "reflect-metadata";

import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import request from "supertest";

import { PayerAccountsModule } from "../../../src/settlement/payer-accounts.module";
import { applyAllUpAndCreateAppRole, startPgEnv, stopPgEnv, type PgTestEnv } from "../../_helpers/postgres-container";
import { ACTOR_A, STORE_A_X, STORE_A_Y, TENANT_A, TENANT_B } from "../../catalog/__support__/isolation-harness";
import { bootScopedApp } from "../../catalog/erpnext-reconciliation/__support__/read-store-scope";
import {
  contractChecker,
  idempotencyProviders,
  SES_ADMIN_X,
  SES_MANAGER,
  SES_OWNER_ACTIVE_X,
  SES_OWNER_ALL,
  SES_OWNER_B,
  SES_STAFF,
  seedPayerMembers,
} from "../__support__/payer-http-harness";

const BASE = "/api/v1/settlement/payer-accounts";
const UPDATED_ACTION = "settlement.payer_account.updated";
const OWNER_USER = "0a000000-0000-7000-8000-0000004184a1";
const ADMIN_USER = "0a000000-0000-7000-8000-0000004184a2";

const conforms = contractChecker();

let env: PgTestEnv | null = null;
let app: INestApplication | null = null;
let skipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPayerMembers(env);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] !== "1") throw new Error(`Container start failed: ${reason}`);
    skipped = true;
    return;
  }
  app = await bootScopedApp(env, PayerAccountsModule, undefined, { providers: idempotencyProviders() });
}, 240_000);

afterAll(async () => {
  if (app) await app.close();
  if (env) await stopPgEnv(env);
}, 60_000);

const server = () => app!.getHttpServer() as Parameters<typeof request>[0];
const skip = (): boolean => skipped;
let keySeq = 0;
const freshKey = (): string => `rt572-payer-key-${(keySeq += 1).toString().padStart(8, "0")}`;

interface PatchOptions {
  readonly key?: string | null;
}

// The cookie-session Origin check (RT-430) is the shared auth guard's, which this harness fakes; the
// unsafe-method set it applies includes PATCH (`origin-check.ts`, covered by origin-check.http.integration.spec).
function patchRaw(session: string | null, path: string, body: unknown, opts: PatchOptions = {}): request.Test {
  let req = request(server()).patch(path).send(body as object).set("Origin", "http://127.0.0.1");
  if (session !== null) req = req.set("x-test-session", session);
  const key = opts.key === undefined ? freshKey() : opts.key;
  return key === null ? req : req.set("Idempotency-Key", key);
}
const patch = (session: string | null, payerRef: string, body: unknown, opts: PatchOptions = {}): request.Test =>
  patchRaw(session, `${BASE}/${payerRef}`, body, opts);

interface PayerSeed {
  readonly storeId?: string | null;
  readonly tenantId?: string;
  readonly externalRef?: string | null;
  readonly status?: "active" | "suspended";
  readonly displayName?: string;
}

/** A fresh payer at version 0 (tenant-wide, unlinked, active, in tenant A unless told otherwise). */
async function newPayer(seed: PayerSeed = {}): Promise<string> {
  const id = randomUUID();
  await env!.admin.query(
    `INSERT INTO payer_account (id, tenant_id, store_id, category, display_name, external_ref, status)
     VALUES ($1, $2, $3, 'corporate', $4, $5, $6)`,
    [id, seed.tenantId ?? TENANT_A, seed.storeId ?? null, seed.displayName ?? "Update payer", seed.externalRef ?? null, seed.status ?? "active"],
  );
  return id;
}

interface PayerState {
  readonly display_name: string;
  readonly external_ref: string | null;
  readonly status: string;
  readonly version: number;
}
async function payerState(id: string): Promise<PayerState> {
  const r = await env!.admin.query<PayerState>(
    `SELECT display_name, external_ref, status, version FROM payer_account WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
}

interface AuditRow {
  readonly store_id: string | null;
  readonly actor_user_id: string | null;
  readonly tenant_id: string | null;
  readonly target_type: string | null;
  readonly metadata: Record<string, unknown>;
}
async function auditRows(payerId: string): Promise<AuditRow[]> {
  const r = await env!.admin.query<AuditRow>(
    `SELECT store_id::text, actor_user_id::text, tenant_id::text, target_type, metadata
       FROM audit_events WHERE action = $1 AND target_id = $2 ORDER BY occurred_at`,
    [UPDATED_ACTION, payerId],
  );
  return r.rows;
}

function expectError(res: request.Response, status: number, code: string): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
  conforms("Error", res.body);
}

/** A refusal changed nothing: same state, same version, no audit row. */
async function expectUntouched(id: string, before: PayerState): Promise<void> {
  expect(await payerState(id)).toEqual(before);
  expect(await auditRows(id)).toEqual([]);
}

// ===========================================================================
// repair and the effective update
// ===========================================================================
describe("consoleUpdatePayerAccount — update", () => {
  it("repairs a missing externalRef: 200, contract shape, version 0 -> 1, the row updated", async () => {
    if (skip()) return;
    const id = await newPayer();
    const res = await patch(SES_OWNER_ALL, id, { expectedVersion: 0, externalRef: "CUST-REPAIRED" }).expect(200);
    conforms("PayerAccount", res.body);
    expect(res.body).toEqual({
      payerRef: id,
      category: "corporate",
      displayName: "Update payer",
      externalRef: "CUST-REPAIRED",
      status: "active",
      storeId: null,
      version: 1,
    });
    expect(await payerState(id)).toMatchObject({ external_ref: "CUST-REPAIRED", version: 1 });
  });

  it("replaces a link, renames, suspends and reactivates; several fields are one version bump", async () => {
    if (skip()) return;
    const id = await newPayer({ externalRef: "CUST-OLD" });
    const multi = await patch(SES_OWNER_ALL, id, {
      expectedVersion: 0,
      displayName: "Renamed payer",
      externalRef: "CUST-NEW",
      status: "suspended",
    }).expect(200);
    expect(multi.body).toMatchObject({ displayName: "Renamed payer", externalRef: "CUST-NEW", status: "suspended", version: 1 });
    const back = await patch(SES_OWNER_ALL, id, { expectedVersion: 1, status: "active" }).expect(200);
    expect(back.body).toMatchObject({ status: "active", externalRef: "CUST-NEW", version: 2 });
  });

  it("leaves category, store and the other fields alone, and keeps surrounding spaces in a display name", async () => {
    if (skip()) return;
    const id = await newPayer({ storeId: STORE_A_X, externalRef: "CUST-KEEP" });
    const res = await patch(SES_OWNER_ALL, id, { expectedVersion: 0, displayName: " Padded name " }).expect(200);
    expect(res.body).toMatchObject({ category: "corporate", storeId: STORE_A_X, externalRef: "CUST-KEEP", displayName: " Padded name " });
  });

  it("a request that changes nothing is a no-op: 200, version not bumped, no audit", async () => {
    if (skip()) return;
    const id = await newPayer({ externalRef: "CUST-SAME", displayName: "Same name" });
    const before = await payerState(id);
    const res = await patch(SES_OWNER_ALL, id, { expectedVersion: 0, displayName: "Same name", externalRef: "CUST-SAME", status: "active" }).expect(200);
    expect(res.body).toMatchObject({ version: 0, externalRef: "CUST-SAME" });
    conforms("PayerAccount", res.body);
    await expectUntouched(id, before);
  });

  it("a stale expectedVersion is 409 payer_version_conflict, even for a no-op, writing nothing", async () => {
    if (skip()) return;
    const id = await newPayer({ externalRef: "CUST-V" });
    await patch(SES_OWNER_ALL, id, { expectedVersion: 0, displayName: "Bumped" }).expect(200);
    const before = await payerState(id);
    expectError(await patch(SES_OWNER_ALL, id, { expectedVersion: 0, externalRef: "CUST-STALE" }), 409, "payer_version_conflict");
    expectError(await patch(SES_OWNER_ALL, id, { expectedVersion: 0, displayName: "Bumped" }), 409, "payer_version_conflict");
    expectError(await patch(SES_OWNER_ALL, id, { expectedVersion: 7, status: "suspended" }), 409, "payer_version_conflict");
    expect(await payerState(id)).toEqual(before);
    expect(await auditRows(id)).toHaveLength(1);
  });

  it("two callers with the same expectedVersion: exactly one wins, the other is 409", async () => {
    if (skip()) return;
    const id = await newPayer({ externalRef: "CUST-RACE" });
    const [a, b] = await Promise.all([
      patch(SES_OWNER_ALL, id, { expectedVersion: 0, displayName: "Racer A" }),
      patch(SES_OWNER_ALL, id, { expectedVersion: 0, displayName: "Racer B" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await payerState(id)).version).toBe(1);
    expect(await auditRows(id)).toHaveLength(1);
  });
});

// ===========================================================================
// validation
// ===========================================================================
describe("consoleUpdatePayerAccount — validation (400, never 5xx, writing nothing)", () => {
  const LONG_REF = "R".repeat(141);
  it.each([
    ["an empty body", {}],
    ["only expectedVersion", { expectedVersion: 0 }],
    ["no expectedVersion", { displayName: "No version" }],
    ["a null externalRef (the link cannot be cleared)", { expectedVersion: 0, externalRef: null }],
    ["a null displayName", { expectedVersion: 0, displayName: null }],
    ["category (immutable)", { expectedVersion: 0, displayName: "X", category: "insurer" }],
    ["storeId (immutable)", { expectedVersion: 0, displayName: "X", storeId: null }],
    ["a smuggled tenant_id", { expectedVersion: 0, displayName: "X", tenant_id: TENANT_B }],
    ["a smuggled version", { expectedVersion: 0, displayName: "X", version: 3 }],
    ["an unknown status", { expectedVersion: 0, status: "deleted" }],
    ["a negative expectedVersion", { expectedVersion: -1, displayName: "X" }],
    ["a fractional expectedVersion", { expectedVersion: 1.5, displayName: "X" }],
    ["a string expectedVersion", { expectedVersion: "0", displayName: "X" }],
    ["an expectedVersion past int4", { expectedVersion: 2147483648, displayName: "X" }],
    ["an empty displayName", { expectedVersion: 0, displayName: "" }],
    ["a whitespace-only displayName", { expectedVersion: 0, displayName: " \t " }],
    ["a NUL in displayName", { expectedVersion: 0, displayName: "Payer\u0000" }],
    ["a displayName over 200 characters", { expectedVersion: 0, displayName: "N".repeat(201) }],
    ["an empty externalRef", { expectedVersion: 0, externalRef: "" }],
    ["a whitespace-only externalRef", { expectedVersion: 0, externalRef: "   " }],
    ["a leading space in externalRef", { expectedVersion: 0, externalRef: " CUST-1" }],
    ["a trailing space in externalRef", { expectedVersion: 0, externalRef: "CUST-1 " }],
    ["a newline inside externalRef", { expectedVersion: 0, externalRef: "CUST\n1" }],
    ["a tab inside externalRef", { expectedVersion: 0, externalRef: "CUST\t1" }],
    ["a NUL in externalRef", { expectedVersion: 0, externalRef: "CUST\u0000" }],
    ["a zero-width space in externalRef", { expectedVersion: 0, externalRef: "CUST\u200b1" }],
    ["a line separator in externalRef", { expectedVersion: 0, externalRef: "CUST\u20281" }],
    ["a BOM in externalRef", { expectedVersion: 0, externalRef: "\ufeffCUST1" }],
    ["an externalRef over 140 characters", { expectedVersion: 0, externalRef: LONG_REF }],
  ])("refuses %s", async (_name, body) => {
    if (skip()) return;
    const id = await newPayer({ externalRef: "CUST-VALID" });
    const before = await payerState(id);
    expectError(await patch(SES_OWNER_ALL, id, body), 400, "validation_error");
    await expectUntouched(id, before);
  });

  it.each([
    ["not-a-uuid"],
    ["0a000000-0000-7000-8000-00000000zzzz"],
    ["12345"],
    ["%00"],
  ])("refuses the malformed payerRef %s with 400 before any SQL cast", async (payerRef) => {
    if (skip()) return;
    expectError(await patch(SES_OWNER_ALL, payerRef, { expectedVersion: 0, displayName: "X" }), 400, "validation_error");
  });

  it("accepts an externalRef at 140 characters with inner spaces", async () => {
    if (skip()) return;
    const id = await newPayer();
    const ref = `A ${"b".repeat(136)} C`;
    expect(ref).toHaveLength(140);
    const res = await patch(SES_OWNER_ALL, id, { expectedVersion: 0, externalRef: ref }).expect(200);
    expect(res.body.externalRef).toBe(ref);
  });

  it("refuses a write without an Idempotency-Key (400), writing nothing", async () => {
    if (skip()) return;
    const id = await newPayer();
    const before = await payerState(id);
    const res = await patch(SES_OWNER_ALL, id, { expectedVersion: 0, displayName: "No key" }, { key: null });
    expect(res.status).toBe(400);
    await expectUntouched(id, before);
  });
});

// ===========================================================================
// authorization, tenant isolation and store scope
// ===========================================================================
describe("consoleUpdatePayerAccount — authorization and scope", () => {
  it.each([
    ["store_manager", SES_MANAGER],
    ["store_staff", SES_STAFF],
  ])("refuses a %s with 403 (role), writing nothing", async (_role, session) => {
    if (skip()) return;
    const id = await newPayer();
    const before = await payerState(id);
    const res = await patch(session, id, { expectedVersion: 0, displayName: "Refused role" });
    expect(res.status).toBe(403);
    expect((res.body as { error?: { code?: string } }).error?.code).not.toBe("payer_scope_insufficient");
    conforms("Error", res.body);
    await expectUntouched(id, before);
  });

  it("refuses an unauthenticated request with 401", async () => {
    if (skip()) return;
    const id = await newPayer();
    const before = await payerState(id);
    expect((await patch(null, id, { expectedVersion: 0, displayName: "Anon" })).status).toBe(401);
    await expectUntouched(id, before);
  });

  it("another tenant's payer, and an absent one, are the same 404 (tenant isolation)", async () => {
    if (skip()) return;
    const mine = await newPayer({ externalRef: "CUST-A" });
    const theirs = await newPayer({ tenantId: TENANT_B, storeId: null, externalRef: "CUST-B" });
    const mineBefore = await payerState(mine);
    const theirsBefore = await payerState(theirs);
    expectError(await patch(SES_OWNER_B, mine, { expectedVersion: 0, displayName: "Cross tenant" }), 404, "not_found");
    expectError(await patch(SES_OWNER_ALL, theirs, { expectedVersion: 0, displayName: "Cross tenant" }), 404, "not_found");
    expectError(await patch(SES_OWNER_ALL, randomUUID(), { expectedVersion: 0, displayName: "Absent" }), 404, "not_found");
    expect(await payerState(mine)).toEqual(mineBefore);
    expect(await payerState(theirs)).toEqual(theirsBefore);
    expect(await auditRows(mine)).toEqual([]);
    expect(await auditRows(theirs)).toEqual([]);
  });

  it("a store-scoped payer outside the caller's stores is 404 (even with a status field, before the 403 check)", async () => {
    if (skip()) return;
    const inY = await newPayer({ storeId: STORE_A_Y });
    const before = await payerState(inY);
    expectError(await patch(SES_ADMIN_X, inY, { expectedVersion: 0, displayName: "Out of scope" }), 404, "not_found");
    expectError(await patch(SES_ADMIN_X, inY, { expectedVersion: 0, status: "suspended" }), 404, "not_found");
    expectError(await patch(SES_OWNER_ACTIVE_X, inY, { expectedVersion: 0, displayName: "Active store X" }), 404, "not_found");
    await expectUntouched(inY, before);
  });

  it("a store-scoped payer inside the caller's stores is editable, status and externalRef included", async () => {
    if (skip()) return;
    const inX = await newPayer({ storeId: STORE_A_X });
    const res = await patch(SES_ADMIN_X, inX, { expectedVersion: 0, externalRef: "CUST-X-OK", status: "suspended" }).expect(200);
    expect(res.body).toMatchObject({ storeId: STORE_A_X, externalRef: "CUST-X-OK", status: "suspended", version: 1 });
  });

  describe("a tenant-wide payer", () => {
    it("lets a store-restricted caller change only the displayName (200)", async () => {
      if (skip()) return;
      const id = await newPayer();
      const res = await patch(SES_ADMIN_X, id, { expectedVersion: 0, displayName: "Admin renamed" }).expect(200);
      expect(res.body).toMatchObject({ displayName: "Admin renamed", storeId: null, version: 1 });
    });

    it.each([
      ["a status change", { status: "suspended" }],
      ["an externalRef change", { externalRef: "CUST-TENANT-WIDE" }],
      ["status repeating the current value (the gate is by presence)", { status: "active" }],
      ["externalRef repeating the current value (the gate is by presence)", { externalRef: "CUST-CURRENT" }],
      ["a displayName mixed with a status (refused whole)", { displayName: "Mixed", status: "suspended" }],
    ])("refuses %s from a tenant_admin limited to one store: 403 payer_scope_insufficient, writing nothing", async (_name, change) => {
      if (skip()) return;
      const id = await newPayer({ externalRef: "CUST-CURRENT" });
      const before = await payerState(id);
      expectError(await patch(SES_ADMIN_X, id, { expectedVersion: 0, ...change }), 403, "payer_scope_insufficient");
      await expectUntouched(id, before);
    });

    it("refuses an owner whose active store is one store (tenant-wide scope needs all stores, none selected)", async () => {
      if (skip()) return;
      const id = await newPayer();
      const before = await payerState(id);
      expectError(await patch(SES_OWNER_ACTIVE_X, id, { expectedVersion: 0, status: "suspended" }), 403, "payer_scope_insufficient");
      await expectUntouched(id, before);
    });

    it("lets an owner with all stores change the status and the link", async () => {
      if (skip()) return;
      const id = await newPayer();
      const res = await patch(SES_OWNER_ALL, id, { expectedVersion: 0, status: "suspended", externalRef: "CUST-ALL" }).expect(200);
      expect(res.body).toMatchObject({ status: "suspended", externalRef: "CUST-ALL", version: 1 });
    });

    it("decides the scope 403 before the version 409", async () => {
      if (skip()) return;
      const id = await newPayer();
      await patch(SES_OWNER_ALL, id, { expectedVersion: 0, displayName: "Version moved" }).expect(200);
      expectError(await patch(SES_ADMIN_X, id, { expectedVersion: 0, status: "suspended" }), 403, "payer_scope_insufficient");
    });
  });
});

// ===========================================================================
// idempotency
// ===========================================================================
describe("consoleUpdatePayerAccount — idempotency", () => {
  it("a replay returns the stored 200 and does not bump twice; another body under the key is 409", async () => {
    if (skip()) return;
    const id = await newPayer({ externalRef: "CUST-IDEM" });
    const key = freshKey();
    const body = { expectedVersion: 0, displayName: "Idempotent update" };
    const first = await patch(SES_OWNER_ALL, id, body, { key }).expect(200);
    const replay = await patch(SES_OWNER_ALL, id, body, { key });
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body).toEqual(first.body);
    expect((await payerState(id)).version).toBe(1);
    expect(await auditRows(id)).toHaveLength(1);
    expectError(await patch(SES_OWNER_ALL, id, { expectedVersion: 0, displayName: "Another name" }, { key }), 409, "idempotency_key_conflict");
    expect((await payerState(id)).display_name).toBe("Idempotent update");
  });

  it("the same key on two payers is two operations (the path parameter is part of the key)", async () => {
    if (skip()) return;
    const [a, b] = [await newPayer(), await newPayer()];
    const key = freshKey();
    const body = { expectedVersion: 0, externalRef: "CUST-TWO-PAYERS" };
    await patch(SES_OWNER_ALL, a, body, { key }).expect(200);
    const second = await patch(SES_OWNER_ALL, b, body, { key });
    expect(second.status).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBeUndefined();
    expect((await payerState(b)).external_ref).toBe("CUST-TWO-PAYERS");
  });
});

// ===========================================================================
// audit
// ===========================================================================
describe("consoleUpdatePayerAccount — audit", () => {
  it("writes one tenant-level row for a tenant-wide payer: fields, versions, status and link before / after, no display name", async () => {
    if (skip()) return;
    const id = await newPayer();
    await patch(SES_OWNER_ALL, id, {
      expectedVersion: 0,
      displayName: "Audit secret name",
      externalRef: "CUST-AUDIT",
      status: "suspended",
    }).expect(200);
    const rows = await auditRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ store_id: null, actor_user_id: OWNER_USER, tenant_id: TENANT_A, target_type: "payer_account" });
    expect(rows[0]!.metadata).toEqual({
      payerRef: id,
      changedFields: ["displayName", "externalRef", "status"],
      fromVersion: 0,
      toVersion: 1,
      statusFrom: "active",
      statusTo: "suspended",
      externalRefFrom: null,
      externalRefTo: "CUST-AUDIT",
    });
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain("Audit secret name");
  });

  it("carries the payer's store for a store-scoped payer, and only the changed pairs", async () => {
    if (skip()) return;
    const id = await newPayer({ storeId: STORE_A_X, externalRef: "CUST-FROM" });
    await patch(SES_ADMIN_X, id, { expectedVersion: 0, externalRef: "CUST-TO" }).expect(200);
    const rows = await auditRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ store_id: STORE_A_X, actor_user_id: ADMIN_USER });
    expect(rows[0]!.metadata).toEqual({
      payerRef: id,
      changedFields: ["externalRef"],
      fromVersion: 0,
      toVersion: 1,
      externalRefFrom: "CUST-FROM",
      externalRefTo: "CUST-TO",
    });
  });

  it("is written in the update's transaction: a failing audit insert rolls the update back", async () => {
    if (skip()) return;
    const id = await newPayer({ externalRef: "CUST-ATOMIC" });
    const before = await payerState(id);
    await env!.admin.query(
      `CREATE OR REPLACE FUNCTION rt572_fail_audit() RETURNS trigger LANGUAGE plpgsql AS
         $$ BEGIN RAISE EXCEPTION 'rt572 audit failure'; END $$`,
    );
    await env!.admin.query(
      `CREATE TRIGGER rt572_fail_audit BEFORE INSERT ON audit_events
         FOR EACH ROW WHEN (NEW.action = '${UPDATED_ACTION}') EXECUTE FUNCTION rt572_fail_audit()`,
    );
    try {
      const res = await patch(SES_OWNER_ALL, id, { expectedVersion: 0, displayName: "Rolled back" });
      expect(res.status).toBe(500);
      expect(await payerState(id)).toEqual(before);
    } finally {
      await env!.admin.query(`DROP TRIGGER IF EXISTS rt572_fail_audit ON audit_events`);
      await env!.admin.query(`DROP FUNCTION IF EXISTS rt572_fail_audit()`);
    }
    expect(await auditRows(id)).toEqual([]);
    await patch(SES_OWNER_ALL, id, { expectedVersion: 0, displayName: "Applied after" }).expect(200);
  });
});

// ===========================================================================
// frozen postings (RT-332)
// ===========================================================================
describe("consoleUpdatePayerAccount — frozen postings (RT-332)", () => {
  const SALE = "0a000000-0000-7000-8000-000000572c01";
  const POSTING = "0a000000-0000-7000-8000-000000572c02";
  const SALE_LINE = "0a000000-0000-7000-8000-000000572c03";
  let payer = "";

  async function seedFrozenPosting(): Promise<void> {
    const a = env!.admin;
    payer = await newPayer({ externalRef: "CUST-FROZEN" });
    await a.query(
      `INSERT INTO sales (id, tenant_id, store_id, currency_code, pos_total, occurred_at, business_date,
                          source_system, external_id, payload_hash, created_by, responsibility_count)
       VALUES ($1, $2, $3, 'EGP', 10, now(), '2026-10-17', 'pos-572', 'rt572-frozen', $4, $5, 1)`,
      [SALE, TENANT_A, STORE_A_X, "f".repeat(64), ACTOR_A],
    );
    await a.query(
      `INSERT INTO sale_lines (id, sale_id, tenant_id, store_id, line_name, unit_price, currency_code, quantity, line_amount, unit)
       VALUES ($1, $2, $3, $4, 'Widget', 10, 'EGP', 1, 10, 'ea')`,
      [SALE_LINE, SALE, TENANT_A, STORE_A_X],
    );
    await a.query(
      `INSERT INTO sale_responsibilities (tenant_id, store_id, sale_id, payer_id, amount, sequence) VALUES ($1, $2, $3, $4, 10, 1)`,
      [TENANT_A, STORE_A_X, SALE, payer],
    );
    await a.query(
      `INSERT INTO erpnext_posting_status (id, tenant_id, store_id, sale_id, kind, source_ref_id, source_system, external_id, payload_hash, status, current_resolution_version)
       VALUES ($1, $2, $3, $4, 'sale_post', $4, 'pos-572', 'rt572-frozen-posting', $5, 'pending', NULL)`,
      [POSTING, TENANT_A, STORE_A_X, SALE, "f".repeat(64)],
    );
    await a.query(
      `INSERT INTO erpnext_posting_resolution (tenant_id, intent_id, resolution_version, sale_line_id, erpnext_item_ref, item_map_id, warehouse_ref, warehouse_map_id, payer_external_ref, resolved_by)
       VALUES ($1, $2, 1, $3, 'ERP-ITEM', gen_random_uuid(), 'ERP-WH', gen_random_uuid(), 'CUST-FROZEN', 'system')`,
      [TENANT_A, POSTING, SALE_LINE],
    );
    await a.query(`UPDATE erpnext_posting_status SET current_resolution_version = 1 WHERE id = $1`, [POSTING]);
  }

  const frozenRefs = async (): Promise<Array<{ resolution_version: number; payer_external_ref: string | null }>> =>
    (
      await env!.admin.query(
        `SELECT resolution_version, payer_external_ref FROM erpnext_posting_resolution WHERE intent_id = $1 ORDER BY resolution_version`,
        [POSTING],
      )
    ).rows;

  it("a changed externalRef (and a suspension) never touches the frozen resolution or the sale's responsibilities", async () => {
    if (skip()) return;
    await seedFrozenPosting();
    await patch(SES_OWNER_ALL, payer, { expectedVersion: 0, externalRef: "CUST-REPLACED", status: "suspended" }).expect(200);
    expect(await payerState(payer)).toMatchObject({ external_ref: "CUST-REPLACED", status: "suspended" });
    expect(await frozenRefs()).toEqual([{ resolution_version: 1, payer_external_ref: "CUST-FROZEN" }]);
    const responsibilities = await env!.admin.query(`SELECT payer_id::text FROM sale_responsibilities WHERE sale_id = $1`, [SALE]);
    expect(responsibilities.rows).toEqual([{ payer_id: payer }]);
    const current = await env!.admin.query(`SELECT current_resolution_version FROM erpnext_posting_status WHERE id = $1`, [POSTING]);
    expect(current.rows).toEqual([{ current_resolution_version: 1 }]);
  });
});
