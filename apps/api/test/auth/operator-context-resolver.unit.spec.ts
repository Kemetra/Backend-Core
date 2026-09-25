/**
 * operator-context-resolver.unit.spec.ts — 008 Option Y, 029 D3 re-pointed.
 *
 * Docker-free unit coverage for PgOperatorContextResolver — the security core
 * of the sale-auth path. Every branch of the verify → user → device →
 * membership → role/store eligibility derivation is asserted with fakes for
 * `pool.query`, the IdentityProviderPort, and the DeviceRepository. No NestJS
 * module, no Testcontainers, no network.
 *
 * 029 D3: the resolver now verifies via the provider-neutral IdentityProviderPort
 * (returning a neutral subject) and resolves the local user via the
 * external_identity_links join — NOT clerk_user_id. The refusal taxonomy + the
 * happy-path scoping are UNCHANGED; this spec passing unchanged (modulo the seam
 * swap) is the N-2 regression proof.
 *
 * The end-to-end SQL-against-real-schema proof lives in the testcontainer
 * integration spec (sale-auth.integration.spec.ts); this spec proves the
 * decision logic + the typed refusal taxonomy.
 */
import "reflect-metadata";

import type { Pool } from "pg";
import type { DeviceRow } from "@data-pulse-2/db/schema";

import {
  PgOperatorContextResolver,
} from "../../src/auth/operator-context-resolver";
import type {
  IdentityProviderPort,
  VerifiedSubject,
} from "../../src/auth/identity-provider.port";
import type { DeviceRepository } from "../../src/pos-operators/device.repository";

const SUB = "user_clerk_sub_123";
const USER_ID = "0a000000-0000-7000-8000-00000000aa01";
const TENANT_ID = "0a000000-0000-7000-8000-000000000001";
const STORE_ID = "0a000000-0000-7000-8000-000000000002";
const DEVICE_ID = "0a000000-0000-7000-8000-000000000003";
const MEMBERSHIP_ID = "0a000000-0000-7000-8000-000000000004";

function fakePool(query: jest.Mock): Pool {
  const client = { query, release: jest.fn() };
  return {
    query,
    connect: jest.fn().mockResolvedValue(client),
  } as unknown as Pool;
}

function makeDevice(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: DEVICE_ID,
    tenantId: TENANT_ID,
    storeId: STORE_ID,
    revokedAt: null,
    ...overrides,
  } as unknown as DeviceRow;
}

interface UserRow {
  id: string;
  deleted_at: Date | null;
}
interface MembershipRow {
  id: string;
  store_access_kind: "all" | "specific";
  revoked_at: Date | null;
  deleted_at: Date | null;
  role_code: string;
}

/**
 * Build a resolver with scripted dependencies. `userRow` / `membershipRow`
 * drive the two `pool.query` calls (user lookup, membership lookup); a third
 * query (store_access) returns `storeAccessRows`.
 *
 * 029 D3: the identity seam is now the provider-neutral IdentityProviderPort.
 * `verify` is expressed as the verifier-style `() => { sub }` for parity with
 * the prior spec and wrapped into a neutral VerifiedSubject; the user-lookup
 * query branch now matches the external_identity_links join (FROM
 * external_identity_links), proving the resolver reads the link, not
 * clerk_user_id.
 */
function build(opts: {
  verify?: () => Promise<{ sub: string }>;
  device?: DeviceRow | null;
  userRow?: UserRow | null;
  membershipRow?: MembershipRow | null;
  storeAccessRows?: Array<{ one: number }>;
}) {
  const verifyFn = opts.verify ?? (async () => ({ sub: SUB }));
  const identityProvider = {
    verifyIdentityToken: async (raw: string): Promise<VerifiedSubject> => {
      const { sub } = await verifyFn();
      void raw;
      return { providerKey: "clerk", issuer: "https://issuer.example", subject: sub };
    },
  } as unknown as IdentityProviderPort;
  const deviceRepository = {
    findActiveByAttestation: jest.fn().mockResolvedValue(
      opts.device === undefined ? makeDevice() : opts.device,
    ),
  } as unknown as DeviceRepository;

  const query = jest.fn((sql: string) => {
    const text = String(sql);
    if (text.includes("FROM external_identity_links")) {
      return Promise.resolve({
        rows: opts.userRow === undefined
          ? [{ id: USER_ID, deleted_at: null }]
          : opts.userRow === null
            ? []
            : [opts.userRow],
      });
    }
    if (text.includes("FROM memberships")) {
      return Promise.resolve({
        rows: opts.membershipRow === undefined
          ? [{
              id: MEMBERSHIP_ID,
              store_access_kind: "all",
              revoked_at: null,
              deleted_at: null,
              role_code: "store_manager",
            }]
          : opts.membershipRow === null
            ? []
            : [opts.membershipRow],
      });
    }
    if (text.includes("FROM store_access")) {
      return Promise.resolve({ rows: opts.storeAccessRows ?? [] });
    }
    return Promise.resolve({ rows: [] });
  });
  const pool = fakePool(query);

  return new PgOperatorContextResolver(pool, identityProvider, deviceRepository);
}

describe("PgOperatorContextResolver — refusals (security branches)", () => {
  it("token verify throws → clerk_jwt_invalid", async () => {
    const r = build({ verify: async () => { throw new Error("bad jwt"); } });
    expect(await r.resolve("jwt", "att")).toEqual({ kind: "refused", reason: "clerk_jwt_invalid" });
  });

  it("no ACTIVE external_identity_links row for subject → user_unmapped", async () => {
    const r = build({ userRow: null });
    expect(await r.resolve("jwt", "att")).toEqual({ kind: "refused", reason: "user_unmapped" });
  });

  it("soft-deleted user → user_disabled", async () => {
    const r = build({ userRow: { id: USER_ID, deleted_at: new Date("2026-01-01") } });
    expect(await r.resolve("jwt", "att")).toEqual({ kind: "refused", reason: "user_disabled" });
  });

  it("no active device for attestation → device_invalid", async () => {
    const r = build({ device: null });
    expect(await r.resolve("jwt", "att")).toEqual({ kind: "refused", reason: "device_invalid" });
  });

  it("no membership in device tenant → membership_missing", async () => {
    const r = build({ membershipRow: null });
    expect(await r.resolve("jwt", "att")).toEqual({ kind: "refused", reason: "membership_missing" });
  });

  it("revoked membership → membership_revoked", async () => {
    const r = build({
      membershipRow: {
        id: MEMBERSHIP_ID, store_access_kind: "all",
        revoked_at: new Date("2026-01-01"), deleted_at: null, role_code: "store_manager",
      },
    });
    expect(await r.resolve("jwt", "att")).toEqual({ kind: "refused", reason: "membership_revoked" });
  });

  it("ineligible role (store_staff/cashier) → role_ineligible", async () => {
    const r = build({
      membershipRow: {
        id: MEMBERSHIP_ID, store_access_kind: "all",
        revoked_at: null, deleted_at: null, role_code: "store_staff",
      },
    });
    expect(await r.resolve("jwt", "att")).toEqual({ kind: "refused", reason: "role_ineligible" });
  });

  it("specific store access with device store NOT in set → store_not_in_access_set", async () => {
    const r = build({
      membershipRow: {
        id: MEMBERSHIP_ID, store_access_kind: "specific",
        revoked_at: null, deleted_at: null, role_code: "store_manager",
      },
      storeAccessRows: [], // not in set
    });
    expect(await r.resolve("jwt", "att")).toEqual({
      kind: "refused", reason: "store_not_in_access_set",
    });
  });
});

describe("PgOperatorContextResolver — happy path", () => {
  it("eligible store_manager, access=all → ok with context + deviceId scoped FROM the device row", async () => {
    const r = build({}); // all defaults: valid user, active device, store_manager/all
    const result = await r.resolve("jwt", "att");
    expect(result).toEqual({
      kind: "ok",
      deviceId: DEVICE_ID,
      context: {
        userId: USER_ID,
        tenantId: TENANT_ID,
        storeId: STORE_ID,
        isPlatformAdmin: false,
        source: "token",
      },
    });
  });

  it("specific store access WITH device store in set → ok", async () => {
    const r = build({
      membershipRow: {
        id: MEMBERSHIP_ID, store_access_kind: "specific",
        revoked_at: null, deleted_at: null, role_code: "store_manager",
      },
      storeAccessRows: [{ one: 1 }], // in set
    });
    const result = await r.resolve("jwt", "att");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.context.storeId).toBe(STORE_ID);
  });

  it("owner and tenant_admin roles are eligible", async () => {
    for (const role of ["owner", "tenant_admin"]) {
      const r = build({
        membershipRow: {
          id: MEMBERSHIP_ID, store_access_kind: "all",
          revoked_at: null, deleted_at: null, role_code: role,
        },
      });
      const result = await r.resolve("jwt", "att");
      expect(result.kind).toBe("ok");
    }
  });
});

describe("PgOperatorContextResolver — membership lookup determinism (audit M-3)", () => {
  // A user may have one ACTIVE membership row plus soft-deleted rows for the same
  // (tenant_id, user_id) — the partial unique index is scoped `WHERE deleted_at IS
  // NULL`. A bare `LIMIT 1` could return a stale row in heap order and refuse a
  // legitimately-active operator. The query must `ORDER BY` so the active grant
  // (revoked_at / deleted_at both NULL) sorts first.
  it("orders the membership lookup to prefer the active grant (revoked/deleted NULLS FIRST)", async () => {
    const seenSql: string[] = [];
    const query = jest.fn((sql: string) => {
      seenSql.push(String(sql));
      const text = String(sql);
      if (text.includes("FROM external_identity_links")) {
        return Promise.resolve({ rows: [{ id: USER_ID, deleted_at: null }] });
      }
      if (text.includes("FROM memberships")) {
        return Promise.resolve({
          rows: [{
            id: MEMBERSHIP_ID,
            store_access_kind: "all",
            revoked_at: null,
            deleted_at: null,
            role_code: "store_manager",
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });
    const pool = fakePool(query);
    const identityProvider = {
      verifyIdentityToken: async (raw: string): Promise<VerifiedSubject> => {
        void raw;
        return { providerKey: "clerk", issuer: "https://issuer.example", subject: SUB };
      },
    } as unknown as IdentityProviderPort;
    const deviceRepository = {
      findActiveByAttestation: jest.fn().mockResolvedValue(makeDevice()),
    } as unknown as DeviceRepository;

    const resolver = new PgOperatorContextResolver(pool, identityProvider, deviceRepository);
    await resolver.resolve("jwt", "att");

    const membershipSql = seenSql.find((s) => s.includes("FROM memberships"));
    expect(membershipSql).toBeDefined();
    // Normalize whitespace so the assertion is robust to formatting.
    const normalized = String(membershipSql).replace(/\s+/g, " ");
    expect(normalized).toMatch(
      /ORDER BY m\.revoked_at NULLS FIRST, m\.deleted_at NULLS FIRST/,
    );
    // The ORDER BY must precede LIMIT 1 (otherwise it is inert).
    expect(normalized.indexOf("ORDER BY")).toBeLessThan(normalized.indexOf("LIMIT 1"));
  });
});
