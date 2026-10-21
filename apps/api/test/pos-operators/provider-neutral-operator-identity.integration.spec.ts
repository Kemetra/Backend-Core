/**
 * RT-796 — POS operator lookups resolve through `external_identity_links`.
 *
 * Real Postgres (Testcontainers, full schema). The services under test are the
 * six sites that used to read `users.clerk_user_id`:
 *
 *   sign-in / sign-out / roster / active-session  (PosOperatorsService)
 *   stuck-shifts                                  (PosShiftsService)
 *   cashier eligibility + cashier roster          (CashierEligibilityRepository)
 *   audit-event actor resolution                  (PosAuditEventsService)
 *
 * The domain role is deliberately DENIED `external_identity_links`: only the
 * auth-lookup role is documented to read it (docs/operations/database-roles.md),
 * so a lookup that leaks onto the domain pool fails here instead of in prod.
 *
 * Verified claims come from a stub at the OperatorTokenVerifier seam, so the
 * same code is exercised for a Clerk-era user, a Descope-only user (link row,
 * no `clerk_user_id`), a user cut over by the RT-791 apply, and a third
 * provider this codebase has never heard of.
 */
import "reflect-metadata";

import { runWithTenantContext } from "@data-pulse-2/db";
import { createLogger, type Logger } from "@data-pulse-2/shared";
import { hashToken } from "@data-pulse-2/auth";
import { Pool } from "pg";

import type { OperatorTokenClaims, OperatorTokenVerifier } from "../../src/auth/operator-token-verifier";
import { CashierEligibilityRepository } from "../../src/pos-cashier-admissions/cashier-eligibility";
import type { AuditEventItemInput } from "../../src/pos-audit-events/dto";
import {
  LEGACY_SHIFT_OPEN_SQL,
  PosAuditEventsService,
} from "../../src/pos-audit-events/pos-audit-events.service";
import { DeviceRepository } from "../../src/pos-operators/device.repository";
import { PosOperatorsService } from "../../src/pos-operators/pos-operators.service";
import { PosShiftsService } from "../../src/pos-shifts/pos-shifts.service";
import {
  APP_ROLE_NAME,
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const id = (n: number): string => `0b796000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const TENANT_ID = id(1);
const STORE_ID = id(2);
const ROLE_ADMIN = id(3);
const ROLE_STAFF = id(4);
const DEVICE_ID = id(5);
const DEVICE_ATTESTATION = "rt796-device-attestation";

/** A Descope-only manager: an active link, never a `clerk_user_id`. */
const U_ADMIN = id(10);
/** A Clerk-era manager (un-cut-over): `clerk_user_id` and a matching active link. */
const U_CLERK_ADMIN = id(11);
/** A manager of a third provider this codebase has no adapter for. */
const U_ACME_ADMIN = id(12);
/** A manager with a bridge-column value but NO link row. */
const U_GHOST_ADMIN = id(13);
/** A manager cut over by an RT-791 apply: old link disabled, new link active. */
const U_CUT_ADMIN = id(14);
/** Cashiers. */
const U_LEGACY = id(20);
const U_DESCOPE = id(21);
const U_CUTOVER = id(22);
const U_GHOST = id(23);
/** Another user with a perfectly valid link (audit negative). */
const U_OTHER = id(30);

const SUB_ADMIN = "U2rt796Admin";
const SUB_CLERK_ADMIN = "user_rt796_clerk_admin";
const SUB_ACME_ADMIN = "acme|rt796-admin";
const SUB_LEGACY = "user_rt796_legacy_cashier";
const SUB_DESCOPE = "U2rt796Cashier";
const SUB_CUTOVER_OLD = "user_rt796_cutover_old";
const SUB_CUTOVER_NEW = "U2rt796Cutover";
const SUB_GHOST = "user_rt796_ghost_no_link";
const SUB_GHOST_ADMIN = "user_rt796_ghost_admin_no_link";
const SUB_CUT_ADMIN_OLD = "user_rt796_cut_admin_old";
const SUB_CUT_ADMIN_NEW = "U2rt796CutAdmin";
const SUB_OTHER = "user_rt796_other_user";

const JWTS: Readonly<Record<string, OperatorTokenClaims>> = {
  "jwt-admin": { providerKey: "descope", sub: SUB_ADMIN },
  "jwt-admin-as-clerk": { providerKey: "clerk", sub: SUB_ADMIN },
  "jwt-clerk-admin": { providerKey: "clerk", sub: SUB_CLERK_ADMIN },
  "jwt-acme-admin": { providerKey: "acme", sub: SUB_ACME_ADMIN },
  "jwt-cut-admin-old": { providerKey: "clerk", sub: SUB_CUT_ADMIN_OLD },
  "jwt-cut-admin-new": { providerKey: "descope", sub: SUB_CUT_ADMIN_NEW },
  "jwt-ghost": { providerKey: "clerk", sub: SUB_GHOST_ADMIN },
};

const verifier: OperatorTokenVerifier = {
  async verify(rawJwt: string): Promise<OperatorTokenClaims> {
    const claims = JWTS[rawJwt];
    if (!claims) throw new Error("stub verifier: unknown jwt");
    return claims;
  },
};

let env: PgTestEnv | null = null;
let admin: Pool | null = null;
let operators: PosOperatorsService;
let shifts: PosShiftsService;
let audit: PosAuditEventsService;
let eligibility: CashierEligibilityRepository;
let dockerSkipped = false;

const logger = createLogger({ service: "api-test", level: "silent" }) as Logger;

function skip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[provider-neutral-operator-identity] skipping (Docker unavailable)");
  }
  return dockerSkipped;
}

interface SeedUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly clerkUserId: string | null;
}

async function seedUser(user: SeedUser): Promise<void> {
  await admin!.query(
    `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES ($1, $2, $3, $4)`,
    [user.id, user.email, user.displayName, user.clerkUserId],
  );
}

interface SeedLink {
  readonly userId: string;
  readonly providerKey: string;
  readonly subject: string;
  readonly status?: "active" | "disabled";
}

async function seedLink(link: SeedLink): Promise<void> {
  const status = link.status ?? "active";
  await admin!.query(
    `INSERT INTO external_identity_links (provider_key, issuer, subject, user_id, status, disabled_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'disabled' THEN now() ELSE NULL END)`,
    [link.providerKey, `https://issuer.test/${link.providerKey}`, link.subject, link.userId, status],
  );
}

async function seedMembership(n: number, userId: string, roleId: string): Promise<void> {
  await admin!.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
     VALUES ($1, $2, $3, $4, 'all')`,
    [id(100 + n), TENANT_ID, userId, roleId],
  );
}

async function seedOperatorSession(
  n: number,
  userId: string,
  window: { issuedAt: string; expiresAt: string },
): Promise<string> {
  const tokenId = id(200 + n);
  await admin!.query(
    `INSERT INTO auth_tokens
       (id, token_hash, tenant_id, user_id, device_id, store_id, scope, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pos_operator', $7, $8)`,
    [tokenId, hashToken(`rt796-session-${n}`), TENANT_ID, userId, DEVICE_ID, STORE_ID, window.issuedAt, window.expiresAt],
  );
  return tokenId;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[provider-neutral-operator-identity] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  admin = new Pool({ connectionString: env.adminUri });
  // Only the auth-lookup role is documented to read the links table.
  await admin.query(`REVOKE ALL ON external_identity_links FROM ${APP_ROLE_NAME}`);

  await admin.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, 'rt796', 'RT-796')`, [TENANT_ID]);
  await admin.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES ($1, $3, 'tenant_admin', 'Admin'), ($2, $3, 'store_staff', 'Staff')`,
    [ROLE_ADMIN, ROLE_STAFF, TENANT_ID],
  );
  await admin.query(`INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'S1', 'Store 1')`, [
    STORE_ID,
    TENANT_ID,
  ]);
  await admin.query(
    `INSERT INTO devices (id, tenant_id, store_id, label, token_hash) VALUES ($1, $2, $3, 'till-1', $4)`,
    [DEVICE_ID, TENANT_ID, STORE_ID, hashToken(DEVICE_ATTESTATION)],
  );

  // Managers.
  await seedUser({ id: U_ADMIN, email: "admin@rt796.test", displayName: "Descope Admin", clerkUserId: null });
  await seedLink({ userId: U_ADMIN, providerKey: "descope", subject: SUB_ADMIN });
  await seedUser({ id: U_CLERK_ADMIN, email: "clerk-admin@rt796.test", displayName: "Clerk Admin", clerkUserId: SUB_CLERK_ADMIN });
  await seedLink({ userId: U_CLERK_ADMIN, providerKey: "clerk", subject: SUB_CLERK_ADMIN });
  await seedUser({ id: U_ACME_ADMIN, email: "acme-admin@rt796.test", displayName: "Acme Admin", clerkUserId: null });
  await seedLink({ userId: U_ACME_ADMIN, providerKey: "acme", subject: SUB_ACME_ADMIN });
  await seedUser({ id: U_GHOST_ADMIN, email: "ghost-admin@rt796.test", displayName: "Ghost Admin", clerkUserId: SUB_GHOST_ADMIN });
  await seedUser({ id: U_CUT_ADMIN, email: "cut-admin@rt796.test", displayName: "Cutover Admin", clerkUserId: SUB_CUT_ADMIN_NEW });
  await seedLink({ userId: U_CUT_ADMIN, providerKey: "clerk", subject: SUB_CUT_ADMIN_OLD, status: "disabled" });
  await seedLink({ userId: U_CUT_ADMIN, providerKey: "descope", subject: SUB_CUT_ADMIN_NEW });
  for (const [n, user] of [U_ADMIN, U_CLERK_ADMIN, U_ACME_ADMIN, U_GHOST_ADMIN, U_CUT_ADMIN].entries()) {
    await seedMembership(n, user, ROLE_ADMIN);
  }

  // Cashiers: alphabetical by display name so the roster order is pinned.
  await seedUser({ id: U_LEGACY, email: "legacy@rt796.test", displayName: "Alpha Legacy", clerkUserId: SUB_LEGACY });
  await seedLink({ userId: U_LEGACY, providerKey: "clerk", subject: SUB_LEGACY });
  await seedUser({ id: U_DESCOPE, email: "descope@rt796.test", displayName: "Beta Descope", clerkUserId: null });
  await seedLink({ userId: U_DESCOPE, providerKey: "descope", subject: SUB_DESCOPE });
  // After an RT-791 apply: the Clerk link is disabled, the Descope link is active.
  await seedUser({ id: U_CUTOVER, email: "cutover@rt796.test", displayName: "Gamma Cutover", clerkUserId: SUB_CUTOVER_NEW });
  await seedLink({ userId: U_CUTOVER, providerKey: "clerk", subject: SUB_CUTOVER_OLD, status: "disabled" });
  await seedLink({ userId: U_CUTOVER, providerKey: "descope", subject: SUB_CUTOVER_NEW });
  // A bridge-column value with no link at all.
  await seedUser({ id: U_GHOST, email: "ghost@rt796.test", displayName: "Delta Ghost", clerkUserId: SUB_GHOST });
  for (const [n, user] of [U_LEGACY, U_DESCOPE, U_CUTOVER, U_GHOST].entries()) {
    await seedMembership(10 + n, user, ROLE_STAFF);
  }

  await seedUser({ id: U_OTHER, email: "other@rt796.test", displayName: "Other Person", clerkUserId: null });
  await seedLink({ userId: U_OTHER, providerKey: "clerk", subject: SUB_OTHER });

  const devices = new DeviceRepository(admin, env.app);
  operators = new PosOperatorsService(env.app, verifier, devices, logger, admin);
  shifts = new PosShiftsService(env.app, verifier, logger, 0, admin);
  audit = new PosAuditEventsService(env.app, devices, logger, admin);
  eligibility = new CashierEligibilityRepository(admin);
}, 180_000);

afterAll(async () => {
  if (admin) await admin.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

afterEach(async () => {
  if (!admin) return;
  await admin.query(`DELETE FROM auth_tokens WHERE scope = 'pos_operator'`).catch(() => undefined);
});

const signInBody = { kind: "manager_admin", device_token_attestation: DEVICE_ATTESTATION } as const;

describe("operator sign-in resolves the ACTIVE identity link", () => {
  it("a Descope-only user (link row, clerk_user_id NULL) signs in; operator.id is the link subject", async () => {
    if (skip()) return;
    const res = await operators.signIn("jwt-admin", signInBody, "req-1");
    expect(res).toMatchObject({
      kind: "signed_in",
      operator: { id: SUB_ADMIN, user_id: U_ADMIN, role: "admin", tenant_id: TENANT_ID, branch_id: STORE_ID },
    });
  });

  it("IDENTITY_PROVIDER=clerk regression: an un-cut-over user's operator.id is byte-identical to clerk_user_id", async () => {
    if (skip()) return;
    const res = await operators.signIn("jwt-clerk-admin", signInBody, "req-2");
    expect(res).toMatchObject({ kind: "signed_in", operator: { id: SUB_CLERK_ADMIN, user_id: U_CLERK_ADMIN } });
    const row = await admin!.query<{ clerk_user_id: string }>(`SELECT clerk_user_id FROM users WHERE id = $1`, [
      U_CLERK_ADMIN,
    ]);
    expect((res as { operator: { id: string } }).operator.id).toBe(row.rows[0]!.clerk_user_id);
  });

  it("a third provider needs no change here: its link row is all sign-in needs", async () => {
    if (skip()) return;
    const res = await operators.signIn("jwt-acme-admin", signInBody, "req-3");
    expect(res).toMatchObject({ kind: "signed_in", operator: { id: SUB_ACME_ADMIN, user_id: U_ACME_ADMIN } });
  });

  it("the link's provider discriminates: the same subject under another provider is unmapped", async () => {
    if (skip()) return;
    expect(await operators.signIn("jwt-admin-as-clerk", signInBody, "req-4")).toEqual({ kind: "refused" });
  });

  it("a subject whose link is DISABLED does not sign in; the same user's active link does", async () => {
    if (skip()) return;
    expect(await operators.signIn("jwt-cut-admin-old", signInBody, "req-5")).toEqual({ kind: "refused" });
    expect(await operators.signIn("jwt-cut-admin-new", signInBody, "req-5b")).toMatchObject({
      kind: "signed_in",
      operator: { id: SUB_CUT_ADMIN_NEW, user_id: U_CUT_ADMIN },
    });
  });

  it("a clerk_user_id with no link row does not sign in (the bridge column is off the join path)", async () => {
    if (skip()) return;
    expect(await operators.signIn("jwt-ghost", signInBody, "req-6")).toEqual({ kind: "refused" });
  });

  it("sign-out finds the Descope-only user's session through the link", async () => {
    if (skip()) return;
    const signedIn = await operators.signIn("jwt-admin", signInBody, "req-7");
    if (signedIn.kind !== "signed_in") throw new Error("setup: sign-in refused");
    const out = await operators.signOut("jwt-admin", { session_id: signedIn.operator_session.id }, "req-8");
    expect(out).toEqual({ kind: "signed_out" });
  });
});

describe("operator roster lists cashiers with an ACTIVE link", () => {
  it("includes Descope-only and cut-over cashiers; excludes a clerk_user_id with no link", async () => {
    if (skip()) return;
    const res = await operators.roster("jwt-admin", { branch_id: STORE_ID }, "req-9");
    if ("kind" in res) throw new Error("roster refused");
    expect(res.cashiers).toEqual([
      { id: SUB_LEGACY, user_id: U_LEGACY, display_name: "Alpha Legacy", role: "cashier" },
      { id: SUB_DESCOPE, user_id: U_DESCOPE, display_name: "Beta Descope", role: "cashier" },
      { id: SUB_CUTOVER_NEW, user_id: U_CUTOVER, display_name: "Gamma Cutover", role: "cashier" },
    ]);
  });
});

describe("active-session resolves the target wire id through the active link", () => {
  it("a Descope-only cashier's wire id (the link subject) finds their live session", async () => {
    if (skip()) return;
    await seedOperatorSession(1, U_DESCOPE, { issuedAt: "2020-01-01T00:00:00Z", expiresAt: "2999-01-01T00:00:00Z" });
    const res = await operators.activeSession(
      "jwt-admin",
      { branch_id: STORE_ID, operator_id: SUB_DESCOPE },
      "req-10",
    );
    expect(res).toEqual({ kind: "active" });
  });

  it("a DISABLED link's subject names nobody: none, even though that user has a live session", async () => {
    if (skip()) return;
    await seedOperatorSession(2, U_CUTOVER, { issuedAt: "2020-01-01T00:00:00Z", expiresAt: "2999-01-01T00:00:00Z" });
    const stale = await operators.activeSession(
      "jwt-admin",
      { branch_id: STORE_ID, operator_id: SUB_CUTOVER_OLD },
      "req-11",
    );
    expect(stale).toEqual({ kind: "none" });
    const current = await operators.activeSession(
      "jwt-admin",
      { branch_id: STORE_ID, operator_id: SUB_CUTOVER_NEW },
      "req-12",
    );
    expect(current).toEqual({ kind: "active" });
  });
});

describe("stuck-shifts resolves the manager through the active link", () => {
  beforeAll(async () => {
    if (dockerSkipped || !admin) return;
    await admin.query(LEGACY_SHIFT_OPEN_SQL, [id(300), TENANT_ID, STORE_ID, U_DESCOPE, DEVICE_ID, "2020-01-01T00:00:00Z"]);
  });

  it("a Descope-only manager lists the stuck shifts", async () => {
    if (skip()) return;
    const res = await shifts.getStuck("jwt-admin", STORE_ID, "req-13");
    expect(res).toMatchObject({
      kind: "ok",
      body: { kind: "ok", shifts: [{ shift_id: id(300), cashier_display_name: "Beta Descope" }] },
    });
  });

  it("an Un-cut-over manager (Clerk link) still lists them", async () => {
    if (skip()) return;
    const res = await shifts.getStuck("jwt-clerk-admin", STORE_ID, "req-14");
    expect(res).toMatchObject({ kind: "ok" });
  });

  it("a clerk_user_id with no link, or a disabled link, is refused", async () => {
    if (skip()) return;
    expect(await shifts.getStuck("jwt-ghost", STORE_ID, "req-15")).toEqual({ kind: "refused" });
    expect(await shifts.getStuck("jwt-cut-admin-old", STORE_ID, "req-16")).toEqual({ kind: "refused" });
  });

  it("never logs the subject of an unmapped user", async () => {
    if (skip()) return;
    const warn = jest.fn();
    const spy = new PosShiftsService(env!.app, verifier, { warn } as unknown as Logger, 0, admin!);
    await spy.getStuck("jwt-ghost", STORE_ID, "req-17");
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SUB_GHOST_ADMIN);
  });
});

describe("cashier eligibility and roster resolve operator_id from the active link", () => {
  const scope = { deviceId: DEVICE_ID, tenantId: TENANT_ID, storeId: STORE_ID };
  const asTenant = <T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> =>
    runWithTenantContext(env!.app, { tenantId: TENANT_ID, isPlatformAdmin: false }, fn);

  it("a Descope-only cashier is eligible, and operatorId is the link subject", async () => {
    if (skip()) return;
    const res = await asTenant((c) => eligibility.check(c, scope, U_DESCOPE));
    expect(res).toEqual({ eligible: true, displayName: "Beta Descope", operatorId: SUB_DESCOPE });
  });

  it("an un-cut-over cashier's operatorId is byte-identical to clerk_user_id", async () => {
    if (skip()) return;
    const res = await asTenant((c) => eligibility.check(c, scope, U_LEGACY));
    expect(res).toEqual({ eligible: true, displayName: "Alpha Legacy", operatorId: SUB_LEGACY });
  });

  it("a cut-over cashier is identified by the ACTIVE link, not the disabled one", async () => {
    if (skip()) return;
    const res = await asTenant((c) => eligibility.check(c, scope, U_CUTOVER));
    expect(res).toEqual({ eligible: true, displayName: "Gamma Cutover", operatorId: SUB_CUTOVER_NEW });
  });

  it("a clerk_user_id with no active link is profile_incomplete", async () => {
    if (skip()) return;
    const res = await asTenant((c) => eligibility.check(c, scope, U_GHOST));
    expect(res).toEqual({ eligible: false, reason: "profile_incomplete" });
  });

  it("the roster is exactly the admissible set: active links only, ordered by display name", async () => {
    if (skip()) return;
    const roster = await asTenant((c) => eligibility.roster(c, scope));
    expect(roster).toEqual([
      { user_id: U_LEGACY, operator_id: SUB_LEGACY, display_name: "Alpha Legacy" },
      { user_id: U_DESCOPE, operator_id: SUB_DESCOPE, display_name: "Beta Descope" },
      { user_id: U_CUTOVER, operator_id: SUB_CUTOVER_NEW, display_name: "Gamma Cutover" },
    ]);
  });
});

describe("audit ingestion: acting_operator_id matches ANY link of the session's user", () => {
  const EVENT_AT = "2026-10-21T10:00:00.000Z";
  const WINDOW = { issuedAt: "2026-10-21T08:00:00.000Z", expiresAt: "2026-10-21T20:00:00.000Z" };
  let eventSeq = 0;

  function event(overrides: Partial<AuditEventItemInput>): AuditEventItemInput {
    eventSeq += 1;
    return {
      event_id: id(400 + eventSeq),
      tenant_id: TENANT_ID,
      branch_id: STORE_ID,
      originating_terminal_id: DEVICE_ID,
      acting_operator_id: SUB_CUTOVER_OLD,
      action_category: "cashier.pin.reset",
      created_at: EVENT_AT,
      payload: {},
      ...overrides,
    };
  }

  async function sync(events: AuditEventItemInput[]) {
    return audit.syncBatch({ device_token_attestation: DEVICE_ATTESTATION, events }, null);
  }

  async function actorOf(eventId: string): Promise<string | undefined> {
    const r = await admin!.query<{ actor_user_id: string }>(`SELECT actor_user_id FROM audit_events WHERE id = $1`, [
      eventId,
    ]);
    return r.rows[0]?.actor_user_id;
  }

  it("a batch queued under the PREVIOUS provider id (disabled link) after an apply is accepted", async () => {
    if (skip()) return;
    await seedOperatorSession(3, U_CUTOVER, WINDOW);
    const queued = event({ acting_operator_id: SUB_CUTOVER_OLD });
    expect(await sync([queued])).toEqual({ accepted: [queued.event_id], duplicates: [], rejected: [] });
    expect(await actorOf(queued.event_id)).toBe(U_CUTOVER);
  });

  it("the CURRENT (active) provider id of the same user is accepted too", async () => {
    if (skip()) return;
    await seedOperatorSession(4, U_CUTOVER, WINDOW);
    const current = event({ acting_operator_id: SUB_CUTOVER_NEW });
    expect(await sync([current])).toMatchObject({ accepted: [current.event_id], rejected: [] });
  });

  it("a Descope-only operator's events are accepted (no clerk_user_id involved)", async () => {
    if (skip()) return;
    await seedOperatorSession(5, U_DESCOPE, WINDOW);
    const ev = event({ acting_operator_id: SUB_DESCOPE });
    expect(await sync([ev])).toMatchObject({ accepted: [ev.event_id], rejected: [] });
    expect(await actorOf(ev.event_id)).toBe(U_DESCOPE);
  });

  it("an id never linked to the session's user is invalid_actor", async () => {
    if (skip()) return;
    await seedOperatorSession(6, U_CUTOVER, WINDOW);
    const ev = event({ acting_operator_id: "user_never_linked_to_anybody" });
    expect(await sync([ev])).toEqual({
      accepted: [],
      duplicates: [],
      rejected: [{ event_id: ev.event_id, category: "invalid_input" }],
    });
    expect(await actorOf(ev.event_id)).toBeUndefined();
  });

  it("ANOTHER user's real, valid id does not authorize an event on this user's session", async () => {
    if (skip()) return;
    await seedOperatorSession(7, U_CUTOVER, WINDOW);
    const ev = event({ acting_operator_id: SUB_OTHER });
    expect(await sync([ev])).toMatchObject({
      accepted: [],
      rejected: [{ event_id: ev.event_id, category: "invalid_input" }],
    });
  });

  it("the session-at-event-time join is still the authorization: no session in the window, no alias", async () => {
    if (skip()) return;
    await seedOperatorSession(8, U_CUTOVER, WINDOW);
    const before = event({ acting_operator_id: SUB_CUTOVER_OLD, created_at: "2026-10-21T07:00:00.000Z" });
    const after = event({ acting_operator_id: SUB_CUTOVER_OLD, created_at: "2026-10-21T21:00:00.000Z" });
    expect(await sync([before, after])).toMatchObject({
      accepted: [],
      rejected: [
        { event_id: before.event_id, category: "invalid_input" },
        { event_id: after.event_id, category: "invalid_input" },
      ],
    });
  });

  it("a clerk_user_id with no link no longer authorizes events", async () => {
    if (skip()) return;
    await seedOperatorSession(9, U_GHOST, WINDOW);
    const ev = event({ acting_operator_id: SUB_GHOST });
    expect(await sync([ev])).toMatchObject({ accepted: [], rejected: [{ category: "invalid_input" }] });
  });

  it("the alias is bound to the pinned session when the event names one", async () => {
    if (skip()) return;
    const ghostSession = await seedOperatorSession(10, U_OTHER, WINDOW);
    await seedOperatorSession(11, U_CUTOVER, WINDOW);
    // U_CUTOVER's old id, but pinned to U_OTHER's session: the user bound to
    // THAT session has no such link.
    const ev = event({ acting_operator_id: SUB_CUTOVER_OLD, session_id: ghostSession });
    expect(await sync([ev])).toMatchObject({ accepted: [], rejected: [{ category: "invalid_input" }] });
  });
});
