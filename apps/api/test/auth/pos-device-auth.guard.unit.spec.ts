/**
 * pos-device-auth.guard.unit.spec.ts
 *
 * Docker-free unit coverage for PosDeviceAuthGuard (issue #488, Option B-prime).
 *
 * The read-down catalogue API (010) must authenticate a POS terminal by its
 * `devices` pairing token ALONE — no operator session — and resolve
 * `(tenant_id, store_id)` from the store-bound device row. This guard is the
 * device-principal authenticator for the read-down routes ONLY; it does NOT
 * extend or broaden PosOperatorAuthGuard.
 *
 * Strategy: a hand-written fake DeviceRepository. The guard is constructed
 * directly. No NestJS test module, no Testcontainers, no network.
 *
 * Contract under test (FR-001 device-principal; FR-002 scope-from-principal):
 *   - valid pairing token (active device row) → returns true; req.context is
 *     populated with the row's (tenantId, storeId), source 'token'.
 *   - missing Authorization header              → UnauthorizedException (401)
 *   - non-bearer / malformed header             → UnauthorizedException (401)
 *   - token matches no active device (null,
 *     incl. revoked)                            → UnauthorizedException (401)
 *   - dashboard cookie session present          → UnauthorizedException (401)
 *     (dashboard credentials never authenticate a device principal)
 */
import "reflect-metadata";

import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { DeviceRow } from "@data-pulse-2/db/schema";
import type { Pool } from "pg";

import { SESSION_COOKIE_NAME } from "../../src/auth/auth.guard";
import { DeviceRepository } from "../../src/pos-operators/device.repository";
import { PosDeviceAuthGuard } from "../../src/auth/pos-device-auth.guard";
import type { TenantContextRequest } from "../../src/context/types";

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------

const DEVICE_ID = "0a000000-0000-7000-8000-0000000dev01";
const TENANT_ID = "0a000000-0000-7000-8000-0000000ten01";
const STORE_ID = "0a000000-0000-7000-8000-0000000sto01";
const SESSION_ID = "0a000000-0000-7000-8000-0000000ses01";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const makeFakeDevices = () => ({
  findActiveByAttestation: jest.fn<Promise<DeviceRow | null>, [string]>(),
});

function buildGuard() {
  const devices = makeFakeDevices();
  const guard = new PosDeviceAuthGuard(devices as unknown as DeviceRepository);
  return { guard, devices };
}

function makeDevice(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: DEVICE_ID,
    tenantId: TENANT_ID,
    storeId: STORE_ID,
    label: "Lane 1",
    revokedAt: null,
    ...overrides,
  } as unknown as DeviceRow;
}

// ---------------------------------------------------------------------------
// ExecutionContext / request helpers
// ---------------------------------------------------------------------------

function makeCtx(req: object): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
    }),
  } as unknown as ExecutionContext;
}

function makeRequest(opts: { cookie?: string; authorization?: string }): TenantContextRequest {
  const req: Record<string, unknown> = {
    headers: {} as Record<string, string>,
    cookies: {} as Record<string, string>,
  };
  if (opts.cookie !== undefined) {
    (req.cookies as Record<string, string>)[SESSION_COOKIE_NAME] = opts.cookie;
  }
  if (opts.authorization !== undefined) {
    (req.headers as Record<string, string>)["authorization"] = opts.authorization;
  }
  return req as unknown as TenantContextRequest;
}

// ===========================================================================
// PDG1 — valid pairing token authenticates + resolves store scope
// ===========================================================================

describe("PosDeviceAuthGuard — valid device pairing token", () => {
  it("PDG1: active device row → returns true and publishes (tenant, store) onto req.context", async () => {
    const { guard, devices } = buildGuard();
    devices.findActiveByAttestation.mockResolvedValue(makeDevice());

    const req = makeRequest({ authorization: "Bearer device-pairing-token" });
    const result = await guard.canActivate(makeCtx(req));

    expect(result).toBe(true);
    // The raw token (sans "Bearer ") is what gets hashed + looked up.
    expect(devices.findActiveByAttestation).toHaveBeenCalledWith("device-pairing-token");
    expect(req.context).toEqual({
      userId: null,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      isPlatformAdmin: false,
      source: "token",
    });
    // A device principal is also published for the audit actor (FR-080):
    // null operator user, the device id as tokenId, `pos` device scope.
    expect(req.principal).toEqual({
      kind: "token",
      tokenId: DEVICE_ID,
      tenantId: TENANT_ID,
      userId: null,
      storeId: STORE_ID,
      scope: "pos",
    });
  });

  it("PDG1b (RT-113 BC2): publishes the authenticated device id as req.posDeviceId", async () => {
    const { guard, devices } = buildGuard();
    devices.findActiveByAttestation.mockResolvedValue(makeDevice());

    const req = makeRequest({ authorization: "Bearer device-pairing-token" });
    await guard.canActivate(makeCtx(req));

    expect(req.posDeviceId).toBe(DEVICE_ID);
  });

  it("PDG1c: a refused credential publishes no device binding", async () => {
    const { guard, devices } = buildGuard();
    devices.findActiveByAttestation.mockResolvedValue(null);

    const req = makeRequest({ authorization: "Bearer revoked-token" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toThrow();

    expect(req.posDeviceId).toBeUndefined();
  });
});

// ===========================================================================
// PDG2 — missing Authorization header is rejected
// ===========================================================================

describe("PosDeviceAuthGuard — missing credential", () => {
  it("PDG2: no Authorization header → UnauthorizedException; no DB lookup", async () => {
    const { guard, devices } = buildGuard();

    const req = makeRequest({});
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(devices.findActiveByAttestation).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// PDG3 — non-bearer / malformed header is rejected
// ===========================================================================

describe("PosDeviceAuthGuard — malformed header", () => {
  it("PDG3: non-Bearer Authorization → UnauthorizedException; no DB lookup", async () => {
    const { guard, devices } = buildGuard();

    const req = makeRequest({ authorization: "Basic abc123" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(devices.findActiveByAttestation).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// PDG4 — token matching no active device (incl. revoked) is rejected
// ===========================================================================

describe("PosDeviceAuthGuard — unknown / revoked device token", () => {
  it("PDG4: findActiveByAttestation returns null → UnauthorizedException; no context published", async () => {
    const { guard, devices } = buildGuard();
    devices.findActiveByAttestation.mockResolvedValue(null);

    const req = makeRequest({ authorization: "Bearer revoked-or-unknown" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(req.context).toBeUndefined();
  });
});

// ===========================================================================
// PDG5 — a dashboard cookie session never authenticates a device principal
// ===========================================================================

describe("PosDeviceAuthGuard — dashboard cookie rejected", () => {
  it("PDG5: cookie session, no Bearer → UnauthorizedException; no DB lookup", async () => {
    const { guard, devices } = buildGuard();

    const req = makeRequest({ cookie: SESSION_ID });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(devices.findActiveByAttestation).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// PDG6 (RT-213) — a device of a suspended / pending / soft-deleted tenant is
// refused exactly like a revoked device.
//
// The check lives in DeviceRepository (the one device resolution every
// device route shares), so this block wires the REAL DeviceRepository over
// two fake pools: the pre-tenant lookup pool returns the device row, and
// the domain pool answers the tenant-status read inside the device's tenant
// context. Docker-free; the SQL itself is proven in
// test/auth/tenant-status-device-auth.http.integration.spec.ts.
// ===========================================================================

interface TenantRowFake {
  status: string;
  deleted_at: Date | null;
}

/** The pre-tenant lookup pool: answers the drizzle device lookup (array rows). */
function fakeLookupPool(deviceTenantId = TENANT_ID): Pool {
  return {
    query: jest.fn(async (config: { rowMode?: string }) => {
      if (config && config.rowMode === "array") {
        return {
          rows: [
            [
              DEVICE_ID,
              deviceTenantId,
              STORE_ID,
              "Lane 1",
              Buffer.from("hash"),
              null,
              "2026-10-01T00:00:00.000Z",
              "2026-10-01T00:00:00.000Z",
            ],
          ],
        };
      }
      return { rows: [] };
    }),
  } as unknown as Pool;
}

interface DomainFake {
  pool: Pool;
  calls: Array<{ text: string; params: unknown[] | undefined }>;
}

/** The domain pool: the tenants read must run inside runWithTenantContext. */
function fakeDomainPool(tenantRow: TenantRowFake | null): DomainFake {
  const calls: DomainFake["calls"] = [];
  const client = {
    query: jest.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (/\bfrom\s+tenants\b/i.test(text)) {
        return { rows: tenantRow === null ? [] : [tenantRow] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn(async () => client) } as unknown as Pool;
  return { pool, calls };
}

function guardOver(tenantRow: TenantRowFake | null): {
  guard: PosDeviceAuthGuard;
  domain: DomainFake;
} {
  const domain = fakeDomainPool(tenantRow);
  const repo = new DeviceRepository(fakeLookupPool(), domain.pool);
  return { guard: new PosDeviceAuthGuard(repo), domain };
}

/** What a revoked device gets today: the guard's generic 401. */
async function revokedDeviceRefusal(): Promise<unknown> {
  const { guard, devices } = buildGuard();
  devices.findActiveByAttestation.mockResolvedValue(null);
  try {
    await guard.canActivate(makeCtx(makeRequest({ authorization: "Bearer revoked" })));
  } catch (err) {
    return err;
  }
  throw new Error("a revoked device was admitted");
}

describe("PosDeviceAuthGuard — RT-213 tenant status", () => {
  it("PDG6a: active tenant → admitted; the status is read inside the device's tenant context", async () => {
    const { guard, domain } = guardOver({ status: "active", deleted_at: null });
    const req = makeRequest({ authorization: "Bearer device-pairing-token" });

    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(req.posDeviceId).toBe(DEVICE_ID);
    // The tenants read is RLS-scoped to the DEVICE's tenant (constitution §II).
    const guc = domain.calls.find((c) => c.text.includes("app.current_tenant"));
    expect(guc?.params).toEqual([TENANT_ID]);
    expect(domain.calls.some((c) => /\bfrom\s+tenants\b/i.test(c.text))).toBe(true);
  });

  it.each<[string, TenantRowFake | null]>([
    ["suspended", { status: "suspended", deleted_at: null }],
    ["pending", { status: "pending", deleted_at: null }],
    ["soft-deleted (status active)", { status: "active", deleted_at: new Date("2026-10-01T00:00:00Z") }],
    ["soft-deleted and suspended", { status: "suspended", deleted_at: new Date("2026-10-01T00:00:00Z") }],
    ["tenant row not visible", null],
  ])("PDG6b: %s tenant → the same 401 as a revoked device; nothing published", async (_label, row) => {
    const { guard } = guardOver(row);
    const req = makeRequest({ authorization: "Bearer device-pairing-token" });

    const err = await guard.canActivate(makeCtx(req)).then(
      () => {
        throw new Error("a device of an inactive tenant was admitted");
      },
      (e: unknown) => e,
    );
    const revoked = await revokedDeviceRefusal();

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).getStatus()).toBe(
      (revoked as UnauthorizedException).getStatus(),
    );
    expect((err as UnauthorizedException).getResponse()).toEqual(
      (revoked as UnauthorizedException).getResponse(),
    );
    expect(req.context).toBeUndefined();
    expect(req.principal).toBeUndefined();
    expect(req.posDeviceId).toBeUndefined();
  });
});
